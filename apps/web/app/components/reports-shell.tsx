import type { ReactNode } from "react";
import Link from "next/link";
import { BrandLogo } from "./brand-logo";
const sections = [
  { id: "publications", href: "/analytics", label: "انتشارها" },
  { id: "comments", href: "/analytics/comments", label: "کامنت‌ها و پاسخ‌ها" },
  { id: "usage", href: "/analytics/usage", label: "مصرف هوش مصنوعی" },
];
export function ReportsShell({
  active,
  title,
  description,
  children,
  actions,
}: {
  active: string;
  title: string;
  description: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <BrandLogo />
          <span>گزارش‌ها</span>
        </div>
        <div className="header-actions">
          {actions}
          <Link className="ghost-link" href="/calendar">
            تقویم انتشار
          </Link>
        </div>
      </header>
      <section className="analytics-shell">
        <nav className="report-tabs" aria-label="بخش‌های گزارش">
          {sections.map((section) => (
            <Link
              key={section.id}
              href={section.href}
              aria-current={active === section.id ? "page" : undefined}
            >
              {section.label}
            </Link>
          ))}
        </nav>
        <div className="analytics-heading">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {children}
      </section>
    </main>
  );
}
