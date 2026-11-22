"use client";
// Superadmin billing actions (BILLING §3–§6): each posts to /api/admin/billing, which
// checks the superadmin role on the server.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

async function billing(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("/api/admin/billing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "That didn't work. Try again.");
  return data;
}

function useBilling() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (body: Record<string, unknown>, done: (r: Record<string, unknown>) => string) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: done(await billing(body)) });
      router.refresh();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  };
  const view = note && (
    <p role={note.ok ? "status" : "alert"} style={{ color: note.ok ? "#1a7f37" : "#c62828" }}>
      {note.text}
    </p>
  );
  return { busy, act, view };
}

const submit = (fn: (f: FormData) => void) => (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  fn(new FormData(e.currentTarget));
};
const val = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** "1234.5" → "123450" paise; null when not a rupee amount with at most 2 decimals. */
export function rupeesToPaise(rupees: string): string | null {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(rupees.trim());
  if (!m) return null;
  const paise = `${m[1]}${(m[2] ?? "").padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
  return paise === "0" ? null : paise;
}

export function RunMonthForm({ year, month }: { year: number; month: number }) {
  const { busy, act, view } = useBilling();
  return (
    <form
      onSubmit={submit((f) =>
        act(
          { action: "run", year: Number(val(f, "year")), month: Number(val(f, "month")) },
          (r) => `${String(r.drafts)} draft invoice(s) made or refreshed.`,
        ),
      )}
    >
      <h2>Make drafts for a month</h2>
      <label>
        Year <input name="year" type="number" defaultValue={year} min={2026} max={2100} />
      </label>{" "}
      <label>
        Month <input name="month" type="number" defaultValue={month} min={1} max={12} />
      </label>{" "}
      <button disabled={busy}>Make drafts</button>
      {view}
    </form>
  );
}

export function IssueButton({ invoiceId }: { invoiceId: string }) {
  const { busy, act, view } = useBilling();
  return (
    <>
      <button
        disabled={busy}
        onClick={() => {
          if (window.confirm("Issue this invoice? It gets a number and the firm sees it.")) {
            void act({ action: "issue", invoiceId }, (r) => `Issued as ${String(r.number)}.`);
          }
        }}
      >
        Issue
      </button>
      {view}
    </>
  );
}

export function PaymentForm({ invoiceId }: { invoiceId: string }) {
  const { busy, act, view } = useBilling();
  const [bad, setBad] = useState(false);
  return (
    <form
      onSubmit={submit((f) => {
        const paise = rupeesToPaise(val(f, "amount"));
        setBad(paise === null);
        if (paise === null) return;
        void act(
          {
            action: "payment",
            invoiceId,
            amountPaise: paise,
            paidOn: val(f, "paidOn"),
            ...(val(f, "method") ? { method: val(f, "method") } : {}),
            ...(val(f, "reference") ? { reference: val(f, "reference") } : {}),
          },
          (res) =>
            res.status === "paid" ? "Recorded. The invoice is paid." : "Recorded. Some amount is still due.",
        );
      })}
    >
      <input name="amount" placeholder="₹ amount" required size={10} />{" "}
      <input name="paidOn" type="date" required />{" "}
      <input name="method" placeholder="NEFT / cheque" size={10} />{" "}
      <input name="reference" placeholder="UTR / cheque no." size={12} />{" "}
      <button disabled={busy}>Record payment</button>
      {bad && <p role="alert">Enter the amount in rupees, e.g. 2360 or 2360.50.</p>}
      {view}
    </form>
  );
}

export function OverrideForm({ firms }: { firms: { id: string; name: string }[] }) {
  const { busy, act, view } = useBilling();
  return (
    <form
      onSubmit={submit((f) =>
        act(
          {
            action: "override",
            firmId: val(f, "firmId"),
            state: val(f, "state"),
            reason: val(f, "reason"),
            ...(val(f, "until") ? { until: val(f, "until") } : {}),
          },
          (r) => `Firm status is now ${String(r.state)}.`,
        ),
      )}
    >
      <h2>Override a firm&apos;s status</h2>
      <select name="firmId" required>
        {firms.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>{" "}
      <select name="state">
        <option value="active">Active</option>
        <option value="overdue">Overdue (notice only)</option>
        <option value="restricted">Restricted</option>
        <option value="suspended">Suspended</option>
      </select>{" "}
      <input name="reason" placeholder="Reason (required)" required minLength={5} size={30} />{" "}
      <label>
        until <input name="until" type="date" />
      </label>{" "}
      <button disabled={busy}>Override</button>
      {view}
    </form>
  );
}

export function RefreshButton() {
  const { busy, act, view } = useBilling();
  return (
    <>
      <button
        disabled={busy}
        onClick={() => void act({ action: "refresh" }, () => "Firm statuses refreshed.")}
      >
        Refresh all firm statuses
      </button>
      {view}
    </>
  );
}
