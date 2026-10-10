type GoalStep = { key: string; type: string; name: string; config: Record<string, unknown>; position: { x: number; y: number } };
type GoalConnection = { sourceKey: string; targetKey: string };
type WorkflowGoal = { name: string; description: string; hint: string; steps: GoalStep[]; connections: GoalConnection[] };

export const workflowGoalOptions = [
  { id: "collection", title: "انتشار محتوای آماده", description: "محتوا را از اکسل یا گوگل‌شیت وارد کن، برای هر مقصد بررسی کن و زمان انتشار را تعیین کن." },
  { id: "news", title: "پایش و بازنویسی خبر", description: "خبر را از خوراک RSS بگیر، با هوش مصنوعی بازنویسی کن و پیش از ادامه بررسی کن." },
  { id: "comments", title: "تحلیل کامنت‌ها", description: "کامنت‌ها را از API سایت بخوان و گزارش بازخورد بگیر؛ این مسیر پاسخی ارسال نمی‌کند." },
] as const;

export function getWorkflowGoal(goal: string | null): WorkflowGoal | null {
  const step = (key: string, type: string, name: string, config: Record<string, unknown>, index: number): GoalStep =>
    ({ key, type, name, config, position: { x: 800 - index * 250, y: 120 } });
  const connect = (keys: string[]): GoalConnection[] => keys.slice(1).map((key, index) => ({ sourceKey: keys[index], targetKey: key }));
  if (goal === "collection") return {
    name: "انتشار محتوای آماده", description: workflowGoalOptions[0].description,
    hint: "اول حساب مقصد را در کارت انتشار انتخاب و جریان را ذخیره کن. سپس از کارت مجموعه، اکسل یا گوگل‌شیت را وارد و تغییرات را بررسی کن. تأیید ورود محتوا با تأیید انتشار جداست؛ خروجی‌ها را در تقویم بررسی کن.",
    steps: [step("collection", "collection_source", "مجموعه از اکسل / گوگل‌شیت", { collectionSource: "excel", sheetAutoRefresh: false }, 0),
      step("publish", "publish", "انتشار", { accountId: "", publishIntervalSeconds: 30 }, 1)],
    connections: connect(["collection", "publish"]),
  };
  if (goal === "news") return {
    name: "پایش و بازنویسی خبر", description: workflowGoalOptions[1].description,
    hint: "آدرس خوراک RSS و سرویس هوش مصنوعی را تنظیم کن. خروجی پس از بررسی تو در پیش‌نویس می‌ماند؛ برای ارسال به حساب مقصد، کارت پیش‌نویس را با انتشار جایگزین کن. فعال‌کردن پایش به معنی انتشار موفق نیست.",
    steps: [step("source", "rss_source", "خوراک خبر", { sourceKind: "rss", feedUrl: "" }, 0),
      step("rewrite", "ai", "بازنویسی خبر", { profileId: "default", aiMode: "rewrite" }, 1),
      step("review", "human_approval", "بررسی محتوا", {}, 2), step("draft", "draft", "پیش‌نویس خبر", {}, 3)],
    connections: connect(["source", "rewrite", "review", "draft"]),
  };
  if (goal === "comments") return {
    name: "تحلیل کامنت‌ها", description: workflowGoalOptions[2].description,
    hint: "در کارت منبع، اتصال API و مسیر و فیلدهای واقعی سایتت را وارد و خواندن را آزمایش کن؛ سپس سرویس هوش مصنوعی را انتخاب کن. نتیجه در پیش‌نویس و صفحه اجرای جریان دیده می‌شود. این الگو کامنتی را تأیید، رد یا پاسخ نمی‌دهد.",
    steps: [step("comments", "api_source", "کامنت‌های سایت", { connectionId: "", path: "", itemsPath: "", idField: "id", textField: "text", contextField: "context", readMode: "batch", batchLimit: 10, includeIndividual: false }, 0),
      step("feedback", "ai", "تحلیل بازخورد", { profileId: "default", aiMode: "feedback" }, 1),
      step("report", "draft", "گزارش کامنت‌ها", {}, 2)],
    connections: connect(["comments", "feedback", "report"]),
  };
  return null;
}
