/// A message the UI translates: `\x1f code (\x1f arg)* \x1e` (see `localize` in src/i18n.tsx).
/// Segments can be mixed with plain text, e.g. `format!("{}: {e}", msg!("conn_failed"))`.
macro_rules! msg {
    ($code:literal $(, $arg:expr)* $(,)?) => {{
        #[allow(unused_mut)]
        let mut s = String::from(concat!("\u{1f}", $code));
        $(
            s.push('\u{1f}');
            s.extend($arg.to_string().chars().filter(|c| *c != '\u{1f}' && *c != '\u{1e}'));
        )*
        s.push('\u{1e}');
        s
    }};
}

mod agent;
mod features;
mod git;
mod ports;
mod ssh;
mod sshconfig;
mod vault;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use ssh::{AuthSpec, ConnectSpec, TermCmd, TunnelRuntime};
use vault::{Settings, SshKey, Tunnel, Unlocked};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub struct AppState {
    vault_path: PathBuf,
    vault: Mutex<Option<Unlocked>>,
    last_activity: Mutex<Instant>,
    terms: Mutex<HashMap<String, mpsc::UnboundedSender<TermCmd>>>,
    tunnels: Mutex<HashMap<String, TunnelRuntime>>,
    agent: Mutex<features::AgentState>,
}

impl AppState {
    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    fn with<T>(&self, f: impl FnOnce(&mut Unlocked) -> anyhow::Result<T>) -> CmdResult<T> {
        self.touch();
        let mut g = self.vault.lock().unwrap();
        let v = g.as_mut().ok_or("Kasa kilitli")?;
        f(v).map_err(err)
    }

    /// Builds a connection spec for a host; decrypted secrets are copied out
    /// only for the lifetime of the connection attempt.
    fn connect_spec(&self, host_id: &str) -> CmdResult<ConnectSpec> {
        self.with(|v| {
            let h = v.data.hosts.iter().find(|h| h.id == host_id).ok_or_else(|| anyhow::anyhow!(msg!("host_not_found")))?;
            let auth = if h.auth == "password" {
                AuthSpec::Password(Zeroizing::new(h.password.clone().unwrap_or_default()))
            } else {
                let kid = h.key_id.as_deref().ok_or_else(|| anyhow::anyhow!(msg!("host_no_key")))?;
                let k = v.data.keys.iter().find(|k| k.id == kid).ok_or_else(|| anyhow::anyhow!(msg!("key_not_found")))?;
                AuthSpec::Key(ssh::key_from_text(&k.private_key, k.passphrase.as_deref())?)
            };
            Ok(ConnectSpec {
                host: h.host.clone(),
                port: h.port,
                user: h.username.clone(),
                auth,
                known_fp: h.host_key_fp.clone(),
            })
        })
    }

    fn invalidate_agent(&self) {
        self.agent.lock().unwrap().cache = None;
    }

    fn close_terms(&self) {
        for (_, t) in self.terms.lock().unwrap().drain() {
            let _ = t.send(TermCmd::Close);
        }
    }

    async fn stop_all(&self) {
        self.close_terms();
        let tunnels: Vec<_> = self.tunnels.lock().unwrap().drain().map(|(_, t)| t).collect();
        for t in tunnels {
            t.task.abort();
            t.shared.shutdown().await;
        }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ---------- views sent to the webview (no secrets) ----------

#[derive(Serialize)]
struct HostView {
    id: String,
    name: String,
    group: String,
    host: String,
    port: u16,
    username: String,
    auth: String,
    key_id: Option<String>,
    has_password: bool,
    notes: String,
    host_key_fp: Option<String>,
}

#[derive(Serialize)]
struct KeyView {
    id: String,
    name: String,
    public_key: String,
    fingerprint: String,
    algorithm: String,
    has_passphrase: bool,
    created: u64,
    agent: bool,
}

#[derive(Serialize)]
struct TunnelView {
    id: String,
    name: String,
    host_id: String,
    bind_addr: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    auto_start: bool,
    running: bool,
    active: usize,
    last_error: Option<String>,
}

#[derive(Serialize)]
struct Snapshot {
    hosts: Vec<HostView>,
    keys: Vec<KeyView>,
    tunnels: Vec<TunnelView>,
    settings: Settings,
}

#[derive(Serialize)]
struct Status {
    exists: bool,
    unlocked: bool,
    path: String,
}

// ---------- vault commands ----------

#[tauri::command]
fn vault_status(state: State<'_, AppState>) -> Status {
    Status {
        exists: state.vault_path.exists(),
        unlocked: state.vault.lock().unwrap().is_some(),
        path: state.vault_path.display().to_string(),
    }
}

#[tauri::command]
async fn vault_create(app: AppHandle, state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let password = Zeroizing::new(password);
    if password.chars().count() < 10 {
        return Err(msg!("master_too_short"));
    }
    let path = state.vault_path.clone();
    let v = tauri::async_runtime::spawn_blocking(move || Unlocked::create(&path, &password))
        .await
        .map_err(err)?
        .map_err(err)?;
    *state.vault.lock().unwrap() = Some(v);
    state.touch();
    features::sync_agent(&app);
    let _ = app.emit("unlocked", ());
    Ok(())
}

#[tauri::command]
async fn vault_unlock(app: AppHandle, state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let password = Zeroizing::new(password);
    let path = state.vault_path.clone();
    let v = tauri::async_runtime::spawn_blocking(move || Unlocked::open(&path, &password))
        .await
        .map_err(err)?
        .map_err(err)?;
    let auto: Vec<(String, String)> =
        v.data.tunnels.iter().filter(|t| t.auto_start).map(|t| (t.id.clone(), t.name.clone())).collect();
    *state.vault.lock().unwrap() = Some(v);
    state.touch();
    features::sync_agent(&app);
    let _ = app.emit("unlocked", ());

    // Auto-start tunnels in the background so unlocking never waits on the network.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app2.state::<AppState>();
        for (id, name) in auto {
            if state.tunnels.lock().unwrap().contains_key(&id) {
                continue;
            }
            if let Err(e) = start_tunnel_inner(&app2, &state, &id).await {
                let why = if e.starts_with("HOSTKEY_") { msg!("autostart_hostkey") } else { e };
                let _ = app2.emit("toast", format!("{}: {why}", msg!("autostart_failed", name)));
            }
        }
    });
    Ok(())
}

async fn lock_inner(app: &AppHandle, state: &AppState) {
    let close = state.vault.lock().unwrap().as_ref().map(|v| v.data.settings.close_on_lock).unwrap_or(false);
    // Dropping `Unlocked` zeroizes the derived key and all decrypted data.
    *state.vault.lock().unwrap() = None;
    {
        let mut a = state.agent.lock().unwrap();
        a.cache = None;
        a.approved.clear();
    }
    // Terminals always close (an unlocked shell is as good as the vault);
    // tunnels may keep running if the user prefers.
    state.close_terms();
    if close {
        state.stop_all().await;
    }
    let _ = app.emit("locked", ());
    let _ = app.emit("tunnels-changed", ());
}

#[tauri::command]
async fn vault_lock(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    lock_inner(&app, &state).await;
    Ok(())
}

#[tauri::command]
async fn vault_change_password(state: State<'_, AppState>, current: String, new: String) -> CmdResult<()> {
    let current = Zeroizing::new(current);
    let new = Zeroizing::new(new);
    if new.chars().count() < 10 {
        return Err(msg!("new_password_too_short"));
    }
    let path = state.vault_path.clone();
    let check = current.clone();
    tauri::async_runtime::spawn_blocking(move || Unlocked::open(&path, &check).map(|_| ()))
        .await
        .map_err(err)?
        .map_err(|_| msg!("current_password_wrong"))?;
    state.with(|v| v.change_password(&new))
}

/// Tray menu items, relabelled when the UI language changes.
struct TrayItems([MenuItem<tauri::Wry>; 3]);

#[tauri::command]
fn tray_labels(items: State<'_, TrayItems>, labels: Vec<String>) {
    for (item, label) in items.0.iter().zip(labels) {
        let _ = item.set_text(label);
    }
}

#[tauri::command]
fn touch(state: State<'_, AppState>) {
    state.touch();
}

#[tauri::command]
fn snapshot(state: State<'_, AppState>) -> CmdResult<Snapshot> {
    let runtime: HashMap<String, (usize, Option<String>)> = state
        .tunnels
        .lock()
        .unwrap()
        .iter()
        .map(|(id, t)| (id.clone(), (t.shared.active.load(Ordering::SeqCst), t.shared.last_error.lock().unwrap().clone())))
        .collect();
    state.with(|v| {
        let d = &v.data;
        Ok(Snapshot {
            hosts: d
                .hosts
                .iter()
                .map(|h| HostView {
                    id: h.id.clone(),
                    name: h.name.clone(),
                    group: h.group.clone(),
                    host: h.host.clone(),
                    port: h.port,
                    username: h.username.clone(),
                    auth: h.auth.clone(),
                    key_id: h.key_id.clone(),
                    has_password: h.password.as_deref().is_some_and(|p| !p.is_empty()),
                    notes: h.notes.clone(),
                    host_key_fp: h.host_key_fp.clone(),
                })
                .collect(),
            keys: d
                .keys
                .iter()
                .map(|k| KeyView {
                    id: k.id.clone(),
                    name: k.name.clone(),
                    public_key: k.public_key.clone(),
                    fingerprint: k.fingerprint.clone(),
                    algorithm: k.algorithm.clone(),
                    has_passphrase: k.passphrase.as_deref().is_some_and(|p| !p.is_empty()),
                    created: k.created,
                    agent: k.agent,
                })
                .collect(),
            tunnels: d
                .tunnels
                .iter()
                .map(|t| {
                    let rt = runtime.get(&t.id);
                    TunnelView {
                        id: t.id.clone(),
                        name: t.name.clone(),
                        host_id: t.host_id.clone(),
                        bind_addr: t.bind_addr.clone(),
                        local_port: t.local_port,
                        remote_host: t.remote_host.clone(),
                        remote_port: t.remote_port,
                        auto_start: t.auto_start,
                        running: rt.is_some(),
                        active: rt.map(|r| r.0).unwrap_or(0),
                        last_error: rt.and_then(|r| r.1.clone()),
                    }
                })
                .collect(),
            settings: d.settings.clone(),
        })
    })
}

#[tauri::command]
fn settings_save(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> CmdResult<()> {
    state.with(|v| {
        v.data.settings = Settings { auto_lock_minutes: settings.auto_lock_minutes.clamp(1, 240), ..settings };
        v.save()
    })?;
    features::sync_agent(&app);
    Ok(())
}

// ---------- hosts ----------

#[derive(Deserialize)]
struct HostInput {
    id: Option<String>,
    name: String,
    group: String,
    host: String,
    port: u16,
    username: String,
    auth: String,
    key_id: Option<String>,
    /// None or "" keeps the stored password.
    password: Option<String>,
    notes: String,
}

#[tauri::command]
fn host_save(state: State<'_, AppState>, input: HostInput) -> CmdResult<String> {
    let password = input.password.map(Zeroizing::new);
    state.with(|v| {
        if input.host.trim().is_empty() || input.username.trim().is_empty() {
            anyhow::bail!(msg!("host_required_fields"));
        }
        let existing = input.id.as_deref().and_then(|id| v.data.hosts.iter().position(|h| h.id == id));
        let mut h = existing.map(|i| v.data.hosts[i].clone()).unwrap_or_default();
        if h.id.is_empty() {
            h.id = new_id();
        }
        if h.host != input.host.trim() || h.port != input.port {
            h.host_key_fp = None; // different server: re-verify host key
        }
        h.name = if input.name.trim().is_empty() { input.host.trim().to_string() } else { input.name.trim().to_string() };
        h.group = input.group.trim().to_string();
        h.host = input.host.trim().to_string();
        h.port = if input.port == 0 { 22 } else { input.port };
        h.username = input.username.trim().to_string();
        h.auth = input.auth;
        h.key_id = input.key_id.filter(|k| !k.is_empty());
        if let Some(p) = password.as_ref().filter(|p| !p.is_empty()) {
            h.password = Some(p.to_string());
        }
        h.notes = input.notes;
        let id = h.id.clone();
        match existing {
            Some(i) => v.data.hosts[i] = h,
            None => v.data.hosts.push(h),
        }
        v.save()?;
        Ok(id)
    })
}

#[tauri::command]
fn host_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.with(|v| {
        if v.data.tunnels.iter().any(|t| t.host_id == id) {
            anyhow::bail!(msg!("host_has_tunnels"));
        }
        v.data.hosts.retain(|h| h.id != id);
        v.save()
    })
}

#[tauri::command]
fn host_trust(state: State<'_, AppState>, id: String, fingerprint: String) -> CmdResult<()> {
    state.with(|v| {
        if let Some(h) = v.data.hosts.iter_mut().find(|h| h.id == id) {
            h.host_key_fp = Some(fingerprint);
        } else if let Some(a) = v.data.git_accounts.iter_mut().find(|a| a.id == id) {
            a.host_key_fp = Some(fingerprint);
        } else {
            anyhow::bail!(msg!("host_not_found"));
        }
        v.save()
    })
}

#[tauri::command]
async fn host_test(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let spec = state.connect_spec(&id)?;
    let s = ssh::connect(&spec).await.map_err(err)?;
    drop(spec);
    let (_, out) = ssh::exec(&s, "uname -snrm 2>/dev/null || ver").await.map_err(err)?;
    ssh::disconnect(&s).await;
    Ok(out.trim().to_string())
}

/// Appends a key's public half to ~/.ssh/authorized_keys on the host
/// (using the host's current auth method), like ssh-copy-id.
#[tauri::command]
async fn host_install_key(state: State<'_, AppState>, id: String, key_id: String) -> CmdResult<()> {
    let pubkey = state.with(|v| {
        v.data.keys.iter().find(|k| k.id == key_id).map(|k| k.public_key.clone()).ok_or_else(|| anyhow::anyhow!(msg!("key_not_found")))
    })?;
    if pubkey.contains('\'') || pubkey.contains('\n') {
        return Err(msg!("pubkey_invalid"));
    }
    let spec = state.connect_spec(&id)?;
    let s = ssh::connect(&spec).await.map_err(err)?;
    drop(spec);
    let cmd = format!(
        "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '{k}' ~/.ssh/authorized_keys || echo '{k}' >> ~/.ssh/authorized_keys)",
        k = pubkey
    );
    let (code, out) = ssh::exec(&s, &cmd).await.map_err(err)?;
    ssh::disconnect(&s).await;
    if code != 0 {
        return Err(format!("{}: {}", msg!("remote_command_failed", code), out.trim()));
    }
    Ok(())
}

// ---------- keys ----------

#[tauri::command]
fn key_import(state: State<'_, AppState>, name: String, text: Option<String>, path: Option<String>, passphrase: Option<String>) -> CmdResult<String> {
    let text = Zeroizing::new(match (text, path) {
        (Some(t), _) if !t.trim().is_empty() => t,
        (_, Some(p)) => std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", msg!("file_unreadable")))?,
        _ => return Err(msg!("key_input_required")),
    });
    let passphrase = passphrase.filter(|p| !p.is_empty()).map(Zeroizing::new);
    let parsed = ssh::parse_key(&text, passphrase.as_deref().map(|s| s.as_str())).map_err(err)?;
    state.invalidate_agent();
    state.with(|v| {
        if v.data.keys.iter().any(|k| k.fingerprint == parsed.fingerprint) {
            anyhow::bail!(msg!("key_exists"));
        }
        let id = new_id();
        v.data.keys.push(SshKey {
            id: id.clone(),
            name: if name.trim().is_empty() { parsed.algorithm.clone() } else { name.trim().to_string() },
            private_key: text.trim().to_string(),
            passphrase: passphrase.as_ref().map(|p| p.to_string()),
            public_key: parsed.public_key,
            fingerprint: parsed.fingerprint,
            algorithm: parsed.algorithm,
            created: now(),
            agent: true,
        });
        v.save()?;
        Ok(id)
    })
}

#[tauri::command]
fn key_generate(state: State<'_, AppState>, name: String) -> CmdResult<String> {
    let comment = format!("{}@skyvault", name.trim().replace(' ', "-"));
    let (text, parsed) = ssh::generate_ed25519(&comment).map_err(err)?;
    state.invalidate_agent();
    state.with(|v| {
        let id = new_id();
        v.data.keys.push(SshKey {
            id: id.clone(),
            name: name.trim().to_string(),
            private_key: text.to_string(),
            passphrase: None,
            public_key: parsed.public_key,
            fingerprint: parsed.fingerprint,
            algorithm: parsed.algorithm,
            created: now(),
            agent: true,
        });
        v.save()?;
        Ok(id)
    })
}

#[tauri::command]
fn key_rename(state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    state.invalidate_agent();
    state.with(|v| {
        let k = v.data.keys.iter_mut().find(|k| k.id == id).ok_or_else(|| anyhow::anyhow!(msg!("key_not_found")))?;
        k.name = name.trim().to_string();
        v.save()
    })
}

#[tauri::command]
fn key_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.invalidate_agent();
    state.with(|v| {
        if v.data.hosts.iter().any(|h| h.key_id.as_deref() == Some(id.as_str())) {
            anyhow::bail!(msg!("key_in_use"));
        }
        v.data.keys.retain(|k| k.id != id);
        v.save()
    })
}

// ---------- tunnels ----------

#[derive(Deserialize)]
struct TunnelInput {
    id: Option<String>,
    name: String,
    host_id: String,
    bind_addr: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    auto_start: bool,
}

#[tauri::command]
fn tunnel_save(state: State<'_, AppState>, input: TunnelInput) -> CmdResult<String> {
    state.with(|v| {
        if input.local_port == 0 || input.remote_port == 0 {
            anyhow::bail!(msg!("ports_range"));
        }
        if !v.data.hosts.iter().any(|h| h.id == input.host_id) {
            anyhow::bail!(msg!("select_host"));
        }
        let t = Tunnel {
            id: input.id.clone().unwrap_or_else(new_id),
            name: if input.name.trim().is_empty() { format!("{} → {}", input.local_port, input.remote_port) } else { input.name.trim().to_string() },
            host_id: input.host_id,
            bind_addr: if input.bind_addr.trim().is_empty() { "127.0.0.1".into() } else { input.bind_addr.trim().to_string() },
            local_port: input.local_port,
            remote_host: if input.remote_host.trim().is_empty() { "127.0.0.1".into() } else { input.remote_host.trim().to_string() },
            remote_port: input.remote_port,
            auto_start: input.auto_start,
        };
        let id = t.id.clone();
        match v.data.tunnels.iter().position(|x| x.id == id) {
            Some(i) => v.data.tunnels[i] = t,
            None => v.data.tunnels.push(t),
        }
        v.save()?;
        Ok(id)
    })
}

#[tauri::command]
async fn tunnel_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    stop_tunnel_inner(&app, &state, &id).await;
    state.with(|v| {
        v.data.tunnels.retain(|t| t.id != id);
        v.save()
    })
}

async fn start_tunnel_inner(app: &AppHandle, state: &AppState, id: &str) -> CmdResult<()> {
    let t = state.with(|v| v.data.tunnels.iter().find(|t| t.id == id).cloned().ok_or_else(|| anyhow::anyhow!(msg!("tunnel_not_found"))))?;
    let spec = state.connect_spec(&t.host_id)?;
    let notify = {
        let app = app.clone();
        std::sync::Arc::new(move || {
            let _ = app.emit("tunnels-changed", ());
        })
    };
    let rt = ssh::start_tunnel(notify, spec, &t.bind_addr, t.local_port, t.remote_host.clone(), t.remote_port)
        .await
        .map_err(err)?;
    if let Some(old) = state.tunnels.lock().unwrap().insert(id.to_string(), rt) {
        old.task.abort();
    }
    let _ = app.emit("tunnels-changed", ());
    Ok(())
}

async fn stop_tunnel_inner(app: &AppHandle, state: &AppState, id: &str) {
    let rt = state.tunnels.lock().unwrap().remove(id);
    if let Some(rt) = rt {
        rt.task.abort();
        rt.shared.shutdown().await;
    }
    let _ = app.emit("tunnels-changed", ());
}

#[tauri::command]
async fn tunnel_start(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if state.tunnels.lock().unwrap().contains_key(&id) {
        return Ok(());
    }
    start_tunnel_inner(&app, &state, &id).await
}

#[tauri::command]
async fn tunnel_stop(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.touch();
    stop_tunnel_inner(&app, &state, &id).await;
    Ok(())
}

// ---------- terminals ----------

#[tauri::command]
async fn term_open(app: AppHandle, state: State<'_, AppState>, host_id: String, cols: u32, rows: u32) -> CmdResult<String> {
    let spec = state.connect_spec(&host_id)?;
    let sid = new_id();
    let tx = ssh::open_terminal(app, sid.clone(), spec, cols.max(10), rows.max(5)).await.map_err(err)?;
    state.terms.lock().unwrap().insert(sid.clone(), tx);
    Ok(sid)
}

#[tauri::command]
fn term_write(state: State<'_, AppState>, sid: String, data: String) {
    state.touch();
    if let Some(t) = state.terms.lock().unwrap().get(&sid) {
        let _ = t.send(TermCmd::Data(data.into_bytes()));
    }
}

#[tauri::command]
fn term_resize(state: State<'_, AppState>, sid: String, cols: u32, rows: u32) {
    if let Some(t) = state.terms.lock().unwrap().get(&sid) {
        let _ = t.send(TermCmd::Resize(cols, rows));
    }
}

#[tauri::command]
fn term_close(state: State<'_, AppState>, sid: String) {
    if let Some(t) = state.terms.lock().unwrap().remove(&sid) {
        let _ = t.send(TermCmd::Close);
    }
}

// ---------- app ----------

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn auto_lock_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let state = app.state::<AppState>();
            let limit = match state.vault.lock().unwrap().as_ref() {
                Some(v) => Duration::from_secs(v.data.settings.auto_lock_minutes as u64 * 60),
                None => continue,
            };
            if state.last_activity.lock().unwrap().elapsed() >= limit {
                lock_inner(&app, &state).await;
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // SKYVAULT_VAULT points at an alternate vault file (USB stick, tests).
            let vault_path = match std::env::var_os("SKYVAULT_VAULT") {
                Some(p) => PathBuf::from(p),
                None => app.path().app_data_dir()?.join("vault.skv"),
            };
            app.manage(AppState {
                vault_path,
                vault: Mutex::new(None),
                last_activity: Mutex::new(Instant::now()),
                terms: Mutex::new(HashMap::new()),
                tunnels: Mutex::new(HashMap::new()),
                agent: Mutex::new(Default::default()),
            });
            features::sync_agent(app.handle());

            // English until the UI reports its language via `tray_labels`.
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let lock = MenuItem::with_id(app, "lock", "Lock", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &lock, &quit])?;
            app.manage(TrayItems([show.clone(), lock.clone(), quit.clone()]));
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SkyVault")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "lock" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<AppState>();
                            lock_inner(&app, &state).await;
                        });
                    }
                    "quit" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<AppState>();
                            *state.vault.lock().unwrap() = None;
                            state.stop_all().await;
                            app.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            auto_lock_loop(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps tunnels alive in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_change_password,
            touch,
            snapshot,
            settings_save,
            host_save,
            host_delete,
            host_trust,
            host_test,
            host_install_key,
            key_import,
            key_generate,
            key_rename,
            key_delete,
            tunnel_save,
            tunnel_delete,
            tunnel_start,
            tunnel_stop,
            term_open,
            term_write,
            term_resize,
            term_close,
            features::agent_status,
            features::agent_answer,
            features::key_set_agent,
            features::secret_list,
            features::secret_get,
            features::secret_save,
            features::secret_delete,
            features::secret_copy,
            features::note_list,
            features::note_get,
            features::note_save,
            features::note_delete,
            features::git_list,
            features::git_save,
            features::git_delete,
            features::git_apply,
            features::git_set_ssh_command,
            features::git_test,
            tray_labels,
            features::host_ports,
            features::host_probe,
            features::local_port_check,
            features::ssh_config_scan,
            features::ssh_config_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
