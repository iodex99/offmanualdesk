// One firm: employees, servers' enrolment, settings, skill packs and invoices.
// Every loader checks the session's access to this firm on the server.
import Link from "next/link";
import { formatDate, formatINR } from "@offmanual/shared-schema/format";
import { firmOverview, listEmployees } from "@/lib/admin";
import { listInvoices } from "@/lib/billing/admin";
import {
  AddEmployeeForm,
  EmployeeStatusButton,
  EnrolmentCodeForm,
  PackGrantForm,
  PolicyForm,
} from "../forms";
import { load, pageSession } from "../session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function FirmPage({ params }: { params: Promise<{ firmId: string }> }) {
  const { firmId } = await params;
  if (!UUID.test(firmId)) return <p>That firm doesn't exist.</p>;
  const { deps, session } = await pageSession();
  const overview = await load(() => firmOverview(deps, session, firmId));
  if (overview === "forbidden") return <p>You don't have access to this firm.</p>;
  const people = await listEmployees(deps, session, firmId);
  const { invoices } = await listInvoices(deps, session, firmId);
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return (
    <main>
      <p>
        <Link href="/firms">All firms</Link>
      </p>
      <h1>{overview.firm.name}</h1>
      <p>Status: {overview.firm.status}</p>

      <section>
        <h2>Employees</h2>
        {people.length === 0 ? (
          <p>No employees yet.</p>
        ) : (
          <table cellPadding={6}>
            <thead>
              <tr>
                <th align="left">Name</th>
                <th align="left">Email</th>
                <th align="left">Status</th>
                <th align="left">Signed in on Desk</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.email}</td>
                  <td>{p.status}</td>
                  <td>{p.boundAt ? formatDate(p.boundAt) : "not yet"}</td>
                  <td>
                    <EmployeeStatusButton firmId={firmId} employeeId={p.id} status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <AddEmployeeForm firmId={firmId} />
      </section>

      <section>
        <h2>Skill packs</h2>
        {overview.grants.length === 0 ? (
          <p>No packs given yet.</p>
        ) : (
          <ul>
            {overview.grants.map((g) => (
              <li key={g.id}>
                {overview.packs.find((p) => p.key === g.packKey)?.name ?? g.packKey} →{" "}
                {g.adGroup ? `AD group ${g.adGroup}` : (nameOf.get(g.employeeId ?? "") ?? "employee")}
              </li>
            ))}
          </ul>
        )}
        <PackGrantForm
          firmId={firmId}
          packs={overview.packs}
          employees={people.map((p) => ({ id: p.id, name: p.name }))}
        />
      </section>

      {overview.policy && (
        <section>
          <h2>Settings</h2>
          <PolicyForm firmId={firmId} policy={overview.policy} />
        </section>
      )}

      {overview.isStaff && (
        <section>
          <h2>Servers</h2>
          <EnrolmentCodeForm firmId={firmId} />
        </section>
      )}

      <section>
        <h2>Invoices</h2>
        {invoices.length === 0 ? (
          <p>No invoices yet.</p>
        ) : (
          <table cellPadding={6}>
            <thead>
              <tr>
                <th align="left">Number</th>
                <th align="left">Period</th>
                <th align="left">Due</th>
                <th align="right">Total</th>
                <th align="left">Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.number ?? "draft"}</td>
                  <td>
                    {formatDate(new Date(`${i.periodStart}T00:00:00+05:30`))} to{" "}
                    {formatDate(new Date(`${i.periodEnd}T00:00:00+05:30`))}
                  </td>
                  <td>{i.dueOn ? formatDate(new Date(`${i.dueOn}T00:00:00+05:30`)) : "-"}</td>
                  <td align="right">{formatINR(BigInt(i.totalPaise), { showPaise: true })}</td>
                  <td>{i.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
