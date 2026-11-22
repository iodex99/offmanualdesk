// OIDC sign-in with Google and Microsoft Entra (openid-client v6: discovery,
// buildAuthorizationUrl, authorizationCodeGrant with PKCE + state + nonce).
// The provider sits behind an interface so tests use a fake; real client IDs come
// from env (PROGRESS.md "Waiting on Dwahnil").
import * as client from "openid-client";

export type ProviderName = "google" | "microsoft";

export interface VerifiedIdentity {
  email: string;
  subject: string;
  provider: ProviderName;
}

export interface LoginStart {
  url: string;
  /** Opaque values to keep in a short-lived HttpOnly cookie until the callback. */
  state: string;
  nonce: string;
  verifier: string;
}

export interface IdentityProvider {
  name: ProviderName;
  start(redirectUri: string): Promise<LoginStart>;
  finish(
    callbackUrl: URL,
    expected: { state: string; nonce: string; verifier: string },
  ): Promise<VerifiedIdentity>;
}

const ISSUERS: Record<ProviderName, (env: NodeJS.ProcessEnv) => string> = {
  google: () => "https://accounts.google.com",
  microsoft: (env) => `https://login.microsoftonline.com/${env.MICROSOFT_TENANT || "common"}/v2.0`,
};

export function providerFromEnv(name: ProviderName, env: NodeJS.ProcessEnv = process.env): IdentityProvider {
  const id = name === "google" ? env.GOOGLE_CLIENT_ID : env.MICROSOFT_CLIENT_ID;
  const secret = name === "google" ? env.GOOGLE_CLIENT_SECRET : env.MICROSOFT_CLIENT_SECRET;
  if (!id || !secret) throw new Error(`${name} sign-in is not configured`);
  let config: client.Configuration | undefined;
  const cfg = async () => (config ??= await client.discovery(new URL(ISSUERS[name](env)), id, secret));
  return {
    name,
    async start(redirectUri) {
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(await cfg(), {
        redirect_uri: redirectUri,
        scope: "openid email profile",
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
        prompt: "select_account",
      });
      return { url: url.href, state, nonce, verifier };
    },
    async finish(callbackUrl, expected) {
      const tokens = await client.authorizationCodeGrant(await cfg(), callbackUrl, {
        pkceCodeVerifier: expected.verifier,
        expectedState: expected.state,
        expectedNonce: expected.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error("no id_token claims");
      const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
      // Google sets email_verified; Entra work accounts are verified by the tenant.
      const verified = name === "microsoft" || claims.email_verified === true;
      if (!email || !verified) throw new Error("email not verified by the identity provider");
      return { email, subject: String(claims.sub), provider: name };
    },
  };
}
