// Superadmin billing board (BILLING §3–§6, ADR-045).
import Link from "next/link";
import { formatDate, formatINR } from "@offmanual/shared-schema/format";
import { billingBoard } from "@/lib/billing/admin";
import { load, pageSession } from "../firms/session";
import { IssueButton, OverrideForm, PaymentForm, RefreshButton, RunMonthForm } from "./forms";

export const dynamic = "force-dynamic";

const day = (d: string) => formatDate(new Date(`${d}T00:00:00+05:30`));

export default async function BillingPage() {
  const { deps, session } = await pageSession();
  const board = await load(() => billingBoard(deps, session));
  if (board === "forbidden") return <p>Only a superadmin can see billing.</p>;
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const prev =
    ist.getUTCMonth() === 0
      ? { y: ist.getUTCFullYear() - 1, m: 12 }
      : { y: ist.getUTCFullYear(), m: ist.getUTCMonth() };
  return (
    <main>
      <p>
        <Link href="/fleet">Fleet</Link> · <Link href="/firms">Firms</Link>
      </p>
      <h1>Billing</h1>
      <p>Drafts are made automatically on the 1st; issuing needs the GSTIN configured.</p>
      <RunMonthForm year={prev.y} month={prev.m} />
      <h2>Invoices</h2>
      {board.invoices.length === 0 ? (
        <p>No invoices yet.</p>
      ) : (
        <table cellPadding={6}>
          <thead>
            <tr>
              <th align="left">Firm</th>
              <th align="left">Month from</th>
              <th align="left">Number</th>
              <th align="left">Due</th>
              <th align="right">Total</th>
              <th align="left">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {board.invoices.map((i) => (
              <tr key={i.id}>
                <td>
                  <Link href={`/firms/${i.firmId}`}>{i.firm}</Link>
                </td>
                <td>{day(i.periodStart)}</td>
                <td>{i.number ?? "draft"}</td>
                <td>{i.dueOn ? day(i.dueOn) : "-"}</td>
                <td align="right">{formatINR(BigInt(i.totalPaise), { showPaise: true })}</td>
                <td>{i.status}</td>
                <td>
                  {i.status === "draft" && <IssueButton invoiceId={i.id} />}
                  {i.status === "issued" && <PaymentForm invoiceId={i.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <OverrideForm firms={board.firms} />
      <h2>Firm statuses</h2>
      <ul>
        {board.firms.map((f) => (
          <li key={f.id}>
            {f.name}: {f.status}
          </li>
        ))}
      </ul>
      <RefreshButton />
    </main>
  );
}
