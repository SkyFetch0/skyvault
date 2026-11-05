import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cable, GitBranch, KeyRound, Lock as LockIcon, LockKeyhole, NotebookPen, Server, Settings as SettingsIcon, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { api, errText, Host, Snapshot, Status } from "./api";
import { I18nProvider, translate, useT } from "./i18n";
import { Lock } from "./Lock";
import { TermPane, TermTab } from "./Terminal";
import { Button, cx, Empty, Modal, UiProvider, useUi } from "./ui";
import { HostsView, KeysView, SettingsView, TunnelsView, Vault } from "./Views";
import { GitPage, NotesView, SecretsView } from "./Views2";

type View = "hosts" | "tunnels" | "keys" | "secrets" | "notes" | "git" | "terminals" | "settings";
type AgentReq = { id: string; key: string; user: string };

function Shell() {
  const { toast, confirm } = useUi();
  const { t, tn } = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("hosts");
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [agentReqs, setAgentReqs] = useState<AgentReq[]>([]);

  const loadStatus = useCallback(async () => {
    const s = await api.status();
    setStatus(s);
    if (s.unlocked) setSnap(await api.snapshot());
    else setSnap(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.snapshot());
    } catch {
      await loadStatus();
    }
  }, [loadStatus]);

  useEffect(() => {
    loadStatus();
    const subs = [
      listen("locked", () => {
        setTabs([]);
        setActive(null);
        loadStatus();
      }),
      listen("tunnels-changed", () => api.snapshot().then(setSnap).catch(() => {})),
      listen<string>("toast", (e) => toast(e.payload, "err")),
      listen<string>("toast-info", (e) => toast(e.payload)),
      listen<AgentReq>("agent-confirm", (e) => setAgentReqs((r) => [...r, e.payload])),
      listen<string>("agent-confirm-done", (e) => setAgentReqs((r) => r.filter((x) => x.id !== e.payload))),
    ];
    return () => subs.forEach((p) => p.then((u) => u()));
  }, [loadStatus, toast]);

  // Report activity to the auto-lock timer (throttled).
  const lastTouch = useRef(0);
  useEffect(() => {
    const h = () => {
      if (Date.now() - lastTouch.current > 20_000) {
        lastTouch.current = Date.now();
        api.touch();
      }
    };
    window.addEventListener("mousemove", h);
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("mousemove", h);
      window.removeEventListener("keydown", h);
    };
  }, []);

  const withTrust = useCallback(
    async <T,>(hostId: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        const m = /^HOSTKEY_(UNKNOWN|MISMATCH)\|(.+)$/.exec(errText(e));
        if (!m) throw e;
        const mismatch = m[1] === "MISMATCH";
        const ok = await confirm({
          title: translate(mismatch ? "trust.mismatchTitle" : "trust.firstTitle"),
          danger: mismatch,
          ok: translate(mismatch ? "trust.mismatchOk" : "trust.firstOk"),
          body: (
            <div className="space-y-3">
              <p>{translate(mismatch ? "trust.mismatchBody" : "trust.firstBody")}</p>
              <code className="block break-all rounded-lg bg-black/40 px-3 py-2 text-xs text-sky-300">{m[2]}</code>
              <p className="text-xs text-zinc-500">{translate("trust.onServer")} ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</p>
            </div>
          ),
        });
        if (!ok) throw translate("common.cancelled");
        await api.trustHost(hostId, m[2]);
        await refresh();
        return await fn();
      }
    },
    [confirm, refresh],
  );

  const openTerminal = useCallback((h: Host) => {
    const key = crypto.randomUUID();
    setTabs((t) => [...t, { key, hostId: h.id, title: h.name, state: "connecting" }]);
    setActive(key);
    setView("terminals");
  }, []);

  const closeTab = (key: string) => {
    setTabs((t) => {
      const rest = t.filter((x) => x.key !== key);
      if (active === key) setActive(rest[rest.length - 1]?.key ?? null);
      return rest;
    });
  };

  const lockNow = async () => {
    await api.lock();
    await loadStatus();
  };

  const req = agentReqs[0];
  const agentModal = req ? (
    <Modal title={t("agent.title")} onClose={() => api.agentAnswer(req.id, false)} width="max-w-md">
      <div className="space-y-3 text-sm text-zinc-300">
        <p>
          {tn(req.user ? "agent.bodyUser" : "agent.body", {
            key: <b className="text-sky-300">{req.key}</b>,
            user: <b className="text-sky-300">{req.user}</b>,
          })}
        </p>
        <p className="text-xs text-zinc-500">{t("agent.hint")}</p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="danger" onClick={() => api.agentAnswer(req.id, false)}>
          {t("agent.deny")}
        </Button>
        <Button variant="primary" autoFocus onClick={() => api.agentAnswer(req.id, true)}>
          {t("agent.allow")}
        </Button>
      </div>
    </Modal>
  ) : null;

  if (!status) return null;
  if (!status.unlocked || !snap)
    return (
      <>
        <Lock exists={status.exists} onDone={loadStatus} />
        {agentModal}
      </>
    );

  const running = snap.tunnels.filter((t) => t.running).length;
  const nav: { id: View; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "hosts", label: t("nav.hosts"), icon: <Server size={17} />, badge: snap.hosts.length },
    { id: "tunnels", label: t("nav.tunnels"), icon: <Cable size={17} />, badge: running || undefined },
    { id: "keys", label: t("nav.keys"), icon: <KeyRound size={17} />, badge: snap.keys.length },
    { id: "secrets", label: t("nav.secrets"), icon: <LockKeyhole size={17} /> },
    { id: "notes", label: t("nav.notes"), icon: <NotebookPen size={17} /> },
    { id: "git", label: t("nav.git"), icon: <GitBranch size={17} /> },
    { id: "terminals", label: t("nav.terminals"), icon: <TerminalSquare size={17} />, badge: tabs.length || undefined },
    { id: "settings", label: t("nav.settings"), icon: <SettingsIcon size={17} /> },
  ];

  return (
    <Vault.Provider value={{ snap, refresh, withTrust, openTerminal }}>
      <div className="flex h-full">
        <aside className="flex w-56 shrink-0 flex-col border-r border-white/[0.06] bg-black/20 p-3">
          <div className="mb-6 flex items-center gap-2.5 px-2 pt-1">
            <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-indigo-500">
              <ShieldCheck size={17} className="text-white" />
            </div>
            <div>
              <div className="text-[15px] font-semibold leading-tight text-zinc-100">SkyVault</div>
              <div className="text-[10px] text-emerald-400">{t("app.unlocked")}</div>
            </div>
          </div>
          <nav className="space-y-0.5">
            {nav.map((n) => (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                className={cx(
                  "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition cursor-pointer",
                  view === n.id ? "bg-sky-500/15 text-sky-200" : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200",
                )}
              >
                {n.icon}
                <span className="flex-1 text-left">{n.label}</span>
                {n.badge ? (
                  <span
                    className={cx(
                      "rounded-md px-1.5 text-[11px]",
                      n.id === "tunnels" ? "bg-emerald-500/20 text-emerald-300" : "bg-white/[0.08] text-zinc-400",
                    )}
                  >
                    {n.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="flex-1" />
          <button
            onClick={lockNow}
            className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-zinc-400 transition hover:bg-red-500/10 hover:text-red-300 cursor-pointer"
          >
            <LockIcon size={17} /> {t("app.lock")}
          </button>
          <div className="px-2.5 pt-1 text-[10px] text-zinc-600">{t("app.autoLockIn", { n: snap.settings.auto_lock_minutes })}</div>
        </aside>

        <main className="relative min-w-0 flex-1">
          {/* Terminals stay mounted so sessions survive view switches. */}
          <div className={cx("absolute inset-0 flex flex-col", view !== "terminals" && "invisible pointer-events-none")}>
            {tabs.length === 0 ? (
              <div className="p-8">
                <Empty icon={<TerminalSquare size={36} />} title={t("app.noTerminals")} text={t("app.noTerminalsHint")} />
              </div>
            ) : (
              <>
                <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-white/[0.06] bg-black/30 px-2">
                  {tabs.map((t) => (
                    <div
                      key={t.key}
                      onClick={() => setActive(t.key)}
                      className={cx(
                        "group flex h-8 cursor-pointer items-center gap-2 rounded-t-lg px-3 text-[13px]",
                        active === t.key ? "bg-[#0b0d12] text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
                      )}
                    >
                      <span
                        className={cx(
                          "size-1.5 rounded-full",
                          t.state === "open" ? "bg-emerald-400" : t.state === "connecting" ? "animate-pulse bg-amber-400" : "bg-zinc-600",
                        )}
                      />
                      {t.title}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(t.key);
                        }}
                        className="text-zinc-600 hover:text-zinc-200 cursor-pointer"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="relative flex-1">
                  {tabs.map((t) => (
                    <TermPane
                      key={t.key}
                      tab={t}
                      visible={view === "terminals" && active === t.key}
                      connect={(cols, rows) => withTrust(t.hostId, () => api.termOpen(t.hostId, cols, rows))}
                      onState={(p) => setTabs((all) => all.map((x) => (x.key === t.key ? { ...x, ...p } : x)))}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
          {view !== "terminals" ? (
            <div className="absolute inset-0 overflow-y-auto p-8">
              {view === "hosts" && <HostsView />}
              {view === "tunnels" && <TunnelsView />}
              {view === "keys" && <KeysView />}
              {view === "secrets" && <SecretsView />}
              {view === "notes" && <NotesView />}
              {view === "git" && <GitPage />}
              {view === "settings" && <SettingsView vaultPath={status.path} />}
            </div>
          ) : null}
        </main>
      </div>
      {agentModal}
    </Vault.Provider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <UiProvider>
        <Shell />
      </UiProvider>
    </I18nProvider>
  );
}
