import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
export type VideoDetails = { width: number; height: number; duration: number };
export function assertShorts(details: VideoDetails) {
  if (!Number.isFinite(details.duration) || details.duration <= 0 || details.duration > 180 || details.height < details.width)
    throw new Error("برای Shorts، ویدئو باید مربع یا عمودی و حداکثر ۳ دقیقه باشد. نوع محتوا یا فایل را اصلاح کنید.");
}
export async function inspectVideo(bytes: Buffer | string): Promise<VideoDetails> {
  const directory = typeof bytes === "string" ? null : await mkdtemp(join(tmpdir(),"hoor-video-")); const path = typeof bytes === "string" ? bytes : join(directory!,"video");
  try {
    if (typeof bytes !== "string") await writeFile(path,bytes,{ mode:0o600 });
    // A missing input and a missing executable both otherwise report ENOENT.
    await access(path);
    return await probeVideo(path);
  } finally { if(directory) await rm(directory,{ recursive:true,force:true }); }
}
async function probeVideo(path:string):Promise<VideoDetails> {
    const { stdout } = await promisify(execFile)("ffprobe", ["-v","error","-rw_timeout","15000000","-show_streams","-show_format","-of","json",path], { timeout:30000, maxBuffer:1_000_000 }).catch(error => {
      if (error.code === "ENOENT") throw Object.assign(new Error("ابزار بررسی ویدئو در پردازشگر نصب نیست؛ سرویس Worker باید با ffprobe اجرا شود."), { code:"VIDEO_INSPECTOR_UNAVAILABLE" });
      throw error;
    });
    const info = JSON.parse(stdout); const stream = info.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
    if (!stream) throw new Error("فایل جریان ویدئویی معتبر ندارد.");
    let width = Number(stream.width), height = Number(stream.height);
    const rotation = Number(stream.side_data_list?.find((s: { rotation?: number }) => s.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
    if (Math.abs(rotation)%180 === 90) [width,height] = [height,width];
    const duration = Number(info.format?.duration ?? stream.duration);
    if (!(width > 0 && height > 0 && duration > 0 && Number.isFinite(duration))) throw new Error("ابعاد یا مدت ویدئو قابل بررسی نیست.");
    return { width,height,duration };
}

/** ffprobe can seek without a temporary file. Only our checked range reader reaches the origin. */
export async function inspectRemoteVideo(source:{size:number;type:string;read:(start:number,end:number)=>Promise<Buffer>}):Promise<VideoDetails> {
  const path=`/${randomUUID()}`;
  let sourceError:unknown;
  const drain=(response:ServerResponse)=>new Promise<void>(resolve=>{
    const done=()=>{response.off("drain",done);response.off("close",done);resolve();};
    response.once("drain",done);response.once("close",done);
  });
  const server=createServer(async(req,res)=>{
    if(req.url!==path || !["GET","HEAD"].includes(req.method??"")){res.writeHead(404).end();return;}
    const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if(req.headers.range && !range){res.writeHead(416,{"Content-Range":`bytes */${source.size}`}).end();return;}
    const start=range ? Number(range[1]) : 0;
    const end=range?.[2] ? Math.min(Number(range[2])+1,source.size) : source.size;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=end||start>=source.size){res.writeHead(416,{"Content-Range":`bytes */${source.size}`}).end();return;}
    res.writeHead(range?206:200,{"Content-Type":source.type,"Content-Length":end-start,"Accept-Ranges":"bytes",...(range?{"Content-Range":`bytes ${start}-${end-1}/${source.size}`}:{})});
    if(req.method==="HEAD"){res.end();return;}
    try {
      for(let offset=start;offset<end && !res.destroyed;){
        const next=Math.min(offset+1024*1024,end);
        const bytes=await source.read(offset,next);
        if(res.destroyed)break;
        if(!res.write(bytes))await drain(res);
        offset=next;
      }
      if(!res.destroyed)res.end();
    }catch(error){sourceError=error;res.destroy();}
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  try {
    const address=server.address();if(!address || typeof address==="string")throw new Error("راه‌اندازی بررسی ویدئو ناموفق بود.");
    try{return await probeVideo(`http://127.0.0.1:${address.port}${path}`);}catch(error){throw sourceError??error;}
  }finally {
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}
