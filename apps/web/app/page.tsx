const steps = [
  "ساخت Workflow",
  "Run",
  "Content Studio",
  "Approval",
  "Calendar / Publish",
  "Analytics / Reports",
];

export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <strong>SocialYar</strong>
        <span>MVP Foundation</span>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">AI-native social automation</p>
          <h1>هستهٔ MVP سوشال‌یار</h1>
          <p className="muted">
            مسیر اصلی محصول از ساخت Workflow تا تحلیل عملکرد، با معماری آماده برای Agent، Approval و Publish.
          </p>
        </div>
        <button>ساخت جریان با هوش مصنوعی</button>
      </section>
      <section className="grid">
        {steps.map((step, index) => (
          <article className="card" key={step}>
            <span className="index">0{index + 1}</span>
            <h2>{step}</h2>
            <p>آماده برای اتصال به API و Workflow Runtime.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
