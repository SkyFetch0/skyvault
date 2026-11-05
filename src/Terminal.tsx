import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, errText } from "./api";
import { translate } from "./i18n";

// One global listener routes output to terminals by session id. Output that
// arrives before a pane registers its sid (the login banner) is buffered.
const sinks = new Map<string, (d: Uint8Array) => void>();
const pending = new Map<string, Uint8Array[]>();
const exits = new Map<string, () => void>();

function b64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

listen<{ sid: string; data: string }>("term-data", ({ payload }) => {
  const bytes = b64(payload.data);
  const sink = sinks.get(payload.sid);
  if (sink) sink(bytes);
  else pending.set(payload.sid, [...(pending.get(payload.sid) ?? []), bytes]);
});
listen<string>("term-exit", ({ payload }) => exits.get(payload)?.());

export type TermTab = { key: string; hostId: string; title: string; sid?: string; state: "connecting" | "open" | "closed" };

export function TermPane({
  tab,
  visible,
  connect,
  onState,
}: {
  tab: TermTab;
  visible: boolean;
  connect: (cols: number, rows: number) => Promise<string>;
  onState: (patch: Partial<TermTab>) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon>(undefined);
  const sidRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13.5,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: {
        background: "#0b0d12",
        foreground: "#d4d4d8",
        cursor: "#38bdf8",
        selectionBackground: "#38bdf855",
        black: "#18181b",
        brightBlack: "#52525b",
        blue: "#60a5fa",
        brightBlue: "#93c5fd",
        cyan: "#22d3ee",
        green: "#4ade80",
        magenta: "#c084fc",
        red: "#f87171",
        yellow: "#facc15",
        white: "#e4e4e7",
      },
    });
    const f = new FitAddon();
    fit.current = f;
    term.loadAddon(f);
    term.open(el.current!);
    f.fit();
    term.write(`\x1b[90m${translate("term.connecting", { name: tab.title })}\x1b[0m\r\n`);

    // Ctrl+Shift+C / Ctrl+Shift+V copy-paste, like most terminals.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyV") {
        navigator.clipboard.readText().then((t) => {
          if (sidRef.current) api.termWrite(sidRef.current, t);
        });
        return false;
      }
      return true;
    });

    const dataSub = term.onData((d) => sidRef.current && api.termWrite(sidRef.current, d));
    const resizeSub = term.onResize(({ cols, rows }) => sidRef.current && api.termResize(sidRef.current, cols, rows));
    const ro = new ResizeObserver(() => {
      if (el.current?.offsetParent) f.fit();
    });
    ro.observe(el.current!);

    let disposed = false;
    connect(term.cols, term.rows)
      .then((sid) => {
        if (disposed) return api.termClose(sid);
        sidRef.current = sid;
        sinks.set(sid, (d) => term.write(d));
        exits.set(sid, () => {
          term.write(`\r\n\x1b[90m${translate("term.closed")}\x1b[0m\r\n`);
          onState({ state: "closed" });
        });
        for (const chunk of pending.get(sid) ?? []) term.write(chunk);
        pending.delete(sid);
        onState({ sid, state: "open" });
        term.focus();
      })
      .catch((e) => {
        term.write(`\r\n\x1b[31m${errText(e)}\x1b[0m\r\n`);
        onState({ state: "closed" });
      });

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      const sid = sidRef.current;
      if (sid) {
        sinks.delete(sid);
        exits.delete(sid);
        api.termClose(sid);
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => fit.current?.fit());
  }, [visible]);

  return <div ref={el} className="absolute inset-0 p-2" style={{ display: visible ? "block" : "none", background: "#0b0d12" }} />;
}
