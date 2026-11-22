const ERRORS: Record<string, string> = {
  "not-registered":
    "This account isn't set up for the Off Manual console. Ask Off Manual (or your firm's owner) to add your email.",
  expired: "That sign-in took too long or was interrupted. Please try again.",
  provider: "We couldn't complete sign-in with that provider. Please try again, or use the other option.",
};

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error ? (ERRORS[error] ?? ERRORS.provider) : null;
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Sign in to Off Manual</h1>
      <p>Use the work account your firm or Off Manual registered for you.</p>
      {message && (
        <p role="alert" style={{ background: "#fff4e5", padding: "0.75rem", borderRadius: 6 }}>
          {message}
        </p>
      )}
      <p>
        <a href="/auth/login/google">Continue with Google</a>
      </p>
      <p>
        <a href="/auth/login/microsoft">Continue with Microsoft</a>
      </p>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Next you'll enter a 6-digit code from your authenticator app. This step is always required.
      </p>
    </main>
  );
}
