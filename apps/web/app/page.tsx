import { BrandLogo } from "./components/brand-logo";
import { WorkflowList } from "./components/workflow-list";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <BrandLogo />
        <span>فضای کاری محتوا</span>
      </header>
      <WorkflowList />
    </main>
  );
}
