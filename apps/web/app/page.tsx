import Link from "next/link";
import { WorkflowList } from "./components/workflow-list";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <strong>هور+</strong>
        <span>فضای کاری محتوا</span>
      </header>
      <WorkflowList />
      <nav className="workflow-shortcuts" aria-label="بخش‌های هور+">
        <Link href="/approvals">تأیید محتوا</Link>
        <Link href="/calendar">تقویم انتشار</Link>
        <Link href="/connections">اتصال کانال‌ها</Link>
        <Link href="/analytics">گزارش‌ها</Link>
      </nav>
    </main>
  );
}
