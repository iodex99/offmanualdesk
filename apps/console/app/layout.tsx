import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Off Manual Console",
  description: "Manage firms, servers, employees, releases and billing for Off Manual Desk.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem" }}>{children}</body>
    </html>
  );
}
