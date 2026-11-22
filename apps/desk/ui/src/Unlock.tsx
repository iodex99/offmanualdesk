// Sign-in and unlock flow (docs/ARCHITECTURE.md F2–F3; PRODUCT.md §4: plain words,
// every "no" has a next step). All checks happen in the Server Agent; this screen
// only shows what it says.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isAgentError, type AgentCall } from "./agent";
import { Assistant, type StartGateway } from "./Assistant";
import { useIdleLock, type ReadIdle } from "./idleLock";

interface Hello {
  known: boolean;
  name?: string;
  status?: string;
  totpEnrolled: boolean;
  pinSet: boolean;
  locked: boolean;
  dayUnlocked: boolean;
  lockedUntil?: string;
  /** Licence (ADR-042): paused firms get one plain message instead of the assistant. */
  servicePaused?: boolean;
  pausedMessage?: string;
  notice?: string;
}

type Screen =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "signup"; url?: string; qr?: string }
  | { kind: "enrol"; qr: string; secret: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "recover" }
  | { kind: "pin" }
  | { kind: "unlock"; usePin: boolean }
  | { kind: "ready"; name: string; notice?: string }
  | { kind: "paused"; message: string }
  | { kind: "disabled" };

export const OFFBOARD_CHECK_MS = 60_000;

const defaultStopGateway = async () => {
  if (isTauri()) await invoke("gateway_stop");
};

const message = (e: unknown) => (isAgentError(e) ? e.message : "Something went wrong. Try again.");

export function Unlock({
  agent,
  onLock,
  startGateway,
  readIdle,
  stopGateway = defaultStopGateway,
}: {
  agent: AgentCall;
  onLock?: () => void;
  startGateway?: StartGateway;
  /** Stops this employee's gateway (offboarding). */
  stopGateway?: () => Promise<void>;
  readIdle?: ReadIdle;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [hello, setHello] = useState<Hello | null>(null);
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [bindCode, setBindCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = (await agent("session.hello")) as Hello;
      setHello(h);
      setError(null);
      setValue("");
      setCode("");
      if (h.known && h.status === "disabled") {
        // Offboarded (F10): the assistant stops; nothing else is possible from here.
        await stopGateway().catch(() => undefined);
        return setScreen({ kind: "disabled" });
      }
      if (!h.known) {
        // F2: sign in on the console (here or on a phone), then type the code shown there.
        try {
          const b = (await agent("auth.bindStart")) as { url?: unknown };
          if (typeof b.url === "string" && b.url.startsWith("https://")) {
            return setScreen({ kind: "signup", url: b.url, qr: await QRCode.toDataURL(b.url) });
          }
        } catch {
          // Not activated yet: fall through to the plain explanation.
        }
        return setScreen({ kind: "signup" });
      }
      if (!h.totpEnrolled) {
        const e = (await agent("auth.totpEnrolStart", {})) as { secret: string; uri: string };
        return setScreen({ kind: "enrol", secret: e.secret, qr: await QRCode.toDataURL(e.uri) });
      }
      if (!h.pinSet) return setScreen({ kind: "pin" });
      if (h.locked) return setScreen({ kind: "unlock", usePin: h.dayUnlocked && !h.lockedUntil });
      if (h.servicePaused) {
        return setScreen({
          kind: "paused",
          message: h.pausedMessage || "Off Manual is paused for your firm. Please contact your admin.",
        });
      }
      setScreen({ kind: "ready", name: h.name ?? "", ...(h.notice ? { notice: h.notice } : {}) });
    } catch (e) {
      setScreen({ kind: "unavailable", message: message(e) });
    }
  }, [agent, stopGateway]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onIdleLocked = useCallback(() => {
    void refresh();
    onLock?.();
  }, [refresh, onLock]);
  // While unlocked, check every minute whether the employee was switched off (F10).
  const ready = screen.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => void refresh(), OFFBOARD_CHECK_MS);
    return () => window.clearInterval(id);
  }, [ready, refresh]);

  useIdleLock({
    active: screen.kind === "ready",
    agent,
    onLocked: onIdleLocked,
    ...(readIdle ? { readIdle } : {}),
  });

  async function run(fn: () => Promise<unknown>, after?: (err: unknown) => void) {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(message(e));
      after?.(e);
    }
  }

  const submit = (fn: () => Promise<unknown>, after?: (err: unknown) => void) => (ev: FormEvent) => {
    ev.preventDefault();
    void run(fn, after);
  };

  const sixDigits = (v: string) => v.replace(/\D/g, "").slice(0, 6);

  switch (screen.kind) {
    case "loading":
      return <p>Starting…</p>;
    case "unavailable":
      return (
        <div role="alert">
          <p>{screen.message}</p>
          <button onClick={() => void refresh()}>Try again</button>
        </div>
      );
    case "signup":
      if (!screen.url) {
        return (
          <p>
            This Windows account isn't set up for Off Manual yet. Use the invite your admin sent you, or ask
            them to add you.
          </p>
        );
      }
      return (
        <form onSubmit={submit(() => agent("auth.bindComplete", { code: bindCode.trim() }))}>
          <p>Sign in to get started.</p>
          <ol>
            <li>
              Open <code>{screen.url}</code> in your browser, or scan this with your phone.
            </li>
            <li>Sign in with the work email your firm invited.</li>
            <li>Type the code it shows here.</li>
          </ol>
          {screen.qr && <img src={screen.qr} alt="QR code for the sign-in page" width={160} height={160} />}
          <label>
            Code{" "}
            <input
              autoComplete="off"
              maxLength={9}
              value={bindCode}
              onChange={(e) => setBindCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
            />
          </label>
          <button type="submit" disabled={bindCode.replace(/-/g, "").length !== 8}>
            Continue
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      );
    case "enrol":
      return (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            setError(null);
            agent("auth.totpEnrolConfirm", { code })
              .then((r) => {
                const codes = (r as { recoveryCodes?: unknown }).recoveryCodes;
                // F2 step 4: recovery codes are shown once, before anything else.
                if (Array.isArray(codes) && codes.every((c) => typeof c === "string")) {
                  setScreen({ kind: "codes", codes: codes as string[] });
                } else {
                  void refresh();
                }
              })
              .catch((e: unknown) => setError(message(e)));
          }}
        >
          <p>
            Scan this with your authenticator app (Google or Microsoft Authenticator), then enter the code.
          </p>
          <img src={screen.qr} alt="QR code for your authenticator app" width={180} height={180} />
          <p className="hint">Can't scan? Key: {screen.secret}</p>
          <CodeInput value={code} onChange={(v) => setCode(sixDigits(v))} />
          <button type="submit">Continue</button>
          {error && <p role="alert">{error}</p>}
        </form>
      );
    case "codes":
      return (
        <div>
          <p>
            Write these recovery codes down and keep them somewhere safe (not on this computer). If you lose
            your phone, one code lets you set up a new one. Each code works once. They won't be shown again.
          </p>
          <ol className="codes">
            {screen.codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <button onClick={() => void refresh()}>I've saved them</button>
        </div>
      );
    case "recover":
      return (
        <form onSubmit={submit(() => agent("auth.recover", { code: value.trim() }))}>
          <p>
            Lost your phone? Enter one of your recovery codes. You'll then set up your authenticator again.
          </p>
          <label>
            Recovery code{" "}
            <input
              autoComplete="off"
              maxLength={11}
              value={value}
              onChange={(e) => setValue(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
            />
          </label>
          <button type="submit" disabled={value.replace(/-/g, "").length !== 10}>
            Continue
          </button>
          <button type="button" onClick={() => void refresh()}>
            Back
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      );
    case "pin":
      return (
        <form onSubmit={submit(() => agent("auth.pinSet", { pin: value, code }))}>
          <p>Choose a PIN of 4 to 8 digits. You'll use it to unlock after a break.</p>
          <label>
            New PIN{" "}
            <input
              type="password"
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 8))}
            />
          </label>
          <p>To confirm it's you, also enter the code from your authenticator app.</p>
          <CodeInput value={code} onChange={(v) => setCode(sixDigits(v))} />
          <button type="submit">Save PIN</button>
          {error && <p role="alert">{error}</p>}
        </form>
      );
    case "unlock":
      return screen.usePin ? (
        <form
          onSubmit={submit(
            () => agent("auth.verifyPin", { pin: value }),
            (e) => {
              if (isAgentError(e) && e.data?.needDailyCode) setScreen({ kind: "unlock", usePin: false });
            },
          )}
        >
          <p>Welcome back{hello?.name ? `, ${hello.name}` : ""}. Enter your PIN to unlock.</p>
          <input
            aria-label="PIN"
            type="password"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 8))}
          />
          <button type="submit">Unlock</button>
          <button type="button" onClick={() => setScreen({ kind: "unlock", usePin: false })}>
            Use today's code instead
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      ) : (
        <form onSubmit={submit(() => agent("auth.verifyDaily", { code }))}>
          <p>Enter today's code from your authenticator app.</p>
          <CodeInput value={code} onChange={(v) => setCode(sixDigits(v))} />
          <button type="submit">Unlock</button>
          <button
            type="button"
            onClick={() => {
              setValue("");
              setError(null);
              setScreen({ kind: "recover" });
            }}
          >
            Lost your phone?
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      );
    case "disabled":
      return (
        <p role="alert">
          Your Off Manual access is switched off. If this is a mistake, please contact your admin.
        </p>
      );
    case "paused":
      return (
        <div role="alert">
          <p>{screen.message}</p>
          <button onClick={() => void refresh()}>Check again</button>
        </div>
      );
    case "ready":
      return (
        <div>
          {screen.notice && (
            <p className="notice" role="status">
              {screen.notice}
            </p>
          )}
          <p>You're signed in{screen.name ? `, ${screen.name}` : ""}.</p>
          <Assistant agent={agent} {...(startGateway ? { start: startGateway } : {})} />
          <button
            onClick={() =>
              void run(async () => {
                await agent("lock.set", { locked: true });
                onLock?.();
              })
            }
          >
            Lock now
          </button>
        </div>
      );
  }
}

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label>
      6-digit code{" "}
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
