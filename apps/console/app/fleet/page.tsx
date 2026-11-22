import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { formatDate } from "@offmanual/shared-schema/format";
import { fleet } from "@/lib/admin";
import { AuthError, getSession, SESSION_COOKIE } from "@/lib/auth";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";

const DOT: Record<string, string> = { green: "#1a7f37", amber: "#b26a00", red: "#c62828" };

export default async function FleetPage() {
  const deps = routeDeps();
  const session = await getSession(deps, (await cookies()).get(SESSION_COOKIE)?.value);
  let rows;
  try {
    rows = await fleet(deps, session);
  } catch (e) {
    if (e instanceof AuthError && e.status === 401) redirect("/sign-in");
    throw e;
  }
  return (
    <main style={{ fontFamily: "system-ui, sans-serif" }}>
      <h1>Fleet</h1>
      {rows.length === 0 ? (
        <p>No servers enrolled yet. Create a firm, then an enrolment code for its server.</p>
      ) : (
        <table cellPadding={6}>
          <thead>
            <tr>
              <th align="left">Firm</th>
              <th align="left">Server</th>
              <th align="left">Status</th>
              <th align="left">Last seen</th>
              <th align="left">Version</th>
              <th align="right">Active seats</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.serverId}>
                <td>{r.firm}</td>
                <td>{r.hostname}</td>
                <td>
                  <span style={{ color: DOT[r.health] }}>●</span> {r.health}
                </td>
                <td>{r.lastHeartbeatAt ? formatDate(r.lastHeartbeatAt) : "never"}</td>
                <td>{r.agentVersion ?? "-"}</td>
                <td align="right">{r.activeSeats}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
