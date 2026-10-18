import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {analysisWindows,collectYoutubeAnalysis} from "@socialyar/db";
import {youtubeAnalysisConfig} from "@socialyar/shared";
import {graphProblem} from "@socialyar/workflow/graph";
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
const config={accountId:randomUUID(),days:7,videoLimit:2,commentLimit:2};
const now=new Date("2026-10-18T14:00:00Z");
test("analysis windows are adjacent equal periods ending yesterday in Pacific time",()=>{
 assert.deepEqual(analysisWindows(7,now),{current:{start:"2026-10-11",end:"2026-10-17"},previous:{start:"2026-10-04",end:"2026-10-10"}});
 assert.equal(analysisWindows(7,new Date("2026-10-18T01:00:00Z")).current.end,"2026-10-16");
});
test("analysis is a source and must lead to an output; invalid limits fail",()=>{
 assert.equal(graphProblem([{key:"analysis",type:"youtube_analysis"},{key:"report",type:"draft"}],[{sourceKey:"analysis",targetKey:"report"}],true),null);
 assert.equal(graphProblem([{key:"analysis",type:"youtube_analysis"}],[],true),"graph_unfinished_branch");
 assert.equal(graphProblem([{key:"a",type:"manual_input"},{key:"b",type:"youtube_analysis"}],[{sourceKey:"a",targetKey:"b"}],false),"graph_invalid_connection");
 for(const field of ["days","videoLimit","commentLimit"])assert.equal(youtubeAnalysisConfig.safeParse({...config,[field]:999}).success,false);
});
function mock(analyticsStatus=200,zeroBaseline=false) {
 const calls:string[]=[];
 const request=(async(url:any,options:any)=>{
  const u=new URL(url);calls.push(String(url));assert.equal(options.headers.Authorization,"Bearer test-token");
  if(u.pathname.endsWith("/channels"))return json({items:[{id:"channel",snippet:{title:"کانال"},statistics:{viewCount:"1000",hiddenSubscriberCount:true,videoCount:"4"},contentDetails:{relatedPlaylists:{uploads:"uploads"}}}]});
  if(u.pathname.endsWith("/playlistItems"))return json({items:[{contentDetails:{videoId:"v1"}},{contentDetails:{videoId:"v2"}},{contentDetails:{videoId:"ignored"}}]});
  if(u.pathname.endsWith("/videos")){assert.equal(u.searchParams.get("id"),"v1,v2");return json({items:[{id:"v1",snippet:{title:"اول"},statistics:{viewCount:"5"}},{id:"v2",snippet:{title:"دوم"},statistics:{viewCount:"10",likeCount:"2",commentCount:"3"}}]});}
  if(u.pathname.endsWith("/commentThreads")){
   const top=(id:string,author:string,date:string)=>({snippet:{videoId:"v1",topLevelComment:{id,snippet:{textDisplay:"نظر",authorChannelId:{value:author},publishedAt:date}}}});
   return u.searchParams.has("pageToken")?json({items:[top("b","viewer","2026-10-16T12:00:00Z")]}):json({items:[top("own","channel","2026-10-17T12:00:00Z"),top("a","viewer","2026-10-17T12:00:00Z")],nextPageToken:"next"});
  }
  assert.equal(u.hostname,"youtubeanalytics.googleapis.com");
  const previous=u.searchParams.get("startDate")==="2026-10-04";
  return analyticsStatus!==200?json({error:{errors:[{reason:"forbidden"}]}},analyticsStatus):json({columnHeaders:[{name:"views"},{name:"estimatedMinutesWatched"},{name:"subscribersGained"}],rows:[[previous?(zeroBaseline?0:10):20,previous?5:10,0]]});
 }) as typeof fetch;
 return {request,calls};
}
test("reads real stats, bounded videos, paginated viewer comments and period growth",async()=>{
 const {request,calls}=mock();const report=await collectYoutubeAnalysis("test-token","channel",config,request,now);
 assert.equal(report.channel.subscribers,null);assert.equal(report.channel.views,1000);
 assert.deepEqual(report.videos.map((v:any)=>v.id),["v2","v1"]);assert.equal(report.videos[1].likes,null);
 assert.deepEqual(report.comments.map(c=>c.id),["a","b"]);assert.equal(report.sample.readVideos,2);
 assert.equal(report.analytics.current?.views,20);assert.equal(report.analytics.changesPercent.views,100);assert.equal(report.analytics.changesPercent.subscribersGained,null);
 assert.equal(calls.length,7);assert.ok(report.warnings.length);
});
test("missing Analytics permission degrades explicitly, never fakes period totals",async()=>{
 const report=await collectYoutubeAnalysis("test-token","channel",config,mock(403).request,now);
 assert.equal(report.analytics.current,null);assert.equal(report.analytics.previous,null);assert.equal(report.analytics.changesPercent.views,null);
 assert.equal(report.channel.views,1000);assert.ok(report.warnings.some(w=>w.includes("Analytics")));
});
test("zero baseline gives no percentage; disabling comments makes no comment request",async()=>{
 const {request,calls}=mock(200,true);const report=await collectYoutubeAnalysis("test-token","channel",{...config,commentLimit:0},request,now);
 assert.equal(report.analytics.changesPercent.views,null);assert.equal(report.comments.length,0);assert.ok(calls.every(c=>!c.includes("commentThreads")));
});
test("does not substitute another channel or swallow primary API errors",async()=>{
 await assert.rejects(()=>collectYoutubeAnalysis("test-token","other",config,mock().request,now),/کانال/);
 await assert.rejects(()=>collectYoutubeAnalysis("test-token","channel",config,(async()=>json({error:{}},429)) as typeof fetch,now),/429/);
});

test("duration/age cohorts and snapshot changes handle missing data and chronology",async()=>{
 const {videoComparison,compareActionSnapshots}=await import("@socialyar/shared");
 assert.deepEqual(videoComparison("PT2M","2026-10-16T14:00:00Z",100,now),{durationSeconds:120,format:"short_candidate",ageDays:2,ageGroup:"week",viewsPerDay:50});assert.equal(videoComparison("PT4M","2026-09-15T14:00:00Z",100,now).format,"long");assert.equal(videoComparison(undefined,undefined,null,now).viewsPerDay,null);assert.equal(videoComparison("PT4M","2027-01-01T00:00:00Z",10,now).ageGroup,"unknown");
 const state={completedAt:"2026-10-17T00:00:00Z",baselineAt:"2026-10-16T00:00:00Z",videoViews:{v1:100,v2:null,v3:10}};const rows=compareActionSnapshots([{title:"اقدام",state}],[{id:"v1",views:120},{id:"v2",views:20}],now.toISOString());assert.deepEqual(rows.map(r=>r.delta),[20,null,null]);assert.deepEqual(compareActionSnapshots([{title:"اقدام",state}],[],"2026-10-16T00:00:00Z"),[]);
});
test("growth plan validates structure and strips invented references",async()=>{
 const {analyzeYoutubeChannel}=await import("../../../packages/ai/src/index");const original=globalThis.fetch;const action={title:"عنوان",evidence:"شاهد",metric:"معیار",videoIds:["real","fake"]};let content=JSON.stringify({summary:"خلاصه",actions:[action,action,action],ideas:[{title:"ایده",outline:"طرح",cover:"کاور",commentIds:["comment","fake"]}]});globalThis.fetch=(async()=>json({choices:[{message:{content}}]})) as typeof fetch;
 try {const connection={provider:"gapgpt",model:"test",token:"test"} as const;const result=await analyzeYoutubeChannel(connection,{videos:[{id:"real"}],comments:[{id:"comment"}]},"");assert.deepEqual(result.actions[0].videoIds,["real"]);assert.deepEqual(result.ideas[0].commentIds,["comment"]);content="not json";await assert.rejects(()=>analyzeYoutubeChannel(connection,{},""),/قالب/);content=JSON.stringify({summary:"خلاصه",actions:[],ideas:[]});await assert.rejects(()=>analyzeYoutubeChannel(connection,{},""),/سه اقدام/);}finally{globalThis.fetch=original;}
});
