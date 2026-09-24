import type { ReactNode } from "react";
import { AuthGate } from "./components/auth-gate";
import "./styles.css";
import { ThemeToggle } from "./components/theme-toggle";

export const metadata = { title: "هور+ | مدیریت جریان محتوا", description: "ساخت و مدیریت جریان‌های تولید و انتشار محتوا" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>
        <AuthGate>{children}</AuthGate>
        <ThemeToggle />
      </body>
    </html>
  );
}
