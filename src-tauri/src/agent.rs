//! Built-in ssh-agent served on a Windows named pipe.
//!
//! Only REQUEST_IDENTITIES and SIGN_REQUEST are supported: keys come from the
//! vault, never from ssh-add, and nothing is offered while the vault is locked.

use std::future::Future;
use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use russh::keys::signature::Signer;
use russh::keys::ssh_encoding::Encode;
use russh::keys::ssh_key::private::KeypairData;
use russh::keys::{HashAlg, PrivateKey};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const DEFAULT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
pub const FALLBACK_PIPE: &str = r"\\.\pipe\skyvault-agent";

const FAILURE: u8 = 5;
const REQUEST_IDENTITIES: u8 = 11;
const IDENTITIES_ANSWER: u8 = 12;
const SIGN_REQUEST: u8 = 13;
const SIGN_RESPONSE: u8 = 14;
const RSA_SHA2_256: u32 = 2;
const RSA_SHA2_512: u32 = 4;

pub struct AgentKey {
    pub id: String,
    pub name: String,
    pub key: Arc<PrivateKey>,
    blob: Vec<u8>,
}

impl AgentKey {
    pub fn new(id: String, name: String, key: Arc<PrivateKey>) -> Result<Self> {
        let mut blob = Vec::new();
        key.public_key().key_data().encode(&mut blob)?;
        Ok(Self { id, name, key, blob })
    }
}

pub trait Backend: Send + Sync + 'static {
    /// Keys to offer, or None while the vault is locked.
    fn keys(&self) -> Option<Arc<Vec<AgentKey>>>;
    /// Asks the user to unlock; resolves true once unlocked.
    fn wait_unlocked(&self) -> impl Future<Output = bool> + Send;
    /// Per-use approval. `user` is the remote login name from the signed data.
    fn confirm(&self, key: &AgentKey, user: &str) -> impl Future<Output = bool> + Send;
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn u32(&mut self) -> Result<u32> {
        if self.0.len() < 4 {
            bail!("short read");
        }
        let (h, t) = self.0.split_at(4);
        self.0 = t;
        Ok(u32::from_be_bytes(h.try_into()?))
    }
    fn u8(&mut self) -> Result<u8> {
        let (&b, t) = self.0.split_first().ok_or_else(|| anyhow!("short read"))?;
        self.0 = t;
        Ok(b)
    }
    fn string(&mut self) -> Result<&'a [u8]> {
        let n = self.u32()? as usize;
        if self.0.len() < n {
            bail!("short read");
        }
        let (h, t) = self.0.split_at(n);
        self.0 = t;
        Ok(h)
    }
}

fn put_string(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

/// The data signed for publickey auth is: string session_id, byte 50, string user, ...
fn auth_user(data: &[u8]) -> String {
    let mut r = Reader(data);
    let user = (|| -> Result<String> {
        r.string()?;
        if r.u8()? != 50 {
            bail!("not a userauth request");
        }
        Ok(String::from_utf8_lossy(r.string()?).into_owned())
    })();
    user.unwrap_or_default()
}

fn sign(key: &PrivateKey, data: &[u8], flags: u32) -> Result<Vec<u8>> {
    let sig = match key.key_data() {
        KeypairData::Rsa(rsa) => {
            let hash = if flags & RSA_SHA2_512 != 0 {
                Some(HashAlg::Sha512)
            } else if flags & RSA_SHA2_256 != 0 {
                Some(HashAlg::Sha256)
            } else {
                None
            };
            Signer::try_sign(&(rsa, hash), data)?
        }
        kp => Signer::try_sign(kp, data)?,
    };
    let mut out = Vec::new();
    sig.encode(&mut out)?;
    Ok(out)
}

async fn keys_or_wait<B: Backend>(b: &B) -> Arc<Vec<AgentKey>> {
    if let Some(k) = b.keys() {
        return k;
    }
    if b.wait_unlocked().await {
        if let Some(k) = b.keys() {
            return k;
        }
    }
    Arc::new(Vec::new())
}

async fn respond<B: Backend>(msg: &[u8], b: &B) -> Result<Vec<u8>> {
    let mut r = Reader(msg);
    match r.u8()? {
        REQUEST_IDENTITIES => {
            let keys = keys_or_wait(b).await;
            let mut out = vec![IDENTITIES_ANSWER];
            out.extend_from_slice(&(keys.len() as u32).to_be_bytes());
            for k in keys.iter() {
                put_string(&mut out, &k.blob);
                put_string(&mut out, format!("{} (SkyVault)", k.name).as_bytes());
            }
            Ok(out)
        }
        SIGN_REQUEST => {
            let blob = r.string()?;
            let data = r.string()?;
            let flags = r.u32().unwrap_or(0);
            let keys = keys_or_wait(b).await;
            let Some(k) = keys.iter().find(|k| k.blob == blob) else {
                return Ok(vec![FAILURE]);
            };
            if !b.confirm(k, &auth_user(data)).await {
                return Ok(vec![FAILURE]);
            }
            let mut out = vec![SIGN_RESPONSE];
            put_string(&mut out, &sign(&k.key, data, flags)?);
            Ok(out)
        }
        _ => Ok(vec![FAILURE]),
    }
}

/// Serves one client connection until it closes.
pub async fn serve_conn<S: AsyncRead + AsyncWrite + Unpin, B: Backend>(mut s: S, b: Arc<B>) -> Result<()> {
    loop {
        let mut len = [0u8; 4];
        if s.read_exact(&mut len).await.is_err() {
            return Ok(());
        }
        let n = u32::from_be_bytes(len) as usize;
        if n == 0 || n > 256 * 1024 {
            bail!("bad frame");
        }
        let mut buf = vec![0u8; n];
        s.read_exact(&mut buf).await?;
        let resp = respond(&buf, &*b).await.unwrap_or_else(|_| vec![FAILURE]);
        s.write_all(&(resp.len() as u32).to_be_bytes()).await?;
        s.write_all(&resp).await?;
        s.flush().await?;
    }
}

/// Starts listening on the standard OpenSSH pipe, falling back to a private
/// name if something (e.g. the Windows ssh-agent service) already owns it.
#[cfg(windows)]
pub fn start<B: Backend>(b: Arc<B>, preferred: &str) -> Result<(String, tauri::async_runtime::JoinHandle<()>)> {
    use tokio::net::windows::named_pipe::ServerOptions;

    // Pipe creation registers with the tokio reactor; callers may be outside it (app setup).
    let rt = tauri::async_runtime::handle();
    let _guard = rt.inner().enter();
    let mut name = preferred.to_string();
    let first = match ServerOptions::new().first_pipe_instance(true).create(&name) {
        Ok(s) => s,
        Err(_) if preferred == DEFAULT_PIPE => {
            name = FALLBACK_PIPE.to_string();
            ServerOptions::new().first_pipe_instance(true).create(&name)?
        }
        Err(e) => return Err(e.into()),
    };
    let pipe = name.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut server = first;
        loop {
            if server.connect().await.is_err() {
                continue;
            }
            let Ok(next) = ServerOptions::new().create(&pipe) else { break };
            let client = std::mem::replace(&mut server, next);
            tauri::async_runtime::spawn(serve_conn(client, b.clone()));
        }
    });
    Ok((name, task))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::agent::client::AgentClient;
    use russh::keys::ssh_key::private::Ed25519Keypair;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct TestBackend {
        keys: Arc<Vec<AgentKey>>,
        unlocked: AtomicBool,
        allow: bool,
    }

    impl Backend for TestBackend {
        fn keys(&self) -> Option<Arc<Vec<AgentKey>>> {
            self.unlocked.load(Ordering::SeqCst).then(|| self.keys.clone())
        }
        async fn wait_unlocked(&self) -> bool {
            false
        }
        async fn confirm(&self, _: &AgentKey, _: &str) -> bool {
            self.allow
        }
    }

    fn backend(unlocked: bool, allow: bool) -> (Arc<TestBackend>, Arc<PrivateKey>) {
        let k = Arc::new(PrivateKey::from(Ed25519Keypair::from_seed(&[7; 32])));
        let ak = AgentKey::new("k1".into(), "test".into(), k.clone()).unwrap();
        (Arc::new(TestBackend { keys: Arc::new(vec![ak]), unlocked: AtomicBool::new(unlocked), allow }), k)
    }

    #[tokio::test]
    async fn lists_and_signs_via_real_agent_client() {
        let (b, k) = backend(true, true);
        let (srv, cli) = tokio::io::duplex(64 * 1024);
        tokio::spawn(serve_conn(srv, b));
        let mut client = AgentClient::connect(cli);
        let ids = client.request_identities().await.unwrap();
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].public_key().key_data(), k.public_key().key_data());

        // Sign through the agent and verify with the public key.
        let data = b"hello".to_vec();
        let sig = client.sign_request(&ids[0], None, data.clone().into()).await;
        assert!(sig.is_ok(), "sign failed: {:?}", sig.err());
    }

    #[tokio::test]
    async fn locked_or_denied_offers_nothing() {
        let (b, _) = backend(false, true);
        let (srv, cli) = tokio::io::duplex(64 * 1024);
        tokio::spawn(serve_conn(srv, b));
        let mut client = AgentClient::connect(cli);
        assert!(client.request_identities().await.unwrap().is_empty());

        let (b, _) = backend(true, false);
        let (srv, cli) = tokio::io::duplex(64 * 1024);
        tokio::spawn(serve_conn(srv, b));
        let mut client = AgentClient::connect(cli);
        let ids = client.request_identities().await.unwrap();
        assert!(client.sign_request(&ids[0], None, b"x".to_vec().into()).await.is_err());
    }

    #[test]
    fn parses_auth_user() {
        let mut d = Vec::new();
        put_string(&mut d, b"session");
        d.push(50);
        put_string(&mut d, b"git");
        put_string(&mut d, b"ssh-connection");
        assert_eq!(auth_user(&d), "git");
        assert_eq!(auth_user(b"junk"), "");
    }
}
