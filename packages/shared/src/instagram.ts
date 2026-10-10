export type InstagramType = "image" | "reel" | "carousel";
export function instagramProblems(settings: Record<string, unknown>, caption: string): string[] {
  const problems: string[] = [];
  const type = settings.instagramType ?? (settings.videoUrl ? "reel" : "image");
  const publicUrl = (value: unknown) => { try { const u = new URL(String(value)); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; } };
  if (!["image", "reel", "carousel"].includes(String(type))) problems.push("نوع انتشار اینستاگرام معتبر نیست.");
  if (caption.length > 2200) problems.push("کپشن باید حداکثر ۲۲۰۰ نویسه باشد.");
  if (type === "image" && !publicUrl(settings.imageUrl)) problems.push("لینک عمومی HTTPS تصویر را وارد کنید.");
  if (type === "reel" && !publicUrl(settings.videoUrl)) problems.push("لینک عمومی HTTPS ویدئوی ریلز را وارد کنید.");
  if (type === "reel" && settings.imageUrl && !publicUrl(settings.imageUrl)) problems.push("لینک کاور ریلز معتبر نیست.");
  if (type === "carousel") {
    const images = settings.instagramImages;
    if (!Array.isArray(images) || images.length < 2 || images.length > 10) problems.push("آلبوم به ۲ تا ۱۰ تصویر نیاز دارد.");
    else if (images.some((url) => !publicUrl(url))) problems.push("تمام تصاویر آلبوم باید لینک عمومی HTTPS داشته باشند.");
  }
  return problems;
}
