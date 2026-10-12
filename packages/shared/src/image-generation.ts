import { z } from "zod";
export const imagePresets = { youtube: [1280,720], reel: [1080,1920], story: [1080,1920], news: [1200,800], square: [1080,1080], custom: [1024,1024] } as const;
export const imageConfigSchema = z.object({
  profileId: z.string().min(1).max(100).default("default"), model: z.string().trim().min(1).max(120),
  preset: z.enum(["youtube","reel","story","news","square","custom"]).default("news"),
  width: z.number().int().min(256).max(4096).default(1024), height: z.number().int().min(256).max(4096).default(1024),
  quality: z.enum(["low","medium","high"]).default("medium"),
  behavior: z.enum(["missing","always","edit"]).default("missing"), invalidAsMissing: z.boolean().default(true),
  instructions: z.string().max(4000).default("برای {{عنوان}} و {{متن}} تصویر مرتبط بساز؛ بدون نوشته."),
  style: z.string().max(200).default("واقعی"), brandColors: z.string().max(200).default(""),
  referenceUrl: z.string().max(1000).default(""), logoUrl: z.string().max(1000).default(""),
  overlayText: z.string().max(300).default(""), textColor: z.string().regex(/^#[a-fA-F0-9]{6}$/).default("#ffffff"),
  count: z.number().int().min(1).max(4).default(1), maxPerRun: z.number().int().min(1).max(4).default(4),
  dailyLimit: z.number().int().min(0).max(100000).nullable().default(10), monthlyLimit: z.number().int().min(0).max(1000000).nullable().default(null),
  dailyBudgetMicros: z.number().int().min(0).max(2147483647).nullable().default(null), monthlyBudgetMicros: z.number().int().min(0).max(2147483647).nullable().default(null),
  // A conservative user-configured reservation; actual provider billing can exceed an estimate.
  estimatedCostMicros: z.number().int().min(1).max(100000000).default(100000),
  onLimit: z.enum(["stop","wait","continue"]).default("stop"), onError: z.enum(["stop","review","continue"]).default("stop"),
  requireApproval: z.boolean().default(false),
});
export type ImageConfig = z.infer<typeof imageConfigSchema>;
export function imageDimensions(config: ImageConfig) { return config.preset === "custom" ? [config.width,config.height] : [...imagePresets[config.preset]]; }
export function imagePrompt(config: ImageConfig, item: { title?: string|null; text?: string }) {
  return config.instructions.replace(/\{\{(?:عنوان|title)\}\}/g,item.title ?? "").replace(/\{\{(?:متن|text)\}\}/g,item.text ?? "").slice(0,12000)+`\nسبک: ${config.style}\nرنگ‌های برند: ${config.brandColors}\nمتن و لوگو را داخل تصویر نساز؛ فضای مناسب برای افزودن آن‌ها باقی بگذار.`;
}
export function collectionImagePath(nodes: Array<{key:string;type:string}>, edges: Array<{sourceKey:string;targetKey:string}>, source:string,target:string): string[]|null {
  const direct=edges.some(e=>e.sourceKey===source&&e.targetKey===target); if(direct)return [];
  const images=nodes.filter(n=>n.type==="image_generate"&&edges.some(e=>e.sourceKey===source&&e.targetKey===n.key)&&edges.some(e=>e.sourceKey===n.key&&e.targetKey===target));
  return images.length===1 ? [images[0].key] : null;
}
