// Superadmin releases board (UPDATES §2 rings, §4 rollback by pin; ADR-057).
import Link from "next/link";
import { formatDate } from "@offmanual/shared-schema/format";
import { releasesBoard } from "@/lib/releases";
import { load, pageSession } from "../firms/session";
import { FirmRolloutForm, PromoteButtons } from "./forms";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const { deps, session } = await pageSession();
  const board = await load(() =>
    releasesBoard(
      { db: deps.db, now: deps.now, allowUnsigned: process.env.OM_ALLOW_UNSIGNED_RELEASES === "true" },
      session,
    ),
  );
  if (board === "forbidden") return <p>Only a superadmin can manage releases.</p>;
  const versions = board.releases.map((r) => r.version);
  return (
    <main>
      <p>
        <Link href="/fleet">Fleet</Link> · <Link href="/firms">Firms</Link> ·{" "}
        <Link href="/billing">Billing</Link>
      </p>
      <h1>Releases</h1>
      <p>
        New releases arrive in ring 0 (lab). Ring 1 is the pilot firms, ring 2 everyone.{" "}
        {board.allowUnsigned
          ? "Unsigned releases may leave the lab ring (OM_ALLOW_UNSIGNED_RELEASES is on)."
          : "Only Authenticode-signed releases can leave the lab ring."}
      </p>
      {board.releases.length === 0 ? (
        <p>No releases registered yet.</p>
      ) : (
        <table cellPadding={6}>
          <thead>
            <tr>
              <th align="left">Version</th>
              <th align="left">Made</th>
              <th align="left">Kind</th>
              <th align="left">Signed</th>
              <th align="left">Rings</th>
              <th align="right">Running</th>
              <th align="right">Staged</th>
              <th align="left">Move</th>
            </tr>
          </thead>
          <tbody>
            {board.releases.map((r) => (
              <tr key={r.version}>
                <td>{r.version}</td>
                <td>{formatDate(r.createdAt)}</td>
                <td>
                  {r.severity === "security"
                    ? `Security${r.deadlineAt ? `, by ${formatDate(r.deadlineAt)}` : ""}`
                    : "Normal"}
                </td>
                <td>{r.authenticode ? "Yes" : "No"}</td>
                <td>{r.rings.join(", ")}</td>
                <td align="right">{r.running}</td>
                <td align="right">{r.staged}</td>
                <td>
                  <PromoteButtons version={r.version} rings={r.rings} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Firms</h2>
      <p>
        A pin keeps a firm on one version whatever its ring. To roll a firm back, pin it to the previous
        version; clear the pin when the fix is out.
      </p>
      {board.firms.length === 0 ? (
        <p>No firms yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {board.firms.map((f) => (
            <li key={f.id} style={{ borderTop: "1px solid #ddd", padding: "0.5rem 0" }}>
              <Link href={`/firms/${f.id}`}>{f.name}</Link> · {f.status} ·{" "}
              <FirmRolloutForm firmId={f.id} ring={f.ring} pin={f.pin} versions={versions} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
