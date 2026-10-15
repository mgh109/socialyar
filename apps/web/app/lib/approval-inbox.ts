import type {ApprovalRow,WorkflowApproval,YoutubeItem} from "./approval-types";
export type {ApprovalRow} from "./approval-types";
export type InboxState="pending"|"attention"|"running";
type Summary={key:string;title:string;excerpt:string;channel:string;context:string;state:InboxState;createdAt:string|null};
export type InboxItem=Summary & ({kind:"workflow";data:WorkflowApproval}|{kind:"youtube";data:YoutubeItem}|{kind:"content";data:ApprovalRow});
export const approvalChannels:Record<string,string>={workflow:"جریان",youtube:"یوتیوب",instagram:"اینستاگرام",telegram:"تلگرام",eitaa:"ایتا",bale:"بله",website:"وب‌سایت",x:"ایکس",linkedin:"لینکدین"};
export function approvalInbox(workflows:WorkflowApproval[],youtube:YoutubeItem[],content:ApprovalRow[]):InboxItem[]{
  const items:InboxItem[]=workflows.map(data=>({kind:"workflow",key:`workflow:${data.runId}:${data.stepKey}`,title:data.output?.title|| (data.output?.commentId ? "بررسی کامنت" : data.stepName),excerpt:data.output?.reply||data.output?.text||"خروجی آمادهٔ بررسی",channel:data.output?.commentId?"youtube":"workflow",context:data.workflowName,state:"pending",createdAt:data.createdAt,data}));
  for(const data of youtube){
    if(!["waiting_approval","failed","queued","uploading","processing","preparing"].includes(data.status) && !(data.status==="waiting_video" && data.settings.collectionId))continue;
    items.push({kind:"youtube",key:`youtube:${data.id}`,title:data.title,excerpt:data.description,channel:"youtube",context:data.channelName,state:data.status==="waiting_approval"?"pending":data.status==="failed"?"attention":"running",createdAt:data.createdAt??data.updatedAt,data});
  }
  const variants=new Set<string>();
  for(const data of content){
    if(data.approval.status!=="pending" || data.variant.channel==="youtube" || variants.has(data.variant.id))continue;
    variants.add(data.variant.id);
    items.push({kind:"content",key:`content:${data.approval.id}`,title:data.variant.title||data.content.title||"بدون عنوان",excerpt:data.variant.body,channel:data.variant.channel,context:"محتوای آمادهٔ انتشار",state:data.variant.settings?.imagePrepared===false?"running":"pending",createdAt:data.approval.createdAt,data});
  }
  const rank={pending:0,attention:1,running:2};
  return items.sort((a,b)=>rank[a.state]-rank[b.state] || (Date.parse(a.createdAt??"")||0)-(Date.parse(b.createdAt??"")||0) || a.key.localeCompare(b.key));
}
const normalized=(value:string)=>value.normalize("NFKC").replace(/ي/g,"ی").replace(/ك/g,"ک").toLocaleLowerCase("fa");
export function filterApprovalInbox(items:InboxItem[],state:InboxState|"all",channel:string,search:string){
  const query=normalized(search.trim());
  return items.filter(item=>(state==="all"||item.state===state)&&(!channel||item.channel===channel)&&(!query||normalized(`${item.title} ${item.excerpt} ${item.context}`).includes(query)));
}
