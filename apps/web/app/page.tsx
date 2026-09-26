import { BrandLogo } from "./components/brand-logo";
import { WorkflowList } from "./components/workflow-list";
import { TopMenu } from "./components/top-menu";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <BrandLogo />
        <TopMenu />
        <span>فضای کاری محتوا</span>
      </header>
      <WorkflowList />
    </main>
  );
}
