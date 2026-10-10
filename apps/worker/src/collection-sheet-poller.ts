import { and, desc, eq } from "drizzle-orm";
import { assertWorkspaceOperational, getDb, workflows, workflowVersions, workflowSteps, collectionSheetSnapshots, fetchGoogleSheet } from "@socialyar/db";
let running=false;
export async function pollCollectionSheets(db=getDb(),read=fetchGoogleSheet) {
  if(running)return;running=true;
  try {
    const active=await db.select().from(workflows).where(eq(workflows.status,"active"));
    for(const workflow of active){
      try { await assertWorkspaceOperational(db,workflow.workspaceId); } catch { continue; }
      const [version]=await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId,workflow.id)).orderBy(desc(workflowVersions.version)).limit(1);if(!version)continue;
      const sources=await db.select().from(workflowSteps).where(and(eq(workflowSteps.workflowVersionId,version.id),eq(workflowSteps.type,"collection_source")));
      for(const source of sources){
        if(source.config.collectionSource!=="google_sheet" || source.config.sheetAutoRefresh!==true || typeof source.config.sheetUrl!=="string")continue;
        const gid=String(source.config.sheetGid??"0"),url=source.config.sheetUrl;
        const [old]=await db.select().from(collectionSheetSnapshots).where(and(eq(collectionSheetSnapshots.workflowId,workflow.id),eq(collectionSheetSnapshots.sourceStepKey,source.key)));
        const minutes=Math.min(1440,Math.max(5,Number(source.config.sheetRefreshMinutes)||5));
        if(old?.sourceUrl===url && old.sheetGid===gid && Date.now()-old.checkedAt.getTime()<minutes*60000)continue;
        let data=null,error:string|null=null;
        try{data=await read(url,gid);}catch(e){error=e instanceof Error?e.message:"خواندن شیت ناموفق بود.";}
        // Only stage a snapshot. Reading a sheet can never approve or enqueue a publication.
        const values={workspaceId:workflow.workspaceId,workflowId:workflow.id,sourceStepKey:source.key,sourceUrl:url,sheetGid:gid,data,error,checkedAt:new Date()};
        await db.insert(collectionSheetSnapshots).values(values).onConflictDoUpdate({target:[collectionSheetSnapshots.workflowId,collectionSheetSnapshots.sourceStepKey],set:values});
      }
    }
  }finally{running=false;}
}
export function startCollectionSheetPoller(){
  const tick=()=>void pollCollectionSheets().catch((e)=>console.error("Google Sheet polling failed",e));
  tick();const timer=setInterval(tick,30000);return ()=>clearInterval(timer);
}
