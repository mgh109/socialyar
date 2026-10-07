import { test } from "node:test";
import assert from "node:assert/strict";
import { collectionRowsSchema, collectionDiff, dropboxDownloadUrl, type CollectionRow } from "../../../packages/shared/src/content-collection";
import { inferMapping, mapCollectionRows, scheduleCollectionRows, readCollectionSheet } from "../../web/app/lib/collection-sheet";
import { assertShorts, inspectVideo } from "../../../packages/db/src/video-inspection";
import { publicMediaAddress } from "../../../packages/db/src/collection-media";
import { graphProblem } from "../../../packages/workflow/src/graph";
const row = (id="episode-1", order=1): CollectionRow => ({ id,order,title:`قسمت ${order}`,description:"توضیحات",videoUrl:`https://files.example.com/${id}.mp4`,coverUrl:"",scheduledAt:null,videoType:"video",playlist:"آموزش",tags:[],privacy:"private",madeForKids:false });
const state = { id:"item-1",status:"waiting_approval",queueVersion:3,videoId:null,updatedAt:new Date("2026-10-08T00:00:00Z") };
test("stable IDs distinguish edits, additions and removals independently of spreadsheet order",()=>{
  const previous = [{ row:row(),itemId:"item-1",active:true },{ row:row("removed",2),itemId:"item-2",active:true }];
  const changes = collectionDiff([row("new",3),{ ...row(),title:"عنوان جدید",order:4 }],previous,[state]);
  assert.deepEqual(changes.map((c)=>[c.id,c.kind]),[["new","added"],["episode-1","changed"],["removed","removed"]]);
  assert.deepEqual(changes[1].fields,["order","title"]); assert.equal(changes[1].version,3);
});
test("reimported identical content is unchanged and cancelled IDs restore the same item",()=>{
  const prior = [{ row:row(),itemId:"item-1",active:true }];
  assert.equal(collectionDiff([row()],prior,[state])[0].kind,"unchanged");
  const restored = collectionDiff([row()],[{ ...prior[0],active:false }],[state])[0];
  assert.equal(restored.kind,"changed");assert.equal(restored.itemId,"item-1");
});
test("published, processing, partial uploads and active preparation are locked",()=>{
  for (const patch of [{ status:"published",videoId:"yt" },{ status:"uploading" },{ sessionEnc:"session" },{ status:"preparing" }]) {
    const changes=collectionDiff([{ ...row(),title:"تغییر" }],[{ row:row(),itemId:state.id,active:true }],[{ ...state,...patch }]);
    assert.ok(changes[0].blocked);
  }
});
test("duplicate IDs, duplicate episode order and unsafe URL schemes reject a batch",()=>{
  assert.equal(collectionRowsSchema.safeParse([row(),row()]).success,false);
  assert.equal(collectionRowsSchema.safeParse([row(),row("another")]).success,false);
  for (const videoUrl of ["http://files.example.com/x.mp4","https://user:pass@files.example.com/x.mp4"]) assert.equal(collectionRowsSchema.safeParse([{ ...row(),videoUrl }]).success,false);
});
test("Persian headers, digits, schedule, boolean and optional columns map correctly",()=>{
  const headers=["شناسه محتوا","ترتیب قسمت","عنوان","لینک ویدئو","تاریخ انتشار شمسی","ساعت انتشار","نوع محتوا","مخصوص کودکان"];
  const { rows,errors }=mapCollectionRows({ headers,rows:[["stable","۲","آموزش","https://files.example.com/v.mp4","۱۴۰۵/۰۷/۲۰","۱۸:۰۰","shorts","خیر"]] },inferMapping(headers));
  assert.deepEqual(errors,[]);assert.equal(rows[0].order,2);assert.equal(rows[0].scheduledAt,"2026-10-12T14:30:00.000Z");assert.equal(rows[0].videoType,"shorts");assert.equal(rows[0].madeForKids,false);
});
test("invalid rows are reported without losing healthy rows",()=>{
  const headers=["id","title","videoUrl","privacy"];
  const result=mapCollectionRows({ headers,rows:[["good","عنوان","https://files.example.com/v.mp4","private"],["bad","عنوان","javascript:bad","unknown"]] },inferMapping(headers));
  assert.equal(result.rows.length,1);assert.equal(result.errors.length,1);
});
test("batch scheduling respects Tehran clock, allowed weekdays and explicit dates",()=>{
  const explicit="2027-01-01T10:00:00.000Z";
  const result=scheduleCollectionRows([row(),row("second",2),{ ...row("third",3),scheduledAt:explicit }],"2026-10-10T14:30:00.000Z",2,[0,2,4]);
  assert.equal(result[0].scheduledAt,"2026-10-10T14:30:00.000Z");assert.equal(result[1].scheduledAt,"2026-10-12T14:30:00.000Z");assert.equal(result[2].scheduledAt,explicit);
  assert.throws(()=>scheduleCollectionRows([row()],"2026-10-10T14:30:00Z",1,[]));
});
test("Dropbox is only a normalization helper; ordinary host links keep their signed query",()=>{
  assert.equal(dropboxDownloadUrl("https://files.example.com/v.mp4?signature=abc"),"https://files.example.com/v.mp4?signature=abc");
  const url=new URL(dropboxDownloadUrl("https://www.dropbox.com/scl/fi/test/v.mp4?rlkey=abc&dl=0"));
  assert.equal(url.searchParams.get("raw"),"1");assert.equal(url.searchParams.get("rlkey"),"abc");assert.equal(url.searchParams.has("dl"),false);
});
test("download destinations cannot point at private addresses or credential-bearing URLs",async()=>{
  for (const url of ["https://127.0.0.1/x","https://10.0.0.1/x","http://files.example.com/x","https://user:password@example.com/x"]) await assert.rejects(publicMediaAddress(url));
});
test("Shorts rejects landscape and overlength videos without silently converting",()=>{
  assert.doesNotThrow(()=>assertShorts({ width:1080,height:1920,duration:180 }));
  assert.throws(()=>assertShorts({ width:1920,height:1080,duration:10 }));assert.throws(()=>assertShorts({ width:1080,height:1920,duration:181 }));
});
test("collection source is a valid direct publishing graph but cannot feed processing nodes",()=>{
  assert.equal(graphProblem([{ key:"s",type:"collection_source" },{ key:"p",type:"publish" }],[{ sourceKey:"s",targetKey:"p" }],true),null);
  assert.equal(graphProblem([{ key:"s",type:"collection_source" },{ key:"a",type:"ai" }],[{ sourceKey:"s",targetKey:"a" }],false),"graph_invalid_connection");
});
test("published metadata offers an explicit update, while file replacement never allows reupload",()=>{
  const record={ row:row(),itemId:state.id,active:true };const published={ ...state,status:"published",videoId:"yt-confirmed" };
  const metadata=collectionDiff([{ ...row(),title:"عنوان اصلاح‌شده" }],[record],[published])[0];assert.equal(metadata.remoteEligible,true);assert.ok(metadata.blocked);
  const replacement=collectionDiff([{ ...row(),videoUrl:"https://files.example.com/new.mp4" }],[record],[published])[0];assert.equal(replacement.remoteEligible,false);assert.ok(replacement.blocked);
});
test("actual video inspection reads dimensions and duration before Shorts approval",async()=>{
  const { execFileSync }=await import("node:child_process");
  const bytes=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=black:s=108x192:r=1","-t","1","-c:v","libx264","-movflags","frag_keyframe+empty_moov","-f","mp4","pipe:1"],{ maxBuffer:1_000_000 });
  const details=await inspectVideo(bytes);assert.equal(details.width,108);assert.equal(details.height,192);assert.equal(details.duration,1);assert.doesNotThrow(()=>assertShorts(details));
});
test("real XLSX files parse headers, hyperlinks and Persian cells with the on-demand ExcelJS import",async()=>{
  const { createRequire }=await import("node:module");const require=createRequire(new URL("../../web/package.json",import.meta.url));const ExcelJS=require("exceljs");
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("محتوا");sheet.addRow(["شناسه محتوا","عنوان","لینک ویدئو"]);sheet.addRow(["episode-01","قسمت اول",{ text:"دانلود",hyperlink:"https://files.example.com/one.mp4" }]);
  const bytes=new Uint8Array(await book.xlsx.writeBuffer());const data=await readCollectionSheet(new File([bytes],"collection.xlsx"));
  assert.deepEqual(data.headers,["شناسه محتوا","عنوان","لینک ویدئو"]);const result=mapCollectionRows(data,inferMapping(data.headers));
  assert.deepEqual(result.errors,[]);assert.equal(result.rows[0].id,"episode-01");assert.equal(result.rows[0].videoUrl,"https://files.example.com/one.mp4");
});
test("spreadsheet formulas are rejected instead of evaluating or trusting cached results",async()=>{
  const { createRequire }=await import("node:module");const require=createRequire(new URL("../../web/package.json",import.meta.url));const ExcelJS=require("exceljs");
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("محتوا");sheet.addRow(["id","title","videoUrl"]);sheet.addRow(["one",{ formula:"1+1",result:2 },"https://files.example.com/one.mp4"]);
  const bytes=new Uint8Array(await book.xlsx.writeBuffer());await assert.rejects(readCollectionSheet(new File([bytes],"collection.xlsx")),/فرمول/);
});
