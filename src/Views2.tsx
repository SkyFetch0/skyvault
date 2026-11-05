import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Check,
  Copy,
  Dices,
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  KeyRound,
  Lock,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Trash2,
  User,
  Wrench,
  Zap,
} from "lucide-react";
import { api, errText, GitInput, GitView, Note, NoteView, SecretInput, SecretView } from "./api";
import { Button, cx, Empty, Field, Input, Modal, Select, Textarea, useUi } from "./ui";
import { Card, PageHeader, useVault } from "./Views";
import { localize, useT } from "./i18n";

function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const reload = useCallback(() => fn().then(setData), [fn]);
  useEffect(() => {
    reload();
  }, [reload]);
  return [data, reload] as const;
}

// =============== password generator ===============

export function generatePassword(len: number, symbols: boolean) {
  const sets = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", ...(symbols ? ["!@#$%^&*-_=+?.:"] : [])];
  const all = sets.join("");
  const pick = (chars: string) => {
    // Rejection sampling avoids modulo bias.
    const max = 256 - (256 % chars.length);
    const b = new Uint8Array(1);
    do crypto.getRandomValues(b);
    while (b[0] >= max);
    return chars[b[0] % chars.length];
  };
  for (;;) {
    const p = Array.from({ length: len }, () => pick(all)).join("");
    if (sets.every((s) => [...p].some((c) => s.includes(c)))) return p;
  }
}

// =============== Secrets ===============

const emptySecret: SecretInput = { title: "", group: "", username: "", password: "", url: "", notes: "" };

export function SecretsView() {
  const { toast, confirm } = useUi();
  const [list, reload] = useLoad(api.secretList);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<SecretInput | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const { t } = useT();

  const groups = useMemo(() => {
    const f = (list ?? []).filter((s) => `${s.title} ${s.username} ${s.url} ${s.group}`.toLowerCase().includes(q.toLowerCase()));
    const m = new Map<string, SecretView[]>();
    const general = t("common.general");
    for (const s of f.sort((a, b) => a.title.localeCompare(b.title))) m.set(s.group || general, [...(m.get(s.group || general) ?? []), s]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list, q, t]);

  const copy = async (s: SecretView, field: "password" | "username") => {
    try {
      const secs = await api.secretCopy(s.id, field);
      toast(t(field === "password" ? "secrets.copiedPassword" : "secrets.copiedUser") + (secs ? t("secrets.clearIn", { n: secs }) : ""));
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  const reveal = async (s: SecretView) => {
    if (revealed[s.id]) return setRevealed(({ [s.id]: _, ...r }) => r);
    const full = await api.secretGet(s.id);
    setRevealed((r) => ({ ...r, [s.id]: full.password }));
    setTimeout(() => setRevealed(({ [s.id]: _, ...r }) => r), 15000);
  };

  const del = async (s: SecretView) => {
    if (!(await confirm({ title: t("secrets.deleteTitle"), body: t("common.deleteConfirm", { name: s.title }), ok: t("common.delete"), danger: true }))) return;
    await api.secretDelete(s.id);
    reload();
  };

  if (!list) return null;
  return (
    <div>
      <PageHeader title={t("nav.secrets")} sub={t("secrets.sub")}>
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-500" />
          <Input className="w-56 pl-8" placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button variant="primary" onClick={() => setEdit({ ...emptySecret })}>
          <Plus size={16} /> {t("secrets.new")}
        </Button>
      </PageHeader>

      {list.length === 0 ? (
        <Empty
          icon={<Lock size={36} />}
          title={t("secrets.empty")}
          text={t("secrets.emptyText")}
          action={
            <Button variant="primary" onClick={() => setEdit({ ...emptySecret })}>
              <Plus size={16} /> {t("secrets.add")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map(([g, items]) => (
            <div key={g}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{g}</div>
              <div className="overflow-hidden rounded-xl border border-white/[0.06]">
                {items.map((s, i) => (
                  <div
                    key={s.id}
                    className={cx("flex items-center gap-3 bg-white/[0.02] px-4 py-3 hover:bg-white/[0.04]", i > 0 && "border-t border-white/[0.05]")}
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-300">
                      {s.url ? <Globe size={16} /> : <Lock size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-zinc-100">{s.title}</div>
                      <div className="flex gap-3 truncate text-xs text-zinc-500">
                        {s.username ? <span>{s.username}</span> : null}
                        {s.url ? (
                          <button className="truncate text-sky-400/80 hover:text-sky-300 cursor-pointer" onClick={() => openUrl(/^https?:/.test(s.url) ? s.url : `https://${s.url}`)}>
                            {s.url}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {s.has_password ? (
                      <code className="hidden w-48 truncate text-right font-mono text-xs text-zinc-400 lg:block">{revealed[s.id] ?? "••••••••••"}</code>
                    ) : null}
                    <div className="flex gap-1">
                      {s.username ? (
                        <Button size="sm" variant="ghost" title={t("secrets.copyUser")} onClick={() => copy(s, "username")}>
                          <User size={14} />
                        </Button>
                      ) : null}
                      {s.has_password ? (
                        <>
                          <Button size="sm" variant="ghost" title={t("secrets.reveal")} onClick={() => reveal(s)}>
                            {revealed[s.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </Button>
                          <Button size="sm" title={t("secrets.copyPassword")} onClick={() => copy(s, "password")}>
                            <Copy size={14} /> {t("common.password")}
                          </Button>
                        </>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t("common.edit")}
                        onClick={async () => {
                          const full = await api.secretGet(s.id);
                          setEdit(full);
                        }}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button size="sm" variant="ghost" title={t("common.delete")} onClick={() => del(s)}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {edit ? (
        <SecretForm
          init={edit}
          groups={[...new Set(list.map((s) => s.group).filter(Boolean))]}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function SecretForm({ init, groups, onClose, onSaved }: { init: SecretInput; groups: string[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const [f, setF] = useState(init);
  const [show, setShow] = useState(!init.id);
  const [len, setLen] = useState(24);
  const [sym, setSym] = useState(true);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof SecretInput>(k: K, v: SecretInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const { t } = useT();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.secretSave(f);
      toast(t("common.saved"));
      onSaved();
    } catch (err) {
      toast(errText(err), "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={init.id ? t("secrets.editTitle") : t("secrets.newTitle")} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("secrets.titleField")}>
            <Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder={t("secrets.titlePh")} autoFocus required />
          </Field>
          <Field label={t("common.group")}>
            <Input value={f.group} onChange={(e) => set("group", e.target.value)} placeholder="web-01" list="secret-groups" />
            <datalist id="secret-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label={t("secrets.username")}>
          <Input value={f.username} onChange={(e) => set("username", e.target.value)} placeholder="admin" />
        </Field>
        <Field label={t("common.password")}>
          <div className="flex gap-2">
            <Input
              type={show ? "text" : "password"}
              className="font-mono"
              value={f.password ?? ""}
              onChange={(e) => set("password", e.target.value)}
            />
            <Button type="button" variant="ghost" onClick={() => setShow(!show)} title={t("secrets.showHide")}>
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-3 rounded-lg bg-black/20 px-3 py-2 text-xs text-zinc-400">
            <Dices size={14} />
            <input type="range" min={8} max={64} value={len} onChange={(e) => setLen(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="w-6 text-right tabular-nums">{len}</span>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={sym} onChange={(e) => setSym(e.target.checked)} className="accent-sky-500" /> {t("secrets.symbols")}
            </label>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                set("password", generatePassword(len, sym));
                setShow(true);
              }}
            >
              {t("common.generate")}
            </Button>
          </div>
        </Field>
        <Field label="URL">
          <Input value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="http://localhost:9090" />
        </Field>
        <Field label={t("common.notes")}>
          <Textarea rows={3} value={f.notes} onChange={(e) => set("notes", e.target.value)} className="font-sans text-sm" />
        </Field>
        <div className="flex justify-end gap-2">
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

// =============== Notes ===============

export function NotesView() {
  const { toast, confirm } = useUi();
  const [list, reload] = useLoad(api.noteList);
  const [q, setQ] = useState("");
  const [cur, setCur] = useState<Note | null>(null);
  const [state, setState] = useState<"saved" | "dirty" | "saving">("saved");
  const timer = useRef<number>(undefined);
  const latest = useRef<Note | null>(null);
  latest.current = cur;
  const { t, locale } = useT();

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const n = latest.current;
    if (!n) return;
    setState("saving");
    try {
      const id = await api.noteSave(n.id || null, n.title || t("common.untitled"), n.body);
      if (!n.id) setCur((c) => (c && !c.id ? { ...c, id } : c));
      setState("saved");
      reload();
    } catch (e) {
      toast(errText(e), "err");
      setState("dirty");
    }
  }, [reload, toast, t]);

  // Save pending edits when leaving the page.
  useEffect(() => () => void (state === "dirty" && flush()), [state, flush]);

  const change = (patch: Partial<Note>) => {
    setCur((c) => (c ? { ...c, ...patch } : c));
    setState("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  };

  const open = async (id: string) => {
    if (state === "dirty") await flush();
    setCur(await api.noteGet(id));
    setState("saved");
  };

  const create = async () => {
    if (state === "dirty") await flush();
    setCur({ id: "", title: "", body: "", updated: Date.now() / 1000 });
  };

  const del = async () => {
    if (!cur) return;
    if (!(await confirm({ title: t("notes.deleteTitle"), body: t("common.deleteConfirm", { name: cur.title || t("common.untitled") }), ok: t("common.delete"), danger: true }))) return;
    if (cur.id) await api.noteDelete(cur.id);
    setCur(null);
    setState("saved");
    reload();
  };

  const filtered = (list ?? []).filter((n) => `${n.title} ${n.preview}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <PageHeader title={t("nav.notes")} sub={t("notes.sub")}>
        <Button variant="primary" onClick={create}>
          <Plus size={16} /> {t("notes.new")}
        </Button>
      </PageHeader>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex w-72 shrink-0 flex-col rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <div className="relative border-b border-white/[0.05] p-2">
            <Search size={14} className="absolute left-4 top-[18px] text-zinc-500" />
            <Input className="h-8 pl-8" placeholder={t("notes.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {filtered.length === 0 ? <div className="p-4 text-center text-sm text-zinc-600">{t("notes.none")}</div> : null}
            {filtered.map((n: NoteView) => (
              <button
                key={n.id}
                onClick={() => open(n.id)}
                className={cx(
                  "block w-full rounded-lg px-3 py-2 text-left transition cursor-pointer",
                  cur?.id === n.id ? "bg-sky-500/15" : "hover:bg-white/[0.04]",
                )}
              >
                <div className="truncate text-sm font-medium text-zinc-200">{n.title || t("common.untitled")}</div>
                <div className="truncate text-xs text-zinc-500">{n.preview || "—"}</div>
                <div className="mt-0.5 text-[10px] text-zinc-600">{new Date(n.updated * 1000).toLocaleString(locale)}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-white/[0.06] bg-white/[0.02]">
          {cur ? (
            <>
              <div className="flex items-center gap-3 border-b border-white/[0.05] px-4 py-2">
                <input
                  value={cur.title}
                  onChange={(e) => change({ title: e.target.value })}
                  placeholder={t("secrets.titleField")}
                  autoFocus={!cur.id}
                  className="h-9 flex-1 bg-transparent text-lg font-semibold text-zinc-100 outline-none placeholder:text-zinc-600"
                />
                <span className="flex items-center gap-1 text-[11px] text-zinc-500">
                  {state === "saved" ? <Check size={12} className="text-emerald-400" /> : null}
                  {t(state === "saved" ? "notes.saved" : state === "saving" ? "notes.saving" : "notes.editing")}
                </span>
                <Button size="sm" variant="ghost" title={t("common.delete")} onClick={del}>
                  <Trash2 size={14} />
                </Button>
              </div>
              <textarea
                value={cur.body}
                onChange={(e) => change({ body: e.target.value })}
                onBlur={() => state === "dirty" && flush()}
                spellCheck={false}
                placeholder={t("notes.bodyPh")}
                className="flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600"
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-zinc-600">
              <NotebookPen size={36} />
              <div className="mt-2 text-sm">{t("notes.pick")}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// =============== Git ===============

type SshMode = "windows" | "bundled" | "custom";

/** core.sshCommand editor: Windows OpenSSH (reaches the agent), git's bundled ssh, or a custom command. */
function GitConfigCard({ view, onChange }: { view: GitView; onChange: () => void }) {
  const { toast, confirm } = useUi();
  const { t } = useT();
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/^"|"$/g, "").toLowerCase();
  const current: SshMode = !view.ssh_command ? "bundled" : norm(view.ssh_command) === norm(view.windows_ssh) ? "windows" : "custom";
  const [mode, setMode] = useState<SshMode>(current);
  const [custom, setCustom] = useState(current === "custom" ? (view.ssh_command ?? "") : "");
  useEffect(() => {
    setMode(current);
    if (current === "custom") setCustom(view.ssh_command ?? "");
  }, [view.ssh_command]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = mode === "windows" ? view.windows_ssh : mode === "custom" ? custom.trim() : null;
  const dirty = mode !== current || (mode === "custom" && custom.trim() !== (view.ssh_command ?? ""));
  const agentOk = current === "windows";

  const apply = async () => {
    if (mode === "custom" && !target) return toast(t("git.cmdEmpty"), "err");
    const cmd = target ? `git config --global core.sshCommand "${target}"` : "git config --global --unset core.sshCommand";
    const ok = await confirm({
      title: t("git.changeTitle"),
      ok: t("git.apply"),
      body: (
        <div className="space-y-2">
          <p>{t("git.willRun")}</p>
          <code className="block break-all rounded-lg bg-black/40 px-3 py-2 text-xs text-sky-300">{cmd}</code>
          <p className="text-xs text-zinc-400">{t("git.currentValue", { v: view.ssh_command ?? t("git.notSet") })}</p>
          {mode !== "windows" ? <p className="text-xs text-amber-300">{t("git.noAgentWarn")}</p> : null}
        </div>
      ),
    });
    if (!ok) return;
    try {
      await api.gitSetSshCommand(target);
      toast(t(mode === "windows" ? "git.nowWindows" : "git.updated"));
      onChange();
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  const modes: [SshMode, string][] = [
    ["windows", "Windows OpenSSH"],
    ["bundled", t("git.modeBundled")],
    ["custom", t("git.modeCustom")],
  ];
  return (
    <Card className={cx(!agentOk && "border-amber-500/30")}>
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
        <GitBranch size={15} /> {t("git.config")}
        {agentOk ? <Check size={15} className="ml-auto text-emerald-400" /> : <AlertTriangle size={15} className="ml-auto text-amber-400" />}
      </div>
      {!view.git_found ? (
        <div className="mt-2 text-xs text-amber-300">{t("git.notFound")}</div>
      ) : (
        <>
          <div className="mt-2 text-xs text-zinc-400">
            core.sshCommand: <code className="break-all text-zinc-300">{view.ssh_command ?? t("git.notSet")}</code>
          </div>
          <div className="mt-3 flex rounded-lg bg-zinc-900 p-0.5 text-xs">
            {modes.map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cx("flex-1 rounded-md px-2 py-1.5 transition", mode === m ? "bg-sky-500/20 text-sky-200" : "text-zinc-400 hover:text-zinc-200")}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-2 text-xs text-zinc-500">
            {mode === "windows" ? (
              view.windows_ssh_exists ? (
                <>{t("git.windowsHint", { path: view.windows_ssh })}</>
              ) : (
                <span className="text-amber-300">{t("git.windowsMissing", { path: view.windows_ssh })}</span>
              )
            ) : mode === "bundled" ? (
              <>{t("git.bundledHint")}</>
            ) : (
              <Input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="C:/Program Files/PuTTY/plink.exe -batch"
                className="font-mono text-xs"
              />
            )}
          </div>
          <Button size="sm" className="mt-2" disabled={!dirty} onClick={apply}>
            <Wrench size={14} /> {t(dirty ? "git.apply" : "git.applied")}
          </Button>
        </>
      )}
    </Card>
  );
}

export function GitPage() {
  const { snap, withTrust } = useVault();
  const { toast, confirm } = useUi();
  const [view, reload] = useLoad(api.gitList);
  const [agent, reloadAgent] = useLoad(api.agentStatus);
  const [edit, setEdit] = useState<GitInput | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { t } = useT();

  const keyName = (id: string) => snap.keys.find((k) => k.id === id)?.name ?? "?";

  const test = async (id: string) => {
    setBusy(id);
    try {
      const out = await withTrust(id, () => api.gitTest(id));
      toast(out);
      reload();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const del = async (id: string, name: string) => {
    if (!(await confirm({ title: t("git.deleteTitle"), body: t("git.deleteBody", { name }), ok: t("common.delete"), danger: true }))) return;
    try {
      await api.gitDelete(id);
      reload();
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  if (!view || !agent) return null;
  return (
    <div className="max-w-4xl">
      <PageHeader title={t("nav.git")} sub={t("git.sub")}>
        <Button
          variant="primary"
          disabled={snap.keys.length === 0}
          onClick={() => setEdit({ name: "", alias: "", hostname: "github.com", port: 22, user: "git", key_id: snap.keys[0]?.id ?? "" })}
        >
          <Plus size={16} /> {t("git.account")}
        </Button>
      </PageHeader>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <Card>
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <KeyRound size={15} /> SSH agent
            <span className={cx("ml-auto size-2 rounded-full", agent.running ? "bg-emerald-400" : "bg-zinc-600")} />
          </div>
          <div className="mt-2 text-xs text-zinc-400">
            {agent.running ? (
              <>
                {t("git.agentRunning", { pipe: agent.pipe ?? "", n: agent.keys })}
                {!agent.default_pipe ? <div className="mt-1 text-amber-300">{t("git.agentFallback", { pipe: agent.pipe ?? "" })}</div> : null}
              </>
            ) : agent.error ? (
              localize(agent.error)
            ) : (
              t("git.agentOff")
            )}
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={reloadAgent}>
            {t("common.refresh")}
          </Button>
        </Card>
        <GitConfigCard view={view} onChange={reload} />
      </div>

      {view.conflicts.length ? (
        <div className="mb-4 flex gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            {t("git.conflicts")} <b>{view.conflicts.join(", ")}</b>
          </div>
        </div>
      ) : null}

      {view.accounts.length === 0 ? (
        <Empty
          icon={<GitBranch size={36} />}
          title={t("git.empty")}
          text={t("git.emptyText")}
        />
      ) : (
        <div className="space-y-2">
          {view.accounts.map((a) => (
            <Card key={a.id} className="flex items-center gap-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-300">
                <GitBranch size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-100">{a.name}</span>
                  <span className="rounded bg-white/[0.06] px-1.5 text-[11px] text-zinc-400">🔑 {keyName(a.key_id)}</span>
                </div>
                <div className="mt-1 font-mono text-xs text-zinc-500">
                  git clone {a.user}@<span className="text-sky-300">{a.alias}</span>:{t("git.repo")}
                  <span className="text-zinc-600"> → {a.hostname}{a.port !== 22 ? `:${a.port}` : ""}</span>
                </div>
              </div>
              <Button size="sm" loading={busy === a.id} onClick={() => test(a.id)}>
                <Zap size={14} /> {t("common.test")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title={t("git.copyPub")}
                onClick={async () => {
                  await navigator.clipboard.writeText(snap.keys.find((k) => k.id === a.key_id)?.public_key ?? "");
                  toast(t("git.pubCopied"));
                  if (a.hostname === "github.com") openUrl("https://github.com/settings/ssh/new");
                }}
              >
                <Copy size={14} />
              </Button>
              <Button size="sm" variant="ghost" title={t("common.edit")} onClick={() => setEdit(a)}>
                <Pencil size={14} />
              </Button>
              <Button size="sm" variant="ghost" title={t("common.delete")} onClick={() => del(a.id, a.name)}>
                <Trash2 size={14} />
              </Button>
            </Card>
          ))}
        </div>
      )}
      <p className="mt-4 text-[11px] text-zinc-600">
        {t("git.footer", { path: view.config_path })}
      </p>
      {edit ? (
        <GitForm
          init={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
            reloadAgent();
          }}
        />
      ) : null}
    </div>
  );
}

function GitForm({ init, onClose, onSaved }: { init: GitInput; onClose: () => void; onSaved: () => void }) {
  const { snap } = useVault();
  const { toast } = useUi();
  const [f, setF] = useState(init);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof GitInput>(k: K, v: GitInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const { t } = useT();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.gitSave({ ...f, port: Number(f.port) || 22 });
      toast(t("gitForm.saved"));
      onSaved();
    } catch (err) {
      toast(errText(err), "err");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={init.id ? t("gitForm.edit") : t("gitForm.new")} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("common.name")}>
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={t("gitForm.namePh")} autoFocus />
          </Field>
          <Field label="Alias" hint={t("gitForm.aliasHint")}>
            <Input value={f.alias} onChange={(e) => set("alias", e.target.value)} placeholder="github-work" required />
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_90px_100px] gap-3">
          <Field label={t("gitForm.host")}>
            <Input value={f.hostname} onChange={(e) => set("hostname", e.target.value)} placeholder="github.com" />
          </Field>
          <Field label={t("common.port")}>
            <Input type="number" value={f.port} onChange={(e) => set("port", Number(e.target.value))} />
          </Field>
          <Field label={t("common.user")}>
            <Input value={f.user} onChange={(e) => set("user", e.target.value)} />
          </Field>
        </div>
        <Field label={t("common.key")}>
          <Select value={f.key_id} onChange={(e) => set("key_id", e.target.value)}>
            {snap.keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.algorithm})
              </option>
            ))}
          </Select>
        </Field>
        <div className="rounded-lg bg-black/30 px-3 py-2 font-mono text-xs text-zinc-400">
          git clone {f.user || "git"}@{f.alias || "alias"}:{t("git.repo")}
        </div>
        <div className="flex justify-end gap-2">
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

export function AgentSettings() {
  const [agent] = useLoad(api.agentStatus);
  const { t } = useT();
  return agent ? (
    <div className="mt-3 rounded-lg bg-black/20 px-3 py-2 text-[11px] text-zinc-500">
      {agent.running ? t("agentSettings.running", { pipe: agent.pipe ?? "", n: agent.keys }) : agent.error ? localize(agent.error) : t("agentSettings.off")}
    </div>
  ) : null;
}
