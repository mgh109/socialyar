import type { ReactNode } from "react";
import localFont from "next/font/local";
import { AuthGate } from "./components/auth-gate";
import "./styles.css";
import { AccountMenu } from "./components/account-menu";

const estedad = localFont({
  src: [
    { path: "../public/fonts/Estedad/Estedad-Thin.woff2", weight: "100", style: "normal" },
    { path: "../public/fonts/Estedad/Estedad-Light.woff2", weight: "300", style: "normal" },
    { path: "../public/fonts/Estedad/Estedad-Medium.woff2", weight: "500", style: "normal" },
    { path: "../public/fonts/Estedad/Estedad-Bold.woff2", weight: "700", style: "normal" },
    { path: "../public/fonts/Estedad/Estedad-Black.woff2", weight: "900", style: "normal" },
  ],
  variable: "--font-estedad",
  style: "normal",
  display: "swap",
});

export const metadata = { icons: { icon: "/logo.png", shortcut: "/logo.png", apple: "/logo.png" }, title: "هور+ | مدیریت جریان محتوا", description: "ساخت و مدیریت جریان‌های تولید و انتشار محتوا" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className={estedad.variable}>
      <body>
        <AuthGate>{children}</AuthGate>
        <AccountMenu />
      </body>
    </html>
  );
}
