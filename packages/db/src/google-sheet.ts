import { googleSheetExport, parseCollectionCSV } from "@socialyar/shared";
export async function fetchGoogleSheet(raw:string,gid?:string,request:typeof fetch=fetch) {
  let url=new URL(googleSheetExport(raw,gid));const signal=AbortSignal.timeout(30000);
  for(let redirect=0;redirect<=3;redirect++) {
    if(url.protocol!=="https:" || url.username || url.password || url.port || !(url.hostname==="docs.google.com" || /^[a-z0-9-]+\.googleusercontent\.com$/.test(url.hostname))) throw new Error("شیت خصوصی است یا به نشانی نامعتبر هدایت شده است؛ دسترسی خواندن با لینک را فعال کنید.");
    const response=await request(url,{redirect:"manual",signal});
    if([301,302,303,307,308].includes(response.status)) {const location=response.headers.get("location");await response.body?.cancel();if(!location)throw new Error("نشانی برگه پیدا نشد.");url=new URL(location,url);continue;}
    if(!response.ok){await response.body?.cancel();throw new Error(`خواندن گوگل‌شیت ناموفق بود (HTTP ${response.status})؛ دسترسی خواندن با لینک را بررسی کنید.`);}
    if((response.headers.get("content-type")??"").includes("text/html")){await response.body?.cancel();throw new Error("شیت خصوصی است یا برگه پیدا نشد؛ دسترسی خواندن با لینک را فعال کنید.");}
    if(Number(response.headers.get("content-length"))>5_000_000){await response.body?.cancel();throw new Error("حجم شیت بیش از حد مجاز است.");}
    const reader=response.body?.getReader();if(!reader)throw new Error("پاسخ شیت خالی است.");let size=0;const chunks:Uint8Array[]=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>5_000_000)throw new Error("حجم شیت بیش از حد مجاز است.");chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    return parseCollectionCSV(Buffer.concat(chunks).toString("utf8"));
  }
  throw new Error("تعداد تغییر مسیرهای گوگل‌شیت بیش از حد مجاز است.");
}
