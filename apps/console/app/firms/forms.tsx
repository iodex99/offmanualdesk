"use client";
// Forms for the firm pages. Each calls the JSON admin API (which checks the session,
// role and firm on the server) and refreshes the page. Plain messages only.
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

async function send(url: string, method: "POST" | "PATCH", body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "That didn't work. Try again.");
  return data;
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ ok: true, text });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "That didn't work. Try again." });
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, run };
}

function Note({ m }: { m: { ok: boolean; text: string } | null }) {
  if (!m) return null;
  return (
    <p role={m.ok ? "status" : "alert"} style={{ color: m.ok ? "#1a7f37" : "#c62828" }}>
      {m.text}
    </p>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "block", margin: "0.4rem 0" }}>
      {label} {children}
    </label>
  );
}

const form = (fn: (f: FormData) => void) => (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  fn(new FormData(e.currentTarget));
};
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const opt = (f: FormData, k: string) => str(f, k) || undefined;

export function CreateFirmForm() {
  const { busy, message, run } = useAction();
  return (
    <form
      onSubmit={form((f) =>
        run(async () => {
          await send("/api/admin/firms", "POST", {
            name: str(f, "name"),
            legalName: str(f, "legalName"),
            gstin: opt(f, "gstin"),
            stateCode: str(f, "stateCode"),
            billingEmail: str(f, "billingEmail"),
            billingPhone: opt(f, "billingPhone"),
          });
          return "Firm created.";
        }),
      )}
    >
      <h2>Add a firm</h2>
      <Field label="Name">
        <input name="name" required />
      </Field>
      <Field label="Legal name">
        <input name="legalName" required />
      </Field>
      <Field label="GSTIN (optional)">
        <input name="gstin" />
      </Field>
      <Field label="State code (e.g. 27)">
        <input name="stateCode" required pattern="\d{2}" />
      </Field>
      <Field label="Billing email">
        <input name="billingEmail" type="email" required />
      </Field>
      <Field label="Billing phone (optional)">
        <input name="billingPhone" />
      </Field>
      <button disabled={busy}>Add firm</button>
      <Note m={message} />
    </form>
  );
}

export function AddEmployeeForm({ firmId }: { firmId: string }) {
  const { busy, message, run } = useAction();
  return (
    <form
      onSubmit={form((f) =>
        run(async () => {
          await send(`/api/admin/firms/${firmId}/employees`, "POST", {
            name: str(f, "name"),
            email: str(f, "email"),
            roleLabel: opt(f, "roleLabel"),
          });
          return "Added. They can now sign in from Off Manual Desk with this email.";
        }),
      )}
    >
      <h3>Add an employee</h3>
      <Field label="Name">
        <input name="name" required />
      </Field>
      <Field label="Work email">
        <input name="email" type="email" required />
      </Field>
      <Field label="Role (optional)">
        <input name="roleLabel" placeholder="Article assistant" />
      </Field>
      <button disabled={busy}>Add employee</button>
      <Note m={message} />
    </form>
  );
}

export function EmployeeStatusButton({
  firmId,
  employeeId,
  status,
}: {
  firmId: string;
  employeeId: string;
  status: string;
}) {
  const { busy, message, run } = useAction();
  const next = status === "disabled" ? "active" : "disabled";
  return (
    <>
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            if (next === "disabled" && !window.confirm("Switch off this person's Off Manual access?")) return;
            await send(`/api/admin/firms/${firmId}/employees/${employeeId}`, "PATCH", { status: next });
          })
        }
      >
        {next === "disabled" ? "Switch off" : "Switch on"}
      </button>
      <Note m={message} />
    </>
  );
}

export function EnrolmentCodeForm({ firmId }: { firmId: string }) {
  const { busy, message, run } = useAction();
  return (
    <form
      onSubmit={form((f) =>
        run(async () => {
          const r = await send(`/api/admin/firms/${firmId}/enrolment-codes`, "POST", {
            serverName: str(f, "serverName"),
          });
          return `Enrolment code: ${String(r.code)} (works once, for ${String(r.expiresInHours)} hours). Run on the server: server-agent enroll -console <console URL> ${String(r.code)}`;
        }),
      )}
    >
      <h3>Enrol a server</h3>
      <Field label="Server name">
        <input name="serverName" required placeholder="RDS01" />
      </Field>
      <button disabled={busy}>Create enrolment code</button>
      <Note m={message} />
    </form>
  );
}

export interface PolicyValues {
  lockTimeoutMaxMin: number;
  dayEndHourIst: number;
  telegramMode: string;
  telegramUnlockMaxMin: number;
  stepUpActions: string[];
  gatewayIdleStopHours: number;
  retentionDays: number;
}

export function PolicyForm({ firmId, policy }: { firmId: string; policy: PolicyValues }) {
  const { busy, message, run } = useAction();
  const n = (f: FormData, k: string) => Number(str(f, k));
  return (
    <form
      onSubmit={form((f) =>
        run(async () => {
          await send(`/api/admin/firms/${firmId}/policy`, "PATCH", {
            lockTimeoutMaxMin: n(f, "lockTimeoutMaxMin"),
            dayEndHourIst: n(f, "dayEndHourIst"),
            telegramMode: str(f, "telegramMode"),
            telegramUnlockMaxMin: n(f, "telegramUnlockMaxMin"),
            gatewayIdleStopHours: n(f, "gatewayIdleStopHours"),
            retentionDays: n(f, "retentionDays"),
            stepUpActions: f.get("reviewStepUp") ? ["review.approve"] : [],
          });
          return "Saved. Servers pick this up within 15 minutes.";
        }),
      )}
    >
      <h3>Firm settings</h3>
      <Field label="Lock after idle (minutes, at most)">
        <input
          name="lockTimeoutMaxMin"
          type="number"
          min={1}
          max={60}
          defaultValue={policy.lockTimeoutMaxMin}
        />
      </Field>
      <Field label="Working day ends at (hour, IST)">
        <input name="dayEndHourIst" type="number" min={12} max={23} defaultValue={policy.dayEndHourIst} />
      </Field>
      <Field label="Telegram">
        <select name="telegramMode" defaultValue={policy.telegramMode}>
          <option value="off">Off</option>
          <option value="text">Text only</option>
          <option value="files">Text and files</option>
        </select>
      </Field>
      <Field label="Telegram unlock lasts (minutes)">
        <input
          name="telegramUnlockMaxMin"
          type="number"
          min={5}
          max={240}
          defaultValue={policy.telegramUnlockMaxMin}
        />
      </Field>
      <Field label="Stop an unused assistant after (hours)">
        <input
          name="gatewayIdleStopHours"
          type="number"
          min={1}
          max={24}
          defaultValue={policy.gatewayIdleStopHours}
        />
      </Field>
      <Field label="Keep a departed employee's data for (days)">
        <input name="retentionDays" type="number" min={30} max={3650} defaultValue={policy.retentionDays} />
      </Field>
      <Field label="Ask for today's code before approving review items">
        <input
          name="reviewStepUp"
          type="checkbox"
          defaultChecked={policy.stepUpActions.includes("review.approve")}
        />
      </Field>
      <button disabled={busy}>Save settings</button>
      <Note m={message} />
    </form>
  );
}

export function PackGrantForm({
  firmId,
  packs,
  employees,
}: {
  firmId: string;
  packs: { key: string; name: string }[];
  employees: { id: string; name: string }[];
}) {
  const { busy, message, run } = useAction();
  return (
    <form
      onSubmit={form((f) =>
        run(async () => {
          const group = str(f, "adGroup");
          const employeeId = str(f, "employeeId");
          if (Boolean(group) === Boolean(employeeId))
            throw new Error("Pick one employee, or type one AD group.");
          await send(`/api/admin/firms/${firmId}/pack-grants`, "POST", {
            packKey: str(f, "packKey"),
            ...(group ? { adGroup: group } : { employeeId }),
          });
          return "Granted.";
        }),
      )}
    >
      <h3>Give a skill pack</h3>
      <Field label="Pack">
        <select name="packKey" required>
          {packs.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="To an employee">
        <select name="employeeId" defaultValue="">
          <option value="">(none)</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="or to everyone in an AD group">
        <input name="adGroup" placeholder="OM-Tally" pattern="OM-[A-Za-z0-9-]{1,60}" />
      </Field>
      <button disabled={busy}>Give pack</button>
      <Note m={message} />
    </form>
  );
}
