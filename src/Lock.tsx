import { useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { api, errText } from "./api";
import { LangSelect, useT } from "./i18n";
import { Button, Input } from "./ui";

function strength(p: string) {
  let s = 0;
  if (p.length >= 10) s++;
  if (p.length >= 16) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return s;
}

export function Lock({ exists, onDone }: { exists: boolean; onDone: () => void }) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const st = strength(pw);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!exists && pw !== pw2) return setError(t("lock.mismatch"));
    setBusy(true);
    try {
      await (exists ? api.unlock(pw) : api.create(pw));
      setPw("");
      setPw2("");
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(14,165,233,0.12),transparent_60%)]">
      <div className="absolute right-4 top-4">
        <LangSelect />
      </div>
      <form onSubmit={submit} className="w-[360px] rounded-2xl border border-white/[0.08] bg-zinc-900/80 p-7 shadow-2xl backdrop-blur">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 shadow-lg shadow-sky-500/20">
            {exists ? <KeyRound className="text-white" size={26} /> : <ShieldCheck className="text-white" size={26} />}
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">SkyVault</h1>
          <p className="mt-1 text-sm text-zinc-500">{exists ? t("lock.unlockSub") : t("lock.createSub")}</p>
        </div>
        <div className="space-y-3">
          <Input type="password" autoFocus placeholder={t("lock.master")} value={pw} onChange={(e) => setPw(e.target.value)} />
          {!exists ? (
            <>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full ${i < st ? (st < 3 ? "bg-amber-500" : "bg-emerald-500") : "bg-zinc-800"}`}
                  />
                ))}
              </div>
              <Input type="password" placeholder={t("lock.masterRepeat")} value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </>
          ) : null}
          {error ? <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div> : null}
          <Button variant="primary" className="w-full" loading={busy} disabled={!pw}>
            {exists ? t("lock.unlock") : t("lock.create")}
          </Button>
        </div>
        <p className="mt-5 text-center text-[11px] leading-relaxed text-zinc-600">{t("lock.footer")}</p>
      </form>
    </div>
  );
}
