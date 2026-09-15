import Link from "next/link";

const steps = [
  ["01", "ساخت Workflow", "تعریف جریان با پرامپت و ذخیره نسخه‌ها"],
  ["02", "Run", "اجرای مرحله‌به‌مرحله و گزارش زنده"],
  ["03", "Content Studio", "ویرایش خروجی و ساخت نسخه کانال‌ها"],
  ["04", "Approval", "تأیید فقط برای موارد حساس"],
  ["05", "Calendar / Publish", "زمان‌بندی و انتشار"],
  ["06", "Analytics / Reports", "تحلیل عملکرد و پیشنهاد Agent"],
];

export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <strong>SocialYar</strong>
        <span>AI-native Social Automation</span>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Workflow-first content operations</p>
          <h1>از ایده تا انتشار، با یک جریان قابل کنترل</h1>
          <p className="muted">
            جریان را با زبان طبیعی بساز، Run را زنده ببین، فقط جایی که لازم است تأیید کن و نتیجه را تحلیل کن.
          </p>
        </div>
        <Link className="primary-link" href="/workflows/new">
          ساخت جریان با هوش مصنوعی
        </Link>
      </section>

      <section className="grid">
        {steps.map(([index, title, description]) => (
          <article className="card" key={title}>
            <span className="index">{index}</span>
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
