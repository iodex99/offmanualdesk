import { formatDate, fyLabel } from "@offmanual/shared-schema/format";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const now = new Date();
  return (
    <main>
      <h1>Off Manual Console</h1>
      <p>Sign-in, firms, servers and billing arrive in milestone M3.</p>
      <p>
        Today is {formatDate(now)} ({fyLabel(now)}).
      </p>
    </main>
  );
}
