import { createContext, useContext, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRight,
  Cable,
  Copy,
  ExternalLink,
  FileInput,
  FileKey,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Server,
  Sparkles,
  TerminalSquare,
  Trash2,
  Upload,
  Zap,
} from "lucide-react";
import { api, errText, Host, HostInput, Snapshot, Tunnel, TunnelInput } from "./api";
import { Button, cx, Empty, Field, Input, Modal, Select, Textarea, Toggle, useUi } from "./ui";
import { AgentSettings } from "./Views2";
import { LangSelect, localize, useT } from "./i18n";
import { SshConfigImport, TunnelForm } from "./Tunnels";

export type VaultCtx = {
  snap: Snapshot;
  refresh: () => Promise<void>;
  /** Runs an SSH action; on an unknown/changed host key asks the user and retries. */
  withTrust: <T>(hostId: string, fn: () => Promise<T>) => Promise<T>;
  openTerminal: (host: Host) => void;
};
export const Vault = createContext<VaultCtx>(null!);
export const useVault = () => useContext(Vault);

export function PageHeader({ title, sub, children }: { title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100">{title}</h2>
        <p className="mt-1 text-sm text-zinc-500">{sub}</p>
      </div>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-white/[0.06] bg-white/[0.025] p-4", className)}>{children}</div>;
}

// =============== Hosts ===============

const emptyHost: HostInput = { name: "", group: "", host: "", port: 22, username: "root", auth: "key", key_id: null, password: null, notes: "" };

export function HostsView() {
  const { snap, refresh, withTrust, openTerminal } = useVault();
  const { toast, confirm } = useUi();
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<HostInput | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [install, setInstall] = useState<Host | null>(null);
  const [importing, setImporting] = useState(false);
  const { t } = useT();

  const groups = useMemo(() => {
    const f = snap.hosts.filter((h) => `${h.name} ${h.host} ${h.username} ${h.group}`.toLowerCase().includes(q.toLowerCase()));
    const m = new Map<string, Host[]>();
    const general = t("common.general");
    for (const h of f) m.set(h.group || general, [...(m.get(h.group || general) ?? []), h]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [snap.hosts, q, t]);

  const test = async (h: Host) => {
    setBusy(h.id);
    try {
      const out = await withTrust(h.id, () => api.testHost(h.id));
      toast(`✓ ${h.name}: ${out || t("hosts.testOk")}`);
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const del = async (h: Host) => {
    if (!(await confirm({ title: t("hosts.deleteTitle"), body: t("common.deleteConfirm", { name: h.name }), ok: t("common.delete"), danger: true }))) return;
    try {
      await api.deleteHost(h.id);
      await refresh();
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  return (
    <div>
      <PageHeader title={t("nav.hosts")} sub={t("hosts.sub")}>
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-500" />
          <Input className="w-56 pl-8" placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button onClick={() => setImporting(true)} title={t("hosts.importTitle")}>
          <FileInput size={16} /> {t("hosts.import")}
        </Button>
        <Button variant="primary" onClick={() => setEdit({ ...emptyHost, key_id: snap.keys[0]?.id ?? null })}>
          <Plus size={16} /> {t("hosts.new")}
        </Button>
      </PageHeader>

      {snap.hosts.length === 0 ? (
        <Empty
          icon={<Server size={36} />}
          title={t("hosts.empty")}
          text={t("hosts.emptyText")}
          action={
            <Button variant="primary" onClick={() => setEdit({ ...emptyHost, key_id: snap.keys[0]?.id ?? null })}>
              <Plus size={16} /> {t("hosts.add")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map(([g, hosts]) => (
            <div key={g}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{g}</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">
                {hosts.map((h) => {
                  const key = snap.keys.find((k) => k.id === h.key_id);
                  return (
                    <Card key={h.id} className="group transition hover:border-sky-500/30 hover:bg-white/[0.04]">
                      <div className="flex items-start gap-3" onDoubleClick={() => openTerminal(h)}>
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500/20 to-indigo-500/20 text-sky-300">
                          <Server size={18} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-zinc-100">{h.name}</div>
                          <div className="truncate font-mono text-xs text-zinc-500">
                            {h.username}@{h.host}
                            {h.port !== 22 ? `:${h.port}` : ""}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-400">
                              {h.auth === "key" ? `🔑 ${key?.name ?? t("hosts.noKey")}` : `🔒 ${t("hosts.passwordAuth")}`}
                            </span>
                            {!h.host_key_fp ? (
                              <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300">{t("hosts.unverified")}</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-1.5 border-t border-white/[0.05] pt-3">
                        <Button size="sm" variant="primary" onClick={() => openTerminal(h)}>
                          <TerminalSquare size={14} /> {t("hosts.connect")}
                        </Button>
                        <Button size="sm" loading={busy === h.id} onClick={() => test(h)}>
                          <Zap size={14} /> {t("common.test")}
                        </Button>
                        <div className="flex-1" />
                        <Button size="sm" variant="ghost" title={t("hosts.installKey")} onClick={() => setInstall(h)}>
                          <Upload size={14} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t("common.edit")}
                          onClick={() => setEdit({ ...h, password: null })}
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button size="sm" variant="ghost" title={t("common.delete")} onClick={() => del(h)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {edit ? <HostForm init={edit} onClose={() => setEdit(null)} /> : null}
      {importing ? <SshConfigImport onClose={() => setImporting(false)} /> : null}
      {install ? <InstallKey host={install} onClose={() => setInstall(null)} /> : null}
    </div>
  );
}

function HostForm({ init, onClose }: { init: HostInput & { has_password?: boolean }; onClose: () => void }) {
  const { snap, refresh } = useVault();
  const { toast } = useUi();
  const [f, setF] = useState<HostInput>(init);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const groups = [...new Set(snap.hosts.map((h) => h.group).filter(Boolean))];
  const { t } = useT();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.saveHost({ ...f, port: Number(f.port) || 22 });
      await refresh();
      toast(t("hostForm.saved"));
      onClose();
    } catch (err) {
      toast(errText(err), "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={init.id ? t("hostForm.edit") : t("hosts.new")} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("common.name")}>
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="web-01" autoFocus />
          </Field>
          <Field label={t("common.group")}>
            <Input value={f.group} onChange={(e) => set("group", e.target.value)} placeholder={t("hostForm.groupPh")} list="groups" />
            <datalist id="groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_90px] gap-3">
          <Field label={t("hostForm.address")}>
            <Input value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="203.0.113.10" required />
          </Field>
          <Field label={t("common.port")}>
            <Input type="number" value={f.port} onChange={(e) => set("port", Number(e.target.value))} />
          </Field>
        </div>
        <Field label={t("common.user")}>
          <Input value={f.username} onChange={(e) => set("username", e.target.value)} required />
        </Field>
        <Field label={t("hostForm.auth")}>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/30 p-1">
            {(["key", "password"] as const).map((a) => (
              <button
                type="button"
                key={a}
                onClick={() => set("auth", a)}
                className={cx(
                  "h-8 rounded-md text-sm transition cursor-pointer",
                  f.auth === a ? "bg-sky-500/20 text-sky-200" : "text-zinc-400 hover:text-zinc-200",
                )}
              >
                {a === "key" ? t("hostForm.sshKey") : t("common.password")}
              </button>
            ))}
          </div>
        </Field>
        {f.auth === "key" ? (
          <Field label={t("common.key")} hint={snap.keys.length === 0 ? t("hostForm.addKeyFirst") : undefined}>
            <Select value={f.key_id ?? ""} onChange={(e) => set("key_id", e.target.value || null)}>
              <option value="">{t("common.choose")}</option>
              {snap.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.algorithm})
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={t("common.password")} hint={init.has_password ? t("hostForm.keepPassword") : undefined}>
            <Input
              type="password"
              value={f.password ?? ""}
              onChange={(e) => set("password", e.target.value)}
              placeholder={init.has_password ? "••••••••" : ""}
            />
          </Field>
        )}
        <Field label={t("common.notes")}>
          <Textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} className="font-sans text-sm" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={saving}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function InstallKey({ host, onClose }: { host: Host; onClose: () => void }) {
  const { snap, withTrust } = useVault();
  const { toast } = useUi();
  const [keyId, setKeyId] = useState(snap.keys[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const { t, tn } = useT();
  const go = async () => {
    setBusy(true);
    try {
      await withTrust(host.id, () => api.installKey(host.id, keyId));
      toast(t("install.done"));
      onClose();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("install.title", { name: host.name })} onClose={onClose} width="max-w-md">
      <p className="mb-4 text-sm text-zinc-400">{tn("install.body", { file: <code className="text-sky-300">~/.ssh/authorized_keys</code> })}</p>
      <Select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
        {snap.keys.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name} ({k.algorithm})
          </option>
        ))}
      </Select>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" loading={busy} disabled={!keyId} onClick={go}>
          {t("install.upload")}
        </Button>
      </div>
    </Modal>
  );
}

// =============== Tunnels ===============

export function TunnelsView() {
  const { snap, refresh, withTrust } = useVault();
  const { toast, confirm } = useUi();
  const [edit, setEdit] = useState<TunnelInput | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const hostName = (id: string) => snap.hosts.find((h) => h.id === id)?.name ?? "?";
  // `t` is the loop variable for tunnels below, so the translator is `tr` here.
  const { t: tr } = useT();

  const toggle = async (t: Tunnel, on: boolean) => {
    setBusy(t.id);
    try {
      if (on) await withTrust(t.host_id, () => api.startTunnel(t.id));
      else await api.stopTunnel(t.id);
      await refresh();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const del = async (t: Tunnel) => {
    if (!(await confirm({ title: tr("tunnels.deleteTitle"), body: tr("common.deleteConfirm", { name: t.name }), ok: tr("common.delete"), danger: true }))) return;
    await api.deleteTunnel(t.id);
    await refresh();
  };

  const newTunnel = () =>
    setEdit({ name: "", host_id: snap.hosts[0]?.id ?? "", bind_addr: "127.0.0.1", local_port: 0, remote_host: "127.0.0.1", remote_port: 0, auto_start: false });

  return (
    <div>
      <PageHeader title={tr("nav.tunnels")} sub={tr("tunnels.sub")}>
        <Button variant="primary" onClick={newTunnel} disabled={snap.hosts.length === 0}>
          <Plus size={16} /> {tr("tunnels.new")}
        </Button>
      </PageHeader>

      {snap.tunnels.length === 0 ? (
        <Empty
          icon={<Cable size={36} />}
          title={tr("tunnels.empty")}
          text={snap.hosts.length ? tr("tunnels.emptyText") : tr("tunnels.addHostFirst")}
          action={snap.hosts.length ? <Button variant="primary" onClick={newTunnel}><Plus size={16} /> {tr("tunnels.add")}</Button> : undefined}
        />
      ) : (
        <div className="space-y-2">
          {snap.tunnels.map((t) => (
            <Card key={t.id} className={cx("flex items-center gap-4", t.running && "border-emerald-500/20 bg-emerald-500/[0.03]")}>
              <Toggle checked={t.running} disabled={busy === t.id} onChange={(v) => toggle(t, v)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-100">{t.name}</span>
                  {t.running ? (
                    <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                      <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                      {tr("tunnels.active", { n: t.active })}
                    </span>
                  ) : null}
                  {t.auto_start ? <span className="rounded bg-white/[0.06] px-1.5 text-[10px] text-zinc-400">{tr("tunnels.auto")}</span> : null}
                </div>
                <div className="mt-1 flex items-center gap-1.5 font-mono text-xs text-zinc-500">
                  <span className="text-zinc-300">
                    {t.bind_addr}:{t.local_port}
                  </span>
                  <ArrowRight size={12} />
                  <span className="text-sky-300">{hostName(t.host_id)}</span>
                  <ArrowRight size={12} />
                  <span>
                    {t.remote_host}:{t.remote_port}
                  </span>
                </div>
                {t.last_error ? <div className="mt-1 text-xs text-red-300">{localize(t.last_error)}</div> : null}
              </div>
              {busy === t.id ? <span className="size-4 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" /> : null}
              <Button size="sm" variant="ghost" title={tr("tunnels.openBrowser")} disabled={!t.running} onClick={() => openUrl(`http://localhost:${t.local_port}`)}>
                <ExternalLink size={14} />
              </Button>
              <Button size="sm" variant="ghost" title={tr("common.edit")} disabled={t.running} onClick={() => setEdit(t)}>
                <Pencil size={14} />
              </Button>
              <Button size="sm" variant="ghost" title={tr("common.delete")} onClick={() => del(t)}>
                <Trash2 size={14} />
              </Button>
            </Card>
          ))}
        </div>
      )}
      {edit ? <TunnelForm init={edit} onClose={() => setEdit(null)} /> : null}
    </div>
  );
}


// =============== Keys ===============

export function KeysView() {
  const { snap, refresh } = useVault();
  const { toast, confirm } = useUi();
  const [mode, setMode] = useState<"import" | "generate" | null>(null);
  const { t, locale } = useT();

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast(t("keys.copied"));
  };
  const del = async (id: string, name: string) => {
    if (!(await confirm({ title: t("keys.deleteTitle"), body: t("keys.deleteBody", { name }), ok: t("common.delete"), danger: true }))) return;
    try {
      await api.deleteKey(id);
      await refresh();
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  return (
    <div>
      <PageHeader title={t("nav.keys")} sub={t("keys.sub")}>
        <Button onClick={() => setMode("generate")}>
          <Sparkles size={16} /> {t("keys.generate")}
        </Button>
        <Button variant="primary" onClick={() => setMode("import")}>
          <Plus size={16} /> {t("common.import")}
        </Button>
      </PageHeader>

      {snap.keys.length === 0 ? (
        <Empty icon={<KeyRound size={36} />} title={t("keys.empty")} text={t("keys.emptyText")} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
          {snap.keys.map((k) => {
            const used = snap.hosts.filter((h) => h.key_id === k.id).length;
            return (
              <Card key={k.id}>
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-300">
                    <FileKey size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-zinc-100">{k.name}</span>
                      <span className="rounded bg-white/[0.06] px-1.5 text-[10px] text-zinc-400">{k.algorithm}</span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500" title={k.fingerprint}>
                      {k.fingerprint}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-600">
                      {t("keys.usedOn", { n: used })}
                      {k.has_passphrase ? ` · ${t("keys.withPassphrase")}` : ""} · {new Date(k.created * 1000).toLocaleDateString(locale)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex gap-1.5 border-t border-white/[0.05] pt-3">
                  <Button size="sm" onClick={() => copy(k.public_key)}>
                    <Copy size={14} /> {t("keys.publicKey")}
                  </Button>
                  <label className="ml-2 flex items-center gap-2 text-[11px] text-zinc-400" title={t("keys.agentTitle")}>
                    <Toggle
                      checked={k.agent}
                      onChange={async (v) => {
                        await api.keySetAgent(k.id, v);
                        await refresh();
                      }}
                    />
                    agent
                  </label>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t("keys.rename")}
                    onClick={async () => {
                      const n = prompt(t("keys.newName"), k.name);
                      if (n) {
                        await api.renameKey(k.id, n);
                        await refresh();
                      }
                    }}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" title={t("common.delete")} onClick={() => del(k.id, k.name)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {mode === "import" ? <ImportKey onClose={() => setMode(null)} /> : null}
      {mode === "generate" ? <GenerateKey onClose={() => setMode(null)} /> : null}
    </div>
  );
}

function ImportKey({ onClose }: { onClose: () => void }) {
  const { refresh } = useVault();
  const { toast } = useUi();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const { t } = useT();

  const pick = async () => {
    const p = await openDialog({ multiple: false, directory: false, title: t("importKey.pick") });
    if (typeof p === "string") {
      setPath(p);
      setText("");
      if (!name) setName(p.split(/[\\/]/).pop() ?? "");
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.importKey(name, text || null, path, pass || null);
      await refresh();
      toast(t("importKey.added"));
      onClose();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("importKey.title")} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t("common.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy-key" autoFocus />
        </Field>
        <Field label={t("importKey.fromFile")} hint={t("importKey.fromFileHint")}>
          <div className="flex gap-2">
            <Input readOnly value={path ?? ""} placeholder={t("importKey.noFile")} />
            <Button type="button" onClick={pick}>
              {t("importKey.choose")}
            </Button>
          </div>
        </Field>
        <Field label={t("importKey.paste")}>
          <Textarea
            rows={5}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPath(null);
            }}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          />
        </Field>
        <Field label={t("importKey.passphrase")}>
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        <p className="text-[11px] text-amber-300/80">{t("importKey.deleteHint")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!text && !path} onClick={save}>
            {t("common.import")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function GenerateKey({ onClose }: { onClose: () => void }) {
  const { refresh } = useVault();
  const { toast } = useUi();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const { t } = useT();
  const save = async () => {
    setBusy(true);
    try {
      await api.generateKey(name);
      await refresh();
      toast(t("genKey.done"));
      onClose();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("genKey.title")} onClose={onClose} width="max-w-md">
      <Field label={t("common.name")} hint={t("genKey.hint")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="laptop-2026" autoFocus />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
          {t("common.generate")}
        </Button>
      </div>
    </Modal>
  );
}

// =============== Settings ===============

export function SettingsView({ vaultPath }: { vaultPath: string }) {
  const { snap, refresh } = useVault();
  const { toast } = useUi();
  const [s, setS] = useState(snap.settings);
  const [cur, setCur] = useState("");
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [busy, setBusy] = useState(false);
  const { t } = useT();

  const saveSettings = async (next: typeof s) => {
    setS(next);
    try {
      await api.saveSettings(next);
      await refresh();
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  const changePw = async () => {
    if (n1 !== n2) return toast(t("settings.mismatch"), "err");
    setBusy(true);
    try {
      await api.changePassword(cur, n1);
      setCur("");
      setN1("");
      setN2("");
      toast(t("settings.changed"));
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <PageHeader title={t("nav.settings")} sub={t("settings.sub")} />
      <div className="space-y-4">
        <Card className="flex items-center justify-between">
          <div>
            <div className="font-medium text-zinc-100">{t("settings.language")}</div>
            <div className="text-[11px] text-zinc-500">{t("settings.languageHint")}</div>
          </div>
          <LangSelect />
        </Card>

        <Card>
          <div className="mb-4 font-medium text-zinc-100">{t("settings.autoLock")}</div>
          <div className="flex items-center justify-between">
            <div className="text-sm text-zinc-400">{t("settings.lockAfter")}</div>
            <Select
              className="w-40! shrink-0"
              value={s.auto_lock_minutes}
              onChange={(e) => saveSettings({ ...s, auto_lock_minutes: Number(e.target.value) })}
            >
              {[1, 5, 10, 15, 30, 60, 120].map((m) => (
                <option key={m} value={m}>
                  {t("settings.minutes", { n: m })}
                </option>
              ))}
            </Select>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm text-zinc-200">{t("settings.closeTunnels")}</div>
              <div className="text-[11px] text-zinc-500">{t("settings.closeTunnelsHint")}</div>
            </div>
            <Toggle checked={s.close_on_lock} onChange={(v) => saveSettings({ ...s, close_on_lock: v })} />
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-zinc-400">{t("settings.clipboard")}</div>
            <Select
              className="w-40! shrink-0"
              value={s.clipboard_clear_secs}
              onChange={(e) => saveSettings({ ...s, clipboard_clear_secs: Number(e.target.value) })}
            >
              {[10, 20, 30, 60, 120, 0].map((m) => (
                <option key={m} value={m}>
                  {m ? t("settings.afterSecs", { n: m }) : t("settings.never")}
                </option>
              ))}
            </Select>
          </div>
        </Card>

        <Card>
          <div className="mb-4 font-medium text-zinc-100">{t("settings.agentCard")}</div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm text-zinc-200">{t("settings.agent")}</div>
              <div className="text-[11px] text-zinc-500">{t("settings.agentHint")}</div>
            </div>
            <Toggle checked={s.agent_enabled} onChange={(v) => saveSettings({ ...s, agent_enabled: v })} />
          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm text-zinc-200">{t("settings.confirm")}</div>
              <div className="text-[11px] text-zinc-500">{t("settings.confirmHint")}</div>
            </div>
            <Toggle checked={s.agent_confirm} onChange={(v) => saveSettings({ ...s, agent_confirm: v })} />
          </div>
          <AgentSettings key={String(s.agent_enabled)} />
        </Card>

        <Card>
          <div className="mb-4 font-medium text-zinc-100">{t("settings.changeMaster")}</div>
          <div className="space-y-3">
            <Input type="password" placeholder={t("settings.current")} value={cur} onChange={(e) => setCur(e.target.value)} />
            <div className="grid grid-cols-2 gap-3">
              <Input type="password" placeholder={t("settings.new")} value={n1} onChange={(e) => setN1(e.target.value)} />
              <Input type="password" placeholder={t("settings.newRepeat")} value={n2} onChange={(e) => setN2(e.target.value)} />
            </div>
            <div className="flex justify-end">
              <Button variant="primary" loading={busy} disabled={!cur || !n1} onClick={changePw}>
                {t("settings.change")}
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <div className="mb-2 font-medium text-zinc-100">{t("settings.vaultFile")}</div>
          <div className="break-all font-mono text-xs text-zinc-400">{vaultPath}</div>
          <p className="mt-2 text-[11px] text-zinc-500">{t("settings.vaultFileHint")}</p>
        </Card>
      </div>
    </div>
  );
}
