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
          const r = await send(`/api/admin/firms/${firmId}/employees`, "POST", {
            name: str(f, "name"),
            email: str(f, "email"),
            roleLabel: opt(f, "roleLabel"),
          });
          return r.inviteSent
            ? "Added, and an invite email is on its way. They sign in from Off Manual Desk with this email."
            : "Added. No invite email was sent: tell them to open Off Manual Desk and sign in with this email.";
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

export function ResendInviteButton({ firmId, employeeId }: { firmId: string; employeeId: string }) {
  const { busy, message, run } = useAction();
  return (
    <>
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            await send(`/api/admin/firms/${firmId}/employees/${employeeId}/invite`, "POST", {});
            return "Invite sent again.";
          })
        }
      >
        Send invite again
      </button>
      <Note m={message} />
    </>
  );
}

export function ResetAuthenticatorButton({ firmId, employeeId }: { firmId: string; employeeId: string }) {
  const { busy, message, run } = useAction();
  return (
    <>
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            if (
              !window.confirm(
                "Reset this person's authenticator? Use this only when they lost their phone and their recovery codes.",
              )
            )
              return;
            await send(`/api/admin/firms/${firmId}/employees/${employeeId}/reset-authenticator`, "POST", {});
            return "Done. Within 15 minutes they can set up their authenticator again in Off Manual Desk.";
          })
        }
      >
        Reset authenticator
      </button>
      <Note m={message} />
    </>
  );
}

const TASK_ROLE_NAMES: Record<string, string> = {
  "": "All tasks",
  article: "Article",
  senior: "Senior",
  manager: "Manager",
  partner: "Partner",
};

/** Which task buttons the person's Desk shows first (ADR-061). */
export function TaskRoleSelect({
  firmId,
  employeeId,
  taskRole,
}: {
  firmId: string;
  employeeId: string;
  taskRole: string | null;
}) {
  const { busy, message, run } = useAction();
  return (
    <>
      <select
        aria-label="Tasks shown first"
        defaultValue={taskRole ?? ""}
        disabled={busy}
        onChange={(e) => {
          const v = e.currentTarget.value;
          void run(async () => {
            await send(`/api/admin/firms/${firmId}/employees/${employeeId}/task-role`, "POST", {
              taskRole: v === "" ? null : v,
            });
            return "Saved. Desk shows these tasks first within 15 minutes.";
          });
        }}
      >
        {Object.entries(TASK_ROLE_NAMES).map(([v, n]) => (
          <option key={v} value={v}>
            {n}
          </option>
        ))}
      </select>
      <Note m={message} />
    </>
  );
}

export function NoticeForm({ firmId }: { firmId: string }) {
  const { busy, message, run } = useAction();
  return (
    <form
      onSubmit={form((f) =>
        run(async () => {
          await send("/api/admin/notices", "POST", {
            firmId,
            audience: str(f, "audience") === "admins" ? "admins" : "all",
            title: str(f, "title"),
            body: str(f, "body"),
          });
          return "Posted. Desks show it within 15 minutes.";
        }),
      )}
    >
      <h3>Post a notice to Desk</h3>
      <Field label="Title">
        <input name="title" required minLength={3} maxLength={80} />
      </Field>
      <Field label="Message">
        <textarea name="body" required maxLength={500} rows={3} />
      </Field>
      <Field label="Who sees it">
        <select name="audience" defaultValue="all">
          <option value="all">Everyone in the firm</option>
          <option value="admins">Firm admins only</option>
        </select>
      </Field>
      <button disabled={busy}>Post notice</button>
      <Note m={message} />
    </form>
  );
}

export function ImportEmployeesForm({ firmId }: { firmId: string }) {
  const { busy, message, run } = useAction();
  return (
    <form
      onSubmit={form((f) =>
        run(async () => {
          const r = (await send(`/api/admin/firms/${firmId}/employees/import`, "POST", {
            text: str(f, "text"),
          })) as {
            added?: { inviteSent: boolean }[];
            skipped?: { line: number; reason: string }[];
          };
          const added = r.added ?? [];
          const skipped = r.skipped ?? [];
          const invites = added.filter((a) => a.inviteSent).length;
          const parts = [`Added ${added.length}${invites ? ` (${invites} invite emails sent)` : ""}.`];
          if (skipped.length)
            parts.push(`Skipped: ${skipped.map((x) => `line ${x.line} (${x.reason})`).join("; ")}`);
          return parts.join(" ");
        }),
      )}
    >
      <h3>Add many people at once</h3>
      <p>One person per line: Name, work email. You can paste from Excel.</p>
      <textarea
        name="text"
        rows={6}
        cols={50}
        placeholder={"Asha Mehta, asha@mehtaco.in\nRavi Shah, ravi@mehtaco.in"}
      />
      <div>
        <button disabled={busy}>Add people</button>
      </div>
      <Note m={message} />
    </form>
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
