import Link from "next/link";
import { listFirms } from "@/lib/admin";
import { CreateFirmForm } from "./forms";
import { load, pageSession } from "./session";

export const dynamic = "force-dynamic";

export default async function FirmsPage() {
  const { deps, session } = await pageSession();
  const firms = await load(() => listFirms(deps, session));
  if (firms === "forbidden") return <p>You don't have access to this page.</p>;
  const staff = session.principal.kind === "console";
  return (
    <main>
      <h1>Firms</h1>
      {staff && (
        <p>
          <Link href="/fleet">Fleet board</Link>
        </p>
      )}
      {firms.length === 0 ? (
        <p>No firms yet.</p>
      ) : (
        <ul>
          {firms.map((f) => (
            <li key={f.id}>
              <Link href={`/firms/${f.id}`}>{f.name}</Link> ({f.status})
            </li>
          ))}
        </ul>
      )}
      {staff && <CreateFirmForm />}
    </main>
  );
}
