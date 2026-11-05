//! Secrets, notes, git aliases and the ssh-agent bridge.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::agent::{self, AgentKey};
use crate::ssh::{self, AuthSpec, ConnectSpec};
use crate::vault::{GitAccount, Note, Secret};
use crate::{AppState, CmdResult, err, new_id, now, show_main};

const APPROVAL_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct AgentState {
    pub pipe: Option<String>,
    pub error: Option<String>,
    pub task: Option<tauri::async_runtime::JoinHandle<()>>,
    pub cache: Option<Arc<Vec<AgentKey>>>,
    pub approved: HashMap<String, Instant>,
    pub pending: HashMap<String, oneshot::Sender<bool>>,
}

// =============== agent ===============

struct AppBackend(AppHandle);

impl agent::Backend for AppBackend {
    fn keys(&self) -> Option<Arc<Vec<AgentKey>>> {
        let state = self.0.state::<AppState>();
        let vault = state.vault.lock().unwrap();
        let v = vault.as_ref()?;
        if !v.data.settings.agent_enabled {
            return Some(Arc::new(Vec::new()));
        }
        let mut a = state.agent.lock().unwrap();
        if let Some(c) = &a.cache {
            return Some(c.clone());
        }
        let keys: Vec<AgentKey> = v
            .data
            .keys
            .iter()
            .filter(|k| k.agent)
            .filter_map(|k| {
                let pk = ssh::key_from_text(&k.private_key, k.passphrase.as_deref()).ok()?;
                AgentKey::new(k.id.clone(), k.name.clone(), pk).ok()
            })
            .collect();
        let keys = Arc::new(keys);
        a.cache = Some(keys.clone());
        Some(keys)
    }

    async fn wait_unlocked(&self) -> bool {
        show_main(&self.0);
        let _ = self.0.emit("toast-info", msg!("agent_wants_unlock"));
        let state = self.0.state::<AppState>();
        for _ in 0..300 {
            if state.vault.lock().unwrap().is_some() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        false
    }

    async fn confirm(&self, key: &AgentKey, user: &str) -> bool {
        let state = self.0.state::<AppState>();
        let ask = state.vault.lock().unwrap().as_ref().map(|v| v.data.settings.agent_confirm).unwrap_or(true);
        if !ask {
            return true;
        }
        if state.agent.lock().unwrap().approved.get(&key.id).is_some_and(|t| t.elapsed() < APPROVAL_TTL) {
            return true;
        }
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        state.agent.lock().unwrap().pending.insert(id.clone(), tx);
        #[derive(Serialize, Clone)]
        struct Req<'a> {
            id: &'a str,
            key: &'a str,
            user: &'a str,
        }
        show_main(&self.0);
        let _ = self.0.emit("agent-confirm", Req { id: &id, key: &key.name, user });
        let ok = matches!(tokio::time::timeout(Duration::from_secs(60), rx).await, Ok(Ok(true)));
        let mut a = state.agent.lock().unwrap();
        a.pending.remove(&id);
        if ok {
            a.approved.insert(key.id.clone(), Instant::now());
        }
        drop(a);
        let _ = self.0.emit("agent-confirm-done", id);
        ok
    }
}

/// Starts or stops the agent to match settings. While locked the setting is
/// unknown, so it runs; requests then prompt for unlock.
pub fn sync_agent(app: &AppHandle) {
    let state = app.state::<AppState>();
    let enabled = state.vault.lock().unwrap().as_ref().map(|v| v.data.settings.agent_enabled).unwrap_or(true);
    let mut a = state.agent.lock().unwrap();
    a.cache = None;
    if enabled && a.task.is_none() {
        #[cfg(windows)]
        match agent::start(Arc::new(AppBackend(app.clone())), agent::DEFAULT_PIPE) {
            Ok((pipe, task)) => {
                a.pipe = Some(pipe);
                a.task = Some(task);
                a.error = None;
            }
            Err(e) => a.error = Some(format!("{}: {e}", msg!("agent_start_failed"))),
        }
    } else if !enabled {
        if let Some(t) = a.task.take() {
            t.abort();
        }
        a.pipe = None;
    }
}

#[derive(Serialize)]
pub struct AgentStatus {
    running: bool,
    pipe: Option<String>,
    default_pipe: bool,
    error: Option<String>,
    keys: usize,
}

#[tauri::command]
pub fn agent_status(state: State<'_, AppState>) -> AgentStatus {
    let keys = state.vault.lock().unwrap().as_ref().map(|v| v.data.keys.iter().filter(|k| k.agent).count()).unwrap_or(0);
    let a = state.agent.lock().unwrap();
    AgentStatus {
        running: a.task.is_some(),
        default_pipe: a.pipe.as_deref() == Some(agent::DEFAULT_PIPE),
        pipe: a.pipe.clone(),
        error: a.error.clone(),
        keys,
    }
}

#[tauri::command]
pub fn agent_answer(state: State<'_, AppState>, id: String, allow: bool) {
    if let Some(tx) = state.agent.lock().unwrap().pending.remove(&id) {
        let _ = tx.send(allow);
    }
}

#[tauri::command]
pub fn key_set_agent(state: State<'_, AppState>, id: String, on: bool) -> CmdResult<()> {
    state.with(|v| {
        let k = v.data.keys.iter_mut().find(|k| k.id == id).ok_or_else(|| anyhow::anyhow!(msg!("key_not_found")))?;
        k.agent = on;
        v.save()
    })?;
    state.agent.lock().unwrap().cache = None;
    Ok(())
}

// =============== secrets ===============

#[derive(Serialize)]
pub struct SecretView {
    id: String,
    title: String,
    group: String,
    username: String,
    url: String,
    has_password: bool,
    has_notes: bool,
    updated: u64,
}

#[tauri::command]
pub fn secret_list(state: State<'_, AppState>) -> CmdResult<Vec<SecretView>> {
    state.with(|v| {
        Ok(v.data
            .secrets
            .iter()
            .map(|s| SecretView {
                id: s.id.clone(),
                title: s.title.clone(),
                group: s.group.clone(),
                username: s.username.clone(),
                url: s.url.clone(),
                has_password: !s.password.is_empty(),
                has_notes: !s.notes.is_empty(),
                updated: s.updated,
            })
            .collect())
    })
}

/// Full entry including the password; only called when the user opens or reveals it.
#[tauri::command]
pub fn secret_get(state: State<'_, AppState>, id: String) -> CmdResult<Secret> {
    state.with(|v| v.data.secrets.iter().find(|s| s.id == id).cloned().ok_or_else(|| anyhow::anyhow!(msg!("record_not_found"))))
}

#[derive(Deserialize)]
pub struct SecretInput {
    id: Option<String>,
    title: String,
    group: String,
    username: String,
    /// None keeps the stored password.
    password: Option<String>,
    url: String,
    notes: String,
}

#[tauri::command]
pub fn secret_save(state: State<'_, AppState>, input: SecretInput) -> CmdResult<String> {
    let password = input.password.map(Zeroizing::new);
    state.with(|v| {
        if input.title.trim().is_empty() {
            anyhow::bail!(msg!("title_required"));
        }
        let pos = input.id.as_deref().and_then(|id| v.data.secrets.iter().position(|s| s.id == id));
        let mut s = pos.map(|i| v.data.secrets[i].clone()).unwrap_or_else(|| Secret { id: new_id(), ..Default::default() });
        s.title = input.title.trim().to_string();
        s.group = input.group.trim().to_string();
        s.username = input.username;
        if let Some(p) = &password {
            s.password = p.to_string();
        }
        s.url = input.url.trim().to_string();
        s.notes = input.notes;
        s.updated = now();
        let id = s.id.clone();
        match pos {
            Some(i) => v.data.secrets[i] = s,
            None => v.data.secrets.push(s),
        }
        v.save()?;
        Ok(id)
    })
}

#[tauri::command]
pub fn secret_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.with(|v| {
        v.data.secrets.retain(|s| s.id != id);
        v.save()
    })
}

/// Copies a field straight from the vault to the clipboard (the webview never
/// sees it) and wipes the clipboard after the configured delay if unchanged.
#[tauri::command]
pub fn secret_copy(app: AppHandle, state: State<'_, AppState>, id: String, field: String) -> CmdResult<u32> {
    let (text, secs) = state.with(|v| {
        let s = v.data.secrets.iter().find(|s| s.id == id).ok_or_else(|| anyhow::anyhow!(msg!("record_not_found")))?;
        let t = match field.as_str() {
            "password" => s.password.clone(),
            "username" => s.username.clone(),
            _ => anyhow::bail!(msg!("unknown_field")),
        };
        Ok((Zeroizing::new(t), v.data.settings.clipboard_clear_secs))
    })?;
    copy_and_clear(&app, text, secs)?;
    Ok(secs)
}

pub fn copy_and_clear(app: &AppHandle, text: Zeroizing<String>, secs: u32) -> CmdResult<()> {
    app.clipboard().write_text(text.as_str()).map_err(err)?;
    if secs > 0 {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(secs as u64)).await;
            if app.clipboard().read_text().is_ok_and(|cur| cur == *text) {
                let _ = app.clipboard().write_text("");
            }
        });
    }
    Ok(())
}

// =============== notes ===============

#[derive(Serialize)]
pub struct NoteView {
    id: String,
    title: String,
    preview: String,
    updated: u64,
}

#[tauri::command]
pub fn note_list(state: State<'_, AppState>) -> CmdResult<Vec<NoteView>> {
    state.with(|v| {
        let mut list: Vec<NoteView> = v
            .data
            .notes
            .iter()
            .map(|n| NoteView {
                id: n.id.clone(),
                title: n.title.clone(),
                preview: n.body.chars().take(90).collect::<String>().replace('\n', " "),
                updated: n.updated,
            })
            .collect();
        list.sort_by(|a, b| b.updated.cmp(&a.updated));
        Ok(list)
    })
}

#[tauri::command]
pub fn note_get(state: State<'_, AppState>, id: String) -> CmdResult<Note> {
    state.with(|v| v.data.notes.iter().find(|n| n.id == id).cloned().ok_or_else(|| anyhow::anyhow!(msg!("note_not_found"))))
}

#[tauri::command]
pub fn note_save(state: State<'_, AppState>, id: Option<String>, title: String, body: String) -> CmdResult<String> {
    let body = Zeroizing::new(body);
    state.with(|v| {
        let pos = id.as_deref().and_then(|id| v.data.notes.iter().position(|n| n.id == id));
        let n = Note { id: id.clone().filter(|_| pos.is_some()).unwrap_or_else(new_id), title: title.trim().to_string(), body: body.to_string(), updated: now() };
        let nid = n.id.clone();
        match pos {
            Some(i) => v.data.notes[i] = n,
            None => v.data.notes.push(n),
        }
        v.save()?;
        Ok(nid)
    })
}

#[tauri::command]
pub fn note_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.with(|v| {
        v.data.notes.retain(|n| n.id != id);
        v.save()
    })
}

// =============== git ===============

#[derive(Serialize)]
pub struct GitView {
    accounts: Vec<GitAccount>,
    ssh_command: Option<String>,
    windows_ssh: &'static str,
    windows_ssh_exists: bool,
    git_found: bool,
    conflicts: Vec<String>,
    config_path: String,
}

#[tauri::command]
pub fn git_list(state: State<'_, AppState>) -> CmdResult<GitView> {
    let accounts = state.with(|v| Ok(v.data.git_accounts.clone()))?;
    let aliases: Vec<String> = accounts.iter().map(|a| a.alias.clone()).collect();
    Ok(GitView {
        conflicts: crate::git::conflicts(&aliases).unwrap_or_default(),
        config_path: crate::git::ssh_dir().map(|d| d.join("config").display().to_string()).unwrap_or_default(),
        accounts,
        ssh_command: crate::git::ssh_command(),
        windows_ssh: crate::git::WINDOWS_SSH,
        windows_ssh_exists: std::path::Path::new(crate::git::WINDOWS_SSH).is_file(),
        git_found: crate::git::git_found(),
    })
}

/// Rewrites the SkyVault block in ~/.ssh/config from the vault.
fn apply_git(state: &AppState) -> CmdResult<()> {
    let aliases = state.with(|v| {
        Ok(v.data
            .git_accounts
            .iter()
            .filter_map(|a| {
                let k = v.data.keys.iter().find(|k| k.id == a.key_id)?;
                Some(crate::git::Alias {
                    alias: a.alias.clone(),
                    hostname: a.hostname.clone(),
                    port: a.port,
                    user: a.user.clone(),
                    public_key: k.public_key.clone(),
                })
            })
            .collect::<Vec<_>>())
    })?;
    let pipe = state.agent.lock().unwrap().pipe.clone().filter(|p| p != agent::DEFAULT_PIPE);
    crate::git::apply(&aliases, pipe.as_deref()).map_err(err)?;
    Ok(())
}

#[derive(Deserialize)]
pub struct GitInput {
    id: Option<String>,
    name: String,
    alias: String,
    hostname: String,
    port: u16,
    user: String,
    key_id: String,
}

#[tauri::command]
pub fn git_save(state: State<'_, AppState>, input: GitInput) -> CmdResult<String> {
    let id = state.with(|v| {
        let alias = input.alias.trim().to_string();
        if !crate::git::valid_alias(&alias) {
            anyhow::bail!(msg!("alias_invalid_chars"));
        }
        if v.data.git_accounts.iter().any(|a| a.alias == alias && Some(&a.id) != input.id.as_ref()) {
            anyhow::bail!(msg!("alias_taken"));
        }
        if !v.data.keys.iter().any(|k| k.id == input.key_id) {
            anyhow::bail!(msg!("select_key"));
        }
        let pos = input.id.as_deref().and_then(|id| v.data.git_accounts.iter().position(|a| a.id == id));
        let mut a = pos.map(|i| v.data.git_accounts[i].clone()).unwrap_or_else(|| GitAccount { id: new_id(), ..Default::default() });
        let hostname = if input.hostname.trim().is_empty() { "github.com".into() } else { input.hostname.trim().to_string() };
        if a.hostname != hostname || a.port != input.port {
            a.host_key_fp = None;
        }
        a.name = if input.name.trim().is_empty() { alias.clone() } else { input.name.trim().to_string() };
        a.alias = alias;
        a.hostname = hostname;
        a.port = if input.port == 0 { 22 } else { input.port };
        a.user = if input.user.trim().is_empty() { "git".into() } else { input.user.trim().to_string() };
        a.key_id = input.key_id;
        let id = a.id.clone();
        match pos {
            Some(i) => v.data.git_accounts[i] = a,
            None => v.data.git_accounts.push(a),
        }
        v.save()?;
        Ok(id)
    })?;
    apply_git(&state)?;
    Ok(id)
}

#[tauri::command]
pub fn git_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.with(|v| {
        v.data.git_accounts.retain(|a| a.id != id);
        v.save()
    })?;
    apply_git(&state)
}

#[tauri::command]
pub fn git_apply(state: State<'_, AppState>) -> CmdResult<()> {
    apply_git(&state)
}

#[tauri::command]
pub fn git_set_ssh_command(value: Option<String>) -> CmdResult<()> {
    crate::git::set_ssh_command(value.as_deref()).map_err(err)
}

/// Authenticates against the remote with the account's key (like `ssh -T git@github.com`).
#[tauri::command]
pub async fn git_test(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let spec = state.with(|v| {
        let a = v.data.git_accounts.iter().find(|a| a.id == id).ok_or_else(|| anyhow::anyhow!(msg!("account_not_found")))?;
        let k = v.data.keys.iter().find(|k| k.id == a.key_id).ok_or_else(|| anyhow::anyhow!(msg!("key_not_found")))?;
        Ok(ConnectSpec {
            host: a.hostname.clone(),
            port: a.port,
            user: a.user.clone(),
            auth: AuthSpec::Key(ssh::key_from_text(&k.private_key, k.passphrase.as_deref())?),
            known_fp: a.host_key_fp.clone(),
        })
    })?;
    let s = ssh::connect(&spec).await.map_err(err)?;
    drop(spec);
    let banner = ssh::shell_banner(&s).await.unwrap_or_default();
    ssh::disconnect(&s).await;
    Ok(if banner.trim().is_empty() { msg!("auth_ok") } else { banner.trim().to_string() })
}

// ---------- tunnel helpers ----------

/// Ports the server listens on plus container IPs, for the tunnel picker.
#[tauri::command]
pub async fn host_ports(state: State<'_, AppState>, id: String) -> CmdResult<crate::ports::PortScan> {
    let spec = state.connect_spec(&id)?;
    let s = ssh::connect(&spec).await.map_err(err)?;
    drop(spec);
    let res = ssh::exec(&s, crate::ports::SCRIPT).await;
    ssh::disconnect(&s).await;
    let (_, out) = res.map_err(err)?;
    Ok(crate::ports::parse(&out))
}

/// Opens a direct-tcpip channel to host:port, i.e. exactly what the tunnel will do.
#[tauri::command]
pub async fn host_probe(state: State<'_, AppState>, id: String, host: String, port: u16) -> CmdResult<()> {
    let spec = state.connect_spec(&id)?;
    let s = ssh::connect(&spec).await.map_err(err)?;
    drop(spec);
    let open = s.channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0);
    let r = match tokio::time::timeout(Duration::from_secs(8), open).await {
        Err(_) => Err(msg!("probe_timeout", host, port)),
        Ok(Err(e)) => Err(format!("{}: {e}", msg!("probe_failed", host, port))),
        Ok(Ok(ch)) => {
            let _ = ch.close().await;
            Ok(())
        }
    };
    ssh::disconnect(&s).await;
    r
}

#[derive(Serialize)]
pub struct LocalPort {
    port: u16,
    free: bool,
    /// Another saved tunnel already uses this local port.
    used_by: Option<String>,
}

fn os_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() && std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
}

/// Status of `port` on this PC and the nearest usable alternative.
#[tauri::command]
pub fn local_port_check(state: State<'_, AppState>, port: u16, exclude_id: Option<String>) -> CmdResult<(LocalPort, u16)> {
    let used = state.with(|v| {
        Ok(v.data
            .tunnels
            .iter()
            .filter(|t| exclude_id.as_deref() != Some(t.id.as_str()))
            .map(|t| (t.local_port, t.name.clone()))
            .collect::<Vec<_>>())
    })?;
    let used_by = |p: u16| used.iter().find(|(lp, _)| *lp == p).map(|(_, n)| n.clone());
    let me = LocalPort { port, free: os_port_free(port), used_by: used_by(port) };
    let ok = |p: u16| used_by(p).is_none() && os_port_free(p);
    // Privileged/high ports map to 10000+; others get +10000 (81 -> 10081, 9090 -> 19090).
    let start = if port < 1024 || port > 55535 { 10000 + port % 10000 } else { port + 10000 };
    let suggestion = if me.free && me.used_by.is_none() { port } else { (start..=65535).chain(10000..start).find(|&p| ok(p)).unwrap_or(port) };
    Ok((me, suggestion))
}

// ---------- ~/.ssh/config import ----------

#[derive(Serialize)]
pub struct ConfigEntryView {
    #[serde(flatten)]
    entry: crate::sshconfig::Entry,
    key_path: Option<String>,
    /// "ok" | "vault" (already imported) | "missing" | "locked" (passphrase / unreadable) | "none"
    key_status: &'static str,
    in_vault: bool,
    git_host: bool,
}

#[derive(Serialize)]
pub struct ConfigScan {
    path: String,
    entries: Vec<ConfigEntryView>,
}

fn home_dir() -> CmdResult<std::path::PathBuf> {
    Ok(crate::git::ssh_dir().map_err(err)?.parent().map(|p| p.to_path_buf()).unwrap_or_default())
}

fn read_config() -> CmdResult<(String, Vec<crate::sshconfig::Entry>)> {
    let path = crate::git::ssh_dir().map_err(err)?.join("config");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    Ok((path.display().to_string(), crate::sshconfig::parse(&crate::git::strip_block(&text), &user)))
}

type KeyFile = (Option<std::path::PathBuf>, Option<(Zeroizing<String>, ssh::ParsedKey)>);

/// First IdentityFile that exists, with its parsed key (None if unreadable or passphrase-protected).
fn entry_key(e: &crate::sshconfig::Entry, home: &std::path::Path) -> KeyFile {
    let path = e.identity_files.iter().map(|f| crate::sshconfig::expand(f, home)).find(|p| p.is_file());
    let parsed = path.as_ref().and_then(|p| {
        let text = Zeroizing::new(std::fs::read_to_string(p).ok()?);
        let k = ssh::parse_key(&text, None).ok()?;
        Some((text, k))
    });
    (path, parsed)
}

fn same_host(h: &crate::vault::Host, e: &crate::sshconfig::Entry) -> bool {
    h.host == e.hostname && h.port == e.port && h.username == e.user
}

#[tauri::command]
pub fn ssh_config_scan(state: State<'_, AppState>) -> CmdResult<ConfigScan> {
    let (path, entries) = read_config()?;
    let home = home_dir()?;
    let entries = state.with(|v| {
        Ok(entries
            .into_iter()
            .map(|e| {
                let (kp, parsed) = entry_key(&e, &home);
                let key_status = match (&kp, &parsed) {
                    (_, Some((_, k))) if v.data.keys.iter().any(|x| x.fingerprint == k.fingerprint) => "vault",
                    (_, Some(_)) => "ok",
                    (Some(_), None) => "locked",
                    (None, _) if e.identity_files.is_empty() => "none",
                    (None, _) => "missing",
                };
                let in_vault = v.data.hosts.iter().any(|h| same_host(h, &e));
                let git_host = ["github.com", "gitlab.com", "bitbucket.org"].contains(&e.hostname.to_ascii_lowercase().as_str());
                ConfigEntryView { key_path: kp.map(|p| p.display().to_string()), key_status, in_vault, git_host, entry: e }
            })
            .collect())
    })?;
    Ok(ConfigScan { path, entries })
}

#[derive(Serialize, Default)]
pub struct ImportReport {
    hosts: usize,
    keys: usize,
    tunnels: usize,
    notes: Vec<String>,
}

/// Imports the chosen aliases: their key file (deduplicated by fingerprint), the host and its LocalForwards.
#[tauri::command]
pub fn ssh_config_import(state: State<'_, AppState>, aliases: Vec<String>) -> CmdResult<ImportReport> {
    let (_, entries) = read_config()?;
    let home = home_dir()?;
    state.invalidate_agent();
    state.with(|v| {
        let mut r = ImportReport::default();
        for e in entries.iter().filter(|e| aliases.contains(&e.alias)) {
            if e.proxy_jump.is_some() {
                r.notes.push(msg!("import_proxyjump", e.alias));
                continue;
            }
            if v.data.hosts.iter().any(|h| same_host(h, e)) {
                r.notes.push(msg!("import_exists", e.alias));
                continue;
            }
            let (kp, parsed) = entry_key(e, &home);
            let key_id = match parsed {
                Some((_, k)) if v.data.keys.iter().any(|x| x.fingerprint == k.fingerprint) => {
                    v.data.keys.iter().find(|x| x.fingerprint == k.fingerprint).map(|x| x.id.clone())
                }
                Some((text, k)) => {
                    let id = new_id();
                    let name = kp.as_ref().and_then(|p| p.file_stem()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| e.alias.clone());
                    v.data.keys.push(crate::vault::SshKey {
                        id: id.clone(),
                        name,
                        private_key: text.trim().to_string(),
                        passphrase: None,
                        public_key: k.public_key,
                        fingerprint: k.fingerprint,
                        algorithm: k.algorithm,
                        created: now(),
                        agent: true,
                    });
                    r.keys += 1;
                    Some(id)
                }
                None => {
                    if let Some(p) = kp {
                        r.notes.push(msg!("import_key_unreadable", e.alias, p.display()));
                    }
                    None
                }
            };
            let host_id = new_id();
            v.data.hosts.push(crate::vault::Host {
                id: host_id.clone(),
                name: e.alias.clone(),
                group: "ssh config".into(),
                host: e.hostname.clone(),
                port: e.port,
                username: e.user.clone(),
                auth: if key_id.is_some() { "key".into() } else { "password".into() },
                key_id,
                ..Default::default()
            });
            r.hosts += 1;
            for f in &e.forwards {
                v.data.tunnels.push(crate::vault::Tunnel {
                    id: new_id(),
                    name: format!("{} {}", e.alias, f.remote_port),
                    host_id: host_id.clone(),
                    bind_addr: f.bind_addr.clone(),
                    local_port: f.local_port,
                    remote_host: f.remote_host.clone(),
                    remote_port: f.remote_port,
                    auto_start: false,
                });
                r.tunnels += 1;
            }
        }
        v.save()?;
        Ok(r)
    })
}
