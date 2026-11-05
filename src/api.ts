import { invoke } from "@tauri-apps/api/core";
import { localize } from "./i18n";

export type Host = {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  auth: "key" | "password";
  key_id: string | null;
  has_password: boolean;
  notes: string;
  host_key_fp: string | null;
};

export type Key = {
  id: string;
  name: string;
  public_key: string;
  fingerprint: string;
  algorithm: string;
  has_passphrase: boolean;
  created: number;
  agent: boolean;
};

export type Tunnel = {
  id: string;
  name: string;
  host_id: string;
  bind_addr: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  auto_start: boolean;
  running: boolean;
  active: number;
  last_error: string | null;
};

export type Settings = {
  auto_lock_minutes: number;
  close_on_lock: boolean;
  agent_enabled: boolean;
  agent_confirm: boolean;
  clipboard_clear_secs: number;
};

export type SecretView = {
  id: string;
  title: string;
  group: string;
  username: string;
  url: string;
  has_password: boolean;
  has_notes: boolean;
  updated: number;
};
export type Secret = { id: string; title: string; group: string; username: string; password: string; url: string; notes: string; updated: number };
export type SecretInput = { id?: string | null; title: string; group: string; username: string; password: string | null; url: string; notes: string };

export type NoteView = { id: string; title: string; preview: string; updated: number };
export type Note = { id: string; title: string; body: string; updated: number };

export type GitAccount = { id: string; name: string; alias: string; hostname: string; port: number; user: string; key_id: string; host_key_fp: string | null };
export type GitInput = { id?: string | null; name: string; alias: string; hostname: string; port: number; user: string; key_id: string };
export type GitView = {
  accounts: GitAccount[];
  ssh_command: string | null;
  windows_ssh: string;
  windows_ssh_exists: boolean;
  git_found: boolean;
  conflicts: string[];
  config_path: string;
};
export type AgentStatus = { running: boolean; pipe: string | null; default_pipe: boolean; error: string | null; keys: number };

export type Snapshot = { hosts: Host[]; keys: Key[]; tunnels: Tunnel[]; settings: Settings };

export type Status = { exists: boolean; unlocked: boolean; path: string };

export type HostInput = {
  id?: string | null;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  auth: "key" | "password";
  key_id: string | null;
  password: string | null;
  notes: string;
};

export type ListenPort = {
  port: number;
  addrs: string[];
  target: string;
  process: string;
  container: string | null;
  public: boolean;
  hint: string | null;
};
export type InnerTarget = { kind: "docker" | "incus"; name: string; ips: string[]; ports: number[] };
export type PortScan = { ports: ListenPort[]; targets: InnerTarget[]; limited: boolean };
export type LocalPort = { port: number; free: boolean; used_by: string | null };

export type Forward = { bind_addr: string; local_port: number; remote_host: string; remote_port: number };
export type ConfigEntry = {
  alias: string;
  hostname: string;
  port: number;
  user: string;
  identity_files: string[];
  forwards: Forward[];
  proxy_jump: string | null;
  key_path: string | null;
  key_status: "ok" | "vault" | "missing" | "locked" | "none";
  in_vault: boolean;
  git_host: boolean;
};
export type ConfigScan = { path: string; entries: ConfigEntry[] };
export type ImportReport = { hosts: number; keys: number; tunnels: number; notes: string[] };

export type TunnelInput = {
  id?: string | null;
  name: string;
  host_id: string;
  bind_addr: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  auto_start: boolean;
};

export const api = {
  status: () => invoke<Status>("vault_status"),
  create: (password: string) => invoke<void>("vault_create", { password }),
  unlock: (password: string) => invoke<void>("vault_unlock", { password }),
  lock: () => invoke<void>("vault_lock"),
  changePassword: (current: string, next: string) => invoke<void>("vault_change_password", { current, new: next }),
  touch: () => invoke<void>("touch"),
  snapshot: () => invoke<Snapshot>("snapshot"),
  saveSettings: (settings: Settings) => invoke<void>("settings_save", { settings }),

  saveHost: (input: HostInput) => invoke<string>("host_save", { input }),
  deleteHost: (id: string) => invoke<void>("host_delete", { id }),
  trustHost: (id: string, fingerprint: string) => invoke<void>("host_trust", { id, fingerprint }),
  testHost: (id: string) => invoke<string>("host_test", { id }),
  installKey: (id: string, keyId: string) => invoke<void>("host_install_key", { id, keyId }),

  importKey: (name: string, text: string | null, path: string | null, passphrase: string | null) =>
    invoke<string>("key_import", { name, text, path, passphrase }),
  generateKey: (name: string) => invoke<string>("key_generate", { name }),
  renameKey: (id: string, name: string) => invoke<void>("key_rename", { id, name }),
  deleteKey: (id: string) => invoke<void>("key_delete", { id }),

  saveTunnel: (input: TunnelInput) => invoke<string>("tunnel_save", { input }),
  hostPorts: (id: string) => invoke<PortScan>("host_ports", { id }),
  hostProbe: (id: string, host: string, port: number) => invoke<void>("host_probe", { id, host, port }),
  /** [status of `port`, nearest usable local port] */
  localPortCheck: (port: number, excludeId?: string | null) =>
    invoke<[LocalPort, number]>("local_port_check", { port, excludeId: excludeId ?? null }),
  sshConfigScan: () => invoke<ConfigScan>("ssh_config_scan"),
  sshConfigImport: (aliases: string[]) => invoke<ImportReport>("ssh_config_import", { aliases }),
  deleteTunnel: (id: string) => invoke<void>("tunnel_delete", { id }),
  startTunnel: (id: string) => invoke<void>("tunnel_start", { id }),
  stopTunnel: (id: string) => invoke<void>("tunnel_stop", { id }),

  agentStatus: () => invoke<AgentStatus>("agent_status"),
  agentAnswer: (id: string, allow: boolean) => invoke<void>("agent_answer", { id, allow }),
  keySetAgent: (id: string, on: boolean) => invoke<void>("key_set_agent", { id, on }),

  secretList: () => invoke<SecretView[]>("secret_list"),
  secretGet: (id: string) => invoke<Secret>("secret_get", { id }),
  secretSave: (input: SecretInput) => invoke<string>("secret_save", { input }),
  secretDelete: (id: string) => invoke<void>("secret_delete", { id }),
  secretCopy: (id: string, field: "password" | "username") => invoke<number>("secret_copy", { id, field }),

  noteList: () => invoke<NoteView[]>("note_list"),
  noteGet: (id: string) => invoke<Note>("note_get", { id }),
  noteSave: (id: string | null, title: string, body: string) => invoke<string>("note_save", { id, title, body }),
  noteDelete: (id: string) => invoke<void>("note_delete", { id }),

  gitList: () => invoke<GitView>("git_list"),
  gitSave: (input: GitInput) => invoke<string>("git_save", { input }),
  gitDelete: (id: string) => invoke<void>("git_delete", { id }),
  gitApply: () => invoke<void>("git_apply"),
  /** null removes core.sshCommand (git falls back to its bundled ssh). */
  gitSetSshCommand: (value: string | null) => invoke<void>("git_set_ssh_command", { value }),
  gitTest: (id: string) => invoke<string>("git_test", { id }),

  termOpen: (hostId: string, cols: number, rows: number) => invoke<string>("term_open", { hostId, cols, rows }),
  termWrite: (sid: string, data: string) => invoke<void>("term_write", { sid, data }),
  termResize: (sid: string, cols: number, rows: number) => invoke<void>("term_resize", { sid, cols, rows }),
  termClose: (sid: string) => invoke<void>("term_close", { sid }),
};

/** Error text in the UI language (backend messages arrive as codes, see i18n.localize). */
export function errText(e: unknown): string {
  return localize(typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
}
