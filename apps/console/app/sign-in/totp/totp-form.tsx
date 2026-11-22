"use client";

import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";

type Status = { enrolled: boolean; mfa: boolean; name: string };

async function call(body: object): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch("/api/auth/totp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

export function TotpForm() {
  const [status, setStatus] = useState<Status | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await call({ action: "status" });
      if (s.status === 401) {
        window.location.href = "/sign-in?error=expired";
        return;
      }
      const st = s.data as unknown as Status;
      if (!st.enrolled) {
        const e = await call({ action: "enrol-start" });
        if (!cancelled && e.status === 200) {
          setSecret(String(e.data.secret));
          setQr(await QRCode.toDataURL(String(e.data.uri)));
        }
      }
      if (!cancelled) setStatus(st);
    })().catch(() => setError("Something went wrong. Reload the page to try again."));
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    const r = await call({ action: "verify", code });
    if (r.status === 200) window.location.href = String(r.data.next);
    else setError(String(r.data.error ?? "That code isn't right."));
  }

  if (!status) return <p>Loading…</p>;
  return (
    <form onSubmit={submit}>
      {!status.enrolled && qr && (
        <>
          <p>
            Welcome, {status.name}. Scan this with Google Authenticator, Microsoft Authenticator or a similar
            app, then enter the 6-digit code it shows.
          </p>
          <img src={qr} alt="QR code for your authenticator app" width={200} height={200} />
          <p style={{ fontSize: "0.8rem", color: "#666" }}>Can't scan? Enter this key instead: {secret}</p>
        </>
      )}
      <label>
        6-digit code{" "}
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
        />
      </label>{" "}
      <button type="submit">Continue</button>
      {error && (
        <p role="alert" style={{ color: "#a00" }}>
          {error}
        </p>
      )}
    </form>
  );
}
