import { redirect } from "next/navigation";
import { pageSession } from "./firms/session";

export const dynamic = "force-dynamic";

/** Staff land on the fleet board; a firm admin lands on their firm. */
export default async function HomePage() {
  const { session } = await pageSession();
  redirect(session.principal.kind === "console" ? "/fleet" : `/firms/${session.principal.firmId}`);
}
