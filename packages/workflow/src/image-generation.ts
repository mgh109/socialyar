import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { imageConfigSchema, imageDimensions, imagePrompt, type ImageConfig } from "@socialyar/shared";
import { getDb, aiProfiles, aiSettings, decryptSecret, imageGenerationJobs, reserveImageJob, generatedImageUrl, fetchCollectionMedia, storeYoutubeMedia } from "@socialyar/db";
export type ImageItem={title?:string|null;text?:string;imageUrl?:string|null;[key:string]:unknown};
export class ImageProviderRejected extends Error {}
export async function requestImages(input:{provider:string;model:string;token:string;prompt:string;config:ImageConfig;reference?:Buffer},request:typeof fetch=fetch){
 const {provider,model,token,prompt,config,reference}=input;const [width,height]=imageDimensions(config);
 const base=provider==="openai"?"https://api.openai.com/v1":provider==="gapgpt"?"https://api.gapgpt.app/v1":provider==="openrouter"?"https://openrouter.ai/api/v1":null;
 if(!base)throw new Error("سرویس تصویر پشتیبانی نمی‌شود.");
 const params:Record<string,unknown>={model,prompt,n:config.count,quality:config.quality};
 let body:BodyInit|undefined;let endpoint=provider==="openrouter"?"/images":"/images/generations";let headers:Record<string,string>={Authorization:`Bearer ${token}`};
 if(provider==="openrouter"){
   const divisor=(a:number,b:number):number=>b?divisor(b,a%b):a;const d=divisor(width,height);
   params.output_format="png";params.aspect_ratio=`${width/d}:${height/d}`;if(reference)params.input_references=[{type:"image_url",image_url:{url:`data:image/png;base64,${reference.toString("base64")}`}}];
 }else{
   params.size=width>height?"1536x1024":width<height?"1024x1536":"1024x1024";params.output_format="png";
   if(reference){endpoint="/images/edits";const form=new FormData();for(const [key,value]of Object.entries(params))form.set(key,String(value));form.set("image",new Blob([new Uint8Array(reference)],{type:"image/png"}),"reference.png");body=form;}
 }
 if(!body){headers["Content-Type"]="application/json";body=JSON.stringify(params);}
 const response=await request(base+endpoint,{method:"POST",headers,body,signal:AbortSignal.timeout(240000)});
 if(!response.ok)throw new ImageProviderRejected(`سرویس تولید تصویر درخواست را نپذیرفت (HTTP ${response.status})؛ مدل، کلید و دسترسی تولید تصویر را بررسی کنید.`);
 const raw=await response.text();if(raw.length>80_000_000)throw new Error("پاسخ تصویر بیش از حد بزرگ است.");const data=JSON.parse(raw);
 if(!Array.isArray(data.data)||!data.data.length||data.data.length>config.count)throw new Error("پاسخ سرویس تصویر معتبر نیست.");
 const images=await Promise.all(data.data.map(async (part:{b64_json?:string;url?:string})=>{
   if(part.b64_json){if(part.b64_json.length>30_000_000)throw new Error("حجم تصویر بیش از حد مجاز است.");return Buffer.from(part.b64_json,"base64");}
   if(part.url)return (await fetchCollectionMedia("",part.url,"image")).bytes;throw new Error("سرویس تصویر قابل استفاده برنگرداند.");
 }));const usage=data.usage??{};const tokens=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?n:null;
 const cost=typeof usage.cost==="number"&&Number.isFinite(usage.cost)&&usage.cost>=0?Math.ceil(usage.cost*1e6):null;
 return {images,inputTokens:tokens(usage.input_tokens??usage.prompt_tokens),outputTokens:tokens(usage.output_tokens??usage.completion_tokens),costMicros:cost};
}
export async function composeImage(bytes:Buffer,config:ImageConfig,title:string,logo?:Buffer){
 const [width,height]=imageDimensions(config);const overlays:sharp.OverlayOptions[]=[];
 if(config.overlayText){const text=config.overlayText.replace(/\{\{(?:عنوان|title)\}\}/g,title);const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
  const layer=await sharp({text:{text:`<span foreground="${config.textColor}">${escape(text)}</span>`,font:"Noto Sans Arabic Bold",width:Math.floor(width*.85),height:Math.floor(height*.25),align:"centre",rgba:true}}).png().toBuffer();overlays.push({input:layer,gravity:"south"});
 }
 if(logo)overlays.push({input:await sharp(logo,{limitInputPixels:20000000}).resize(Math.floor(width*.15),Math.floor(height*.15),{fit:"inside"}).png().toBuffer(),gravity:"northeast"});
 let out=await sharp(bytes,{limitInputPixels:20000000}).rotate().resize(width,height,{fit:"cover"}).composite(overlays).jpeg({quality:88}).toBuffer();
 if(out.length>2_000_000)out=await sharp(out).jpeg({quality:65}).toBuffer();if(out.length>2_000_000)throw new Error("تصویر نهایی از محدودیت حجم رسانه بیشتر است.");return out;
}
export async function generateContentImages(input:{workspaceId:string;workflowId:string;stepKey:string;itemKey:string;config:Record<string,unknown>;item:ImageItem},db=getDb()):Promise<ImageItem & {imageGeneration:Record<string,unknown>;images?:Array<{mediaId:string;url:string;width:number;height:number}>}>{
 const config=imageConfigSchema.parse(input.config);
 if(config.behavior==="missing"&&input.item.imageUrl){
  if(!config.invalidAsMissing)return {...input.item,imageGeneration:{status:"existing"}};
  try{await fetchCollectionMedia(input.workspaceId,input.item.imageUrl,"image",undefined,true);return {...input.item,imageGeneration:{status:"existing"}};}catch{}
 }
 if(config.behavior==="edit"&&!input.item.imageUrl)throw new Error("برای ویرایش، تصویر ورودی لازم است.");
 // Validate public delivery configuration before spending credits.
 generatedImageUrl(input.workspaceId,"0".repeat(64));
 const [profile]=config.profileId==="default"?await db.select().from(aiSettings).where(eq(aiSettings.workspaceId,input.workspaceId)).limit(1):await db.select().from(aiProfiles).where(and(eq(aiProfiles.id,config.profileId),eq(aiProfiles.workspaceId,input.workspaceId))).limit(1);
 if(!profile)throw new Error("اتصال هوش مصنوعی تصویر در این فضای کاری پیدا نشد.");
 config.model=profile.model.trim();
 if(!config.model)throw new Error("مدل اتصال انتخاب‌شده تنظیم نشده است.");
 const prompt=imagePrompt(config,input.item);const cacheKey=createHash("sha256").update(JSON.stringify([input.workflowId,input.stepKey,input.itemKey,config,prompt,input.item.imageUrl,profile.provider])).digest("hex");
 let reference:Buffer|undefined,logo:Buffer|undefined;const referenceUrl=config.behavior==="edit"?input.item.imageUrl:config.referenceUrl;
 if(referenceUrl)reference=await sharp((await fetchCollectionMedia(input.workspaceId,referenceUrl,"image")).bytes).png().toBuffer();
 if(config.logoUrl)logo=(await fetchCollectionMedia(input.workspaceId,config.logoUrl,"image")).bytes;
 const {job,cached}=await reserveImageJob({...input,cacheKey,provider:profile.provider,model:config.model,config},db);
 if(cached)return {...input.item,imageUrl:job.images[0].url,images:job.images,imageGeneration:{jobId:job.id,status:"cached",costMicros:job.costMicros,estimated:job.costEstimated}};
 try{
  const result=await requestImages({provider:profile.provider,model:config.model,token:decryptSecret(profile.encryptedToken),prompt,config,reference});
  // Store usage before image processing: a successful provider call can be billed even if rendering fails.
  await db.update(imageGenerationJobs).set({costMicros:result.costMicros??job.reservedMicros,costEstimated:result.costMicros===null,inputTokens:result.inputTokens,outputTokens:result.outputTokens}).where(eq(imageGenerationJobs.id,job.id));
  const images=await Promise.all(result.images.map(async bytes=>{const rendered=await composeImage(bytes,config,input.item.title??"",logo);const {mediaId}=await storeYoutubeMedia(input.workspaceId,rendered);const [width,height]=imageDimensions(config);return {mediaId,url:generatedImageUrl(input.workspaceId,mediaId),width,height};}));
  await db.update(imageGenerationJobs).set({status:"completed",imageCount:images.length,images,updatedAt:new Date()}).where(eq(imageGenerationJobs.id,job.id));
  return {...input.item,imageUrl:images[0].url,images,imageGeneration:{jobId:job.id,status:"completed",costMicros:result.costMicros??job.reservedMicros,estimated:result.costMicros===null,inputTokens:result.inputTokens,outputTokens:result.outputTokens}};
 }catch(error){if(!(error instanceof ImageProviderRejected) && !(error instanceof Error && /[آ-ی]/.test(error.message)))error=new Error("تولید یا آماده‌سازی تصویر ناموفق بود؛ اتصال سرویس، قالب تصویر و فضای ذخیره‌سازی را بررسی کنید.");await db.update(imageGenerationJobs).set({status:error instanceof ImageProviderRejected?"rejected":"failed",error:error instanceof Error?error.message:"تولید تصویر ناموفق بود.",updatedAt:new Date()}).where(eq(imageGenerationJobs.id,job.id));throw error;}
}
