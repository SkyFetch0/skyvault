import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Box, Check, FileInput, Globe, Lock, Network, Play, RefreshCw, Search, X } from "lucide-react";
import { api, ConfigEntry, errText, InnerTarget, ListenPort, LocalPort, PortScan, TunnelInput } from "./api";
import { Button, cx, Field, Input, Modal, Select, Toggle, useUi } from "./ui";
import { useVault } from "./Views";
import { localize, useT } from "./i18n";

// =============== tunnel form with port picker ===============

type Probe = { state: "idle" | "busy" | "ok" | "err"; msg?: string };

export function TunnelForm({ init, onClose }: { init: TunnelInput; onClose: () => void }) {
  const { snap, refresh, withTrust } = useVault();
  const { toast } = useUi();
  const { t } = useT();
  const [f, setF] = useState<TunnelInput>(init);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof TunnelInput>(k: K, v: TunnelInput[K]) => setF((x) => ({ ...x, [k]: v }));

  // Picker state, cached per host so switching back is instant.
  const [scans, setScans] = useState<Record<string, PortScan>>({});
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState<"ports" | "inner">("ports");
  const [q, setQ] = useState("");
  const scan = scans[f.host_id];

  const load = async (hostId: string) => {
    if (!hostId) return;
    setScanning(true);
    setScanErr(null);
    try {
      const s = await withTrust(hostId, () => api.hostPorts(hostId));
      setScans((m) => ({ ...m, [hostId]: s }));
    } catch (e) {
      setScanErr(errText(e));
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    if (f.host_id && !scans[f.host_id]) load(f.host_id);
  }, [f.host_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local port status, debounced.
  const running = snap.tunnels.find((t) => t.id === init.id)?.running ?? false;
  const [local, setLocal] = useState<{ st: LocalPort; suggest: number } | null>(null);
  useEffect(() => {
    const p = Number(f.local_port);
    if (!p || p > 65535) return setLocal(null);
    const t = setTimeout(() => {
      api.localPortCheck(p, init.id).then(([st, suggest]) => setLocal({ st, suggest })).catch(() => setLocal(null));
    }, 250);
    return () => clearTimeout(t);
  }, [f.local_port, init.id]);
  const ownPort = running && Number(f.local_port) === init.local_port;
  const localOk = ownPort || (local ? local.st.free && !local.st.used_by : true);

  // Names chosen by the picker can be replaced by the next pick; typed ones stay.
  const autoName = useRef(init.name === "");
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  useEffect(() => setProbe({ state: "idle" }), [f.host_id, f.remote_host, f.remote_port]);

  const pick = async (host: string, port: number, label: string) => {
    setF((x) => ({ ...x, remote_host: host, remote_port: port, name: autoName.current ? `${label} ${port}`.trim() : x.name }));
    try {
      const [, suggest] = await api.localPortCheck(port, init.id);
      setF((x) => ({ ...x, local_port: suggest }));
    } catch {
      setF((x) => ({ ...x, local_port: port }));
    }
  };

  const runProbe = async () => {
    setProbe({ state: "busy" });
    try {
      await withTrust(f.host_id, () => api.hostProbe(f.host_id, f.remote_host.trim() || "127.0.0.1", Number(f.remote_port)));
      setProbe({ state: "ok" });
    } catch (e) {
      setProbe({ state: "err", msg: errText(e) });
    }
  };

  const save = async (start: boolean) => {
    setSaving(true);
    try {
      const id = await api.saveTunnel({ ...f, local_port: Number(f.local_port), remote_port: Number(f.remote_port) });
      if (start) {
        await withTrust(f.host_id, () => api.startTunnel(id));
        toast(t("tf.opened", { port: f.local_port }));
      }
      await refresh();
      onClose();
    } catch (err) {
      toast(errText(err), "err");
    } finally {
      setSaving(false);
    }
  };

  const tunneled = (host: string, port: number) =>
    snap.tunnels.some((t) => t.id !== init.id && t.host_id === f.host_id && t.remote_port === port && t.remote_host === host);

  return (
    <Modal title={init.id ? t("tf.edit") : t("tunnels.new")} onClose={onClose} width="max-w-5xl">
      <div className="grid grid-cols-[1fr_380px] gap-5">
        {/* ---------- picker ---------- */}
        <div className="flex min-h-[420px] min-w-0 flex-col rounded-xl border border-white/[0.06] bg-black/20">
          <div className="flex items-center gap-2 border-b border-white/[0.06] p-2.5">
            <div className="flex rounded-lg bg-zinc-900 p-0.5 text-xs">
              {(
                [
                  ["ports", t("tf.tabPorts"), scan?.ports.length],
                  ["inner", t("tf.tabInner"), scan?.targets.length],
                ] as const
              ).map(([k, label, n]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={cx("rounded-md px-2.5 py-1.5 transition", tab === k ? "bg-sky-500/20 text-sky-200" : "text-zinc-400 hover:text-zinc-200")}
                >
                  {label}
                  {n != null ? <span className="ml-1 text-zinc-500">{n}</span> : null}
                </button>
              ))}
            </div>
            <div className="relative ml-auto">
              <Search size={13} className="absolute left-2 top-2 text-zinc-500" />
              <Input className="h-7 w-40 pl-7 text-xs" placeholder={t("tf.searchPh")} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Button type="button" size="sm" variant="ghost" title={t("common.refresh")} disabled={scanning || !f.host_id} onClick={() => load(f.host_id)}>
              <RefreshCw size={14} className={cx(scanning && "animate-spin")} />
            </Button>
          </div>

          {/* Absolute so the list fills the panel without growing the modal. */}
          <div className="relative flex-1">
          <div className="absolute inset-0 overflow-y-auto p-1.5">
            {scanErr ? (
              <div className="m-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300">
                {t("tf.scanFailed")} {scanErr}
                <div className="mt-1 text-zinc-500">{t("tf.manualHint")}</div>
              </div>
            ) : !scan ? (
              <div className="p-6 text-center text-xs text-zinc-500">{scanning ? t("tf.scanning") : t("tf.pickHost")}</div>
            ) : tab === "ports" ? (
              <PortList scan={scan} q={q} selected={f} tunneled={tunneled} onPick={pick} />
            ) : (
              <InnerList targets={scan.targets} q={q} selected={f} onPick={pick} />
            )}
          </div>
          </div>
          {scan?.limited ? (
            <div className="border-t border-white/[0.06] px-3 py-2 text-[11px] text-amber-300/80">
              {t("tf.limited")}
            </div>
          ) : null}
        </div>

        {/* ---------- form ---------- */}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save(false);
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("common.server")}>
              <Select value={f.host_id} onChange={(e) => set("host_id", e.target.value)}>
                {snap.hosts.map((h) => (
                  <option key={h.id} value={h.id} title={`${h.username}@${h.host}`}>
                    {h.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("common.name")}>
              <Input
                value={f.name}
                onChange={(e) => {
                  autoName.current = e.target.value === "";
                  set("name", e.target.value);
                }}
                placeholder={t("tf.namePh")}
              />
            </Field>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-400">{t("tf.remote")}</div>
            <div className="grid grid-cols-[1fr_96px] gap-2">
              <Field label={t("tf.address")} hint={t("tf.addressHint")}>
                <Input value={f.remote_host} onChange={(e) => set("remote_host", e.target.value)} placeholder="127.0.0.1" />
              </Field>
              <Field label={t("common.port")}>
                <Input type="number" value={f.remote_port || ""} onChange={(e) => set("remote_port", Number(e.target.value))} />
              </Field>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button type="button" size="sm" variant="ghost" loading={probe.state === "busy"} disabled={!f.host_id || !f.remote_port} onClick={runProbe}>
                <Network size={13} /> {t("tf.probe")}
              </Button>
              {probe.state === "ok" ? (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <Check size={13} /> {t("tf.probeOk")}
                </span>
              ) : probe.state === "err" ? (
                <span className="flex items-start gap-1 text-xs text-red-300">
                  <X size={13} className="mt-0.5 shrink-0" /> {probe.msg}
                </span>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-400">{t("tf.local")}</div>
            <div className="grid grid-cols-[1fr_96px] gap-2">
              <Field label={t("tf.bind")} hint={t("tf.bindHint")}>
                <Input value={f.bind_addr} onChange={(e) => set("bind_addr", e.target.value)} />
              </Field>
              <Field label={t("tf.localPort")}>
                <Input type="number" value={f.local_port || ""} onChange={(e) => set("local_port", Number(e.target.value))} />
              </Field>
            </div>
            {local && !ownPort ? (
              localOk ? (
                <div className="mt-1.5 flex items-center gap-1 text-xs text-emerald-400/90">
                  <Check size={13} /> {t("tf.free", { port: f.local_port })}
                </div>
              ) : (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-amber-300">
                  <AlertTriangle size={13} />
                  {local.st.used_by ? t("tf.usedBy", { name: local.st.used_by }) : t("tf.busy", { port: f.local_port })}
                  {local.suggest !== Number(f.local_port) ? (
                    <button type="button" className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200 hover:bg-amber-500/25" onClick={() => set("local_port", local.suggest)}>
                      {t("tf.useSuggest", { port: local.suggest })}
                    </button>
                  ) : null}
                </div>
              )
            ) : null}
          </div>

          {f.remote_port ? (
            <div className="flex items-center justify-center gap-2 rounded-lg bg-sky-500/[0.06] px-3 py-2 font-mono text-xs text-sky-200">
              localhost:{f.local_port || "?"} <ArrowRight size={12} /> {snap.hosts.find((h) => h.id === f.host_id)?.name ?? "?"} <ArrowRight size={12} />{" "}
              {f.remote_host || "127.0.0.1"}:{f.remote_port}
            </div>
          ) : null}

          <div className="flex items-center justify-between rounded-xl border border-white/[0.06] px-3 py-2.5">
            <div>
              <div className="text-sm text-zinc-200">{t("tf.autoStart")}</div>
              <div className="text-[11px] text-zinc-500">{t("tf.autoStartHint")}</div>
            </div>
            <Toggle checked={f.auto_start} onChange={(v) => set("auto_start", v)} />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={saving} disabled={!f.remote_port || !f.local_port}>
              {t("common.save")}
            </Button>
            {!running ? (
              <Button type="button" variant="primary" loading={saving} disabled={!f.remote_port || !f.local_port || !localOk} onClick={() => save(true)}>
                <Play size={14} /> {t("tf.saveStart")}
              </Button>
            ) : null}
          </div>
        </form>
      </div>
    </Modal>
  );
}

function matches(q: string, ...parts: (string | number | null | undefined)[]) {
  const s = q.trim().toLowerCase();
  return !s || parts.some((p) => p != null && String(p).toLowerCase().includes(s));
}

function PortList({
  scan,
  q,
  selected,
  tunneled,
  onPick,
}: {
  scan: PortScan;
  q: string;
  selected: TunnelInput;
  tunneled: (host: string, port: number) => boolean;
  onPick: (host: string, port: number, label: string) => void;
}) {
  const { t } = useT();
  const rows = useMemo(
    () => scan.ports.filter((p) => matches(q, p.port, p.process, p.container, p.hint, p.target)),
    [scan.ports, q],
  );
  if (!rows.length) return <div className="p-6 text-center text-xs text-zinc-500">{t("pl.noMatch")}</div>;
  return (
    <div className="space-y-0.5">
      {rows.map((p: ListenPort) => {
        const label = p.container ?? p.process ?? "";
        const sel = selected.remote_port === p.port && (selected.remote_host || "127.0.0.1") === p.target;
        return (
          <button
            key={p.port}
            type="button"
            onClick={() => onPick(p.target, p.port, label)}
            className={cx(
              "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition",
              sel ? "bg-sky-500/15 ring-1 ring-sky-500/40" : "hover:bg-white/[0.04]",
            )}
          >
            <span className="w-14 shrink-0 font-mono text-sm font-semibold text-zinc-100">{p.port}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 truncate text-sm text-zinc-200">
                {p.container ? <Box size={12} className="shrink-0 text-sky-400" /> : null}
                {label || <span className="text-zinc-500">{t("pl.unknown")}</span>}
                {p.hint ? <span className="truncate text-[11px] text-zinc-500">· {p.hint}</span> : null}
              </span>
              <span className="block truncate font-mono text-[10px] text-zinc-500">{p.addrs.join("  ")}</span>
            </span>
            {tunneled(p.target, p.port) ? <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">{t("pl.tunneled")}</span> : null}
            {p.public ? (
              <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300" title={t("pl.publicTitle")}>
                <Globe size={10} /> {t("pl.public")}
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-zinc-400" title={t("pl.localTitle")}>
                <Lock size={10} /> {t("pl.local")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function InnerList({
  targets,
  q,
  selected,
  onPick,
}: {
  targets: InnerTarget[];
  q: string;
  selected: TunnelInput;
  onPick: (host: string, port: number, label: string) => void;
}) {
  const { t: tr } = useT();
  const rows = targets.filter((t) => matches(q, t.name, ...t.ips, ...t.ports));
  if (!rows.length) return <div className="p-6 text-center text-xs text-zinc-500">{tr(targets.length ? "inner.noMatch" : "inner.none")}</div>;
  return (
    <div className="space-y-1.5 p-1">
      <p className="px-1 pb-1 text-[11px] text-zinc-500">
        {tr("inner.hint")}
      </p>
      {rows.map((t) => (
        <div key={`${t.kind}:${t.name}`} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
          <div className="flex items-center gap-2">
            <Box size={13} className={t.kind === "docker" ? "text-sky-400" : "text-violet-400"} />
            <span className="truncate text-sm text-zinc-200">{t.name}</span>
            <span className="rounded bg-white/[0.05] px-1.5 text-[10px] text-zinc-400">{t.kind}</span>
          </div>
          {t.ips.map((ip) => (
            <div key={ip} className="mt-1.5 flex flex-wrap items-center gap-1">
              <button
                type="button"
                title={tr("inner.useIp")}
                className={cx(
                  "rounded px-1.5 py-0.5 font-mono text-[11px]",
                  selected.remote_host === ip ? "bg-sky-500/20 text-sky-200" : "bg-black/30 text-zinc-300 hover:bg-white/[0.06]",
                )}
                onClick={() => onPick(ip, selected.remote_port || 0, t.name)}
              >
                {ip}
              </button>
              {t.ports.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={cx(
                    "rounded px-1.5 py-0.5 font-mono text-[11px]",
                    selected.remote_host === ip && selected.remote_port === p ? "bg-sky-500/25 text-sky-100" : "bg-sky-500/[0.07] text-sky-300 hover:bg-sky-500/15",
                  )}
                  onClick={() => onPick(ip, p, t.name)}
                >
                  :{p}
                </button>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// =============== ~/.ssh/config import ===============

export function SshConfigImport({ onClose }: { onClose: () => void }) {
  const { refresh } = useVault();
  const { toast } = useUi();
  const [scan, setScan] = useState<{ path: string; entries: ConfigEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { t } = useT();

  useEffect(() => {
    api
      .sshConfigScan()
      .then((s) => {
        setScan(s);
        setSel(new Set(s.entries.filter((e) => selectable(e) && !e.git_host).map((e) => e.alias)));
      })
      .catch((e) => setError(errText(e)));
  }, []);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.sshConfigImport([...sel]);
      await refresh();
      const done = t("imp.done", { h: r.hosts, k: r.keys, t: r.tunnels });
      toast(r.notes.length ? [done, ...r.notes.map(localize)].join(" · ") : done, r.notes.length ? "err" : "ok");
      onClose();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (a: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });

  return (
    <Modal title={t("imp.title")} onClose={onClose} width="max-w-2xl">
      {error ? (
        <div className="text-sm text-red-300">{error}</div>
      ) : !scan ? (
        <div className="text-sm text-zinc-500">{t("imp.reading")}</div>
      ) : scan.entries.length === 0 ? (
        <div className="text-sm text-zinc-400">{t("imp.none", { path: scan.path })}</div>
      ) : (
        <>
          <p className="mb-3 text-xs text-zinc-500">
            <code className="text-zinc-400">{scan.path}</code> · {t("imp.desc")}
          </p>
          <div className="space-y-1.5">
            {scan.entries.map((e) => {
              const can = selectable(e);
              return (
                <label
                  key={e.alias}
                  className={cx(
                    "flex items-center gap-3 rounded-lg border border-white/[0.05] px-3 py-2",
                    can ? "cursor-pointer hover:bg-white/[0.03]" : "opacity-50",
                  )}
                >
                  <input type="checkbox" className="accent-sky-500" disabled={!can} checked={sel.has(e.alias)} onChange={() => toggle(e.alias)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm text-zinc-100">
                      {e.alias}
                      {e.in_vault ? <Tag>{t("imp.inVault")}</Tag> : null}
                      {e.proxy_jump ? <Tag warn>{t("imp.proxyJump")}</Tag> : null}
                      {e.git_host ? <Tag>{t("imp.gitHost")}</Tag> : null}
                      {e.forwards.length ? <Tag>{t("imp.tunnels", { n: e.forwards.length })}</Tag> : null}
                    </div>
                    <div className="truncate font-mono text-[11px] text-zinc-500">
                      {e.user}@{e.hostname}
                      {e.port !== 22 ? `:${e.port}` : ""} · {keyText(e, t)}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={busy} disabled={sel.size === 0} onClick={go}>
              <FileInput size={15} /> {t("imp.importN", { n: sel.size })}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

const selectable = (e: ConfigEntry) => !e.in_vault && !e.proxy_jump;

function keyText(e: ConfigEntry, t: ReturnType<typeof useT>["t"]) {
  const file = e.key_path?.split(/[\\/]/).pop() ?? "";
  switch (e.key_status) {
    case "ok":
      return `🔑 ${file}`;
    case "vault":
      return `🔑 ${t("imp.keyInVault", { file })}`;
    case "locked":
      return t("imp.keyLocked", { file });
    case "missing":
      return t("imp.keyMissing");
    default:
      return t("imp.keyNone");
  }
}

function Tag({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return <span className={cx("rounded px-1.5 text-[10px]", warn ? "bg-amber-500/10 text-amber-300" : "bg-white/[0.06] text-zinc-400")}>{children}</span>;
}
