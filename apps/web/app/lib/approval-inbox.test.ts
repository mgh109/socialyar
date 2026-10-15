import {test} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {approvalInbox,filterApprovalInbox,type ApprovalRow} from "./approval-inbox";
import {WorkflowApprovalCard,type WorkflowApproval} from "../components/workflow-approval-card";
import {YoutubeReview,type YoutubeItem} from "../components/youtube-panel";
import {ContentApprovalReview} from "../components/content-approval-review";
const require=createRequire(new URL("../../package.json",import.meta.url));
const React=require("react");const {renderToStaticMarkup}=require("react-dom/server");Object.assign(globalThis,{React});
const workflow:WorkflowApproval={runId:"run",workflowName:"خبرهای روز",stepKey:"approval",stepName:"تأیید خبر",createdAt:"2026-10-15T10:00:00Z",output:{title:"خبر آموزشی",text:"متن کامل محتوا"}};
const youtube=(id:string,status:string):YoutubeItem=>({id,status,runId:null,stepKey:"youtube",title:`آموزش ${id}`,description:"حفظ سورهٔ ناس",channelName:"مدرسه حفظ",videoId:null,progress:0,actualPrivacy:null,error:null,createdAt:"2026-10-15T11:00:00Z",updatedAt:"2026-10-15T11:00:00Z",scheduledAt:null,settings:{collectionId:"collection"},logs:[]});
const row:ApprovalRow={approval:{id:"approval",status:"pending",reason:null,agentRecommendation:null,createdAt:"2026-10-15T12:00:00Z"},variant:{id:"variant",channel:"eitaa",title:"خبر ایتا",body:"متن ایتا",status:"waiting_approval",calendarVersion:2,updatedAt:"2026-10-15T12:00:00Z"},content:{id:"content",runId:null,title:null}};
test("one inbox contains current decisions and follow-ups, without resolved items or duplicate variants",()=>{
  const items=approvalInbox([workflow],[youtube("ready","waiting_approval"),youtube("failed","failed"),youtube("sending","uploading"),youtube("old","published")],[row,{...row,approval:{...row.approval,id:"duplicate"}},{...row,variant:{...row.variant,id:"resolved"},approval:{...row.approval,id:"resolved",status:"approved"}}]);
  assert.equal(items.length,5);assert.deepEqual(items.map(item=>item.state),["pending","pending","pending","attention","running"]);
  assert.equal(items.filter(item=>item.kind==="content").length,1);assert.equal(items[0].key,"workflow:run:approval");
  assert.equal(filterApprovalInbox(items,"pending","","").length,3);
  assert.equal(filterApprovalInbox(items,"attention","youtube","")[0].key,"youtube:failed");
});
test("search recognizes Persian/Arabic letters and filters network independently of queue state",()=>{
  const items=approvalInbox([workflow],[youtube("کودکان","waiting_approval")],[row]);
  assert.equal(filterApprovalInbox(items,"pending","youtube","كودكان").length,1);
  assert.equal(filterApprovalInbox(items,"pending","eitaa","ایتـا").length,0);
  assert.equal(filterApprovalInbox(items,"all","","  خبر  ").length,2);
  assert.equal(filterApprovalInbox(items,"running","","").length,0);
});
test("a pending image job is shown under running rather than ready for approval",()=>{
  const items=approvalInbox([],[],[{...row,variant:{...row.variant,settings:{imagePrepared:false}}}]);
  assert.equal(items[0].state,"running");assert.equal(filterApprovalInbox(items,"pending","","").length,0);
});
test("workflow review displays each image once and keeps editing fields collapsed",()=>{
  const html=renderToStaticMarkup(React.createElement(WorkflowApprovalCard,{item:{...workflow,output:{...workflow.output,imageUrl:"https://example.com/cover.jpg",images:[{url:"https://example.com/cover.jpg"}]}},busy:false,resolve:async()=>{}}));
  assert.equal((html.match(/<img /g)??[]).length,1);assert.doesNotMatch(html,/<textarea|<input/);assert.match(html,/متن کامل محتوا/);assert.match(html,/ویرایش متن/);assert.match(html,/تأیید و ادامه/);
});
test("YouTube review keeps scheduled approval and explicit rejection, with forms and logs collapsed",()=>{
  const item={...youtube("ready","waiting_approval"),scheduledAt:"2026-11-01T10:00:00Z"};
  const html=renderToStaticMarkup(React.createElement(YoutubeReview,{item,reviewMode:true,refresh:()=>{}}));
  assert.doesNotMatch(html,/<textarea|<input/);assert.match(html,/تأیید انتشار زمان‌بندی‌شده/);assert.match(html,/جزئیات و گزارش‌ها/);assert.doesNotMatch(html,/aria-label="وضعیت آماده‌سازی"/);
});
test("content awaiting image preparation cannot be approved from the reading view",()=>{
  const html=renderToStaticMarkup(React.createElement(ContentApprovalReview,{row:{...row,variant:{...row.variant,settings:{imagePrepared:false}}},busy:false,resolve:async()=>{},save:async()=>true}));
  assert.match(html,/<button[^>]*disabled=""[^>]*>تأیید محتوا/);assert.doesNotMatch(html,/<textarea|<input/);
});
