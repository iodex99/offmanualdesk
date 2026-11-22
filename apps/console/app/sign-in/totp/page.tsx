import { TotpForm } from "./totp-form";

export const dynamic = "force-dynamic";

export default function TotpPage() {
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Enter your code</h1>
      <TotpForm />
    </main>
  );
}
