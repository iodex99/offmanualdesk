// Task buttons v1 (docs/SKILLS.md §5). A button collects a few inputs and sends one
// clear request to the assistant naming the skill and the output file. Which tools
// the skill may use is still decided by the employee's packs (ADR-043).
import { fyLabel } from "@offmanual/shared-schema/format";

export type TaskInput = "client" | "month" | "fy" | "period" | "file";

export interface TaskDef {
  id: string;
  label: string;
  inputs: TaskInput[];
  prompt(v: Record<TaskInput, string>): string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11" → "Nov-2026". */
export function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]}-${m[1]}`;
}

/** Client name as used in file names: letters, digits, `&` and `-`; spaces become `_`. */
export function fileSafe(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9& -]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

/** This FY and the previous two, newest first (e.g. FY2026-27). */
export function recentFYs(now: Date): string[] {
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now);
    d.setUTCFullYear(d.getUTCFullYear() - i);
    out.push(fyLabel(d));
  }
  return out;
}

const save = (file: string) => `Save it as ${file} in the client's folder and tell me where it is.`;

export const TASKS: TaskDef[] = [
  {
    id: "bank-reco",
    label: "Bank reco",
    inputs: ["client", "month"],
    prompt: (v) =>
      `Do the bank reconciliation for ${v.client} for ${monthLabel(v.month)} using the bank-recon skill and Tally. ` +
      save(`BankReco_${fileSafe(v.client)}_${v.month}.xlsx`),
  },
  {
    id: "gstr2b",
    label: "GSTR-2B vs books",
    inputs: ["client", "month"],
    prompt: (v) =>
      `Use the gstr2b-vs-books skill for ${v.client} for ${monthLabel(v.month)}. ` +
      save(`GSTR2B_vs_Books_${fileSafe(v.client)}_${v.month}.xlsx`),
  },
  {
    id: "ais-26as",
    label: "26AS/AIS vs books",
    inputs: ["client", "fy"],
    prompt: (v) =>
      `Use the ais-26as-vs-books skill for ${v.client} for ${v.fy}. ` +
      save(`TDS_Credit_Reco_${fileSafe(v.client)}_${v.fy}.xlsx`),
  },
  {
    id: "scrutiny",
    label: "Ledger scrutiny",
    inputs: ["client", "fy"],
    prompt: (v) =>
      `Use the ledger-scrutiny skill for ${v.client} for ${v.fy}. ` +
      save(`Scrutiny_${fileSafe(v.client)}_${v.fy}.xlsx`),
  },
  {
    id: "notice",
    label: "Draft notice reply",
    inputs: ["client", "file"],
    prompt: (v) =>
      `Use the notice-reply-draft skill on the notice ${v.file} for ${v.client}. Save the draft as ` +
      `NoticeReply_${fileSafe(v.client)}_<notice date DD-MM-YYYY>.docx next to the notice and tell me where it is. ` +
      "Don't send or file anything.",
  },
  {
    id: "missing-docs",
    label: "Missing documents",
    inputs: ["period"],
    prompt: (v) =>
      `Use the doc-chaser skill for ${v.period}. Save it as MissingDocs_${fileSafe(v.period)}.xlsx in the firm's ` +
      "reports folder and tell me where it is. Don't contact any client.",
  },
  {
    id: "mis",
    label: "Month-end MIS",
    inputs: ["client", "month"],
    prompt: (v) =>
      `Use the tally-mis skill for ${v.client} for ${monthLabel(v.month)}. ` +
      save(`MIS_${fileSafe(v.client)}_${v.month}.xlsx`),
  },
  {
    id: "summarise",
    label: "Summarise a document",
    inputs: ["file"],
    prompt: (v) =>
      `Summarise ${v.file} in plain points for a CA, then save the summary as a .md file next to it with the same ` +
      "name and tell me where it is.",
  },
  {
    id: "due-week",
    label: "Due this week",
    inputs: [],
    prompt: () =>
      "Use the compliance-calendar skill: what is due this week (DD-MM-YYYY), and for which clients?",
  },
];

/** Missing inputs, in plain words; empty when the task can run. */
export function missingInputs(t: TaskDef, v: Partial<Record<TaskInput, string>>): string[] {
  const names: Record<TaskInput, string> = {
    client: "client",
    month: "month",
    fy: "financial year",
    period: "period",
    file: "file",
  };
  return t.inputs.filter((i) => !(v[i] ?? "").trim()).map((i) => names[i]);
}
