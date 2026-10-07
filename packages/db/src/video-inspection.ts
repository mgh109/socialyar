import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export type VideoDetails = { width: number; height: number; duration: number };
export function assertShorts(details: VideoDetails) {
  if (!Number.isFinite(details.duration) || details.duration <= 0 || details.duration > 180 || details.height < details.width)
    throw new Error("برای Shorts، ویدئو باید مربع یا عمودی و حداکثر ۳ دقیقه باشد. نوع محتوا یا فایل را اصلاح کنید.");
}
export async function inspectVideo(bytes: Buffer): Promise<VideoDetails> {
  const directory = await mkdtemp(join(tmpdir(),"hoor-video-")); const path = join(directory,"video");
  try {
    await writeFile(path,bytes,{ mode:0o600 });
    const { stdout } = await promisify(execFile)("ffprobe", ["-v","error","-show_streams","-show_format","-of","json",path], { timeout:30000, maxBuffer:1_000_000 });
    const info = JSON.parse(stdout); const stream = info.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
    if (!stream) throw new Error("فایل جریان ویدئویی معتبر ندارد.");
    let width = Number(stream.width), height = Number(stream.height);
    const rotation = Number(stream.side_data_list?.find((s: { rotation?: number }) => s.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
    if (Math.abs(rotation)%180 === 90) [width,height] = [height,width];
    const duration = Number(info.format?.duration ?? stream.duration);
    if (!(width > 0 && height > 0 && duration > 0 && Number.isFinite(duration))) throw new Error("ابعاد یا مدت ویدئو قابل بررسی نیست.");
    return { width,height,duration };
  } finally { await rm(directory,{ recursive:true,force:true }); }
}
