import {test} from "node:test";
import assert from "node:assert/strict";
import {googleSheetExport,parseCollectionCSV,validateCollectionDestination,collectionRowSchema} from "../../../packages/shared/src/index";
import {fetchGoogleSheet} from "@socialyar/db";
import {publishToChannel} from "@socialyar/channels";
const mockFetch=(handler:(url:string,init?:RequestInit)=>Response|Promise<Response>)=>((url:unknown,init?:RequestInit)=>Promise.resolve(handler(String(url),init))) as typeof fetch;
const ok=(data:unknown)=>Response.json(data);
test("Google Sheets URL is canonical and cannot target arbitrary hosts or credentials",()=>{
  assert.equal(googleSheetExport("https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42"),"https://docs.google.com/spreadsheets/d/abc_123/gviz/tq?tqx=out:csv&gid=42");
  for(const url of ["https://attacker.example/sheet","https://docs.google.com.evil.test/spreadsheets/d/a","http://docs.google.com/spreadsheets/d/a","https://u:p@docs.google.com/spreadsheets/d/a"])assert.throws(()=>googleSheetExport(url));
});
test("CSV handles Persian, commas, quotes, multiline captions and empty media cells",()=>{
  const parsed=parseCollectionCSV('\uFEFFشناسه محتوا,عنوان,توضیحات,لینک ویدئو\r\none,"عنوان، اول","متن\nبا ""نقل قول""",\r\n');assert.deepEqual(parsed.rows,[["one","عنوان، اول",'متن\nبا "نقل قول"',""]]);
  assert.throws(()=>parseCollectionCSV('id,title\n"unfinished'));assert.throws(()=>parseCollectionCSV('id,title\n"a"oops,b'));assert.throws(()=>parseCollectionCSV(Array(502).fill("a,b").join("\n")));
});
test("Google Sheets reader rejects login redirects, HTML sign-in responses and oversize files",async()=>{
  const url="https://docs.google.com/spreadsheets/d/abc/edit";
  assert.deepEqual(await fetchGoogleSheet(url,"0",mockFetch(()=>new Response("id,title\none,Title",{headers:{"content-type":"text/csv"}}))),{headers:["id","title"],rows:[["one","Title"]]});
  await assert.rejects(()=>fetchGoogleSheet(url,"0",mockFetch(()=>new Response("",{status:302,headers:{location:"https://accounts.google.com/login"}}))),/خصوصی/);
  await assert.rejects(()=>fetchGoogleSheet(url,"0",mockFetch(()=>new Response("<html>",{headers:{"content-type":"text/html"}}))),/خصوصی/);
  await assert.rejects(()=>fetchGoogleSheet(url,"0",mockFetch(()=>new Response("id,title",{headers:{"content-length":"5000001"}}))),/حجم/);
});
test("content validation supports text-only messaging and requires media for Instagram and YouTube",()=>{
  const row=collectionRowSchema.parse({id:"one",order:1,title:"عنوان",description:"متن"});
  for(const channel of ["telegram","eitaa","bale"])assert.doesNotThrow(()=>validateCollectionDestination([row],channel));
  for(const channel of ["youtube","instagram"])assert.throws(()=>validateCollectionDestination([row],channel));
  assert.throws(()=>validateCollectionDestination([{...row,description:"a".repeat(4096)}],"telegram"));
});
test("Telegram and Bale route text, image and video to matching methods with unchanged caption",async()=>{
  for(const channel of ["telegram","bale"] as const)for(const kind of ["text","image","video"]){
    const calls:Array<{url:string;data:Record<string,unknown>}>=[];
    const result=await publishToChannel({channel,content:"متن",title:"عنوان",credentials:{botToken:"test",chatId:"@channel"},...(kind==="image"?{imageUrl:"https://files.example/image.jpg"}:kind==="video"?{videoUrl:"https://files.example/video.mp4"}:{}),fetch:mockFetch((url,init)=>{calls.push({url,data:JSON.parse(String(init?.body))});return ok({ok:true,result:{message_id:1,chat:{username:"channel"}}});})});
    assert.equal(result.externalId,"1");assert.equal(calls.length,1);assert.ok(calls[0].url.startsWith(channel==="bale" ? "https://tapi.bale.ai/" : "https://api.telegram.org/"));assert.ok(calls[0].url.endsWith(kind==="text"?"sendMessage":kind==="image"?"sendPhoto":"sendVideo"));assert.equal(calls[0].data[kind==="text"?"text":"caption"],"عنوان\n\nمتن");
  }
});
test("prepared messaging media uses multipart; unconfirmed result stays unknown",async()=>{
  let form:FormData|undefined;
  await publishToChannel({channel:"bale",content:"متن",videoUrl:"https://files.example/v.mp4",media:new Blob(["video"],{type:"video/mp4"}),credentials:{botToken:"test",chatId:"@channel"},fetch:mockFetch((_url,init)=>{form=init!.body as FormData;return ok({ok:true,result:{message_id:2}});})});assert.ok(form?.get("video") instanceof Blob);
  await assert.rejects(()=>publishToChannel({channel:"telegram",content:"متن",credentials:{botToken:"test",chatId:"@channel"},fetch:mockFetch(()=>ok({ok:true}))}),{code:"DELIVERY_UNKNOWN"});
});
test("Instagram persists a container before publishing and reuses it on retry",async()=>{
  const calls:string[]=[];let persisted:Record<string,unknown>={};
  const request={channel:"instagram" as const,content:"کپشن",externalAccountId:"123",videoUrl:"https://files.example/v.mp4",credentials:{accessToken:"test",apiVersion:"v25.0"},saveProviderState:async(state:Record<string,unknown>)=>{persisted=state;},fetch:mockFetch((url)=>{calls.push(url);if(url.endsWith("/media"))return ok({id:"container"});if(url.includes("status_code"))return ok({status_code:"FINISHED"});if(url.endsWith("media_publish")){assert.equal(persisted.instagramContainerId,"container");return ok({id:"remote"});}return ok({permalink:"https://www.instagram.com/p/test/"});})};
  assert.equal((await publishToChannel(request)).externalId,"remote");assert.equal(calls.filter((u)=>u.endsWith("/media")).length,1);
  calls.length=0;await publishToChannel({...request,providerState:persisted});assert.equal(calls.filter((u)=>u.endsWith("/media")).length,0);
});
test("Instagram processing or already-published containers never blindly call media_publish",async()=>{
  for(const status of ["IN_PROGRESS","PUBLISHED"]){let publishes=0;await assert.rejects(()=>publishToChannel({channel:"instagram",content:"متن",externalAccountId:"123",imageUrl:"https://files.example/i.jpg",credentials:{accessToken:"test",apiVersion:"v25.0"},providerState:{instagramContainerId:"existing"},fetch:mockFetch((url)=>{if(url.endsWith("media_publish"))publishes++;return ok({status_code:status});})}));assert.equal(publishes,0);}
});
test("per-network text columns map independently while old spreadsheets preserve their original shape",async()=>{
  const {inferMapping,mapCollectionRows}=await import("../../web/app/lib/collection-sheet");const {collectionBody}=await import("../../../packages/shared/src/index");
  const sheet={headers:["شناسه محتوا","عنوان","متن","کپشن اینستاگرام","متن تلگرام"],rows:[["id","عنوان","متن مشترک","کپشن مستقل","متن تلگرام مستقل"]]};const {rows,errors}=mapCollectionRows(sheet,inferMapping(sheet.headers));assert.equal(errors.length,0);assert.equal(collectionBody(rows[0],"instagram"),"کپشن مستقل");assert.equal(collectionBody(rows[0],"telegram"),"متن تلگرام مستقل");assert.equal(collectionBody(rows[0],"bale"),"متن مشترک");assert.equal(rows[0].youtubeDescription,undefined);
});

test("Instagram carousel persists children and parent and retries without recreating media",async()=>{
  let persisted:Record<string,unknown>={};let creations=0;let pending=true;let published=0;
  const request={channel:"instagram" as const,instagramType:"carousel",instagramImages:["https://files.example/1.jpg","https://files.example/2.jpg"],content:"کپشن",title:"نباید تکرار شود",externalAccountId:"123",credentials:{accessToken:"test",apiVersion:"v25.0"},saveProviderState:async(state:Record<string,unknown>)=>{persisted={...persisted,...state};},fetch:mockFetch((url,init)=>{
    if(url.endsWith("/media")){creations++;const params=init?.body as URLSearchParams;if(creations<=2)assert.equal(params.get("is_carousel_item"),"true");else{assert.equal(params.get("media_type"),"CAROUSEL");assert.equal(params.get("children"),"c1,c2");assert.equal(params.get("caption"),"کپشن");}return ok({id:`c${creations}`});}
    if(url.includes("status_code"))return ok({status_code:url.includes("/c3?") && pending ? "IN_PROGRESS":"FINISHED"});
    if(url.endsWith("media_publish")){published++;return ok({id:"remote"});}return ok({permalink:"https://www.instagram.com/p/test/"});
  })};
  await assert.rejects(()=>publishToChannel(request),/آماده‌سازی/);assert.equal(creations,3);assert.equal(published,0);pending=false;
  await publishToChannel({...request,providerState:persisted});assert.equal(creations,3);assert.equal(published,1);
});
test("Instagram validates carousel count and media type before any provider call",async()=>{
  const {instagramProblems}=await import("../../../packages/shared/src/index");
  assert.ok(instagramProblems({instagramType:"carousel",instagramImages:["https://files.example/a.jpg"]},"caption").length);
  assert.ok(instagramProblems({instagramType:"reel",imageUrl:"https://files.example/a.jpg"},"caption").length);
  assert.ok(instagramProblems({instagramType:"image",imageUrl:"http://files.example/a.jpg"},"caption").length);
  assert.equal(instagramProblems({instagramType:"image",imageUrl:"https://files.example/a.jpg"},"caption").length,0);
});
