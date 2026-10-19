import { z } from "zod";

export const instagramCards = [
  {
    type: "instagram_publish",
    label: "انتشار اینستاگرام",
    description: "پست، آلبوم، ریلز و استوری",
    source: false,
    ai: false,
  },
  {
    type: "instagram_comments",
    label: "خواندن کامنت اینستاگرام",
    description: "کامنت‌های جدید پست‌های پیج",
    source: true,
    ai: false,
  },
  {
    type: "instagram_action",
    label: "اقدام روی کامنت اینستاگرام",
    description: "پاسخ، مخفی‌کردن یا ارجاع به مدیر",
    source: false,
    ai: true,
  },
  {
    type: "instagram_analysis",
    label: "تحلیل پیج اینستاگرام",
    description: "عملکرد محتوا و پیشنهاد رشد",
    source: true,
    ai: true,
  },
  {
    type: "instagram_inbox",
    label: "پشتیبانی دایرکت اینستاگرام",
    description: "پاسخ از دانش کسب‌وکار با تأیید شما",
    source: true,
    ai: true,
  },
  {
    type: "instagram_trends",
    label: "رصد سوژه و ترند اینستاگرام",
    description: "مقایسه منابع منتخب و کشف سوژه",
    source: true,
    ai: false,
  },
  {
    type: "instagram_ideas",
    label: "ایده‌پردازی محتوا",
    description: "ایده‌های متناسب با برند و مخاطب",
    source: false,
    ai: true,
  },
  {
    type: "instagram_script",
    label: "سناریونویسی محتوا",
    description: "متن گوینده و صحنه‌های زمان‌بندی‌شده",
    source: false,
    ai: true,
  },
  {
    type: "instagram_content",
    label: "تولید محتوای اینستاگرام",
    description: "کپشن، اسلاید و کاور قابل انتشار",
    source: false,
    ai: true,
  },
] as const;
export type InstagramCardType = (typeof instagramCards)[number]["type"];
export const instagramSources = instagramCards
  .filter((c) => c.source)
  .map((c) => c.type as string);
export const instagramAITypes = instagramCards
  .filter((c) => c.ai)
  .map((c) => c.type as string);
export const isInstagramCard = (type: string) =>
  instagramCards.some((c) => c.type === type);
const id = z.string().regex(/^\d{1,100}$/, "شناسه اینستاگرام معتبر نیست.");
const profileId = z
  .union([z.literal("default"), z.string().uuid()])
  .default("default");
const common = {
  connection: z.unknown().optional(),
  profileId,
  instructions: z.string().max(4000).default(""),
  brand: z.string().max(3000).default(""),
  audience: z.string().max(1000).default(""),
  goal: z.string().max(1000).default(""),
  tone: z.string().max(200).default("صمیمی و حرفه‌ای"),
};
const account = {
  connection: z.unknown().optional(),
  accountId: z.string().uuid(),
  batchLimit: z.number().int().min(1).max(50).default(20),
};
const creative = z.object({
  ...common,
  format: z.enum(["reel", "carousel", "story", "image"]).default("reel"),
  count: z.number().int().min(1).max(10).default(3),
  seconds: z.number().int().min(5).max(180).default(30),
  face: z.boolean().default(false),
  production: z.enum(["existing", "filming"]).default("existing"),
  budget: z.string().max(300).default("کم"),
  generateImage: z.boolean().default(false),
  imageProfileId: profileId,
  dailyLimit: z.number().int().min(1).max(100).default(10),
  estimatedCostMicros: z.number().int().min(1).max(10000000).default(100000),
});
export const instagramConfigSchemas = {
  instagram_comments: z.object({
    ...account,
    mediaId: id.or(z.literal("")).default(""),
    after: z.string().datetime().or(z.literal("")).default(""),
  }),
  instagram_action: z.object({
    ...common,
    accountId: account.accountId,
    action: z.enum(["reply", "hide", "review"]).default("reply"),
    requireApproval: z.boolean().default(true),
    dailyLimit: z.number().int().min(1).max(100).default(20),
    context: z.string().max(6000).default(""),
  }),
  instagram_analysis: z.object({
    ...account,
    ...common,
    days: z.number().int().min(7).max(90).default(28),
  }),
  instagram_inbox: z.object({
    ...account,
    ...common,
    context: z.string().max(6000).default(""),
    requireApproval: z.boolean().default(true),
    dailyLimit: z.number().int().min(1).max(100).default(20),
    mode: z.enum(["draft", "reply"]).default("draft"),
  }),
  instagram_trends: z.object({
    ...common,
    accountId: account.accountId.or(z.literal("")).default(""),
    usernames: z
      .array(z.string().regex(/^[A-Za-z0-9_.]{1,30}$/))
      .max(5)
      .default([]),
    references: z.string().max(12000).default(""),
    batchLimit: account.batchLimit,
  }),
  instagram_ideas: creative,
  instagram_script: creative,
  instagram_content: creative,
};
export function parseInstagramConfig(
  type: string,
  raw: unknown,
): Record<string, unknown> {
  const schema =
    instagramConfigSchemas[type as keyof typeof instagramConfigSchemas];
  if (!schema) throw new Error("نوع کارت اینستاگرام معتبر نیست.");
  return schema.parse(raw);
}
export function defaultInstagramConfig(type: string): Record<string, unknown> {
  const common = {
    profileId: "default",
    brand: "",
    audience: "",
    goal: "",
    instructions: "",
    tone: "صمیمی و حرفه‌ای",
  };
  if (type === "instagram_publish")
    return {
      accountId: "",
      channelLock: "instagram",
      publishIntervalSeconds: 30,
      instagramType: "image",
      instagramRequireApproval: true,
    };
  if (type === "instagram_comments")
    return { accountId: "", batchLimit: 20, mediaId: "", after: "" };
  if (type === "instagram_action")
    return {
      ...common,
      accountId: "",
      action: "reply",
      requireApproval: true,
      dailyLimit: 20,
      context: "",
    };
  if (type === "instagram_analysis")
    return { ...common, accountId: "", batchLimit: 20, days: 28 };
  if (type === "instagram_inbox")
    return {
      ...common,
      accountId: "",
      batchLimit: 20,
      context: "",
      mode: "draft",
      requireApproval: true,
      dailyLimit: 20,
    };
  if (type === "instagram_trends")
    return {
      ...common,
      accountId: "",
      usernames: [],
      references: "",
      batchLimit: 20,
    };
  return {
    ...common,
    format: "reel",
    count: 3,
    seconds: 30,
    face: false,
    production: "existing",
    budget: "کم",
    generateImage: false,
    imageProfileId: "default",
    dailyLimit: 10,
    estimatedCostMicros: 100000,
  };
}
export type TrendSample = {
  id: string;
  url: string;
  caption: string;
  timestamp: string;
  likes: number | null;
  comments: number | null;
  source: string;
};
export function compareInstagramSamples(
  items: TrendSample[],
  previous: TrendSample[],
  previousAt?: string,
  now = new Date(),
) {
  const hours = previousAt
    ? (now.getTime() - Date.parse(previousAt)) / 3600000
    : NaN;
  return items
    .map((item) => {
      const old = previous.find((p) => p.id === item.id);
      const measured =
        Number.isFinite(hours) &&
        hours >= 1 &&
        old &&
        item.likes !== null &&
        item.comments !== null &&
        old.likes !== null &&
        old.comments !== null;
      const growth = measured
        ? item.likes! + item.comments! - old.likes! - old.comments!
        : null;
      return {
        ...item,
        interactionGrowth: growth,
        growthPerHour:
          growth !== null ? Math.round((growth / hours) * 100) / 100 : null,
        label:
          growth !== null && growth > 0
            ? "رشد در منابع رصدشده"
            : "سوژه پیشنهادی",
      };
    })
    .sort((a, b) => (b.growthPerHour ?? -1) - (a.growthPerHour ?? -1));
}

const short = z.string().trim().min(1).max(1500);
export const instagramCreativeSchemas = {
  instagram_ideas: z.object({
    summary: short,
    ideas: z
      .array(
        z.object({
          title: z.string().min(1).max(180),
          hook: short,
          angle: short,
          format: z.enum(["reel", "carousel", "story", "image"]),
          goal: short,
          effort: short,
          sourceIds: z.array(z.string().max(100)).max(10).default([]),
        }),
      )
      .min(1)
      .max(10),
  }),
  instagram_script: z.object({
    title: z.string().min(1).max(180),
    hook: short,
    scenes: z
      .array(
        z.object({
          start: z.number().min(0),
          end: z.number().positive(),
          visual: short,
          voice: short,
          overlay: z.string().max(400),
        }),
      )
      .min(1)
      .max(20),
    cta: short,
    requirements: z.array(short).max(10),
  }),
  instagram_content: z.object({
    title: z.string().min(1).max(180),
    caption: z.string().min(1).max(2200),
    coverPrompt: short,
    slides: z
      .array(
        z.object({
          heading: z.string().max(80),
          body: z.string().max(200),
          visual: short,
        }),
      )
      .max(10),
    checklist: z.array(short).max(10),
  }),
  instagram_analysis: z.object({
    summary: short,
    actions: z
      .array(z.object({ title: short, evidence: short, metric: short }))
      .min(1)
      .max(5),
    ideas: z.array(short).max(5),
  }),
};
export function validateInstagramCreative(
  type: string,
  raw: unknown,
  config: Record<string, unknown>,
) {
  const schema =
    instagramCreativeSchemas[type as keyof typeof instagramCreativeSchemas];
  if (!schema) throw new Error("خروجی این کارت پشتیبانی نمی‌شود.");
  const result = schema.parse(raw);
  if (type === "instagram_script") {
    const scenes = (
      result as z.infer<typeof instagramCreativeSchemas.instagram_script>
    ).scenes;
    let end = 0;
    for (const scene of scenes) {
      if (
        scene.start !== end ||
        scene.end <= scene.start ||
        scene.end > Number(config.seconds)
      )
        throw new Error("زمان‌بندی صحنه‌های سناریو معتبر نیست.");
      end = scene.end;
    }
    if (end !== Number(config.seconds))
      throw new Error("مدت سناریو با تنظیم کارت برابر نیست.");
  }
  if (
    type === "instagram_ideas" &&
    (result as z.infer<typeof instagramCreativeSchemas.instagram_ideas>).ideas
      .length !== Number(config.count)
  )
    throw new Error("تعداد ایده‌ها با تنظیم کارت برابر نیست.");
  if (
    type === "instagram_content" &&
    config.format === "carousel" &&
    (result as z.infer<typeof instagramCreativeSchemas.instagram_content>)
      .slides.length !== Number(config.count)
  )
    throw new Error("تعداد اسلایدها با تنظیم کارت برابر نیست.");
  return result;
}
