// Session helper for server-rendered console pages: unsigned-in visitors go to /sign-in.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, getSession, SESSION_COOKIE } from "@/lib/auth";
import { routeDeps } from "@/lib/deps";

export async function pageSession() {
  const deps = routeDeps();
  const session = await getSession(deps, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!session?.mfa) redirect(session ? "/sign-in/totp" : "/sign-in");
  return { deps, session };
}

/** Runs a loader; a 401 sends the visitor to sign in, a 403 shows a plain page. */
export async function load<T>(fn: () => Promise<T>): Promise<T | "forbidden"> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthError && e.status === 401) redirect("/sign-in");
    if (e instanceof AuthError && e.status === 403) return "forbidden";
    throw e;
  }
}
