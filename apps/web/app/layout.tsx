import type { ReactNode } from "react";
import localFont from "next/font/local";
import { AuthGate } from "./components/auth-gate";
import "./styles.css";
import { ThemeToggle } from "./components/theme-toggle";

const estedad = localFont({
  src: "../public/fonts/Estedad/Estedad-VF.woff2",
  variable: "--font-estedad",
  weight: "100 900",
  style: "normal",
  display: "swap",
});

export const metadata = { title: "هور+ | مدیریت جریان محتوا", description: "ساخت و مدیریت جریان‌های تولید و انتشار محتوا" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className={estedad.variable}>
      <body>
        <AuthGate>{children}</AuthGate>
        <ThemeToggle />
      </body>
    </html>
  );
}
