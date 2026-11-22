// Employee sign-in to link Off Manual Desk to their Windows account (ARCHITECTURE F2).
const ERRORS: Record<string, string> = {
  expired: "That sign-in took too long or was interrupted. Please try again.",
  provider: "We couldn't complete sign-in with that provider. Please try again, or use the other option.",
};

export const dynamic = "force-dynamic";

export default async function BindPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error ? (ERRORS[error] ?? ERRORS.provider) : null;
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Set up Off Manual Desk</h1>
      <p>Sign in with the work email your firm invited. You'll get a code to type into Off Manual Desk.</p>
      {message && (
        <p role="alert" style={{ background: "#fff4e5", padding: "0.75rem", borderRadius: 6 }}>
          {message}
        </p>
      )}
      <p>
        <a href="/bind/login/google">Continue with Google</a>
      </p>
      <p>
        <a href="/bind/login/microsoft">Continue with Microsoft</a>
      </p>
    </main>
  );
}
