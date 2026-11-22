// Sign-in and unlock flow (docs/ARCHITECTURE.md F2–F3; PRODUCT.md §4: plain words,
// every "no" has a next step). All checks happen in the Server Agent; this screen
// only shows what it says.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { isAgentError, type AgentCall } from "./agent";
import { Assistant, type StartGateway } from "./Assistant";

interface Hello {
  known: boolean;
  name?: string;
  status?: string;
  totpEnrolled: boolean;
  pinSet: boolean;
  locked: boolean;
  dayUnlocked: boolean;
  lockedUntil?: string;
}

type Screen =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "signup" }
  | { kind: "enrol"; qr: string; secret: string }
  | { kind: "pin" }
  | { kind: "unlock"; usePin: boolean }
  | { kind: "ready"; name: string };

const message = (e: unknown) => (isAgentError(e) ? e.message : "Something went wrong. Try again.");

export function Unlock({
  agent,
  onLock,
  startGateway,
}: {
  agent: AgentCall;
  onLock?: () => void;
  startGateway?: StartGateway;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [hello, setHello] = useState<Hello | null>(null);
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = (await agent("session.hello")) as Hello;
      setHello(h);
      setError(null);
      setValue("");
      setCode("");
      if (!h.known) return setScreen({ kind: "signup" });
      if (!h.totpEnrolled) {
        const e = (await agent("auth.totpEnrolStart", {})) as { secret: string; uri: string };
        return setScreen({ kind: "enrol", secret: e.secret, qr: await QRCode.toDataURL(e.uri) });
      }
      if (!h.pinSet) return setScreen({ kind: "pin" });
      if (h.locked) return setScreen({ kind: "unlock", usePin: h.dayUnlocked && !h.lockedUntil });
      setScreen({ kind: "ready", name: h.name ?? "" });
    } catch (e) {
      setScreen({ kind: "unavailable", message: message(e) });
    }
  }, [agent]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      return (
        <p>
          This Windows account isn't set up for Off Manual yet. Use the invite your admin sent you, or ask
          them to add you.
        </p>
      );
    case "enrol":
      return (
        <form onSubmit={submit(() => agent("auth.totpEnrolConfirm", { code }))}>
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
          {error && <p role="alert">{error}</p>}
        </form>
      );
    case "ready":
      return (
        <div>
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
