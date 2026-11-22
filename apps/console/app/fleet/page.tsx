import Link from "next/link";
import { formatDate } from "@offmanual/shared-schema/format";
import { fleet } from "@/lib/admin";
import { load, pageSession } from "../firms/session";

export const dynamic = "force-dynamic";

const DOT: Record<string, string> = { green: "#1a7f37", amber: "#b26a00", red: "#c62828" };

/** Fleet board v1 (M10): every server, health, versions, seats, recent problem reports. */
export default async function FleetPage() {
  const { deps, session } = await pageSession();
  const rows = await load(() => fleet(deps, session));
  if (rows === "forbidden") return <p>Only Off Manual staff can see the fleet.</p>;
  const red = rows.filter((r) => r.health === "red").length;
  return (
    <main style={{ fontFamily: "system-ui, sans-serif" }}>
      <p>
        <Link href="/firms">Firms</Link> · <Link href="/billing">Billing</Link> ·{" "}
        <Link href="/support">Problem reports</Link> · <Link href="/releases">Releases</Link>
      </p>
      <h1>Fleet</h1>
      <p>
        {rows.length} server{rows.length === 1 ? "" : "s"}, {red} not healthy.
      </p>
      {rows.length === 0 ? (
        <p>No servers enrolled yet. Create a firm, then an enrolment code for its server.</p>
      ) : (
        <table cellPadding={6}>
          <thead>
            <tr>
              <th align="left">Firm</th>
              <th align="left">Firm status</th>
              <th align="left">Server</th>
              <th align="left">Health</th>
              <th align="left">Last seen</th>
              <th align="left">Agent</th>
              <th align="left">OpenClaw</th>
              <th align="left">Desk</th>
              <th align="left">Staged</th>
              <th align="right">Seats</th>
              <th align="right">Reports (7 days)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.serverId}>
                <td>
                  <Link href={`/firms/${r.firmId}`}>{r.firm}</Link>
                </td>
                <td>{r.firmStatus}</td>
                <td>{r.hostname}</td>
                <td>
                  <span style={{ color: DOT[r.health] }}>●</span> {r.health}
                </td>
                <td>{r.lastHeartbeatAt ? formatDate(r.lastHeartbeatAt) : "never"}</td>
                <td>{r.agentVersion ?? "-"}</td>
                <td>{r.openclawVersion ?? "-"}</td>
                <td>{r.deskVersion ?? "-"}</td>
                <td>{r.stagedVersion ?? "-"}</td>
                <td align="right">{r.activeSeats}</td>
                <td align="right">{r.reports7d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
