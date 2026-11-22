// Production dependencies for route handlers.
import type { RouteDeps } from "./auth-routes";
import { getDb } from "./db";
import { mailerFromEnv } from "./email";
import { providerFromEnv, type IdentityProvider, type ProviderName } from "./oidc";
import { loadKey } from "./secretbox";

let providers: Partial<Record<ProviderName, IdentityProvider>> | undefined;

function configuredProviders() {
  if (!providers) {
    providers = {};
    for (const name of ["google", "microsoft"] as const) {
      try {
        providers[name] = providerFromEnv(name);
      } catch {
        // Not configured yet (PROGRESS.md "Waiting on Dwahnil"); that button shows an error.
      }
    }
  }
  return providers;
}

export function routeDeps(): RouteDeps {
  const baseUrl = process.env.OM_CONSOLE_URL ?? "http://localhost:3000";
  return {
    db: getDb(),
    now: () => new Date(),
    dataKey: loadKey(),
    mailer: mailerFromEnv(),
    providers: configuredProviders(),
    baseUrl,
    secureCookies: baseUrl.startsWith("https://"),
  };
}
