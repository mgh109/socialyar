import { and, eq, inArray } from "drizzle-orm";
import { collectionBody, collectionTextChanged, collectionDiff, type CollectionRow, type CollectionRecord } from "@socialyar/shared";
import { getDb, contentCollections, collectionImportEvents, contentItems, contentVariants, publications, schedules, approvals, socialAccounts, workflowSteps } from "@socialyar/db";
type Db = ReturnType<typeof getDb>;
export type CollectionScope = { workflowId: string; sourceStepKey: string; targetStepKey: string };
export function collectionWhere(workspaceId: string, input: CollectionScope) {
  return and(eq(contentCollections.workspaceId, workspaceId), eq(contentCollections.workflowId, input.workflowId), eq(contentCollections.sourceStepKey, input.sourceStepKey), eq(contentCollections.targetStepKey, input.targetStepKey));
}
async function states(db: Db, workspaceId: string, records: CollectionRecord[]) {
  const ids = records.map((r) => r.itemId);
  if (!ids.length) return [];
  return db.select({ variant:contentVariants, publication:publications }).from(contentVariants)
    .innerJoin(contentItems,eq(contentVariants.contentItemId,contentItems.id))
    .leftJoin(publications,eq(publications.contentVariantId,contentVariants.id))
    .where(and(eq(contentItems.workspaceId,workspaceId),inArray(contentVariants.id,ids)));
}
function itemStates(rows: Awaited<ReturnType<typeof states>>) {
  return rows.map(({variant,publication}) => ({ id:variant.id,queueVersion:variant.calendarVersion,updatedAt:variant.updatedAt,
    status:publication?.error?.deliveryUnknown ? "delivery_unknown" : publication?.status === "publishing" || publication?.status === "published" ? publication.status : variant.status,
    videoId:publication?.externalId ?? null }));
}
export async function previewCollectionDestination(db: Db, workspaceId: string, input: CollectionScope & { rows:CollectionRow[]; detectRemovals:boolean }) {
  const [collection] = await db.select().from(contentCollections).where(collectionWhere(workspaceId,input));
  const items = await states(db,workspaceId,collection?.records ?? []);
  if(collection?.records.length && items.length!==collection.records.length) throw new Error("نوع مقصد مجموعه تغییر کرده است؛ کارت انتشار جدید بسازید.");
  return { revision:collection?.revision ?? 0,changes:collectionDiff(input.rows,collection?.records ?? [],itemStates(items)).filter((c) => input.detectRemovals || c.kind !== "removed").map((c) => ({ ...c,remoteEligible:false })) };
}
export async function applyCollectionDestination(db: Db, auth:{workspaceId:string;userId:string}, input:CollectionScope & { rows:CollectionRow[];detectRemovals:boolean;revision:number;selected:Array<{id:string;version:number|null;updatedAt:string|null}> },
  target:{step:typeof workflowSteps.$inferSelect;source:typeof workflowSteps.$inferSelect;account:typeof socialAccounts.$inferSelect}) {
  return db.transaction(async(tx) => {
    await tx.insert(contentCollections).values({workspaceId:auth.workspaceId,...{ workflowId:input.workflowId,sourceStepKey:input.sourceStepKey,targetStepKey:input.targetStepKey }}).onConflictDoNothing();
    const [collection] = await tx.select().from(contentCollections).where(collectionWhere(auth.workspaceId,input)).for("update");
    if (collection.revision !== input.revision) throw new Error("مجموعه تغییر کرده است؛ پیش‌نمایش را تازه کنید.");
    const ids=collection.records.map((r)=>r.itemId);
    // Match the calendar/worker lock order: publication first, then its variant.
    if(ids.length) { await tx.select().from(publications).where(inArray(publications.contentVariantId,ids)).for("update"); await tx.select().from(contentVariants).where(inArray(contentVariants.id,ids)).for("update"); }
    const items=await states(tx as unknown as Db,auth.workspaceId,collection.records);
    if(collection.records.length && items.length!==collection.records.length)throw new Error("نوع مقصد مجموعه تغییر کرده است؛ کارت انتشار جدید بسازید.");
    const changes=collectionDiff(input.rows,collection.records,itemStates(items)).filter((c)=>input.detectRemovals || c.kind!=="removed");
    const records=new Map(collection.records.map((r)=>[r.row.id,r])); const applied:Array<{id:string;kind:string}>=[];const seen=new Set<string>();
    for(const selected of input.selected) {
      if(seen.has(selected.id)) throw new Error("انتخاب تکراری است.");seen.add(selected.id);
      const change=changes.find((c)=>c.id===selected.id);
      if(!change || change.kind==="unchanged" || change.blocked) throw new Error(change?.blocked ?? "تغییر انتخاب‌شده معتبر نیست.");
      if(change.version!==selected.version || change.updatedAt!==selected.updatedAt) throw new Error("وضعیت مقصد تغییر کرده است؛ پیش‌نمایش را تازه کنید.");
      const old=items.find((i)=>i.variant.id===change.itemId);const row=change.row;
      if(old?.variant.channel!==undefined && old.variant.channel!==target.account.channel) throw new Error("شبکه مقصد مجموعه را تغییر ندهید؛ کارت جدید بسازید.");
      if(change.kind==="removed") {
        if(old?.publication) { await tx.update(publications).set({status:"cancelled",queueVersion:old.publication.queueVersion+1,updatedAt:new Date()}).where(eq(publications.id,old.publication.id)); if(old.publication.scheduleId) await tx.update(schedules).set({status:"cancelled",updatedAt:new Date()}).where(eq(schedules.id,old.publication.scheduleId)); }
        await tx.update(contentVariants).set({settings:{...old!.variant.settings,calendarPaused:true,calendarHold:true},calendarVersion:old!.variant.calendarVersion+1,updatedAt:new Date()}).where(eq(contentVariants.id,old!.variant.id));
        await tx.update(approvals).set({status:"rejected",resolvedAt:new Date(),resolvedBy:auth.userId}).where(and(eq(approvals.contentVariantId,old!.variant.id),eq(approvals.status,"pending")));
        records.set(row.id,{row,itemId:old!.variant.id,active:false});
      } else {
        if(row.scheduledAt && Date.parse(row.scheduledAt)<=Date.now()) throw new Error(`«${row.title}»: زمان انتشار گذشته است.`);
        const settings:Record<string,unknown>={...old?.variant.settings,accountId:target.account.id,accountName:target.account.displayName ?? target.account.externalAccountId,
          connection:old?.variant.settings.connection ?? target.step.config.connection,mediaConnection:target.source.config.mediaConnection,
          collectionId:collection.id,collectionSourceKey:input.sourceStepKey,collectionRowId:row.id,workflowId:input.workflowId,publishStepKey:input.targetStepKey,calendarHold:true,calendarPaused:false};
        delete settings.instagramContainerId; delete settings.instagramChildren;
        if(target.account.channel === "instagram") {
          if(!old || change.fields.includes("instagramType")) settings.instagramType=row.instagramType ?? target.step.config.instagramType;
          if(!old || change.fields.includes("instagramImages")) settings.instagramImages=row.instagramImages ?? target.step.config.instagramImages ?? [];
        }
        for(const [field,key] of [["videoUrl","videoUrl"],["coverUrl","imageUrl"],["videoType","videoType"]] as const) if(!old || change.fields.includes(field)) settings[key]=row[field] || null;
        const title=!old || change.fields.includes("title") ? row.title : old.variant.title;
        const body=!old || collectionTextChanged(change.fields,target.account.channel) || change.fields.includes("title") && !row.description ? collectionBody(row,target.account.channel) : old.variant.body;
        let variantId=old?.variant.id;let scheduleId=old?.publication?.scheduleId;
        let date=row.scheduledAt ? new Date(row.scheduledAt) : null;
        if(old && !change.fields.includes("scheduledAt") && scheduleId) { const [schedule]=await tx.select().from(schedules).where(eq(schedules.id,scheduleId));date=old.variant.settings.calendarUnscheduled ? null : schedule?.scheduledAt ?? null; }
        settings.calendarUnscheduled=!date;
        if(old) await tx.update(contentVariants).set({title,body,settings,status:"waiting_approval",calendarVersion:old.variant.calendarVersion+1,updatedAt:new Date()}).where(eq(contentVariants.id,old.variant.id));
        else { const [content]=await tx.insert(contentItems).values({workspaceId:auth.workspaceId,title,body,metadata:{workflowId:input.workflowId,publishStepKey:input.targetStepKey,collectionId:collection.id},status:"waiting_approval"}).returning();
          const [variant]=await tx.insert(contentVariants).values({contentItemId:content.id,channel:target.account.channel,title,body,settings,status:"waiting_approval",generatedBy:"collection"}).returning();variantId=variant.id; }
        if(date && !scheduleId) { const [schedule]=await tx.insert(schedules).values({workspaceId:auth.workspaceId,contentVariantId:variantId!,socialAccountId:target.account.id,scheduledAt:date,timezone:"Asia/Tehran",status:"scheduled"}).returning();scheduleId=schedule.id; }
        else if(scheduleId) await tx.update(schedules).set({...(date?{scheduledAt:date}:{}),status:date?"scheduled":"cancelled",updatedAt:new Date()}).where(eq(schedules.id,scheduleId));
        if(old?.publication) await tx.update(publications).set({status:"cancelled",socialAccountId:target.account.id,scheduleId,queueVersion:old.publication.queueVersion+1,error:null,updatedAt:new Date()}).where(eq(publications.id,old.publication.id));
        else await tx.insert(publications).values({workspaceId:auth.workspaceId,contentVariantId:variantId!,socialAccountId:target.account.id,scheduleId,status:"cancelled"});
        await tx.update(approvals).set({status:"changes_requested",resolvedAt:new Date(),resolvedBy:auth.userId}).where(and(eq(approvals.contentVariantId,variantId!),eq(approvals.status,"pending")));
        await tx.insert(approvals).values({workspaceId:auth.workspaceId,contentVariantId:variantId!,requestedBy:"collection"});
        records.set(row.id,{row,itemId:variantId!,active:true});
      }
      applied.push({id:row.id,kind:change.kind});
    }
    await tx.update(contentCollections).set({records:[...records.values()],revision:collection.revision+1,updatedAt:new Date()}).where(eq(contentCollections.id,collection.id));
    await tx.insert(collectionImportEvents).values({collectionId:collection.id,workspaceId:auth.workspaceId,userId:auth.userId,revision:collection.revision+1,detail:{applied}});
    return {ok:true,applied,queueFailures:0};
  });
}
