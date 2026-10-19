import { and, desc, eq } from "drizzle-orm";
import {
  compareInstagramSamples,
  parseInstagramConfig,
  type TrendSample,
} from "@socialyar/shared";
import {
  generateInstagramCreative,
  generateInstagramSupport,
  type AIConnection,
  type AIRequestUsage,
} from "@socialyar/ai";
import {
  aiProfiles,
  aiSettings,
  createTenantAIQuota,
  decryptSecret,
  getDb,
  instagramConnection,
  publishingTransport,
  readInstagramAnalysis,
  readInstagramTrends,
  runSteps,
  runs,
  workflowSteps,
  sendInstagramAction,
} from "@socialyar/db";
import { generateContentImages } from "./image-generation";
export type InstagramContext = {
  accountId: string;
  mediaId?: string;
  conversationId?: string;
  senderId?: string;
  timestamp?: string;
};
export type InstagramItem = {
  text?: string;
  title?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  commentId?: string;
  reply?: string;
  approved?: boolean;
  instagram?: InstagramContext;
  [key: string]: unknown;
};
export async function executeInstagram(
  input: {
    type: string;
    config: Record<string, unknown>;
    workspaceId: string;
    workflowId: string;
    runId: string;
    stepKey: string;
    recordId: string;
    item: InstagramItem;
    prior?: InstagramItem;
    usage: (usage: AIRequestUsage) => Promise<void>;
    assertOwned: () => Promise<void>;
  },
  db = getDb(),
) {
  const config = parseInstagramConfig(input.type, input.config),
    item = input.item;
  const inheritedContext = item.contentContext as Record<string, unknown> | undefined;
  for (const key of ["brand", "audience", "goal"]) {
    if (!config[key] && typeof inheritedContext?.[key] === "string") config[key] = inheritedContext[key];
  }
  const ai = async (): Promise<AIConnection> => {
    const [settings] =
      config.profileId !== "default"
        ? await db
            .select()
            .from(aiProfiles)
            .where(
              and(
                eq(aiProfiles.id, String(config.profileId)),
                eq(aiProfiles.workspaceId, input.workspaceId),
              ),
            )
        : await db
            .select()
            .from(aiSettings)
            .where(eq(aiSettings.workspaceId, input.workspaceId));
    if (!settings) throw new Error("مدل هوش مصنوعی این کارت در دسترس نیست.");
    const quota = createTenantAIQuota(db, input.workspaceId);
    return {
      provider: settings.provider as AIConnection["provider"],
      model: settings.model,
      token: decryptSecret(settings.encryptedToken),
      beforeRequest: quota.beforeRequest,
      onRequestRejected: quota.onRequestRejected,
      onUsage: async (u) => {
        await quota.onUsage(u);
        await input.usage(u);
      },
    };
  };
  if (input.type === "instagram_comments") {
    if (
      !item.instagram ||
      item.instagram.accountId !== config.accountId ||
      !item.commentId
    )
      throw new Error(
        "برای خواندن کامنت، جریان را فعال کنید تا منبع کامنت‌ها را دریافت کند.",
      );
    return { output: item, hold: false };
  }
  if (input.type === "instagram_trends") {
    let items: TrendSample[] = [];
    const usernames = config.usernames as string[];
    if (usernames.length) {
      const c = await instagramConnection(
          input.workspaceId,
          String(config.accountId),
          db,
        ),
        transport = await publishingTransport(
          input.workspaceId,
          input.config.connection,
          "instagram",
        );
      try {
        items = await readInstagramTrends(
          c,
          usernames,
          Number(config.batchLimit),
          transport.fetch,
        );
      } finally {
        await transport.close();
      }
    }
    const [previous] = await db
      .select({ output: runSteps.output, at: runSteps.finishedAt })
      .from(runSteps)
      .innerJoin(runs, eq(runs.id, runSteps.runId))
      .innerJoin(workflowSteps, eq(workflowSteps.id, runSteps.workflowStepId))
      .where(
        and(
          eq(runs.workflowId, input.workflowId),
          eq(workflowSteps.key, input.stepKey),
          eq(runSteps.status, "completed"),
        ),
      )
      .orderBy(desc(runSteps.finishedAt))
      .limit(1);
    const trends = {
      generatedAt: new Date().toISOString(),
      items: compareInstagramSamples(
        items,
        (previous?.output?.trends as { items?: TrendSample[] })?.items ?? [],
        previous?.at?.toISOString(),
      ),
      references: String(config.references),
      coverage: "فقط منابع منتخب؛ مقایسه رشد با حداقل یک ساعت فاصله",
    };
    if (!items.length && !String(config.references).trim())
      throw new Error(
        "حساب‌های قابل رصد یا نمونه‌های متنی و لینک‌دار را وارد کنید.",
      );
    return {
      output: {
        title: "رصد سوژه‌های اینستاگرام",
        text: [
          ...trends.items.map(
            (i) =>
              `${i.label}: ${i.caption}\n${i.url}\nرشد تعامل: ${i.interactionGrowth ?? "داده کافی نیست"}`,
          ),
          trends.references,
        ]
          .filter(Boolean)
          .join("\n\n"),
        trends,
        contentContext:{brand:config.brand,audience:config.audience,goal:config.goal},
      },
      hold: false,
    };
  }
  if (input.type === "instagram_analysis") {
    const c = await instagramConnection(
        input.workspaceId,
        String(config.accountId),
        db,
      ),
      transport = await publishingTransport(
        input.workspaceId,
        input.config.connection,
        "instagram",
      );
    let data;
    try {
      data = await readInstagramAnalysis(c, config, transport.fetch);
    } finally {
      await transport.close();
    }
    const creative = await generateInstagramCreative(
      await ai(),
      input.type,
      data,
      config,
    );
    return {
      output: {
        title: "تحلیل پیج اینستاگرام",
        text: formatCreative(creative),
        creative,
        instagramAnalysis: data,
      },
      hold: false,
    };
  }
  if (["instagram_action", "instagram_inbox"].includes(input.type)) {
    if (
      !item.instagram ||
      item.instagram.accountId !== config.accountId ||
      !item.commentId ||
      !item.text
    )
      throw new Error("حساب و زمینه ورودی با کارت اینستاگرام یکسان نیست.");
    if (
      (input.type === "instagram_action" && !item.instagram.mediaId) ||
      (input.type === "instagram_inbox" && !item.instagram.conversationId)
    )
      throw new Error("نوع ورودی با اقدام انتخاب‌شده سازگار نیست.");
    if (config.action === "review")
      return {
        output: { ...item, actionStatus: "referred", reason: "ارجاع به مدیر" },
        hold: true,
      };
    const kind =
      input.type === "instagram_inbox"
        ? "message"
        : config.action === "hide"
          ? "hide"
          : "reply";
    let proposed =
      input.prior?.reply !== undefined
        ? input.prior
        : kind === "hide"
          ? {
              ...item,
              reply: "",
              reason: "مخفی‌کردن کامنت",
              decision: "review",
              actionLabel: "تأیید و مخفی‌کردن کامنت",
            }
          : {
              ...item,
              ...(await generateInstagramSupport(
                await ai(),
                item.text,
                config,
              )),
              decision: "reply",
              approved: false,
            };
    if (kind !== "hide" && !proposed.reply)
      return {
        output: { ...proposed, decision: "review", actionStatus: "referred" },
        hold: true,
      };
    if (input.type === "instagram_inbox" && config.mode === "draft")
      return { output: { ...proposed, actionStatus: "draft" }, hold: false };
    if (config.requireApproval !== false && proposed.approved !== true)
      return { output: proposed, hold: true };
    const transport = await publishingTransport(
      input.workspaceId,
      input.config.connection,
      "instagram",
    );
    try {
      return {
        output: {
          ...proposed,
          ...(await sendInstagramAction(
            {
              workspaceId: input.workspaceId,
              workflowId: input.workflowId,
              runId: input.runId,
              accountId: String(config.accountId),
              kind,
              targetId: item.commentId,
              mediaId: item.instagram.mediaId,
              conversationId: item.instagram.conversationId,
              senderId: item.instagram.senderId,
              timestamp: item.instagram.timestamp,
              reply: proposed.reply,
              dailyLimit: Number(config.dailyLimit),
            },
            input.assertOwned,
            db,
            transport.fetch,
          )),
        },
        hold: false,
      };
    } finally {
      await transport.close();
    }
  }
  if (!item.text)
    throw new Error("این کارت به متن یا خروجی کارت قبلی نیاز دارد.");
  // Reuse an already generated package if image generation was interrupted.
  const creative =
    input.prior?.creative ??
    (await generateInstagramCreative(
      await ai(),
      input.type,
      { text: item.text, creative: item.creative, brand: config.brand },
      config,
    ));
  let output: InstagramItem = {
    ...item,
    title: String((creative as any).title ?? item.title ?? "ایده‌های محتوا"),
    text: formatCreative(creative),
    creative,
    contentContext: {brand:config.brand,audience:config.audience,goal:config.goal},
    approved: false,
  };
  if (input.type === "instagram_content") {
    const packageData = creative as {
      caption: string;
      coverPrompt: string;
      slides: Array<{ heading: string; body: string; visual: string }>;
    };
    output.text = packageData.caption;
    // Persist text before any billable image work so resuming does not regenerate it.
    await db
      .update(runSteps)
      .set({ output })
      .where(eq(runSteps.id, input.recordId));
    if (config.generateImage) {
      if (config.format === "carousel") {
        if (packageData.slides.length < 2 || packageData.slides.length > 10)
          throw new Error("آلبوم به ۲ تا ۱۰ اسلاید نیاز دارد.");
        const images: Array<{ url: string }> = [];
        for (let index = 0; index < packageData.slides.length; index++) {
          const slide = packageData.slides[index];
          const generated = await generateContentImages(
            {
              workspaceId: input.workspaceId,
              workflowId: input.workflowId,
              stepKey: input.stepKey,
              itemKey: `${input.runId}:slide:${index}`,
              item: { title: slide.heading, text: slide.body },
              config: {
                profileId: config.imageProfileId,
                preset: "square",
                behavior: "always",
                instructions: slide.visual,
                overlayText: `${slide.heading}\n${slide.body}`.slice(0, 300),
                dailyLimit: config.dailyLimit,
                estimatedCostMicros: config.estimatedCostMicros,
              },
            },
            db,
          );
          if (generated.images?.[0]) images.push(generated.images[0]);
        }
        output = {
          ...output,
          images,
          instagramImages: images.map((i) => i.url),
          imageUrl: images[0]?.url,
          instagramType: "carousel",
        };
      } else {
        output = await generateContentImages(
          {
            workspaceId: input.workspaceId,
            workflowId: input.workflowId,
            stepKey: input.stepKey,
            itemKey: input.runId,
            item: output,
            config: {
              profileId: config.imageProfileId,
              preset:
                config.format === "reel"
                  ? "reel"
                  : config.format === "story"
                    ? "story"
                    : "square",
              behavior: "always",
              instructions: packageData.coverPrompt,
              overlayText: output.title ?? "",
              dailyLimit: config.dailyLimit,
              estimatedCostMicros: config.estimatedCostMicros,
            },
          },
          db,
        );
      }
    }
    output.productionStatus =
      config.format === "reel"
        ? "نیازمند فایل ویدئو یا فیلم‌برداری"
        : config.generateImage
          ? "رسانه آماده بررسی"
          : "متن آماده؛ رسانه را اضافه کنید";
  }
  return { output, hold: false };
}
export function formatCreative(raw: unknown): string {
  const v = raw as any;
  const lines: string[] = [];
  for (const key of ["summary", "title", "hook", "caption", "cta"])
    if (typeof v[key] === "string") lines.push(v[key]);
  if (v.ideas)
    lines.push(
      ...v.ideas.map((i: any, index: number) =>
        typeof i === "string"
          ? i
          : `${index + 1}. ${i.title}\nشروع: ${i.hook}\nزاویه: ${i.angle}\nهدف: ${i.goal}\nتولید: ${i.effort}`,
      ),
    );
  if (v.scenes)
    lines.push(
      ...v.scenes.map(
        (i: any) =>
          `${i.start}–${i.end} ثانیه\nتصویر: ${i.visual}\nگوینده: ${i.voice}\nمتن تصویر: ${i.overlay}`,
      ),
    );
  if (v.slides)
    lines.push(
      ...v.slides.map(
        (i: any, index: number) =>
          `اسلاید ${index + 1}: ${i.heading}\n${i.body}\n${i.visual}`,
      ),
    );
  if (v.actions)
    lines.push(
      ...v.actions.map(
        (i: any) => `${i.title}\nشاهد: ${i.evidence}\nمعیار: ${i.metric}`,
      ),
    );
  if (v.requirements) lines.push("نیازمندی‌ها: " + v.requirements.join("، "));
  return lines.join("\n\n");
}
