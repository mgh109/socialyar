import type { ReactNode } from "react";
import { AuthGate } from "./components/auth-gate";
import "./styles.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
