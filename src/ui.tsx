import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { localize, useT } from "./i18n";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "subtle";
  size?: "sm" | "md";
  loading?: boolean;
};

export function Button({ variant = "subtle", size = "md", loading, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer select-none",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-sky-500 text-white hover:bg-sky-400",
        variant === "subtle" && "bg-white/[0.06] text-zinc-200 hover:bg-white/[0.1] border border-white/[0.06]",
        variant === "ghost" && "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]",
        variant === "danger" && "bg-red-500/15 text-red-300 hover:bg-red-500/25 border border-red-500/20",
        className,
      )}
    >
      {loading ? <span className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export const inputCls =
  "w-full h-9 rounded-lg bg-black/30 border border-white/[0.08] px-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-sky-500/60 focus:ring-2 focus:ring-sky-500/15 transition";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputCls, "pr-8", props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, "h-auto py-2 font-mono text-xs", props.className)} />;
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors cursor-pointer disabled:opacity-50",
        checked ? "bg-emerald-500" : "bg-zinc-700",
      )}
    >
      <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function Modal({ title, onClose, children, width = "max-w-lg" }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onMouseDown={onClose}>
      <div
        className={cx("w-full rounded-2xl border border-white/[0.08] bg-zinc-900 shadow-2xl shadow-black/50", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
          <h3 className="text-[15px] font-semibold text-zinc-100">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 cursor-pointer">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[calc(100vh-8rem)] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] py-16 text-center">
      <div className="mb-3 text-zinc-600">{icon}</div>
      <div className="font-medium text-zinc-300">{title}</div>
      <div className="mt-1 max-w-sm text-sm text-zinc-500">{text}</div>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

// ---------- toasts + confirm dialog ----------

type Toast = { id: number; text: string; kind: "ok" | "err" };
type ConfirmOpts = { title: string; body: ReactNode; ok?: string; danger?: boolean };

const Ctx = createContext<{
  toast: (text: string, kind?: "ok" | "err") => void;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
}>(null!);

export const useUi = () => useContext(Ctx);

export function UiProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<ConfirmOpts | null>(null);
  const resolver = useRef<(v: boolean) => void>(undefined);

  const toast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    // Backend events and results may carry message codes; translate them here once.
    setToasts((t) => [...t, { id, text: localize(text), kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 6000 : 2800);
  }, []);

  const confirm = useCallback((o: ConfirmOpts) => {
    setDlg(o);
    return new Promise<boolean>((res) => (resolver.current = res));
  }, []);

  const close = (v: boolean) => {
    resolver.current?.(v);
    setDlg(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      {dlg ? (
        <Modal title={dlg.title} onClose={() => close(false)} width="max-w-md">
          <div className="text-sm text-zinc-300">{dlg.body}</div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => close(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant={dlg.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
              {dlg.ok ?? t("common.ok")}
            </Button>
          </div>
        </Modal>
      ) : null}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto max-w-sm break-words rounded-xl border px-4 py-2.5 text-sm shadow-xl backdrop-blur",
              t.kind === "ok" ? "border-emerald-500/20 bg-emerald-950/80 text-emerald-200" : "border-red-500/20 bg-red-950/80 text-red-200",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
