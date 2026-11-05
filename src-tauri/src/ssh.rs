//! SSH connections, interactive terminals and local port-forward tunnels.
//!
//! Private keys only live here as parsed `PrivateKey` values in memory; they
//! are never written to temp files or handed to the webview.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{Algorithm, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

// ---------- keys ----------

pub struct ParsedKey {
    pub public_key: String,
    pub fingerprint: String,
    pub algorithm: String,
}

pub fn parse_key(text: &str, passphrase: Option<&str>) -> Result<ParsedKey> {
    let k = russh::keys::decode_secret_key(text.trim(), passphrase)
        .map_err(|e| anyhow!("{}: {e}", msg!("key_unreadable")))?;
    Ok(ParsedKey {
        public_key: k.public_key().to_openssh()?,
        fingerprint: k.fingerprint(HashAlg::Sha256).to_string(),
        algorithm: k.algorithm().as_str().to_string(),
    })
}

/// Returns (private OpenSSH text, parsed metadata) for a fresh Ed25519 key.
pub fn generate_ed25519(comment: &str) -> Result<(Zeroizing<String>, ParsedKey)> {
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(seed.as_mut()).map_err(|e| anyhow!("rng: {e}"))?;
    let mut k = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    k.set_comment(comment);
    let text = k.to_openssh(LineEnding::LF)?;
    let parsed = parse_key(&text, None)?;
    Ok((text, parsed))
}

// ---------- connection ----------

pub enum AuthSpec {
    Key(Arc<PrivateKey>),
    Password(Zeroizing<String>),
}

pub struct ConnectSpec {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthSpec,
    pub known_fp: Option<String>,
}

pub struct Client {
    expected: Option<String>,
    rejected: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            PublicKeyOrCertificate::Certificate(c) => c.public_key().fingerprint(HashAlg::Sha256).to_string(),
        };
        if self.expected.as_deref() == Some(fp.as_str()) {
            return Ok(true);
        }
        *self.rejected.lock().unwrap() = Some(fp);
        Ok(false)
    }
}

pub type Session = Handle<Client>;

pub fn key_from_text(text: &str, passphrase: Option<&str>) -> Result<Arc<PrivateKey>> {
    Ok(Arc::new(
        russh::keys::decode_secret_key(text.trim(), passphrase).map_err(|e| anyhow!("{}: {e}", msg!("key_decode_failed")))?,
    ))
}

pub async fn connect(spec: &ConnectSpec) -> Result<Session> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        inactivity_timeout: None,
        ..Default::default()
    });
    let rejected = Arc::new(Mutex::new(None));
    let handler = Client { expected: spec.known_fp.clone(), rejected: rejected.clone() };

    let fut = client::connect(config, (spec.host.as_str(), spec.port), handler);
    let mut session = match tokio::time::timeout(Duration::from_secs(15), fut).await {
        Err(_) => bail!(msg!("conn_timeout", spec.host, spec.port)),
        Ok(Err(e)) => {
            if let Some(fp) = rejected.lock().unwrap().take() {
                // Prefixes are parsed by the UI to show the trust dialog.
                if spec.known_fp.is_none() {
                    bail!("HOSTKEY_UNKNOWN|{fp}");
                }
                bail!("HOSTKEY_MISMATCH|{fp}");
            }
            return Err(anyhow!("{}: {e}", msg!("conn_failed")));
        }
        Ok(Ok(s)) => s,
    };

    let ok = match &spec.auth {
        AuthSpec::Key(k) => {
            let hash = if matches!(k.algorithm(), Algorithm::Rsa { .. }) {
                session.best_supported_rsa_hash().await?.flatten()
            } else {
                None
            };
            session
                .authenticate_publickey(spec.user.clone(), PrivateKeyWithHashAlg::new(k.clone(), hash))
                .await?
                .success()
        }
        AuthSpec::Password(p) => password_auth(&mut session, &spec.user, p).await?,
    };
    if !ok {
        bail!(msg!("auth_failed", spec.user, spec.host));
    }
    Ok(session)
}

/// Plain password first; servers with `PasswordAuthentication no` usually still
/// take the same password over keyboard-interactive (PAM).
async fn password_auth(session: &mut Session, user: &str, pw: &str) -> Result<bool> {
    if session.authenticate_password(user, pw).await?.success() {
        return Ok(true);
    }
    let mut r = session.authenticate_keyboard_interactive_start(user, None).await?;
    for _ in 0..5 {
        match r {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                // Hidden prompts get the password; visible ones (e.g. OTP) can't be answered.
                let answers = prompts.iter().map(|p| if p.echo { String::new() } else { pw.to_string() }).collect();
                r = session.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
}

pub async fn disconnect(s: &Session) {
    let _ = s.disconnect(Disconnect::ByApplication, "", "en").await;
}

/// Runs a command and returns (exit code, combined output).
pub async fn exec(s: &Session, cmd: &str) -> Result<(u32, String)> {
    let mut ch = s.channel_open_session().await?;
    ch.exec(true, cmd).await?;
    let mut out = Vec::new();
    let mut code = 0;
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => out.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => code = exit_status,
            _ => {}
        }
    }
    Ok((code, String::from_utf8_lossy(&out).into_owned()))
}

/// Opens a shell without a PTY and collects what the server prints before
/// closing it, e.g. GitHub's "Hi user! You've successfully authenticated".
pub async fn shell_banner(s: &Session) -> Result<String> {
    let mut ch = s.channel_open_session().await?;
    ch.request_shell(false).await?;
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(6), async {
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => out.extend_from_slice(&data),
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {}
            }
        }
    })
    .await;
    let _ = ch.close().await;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

// ---------- terminal ----------

pub enum TermCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[derive(Clone, Serialize)]
struct TermData<'a> {
    sid: &'a str,
    data: String,
}

pub async fn open_terminal(
    app: AppHandle,
    sid: String,
    spec: ConnectSpec,
    cols: u32,
    rows: u32,
) -> Result<mpsc::UnboundedSender<TermCmd>> {
    let session = connect(&spec).await?;
    drop(spec);
    let mut ch = session.channel_open_session().await?;
    ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await?;
    ch.request_shell(false).await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();
    tauri::async_runtime::spawn(async move {
        let emit = |bytes: &[u8]| {
            let _ = app.emit("term-data", TermData { sid: &sid, data: B64.encode(bytes) });
        };
        loop {
            tokio::select! {
                msg = ch.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => emit(&data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => emit(&data),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(TermCmd::Data(b)) => { let _ = ch.data(&b[..]).await; }
                    Some(TermCmd::Resize(c, r)) => { let _ = ch.window_change(c, r, 0, 0).await; }
                    Some(TermCmd::Close) | None => { let _ = ch.close().await; break; }
                },
            }
        }
        disconnect(&session).await;
        let _ = app.emit("term-exit", sid.clone());
    });
    Ok(tx)
}

// ---------- tunnels (local forward: bind:local_port -> remote_host:remote_port) ----------

pub struct TunnelShared {
    spec: ConnectSpec,
    session: tokio::sync::Mutex<Option<Arc<Session>>>,
    pub active: AtomicUsize,
    pub last_error: Mutex<Option<String>>,
    remote_host: String,
    remote_port: u16,
}

impl TunnelShared {
    /// Returns a live session, reconnecting lazily if the previous one dropped.
    async fn session(&self) -> Result<Arc<Session>> {
        let mut guard = self.session.lock().await;
        if let Some(s) = guard.as_ref() {
            if !s.is_closed() {
                return Ok(s.clone());
            }
        }
        let s = Arc::new(connect(&self.spec).await?);
        *guard = Some(s.clone());
        Ok(s)
    }

    pub async fn shutdown(&self) {
        if let Some(s) = self.session.lock().await.take() {
            disconnect(&s).await;
        }
    }
}

pub struct TunnelRuntime {
    pub task: tauri::async_runtime::JoinHandle<()>,
    pub shared: Arc<TunnelShared>,
}

/// `notify` is called whenever the tunnel's connection count or error changes.
pub async fn start_tunnel(
    notify: Arc<dyn Fn() + Send + Sync>,
    spec: ConnectSpec,
    bind: &str,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<TunnelRuntime> {
    let listener = TcpListener::bind((bind, local_port))
        .await
        .with_context(|| msg!("listen_failed", bind, local_port))?;
    let shared = Arc::new(TunnelShared {
        spec,
        session: tokio::sync::Mutex::new(None),
        active: AtomicUsize::new(0),
        last_error: Mutex::new(None),
        remote_host,
        remote_port,
    });
    // Connect eagerly so auth/host-key errors surface on start.
    shared.session().await?;

    let sh = shared.clone();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut tcp, peer)) = listener.accept().await else { continue };
            let sh = sh.clone();
            let notify = notify.clone();
            tauri::async_runtime::spawn(async move {
                let open = async {
                    let s = sh.session().await?;
                    let ch = s
                        .channel_open_direct_tcpip(
                            sh.remote_host.clone(),
                            sh.remote_port as u32,
                            peer.ip().to_string(),
                            peer.port() as u32,
                        )
                        .await?;
                    anyhow::Ok(ch)
                };
                match open.await {
                    Ok(ch) => {
                        *sh.last_error.lock().unwrap() = None;
                        sh.active.fetch_add(1, Ordering::SeqCst);
                        notify();
                        let mut stream = ch.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                        sh.active.fetch_sub(1, Ordering::SeqCst);
                    }
                    Err(e) => {
                        *sh.last_error.lock().unwrap() = Some(e.to_string());
                    }
                }
                notify();
            });
        }
    });
    Ok(TunnelRuntime { task, shared })
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server::{self, Auth, Msg, Server as _, VerifiedPublicKey};
    use russh::{Channel, ChannelId};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// Minimal in-process SSH server: one allowed key, password "pw",
    /// echoes exec commands and supports direct-tcpip forwarding.
    #[derive(Clone)]
    struct TestServer {
        allowed: russh::keys::PublicKey,
    }

    impl server::Server for TestServer {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }

    impl server::Handler for TestServer {
        type Error = russh::Error;

        async fn auth_publickey(&mut self, _: &str, key: VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
            Ok(if key.public_key.key_data() == self.allowed.key_data() { Auth::Accept } else { Auth::reject() })
        }

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            Ok(if password == "pw" && user != "kbd" { Auth::Accept } else { Auth::reject() })
        }

        // User "kbd" mimics PasswordAuthentication no + KbdInteractiveAuthentication yes.
        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            user: &str,
            _: &str,
            response: Option<server::Response<'a>>,
        ) -> Result<Auth, Self::Error> {
            if user != "kbd" {
                return Ok(Auth::reject());
            }
            Ok(match response {
                None => Auth::Partial { name: "".into(), instructions: "".into(), prompts: vec![("Password: ".into(), false)].into() },
                Some(mut r) => if r.next().as_deref() == Some(b"pw".as_slice()) { Auth::Accept } else { Auth::reject() },
            })
        }

        async fn channel_open_session(&mut self, _: Channel<Msg>, reply: server::ChannelOpenHandle, _: &mut server::Session) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(&mut self, ch: ChannelId, data: &[u8], s: &mut server::Session) -> Result<(), Self::Error> {
            s.channel_success(ch)?;
            s.data(ch, format!("ran:{}", String::from_utf8_lossy(data)).into_bytes())?;
            s.exit_status_request(ch, 0)?;
            s.eof(ch)?;
            s.close(ch)?;
            Ok(())
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            let target = format!("{host}:{port}");
            tokio::spawn(async move {
                let mut tcp = TcpStream::connect(target).await.unwrap();
                let mut st = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut tcp, &mut st).await;
            });
            Ok(())
        }
    }

    fn key(seed: u8) -> PrivateKey {
        PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
    }

    async fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn ssh_end_to_end() {
        let host_key = key(1);
        let client_key = key(2);
        let host_fp = host_key.fingerprint(HashAlg::Sha256).to_string();

        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ssh_port = socket.local_addr().unwrap().port();
        let config = Arc::new(server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            ..Default::default()
        });
        let mut srv = TestServer { allowed: client_key.public_key().clone() };
        tokio::spawn(async move {
            let _ = srv.run_on_socket(config, &socket).await;
        });

        // Echo service standing in for e.g. a dashboard on the server's 127.0.0.1:9090.
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = echo.accept().await.unwrap();
                tokio::spawn(async move {
                    let (mut r, mut w) = s.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });

        let client_key = Arc::new(client_key);
        let spec = |fp: Option<&str>, auth: AuthSpec| ConnectSpec {
            host: "127.0.0.1".into(),
            port: ssh_port,
            user: "root".into(),
            auth,
            known_fp: fp.map(String::from),
        };

        // Unknown host key -> UI gets the fingerprint to confirm.
        let e = connect(&spec(None, AuthSpec::Key(client_key.clone()))).await.err().unwrap().to_string();
        assert_eq!(e, format!("HOSTKEY_UNKNOWN|{host_fp}"));
        // Changed host key -> MITM warning.
        let e = connect(&spec(Some("SHA256:wrong"), AuthSpec::Key(client_key.clone()))).await.err().unwrap().to_string();
        assert_eq!(e, format!("HOSTKEY_MISMATCH|{host_fp}"));
        // Wrong key / wrong password are rejected.
        assert!(connect(&spec(Some(&host_fp), AuthSpec::Key(Arc::new(key(3))))).await.is_err());
        assert!(connect(&spec(Some(&host_fp), AuthSpec::Password(Zeroizing::new("nope".into())))).await.is_err());
        // Password auth works.
        let s = connect(&spec(Some(&host_fp), AuthSpec::Password(Zeroizing::new("pw".into())))).await.unwrap();
        disconnect(&s).await;
        // Same password over keyboard-interactive when plain password is off.
        let kbd = |pw: &str| ConnectSpec { user: "kbd".into(), ..spec(Some(&host_fp), AuthSpec::Password(Zeroizing::new(pw.into()))) };
        let s = connect(&kbd("pw")).await.unwrap();
        disconnect(&s).await;
        assert!(connect(&kbd("nope")).await.is_err());

        // Key auth + exec.
        let s = connect(&spec(Some(&host_fp), AuthSpec::Key(client_key.clone()))).await.unwrap();
        let (code, out) = exec(&s, "uname -a").await.unwrap();
        assert_eq!((code, out.as_str()), (0, "ran:uname -a"));
        disconnect(&s).await;

        // Local forward: 127.0.0.1:<local> -> server -> 127.0.0.1:<echo>.
        let local = free_port().await;
        let changes = Arc::new(AtomicUsize::new(0));
        let c = changes.clone();
        let rt = start_tunnel(
            Arc::new(move || {
                c.fetch_add(1, Ordering::SeqCst);
            }),
            spec(Some(&host_fp), AuthSpec::Key(client_key.clone())),
            "127.0.0.1",
            local,
            "127.0.0.1".into(),
            echo_port,
        )
        .await
        .unwrap();
        for msg in [&b"ping"[..], &b"second connection"[..]] {
            let mut c = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
            c.write_all(msg).await.unwrap();
            let mut buf = vec![0u8; msg.len()];
            tokio::time::timeout(Duration::from_secs(5), c.read_exact(&mut buf)).await.unwrap().unwrap();
            assert_eq!(buf, msg);
        }
        assert!(changes.load(Ordering::SeqCst) >= 2);
        assert!(rt.shared.last_error.lock().unwrap().is_none());

        // Busy port is reported instead of silently failing.
        let busy = start_tunnel(Arc::new(|| {}), spec(Some(&host_fp), AuthSpec::Key(client_key.clone())), "127.0.0.1", local, "127.0.0.1".into(), echo_port).await;
        assert!(busy.err().unwrap().to_string().contains("\u{1f}listen_failed"));

        rt.task.abort();
        rt.shared.shutdown().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(TcpStream::connect(("127.0.0.1", local)).await.is_err(), "port should be released after stop");
    }

    /// Every format ssh-keygen writes (what users actually have as .pem / id_*).
    #[test]
    fn parses_ssh_keygen_formats() {
        let kg = r"C:\Windows\System32\OpenSSH\ssh-keygen.exe";
        if !std::path::Path::new(kg).exists() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("skyvault-pem-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cases = [
            ("rsa", "PEM", ""),
            ("rsa", "PEM", "parola1"),
            ("rsa", "PKCS8", ""),
            ("ecdsa", "PEM", ""),
            ("ecdsa", "PKCS8", ""),
            ("ed25519", "RFC4716", ""),
            ("ed25519", "RFC4716", "parola1"),
            ("rsa", "RFC4716", "parola1"),
        ];
        for (i, (t, m, pw)) in cases.iter().enumerate() {
            let f = dir.join(format!("k{i}"));
            let st = std::process::Command::new(kg)
                .args(["-q", "-t", t, "-m", m, "-N", pw, "-f"])
                .arg(&f)
                .output()
                .unwrap();
            assert!(st.status.success(), "{t}/{m}: {}", String::from_utf8_lossy(&st.stderr));
            let text = std::fs::read_to_string(&f).unwrap();
            let pass = (!pw.is_empty()).then_some(*pw);
            let parsed = parse_key(&text, pass).unwrap_or_else(|e| panic!("{t}/{m}/{pw:?}: {e}"));
            let want = std::fs::read_to_string(f.with_extension("pub")).unwrap();
            let mut want = want.split_whitespace();
            let mut got = parsed.public_key.split_whitespace();
            assert_eq!((got.next(), got.next()), (want.next(), want.next()), "{t}/{m}");
            if pass.is_some() {
                assert!(parse_key(&text, Some("wrong")).is_err(), "{t}/{m} accepted wrong passphrase");
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn generated_key_roundtrips() {
        let (text, parsed) = generate_ed25519("test@skyvault").unwrap();
        assert!(text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(parsed.public_key.starts_with("ssh-ed25519 "));
        assert!(parsed.fingerprint.starts_with("SHA256:"));
        let again = parse_key(&text, None).unwrap();
        assert_eq!(again.fingerprint, parsed.fingerprint);
        assert!(parse_key("garbage", None).is_err());
    }
}
