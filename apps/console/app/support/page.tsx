// Problem reports from Desk (ARCHITECTURE F11, ADR-050). Off Manual staff only.
import Link from "next/link";
import { formatDate } from "@offmanual/shared-schema/format";
import { listTickets } from "@/lib/support";
import { load, pageSession } from "../firms/session";

export const dynamic = "force-dynamic";

export default async function SupportPage() {
  const { deps, session } = await pageSession();
  const tickets = await load(() => listTickets(deps, session));
  if (tickets === "forbidden") return <p>Only Off Manual staff can see problem reports.</p>;
  return (
    <main>
      <p>
        <Link href="/fleet">Fleet</Link> · <Link href="/firms">Firms</Link> ·{" "}
        <Link href="/billing">Billing</Link>
      </p>
      <h1>Problem reports</h1>
      {tickets.length === 0 ? (
        <p>No reports yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {tickets.map((t) => (
            <li
              key={t.ref ?? String(t.createdAt)}
              style={{ borderTop: "1px solid #ddd", padding: "0.5rem 0" }}
            >
              <strong>{t.ref}</strong> · {t.firm}
              {t.employee ? ` · ${t.employee}` : ""} · {formatDate(t.createdAt)} · {t.status}
              <p>{t.description}</p>
              <details>
                <summary>Details sent by the server</summary>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem" }}>
                  {JSON.stringify(t.bundle, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
