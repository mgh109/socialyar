import Link from "next/link";
import { workflowGoalOptions } from "./workflow-goals";

export function WorkflowStart() {
  return <section className="workflow-start" aria-labelledby="workflow-start-title">
    <h2 id="workflow-start-title">برای چه کاری جریان می‌سازی؟</h2>
    <p>یک مسیر آماده انتخاب کن و تنظیمات خودت را کامل کن. تا ذخیره و فعال‌کردن، کاری اجرا نمی‌شود.</p>
    <div className="workflow-start-grid">
      {workflowGoalOptions.map((goal) => <Link className="card workflow-start-card" key={goal.id} href={`/workflows/new?goal=${goal.id}`}>
        <h3>{goal.title}</h3><p>{goal.description}</p><span>شروع این مسیر ←</span>
      </Link>)}
    </div>
    <div className="workflow-start-actions">
      <Link className="ghost-button" href="/workflows/new">بوم خالی · ساخت حرفه‌ای</Link>
      <Link className="ghost-button" href="/workflows/new?ai=1">ساخت جریان با هوش مصنوعی</Link>
    </div>
  </section>;
}
