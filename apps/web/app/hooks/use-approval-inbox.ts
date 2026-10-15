"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {apiFetch} from "../lib/session";
import type {ApprovalRow,WorkflowApproval,YoutubeItem} from "../lib/approval-types";
export function useApprovalInbox(workspaceId:string){
  const [workflows,setWorkflows]=useState<WorkflowApproval[]>([]),[youtube,setYoutube]=useState<YoutubeItem[]>([]),[content,setContent]=useState<ApprovalRow[]>([]);
  const [errors,setErrors]=useState<Record<string,string>>({}),[loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[updatedAt,setUpdatedAt]=useState<number|null>(null);
  const flight=useRef<Promise<void>|null>(null),generation=useRef(0),controller=useRef<AbortController|null>(null),scope=useRef("");
  const refresh=useCallback(async(force=false)=>{
    if(!workspaceId||scope.current!==workspaceId)return;
    if(flight.current){await flight.current;if(!force||scope.current!==workspaceId)return;}
    const current=++generation.current;const abort=new AbortController();controller.current=abort;setRefreshing(true);
    const get=async(path:string)=>{const response=await apiFetch(path,{signal:abort.signal});if(!response.ok)throw new Error("دریافت صف ناموفق بود");const data=await response.json();if(!Array.isArray(data))throw new Error("پاسخ صف معتبر نیست");return data;};
    const task=(async()=>{
      const results=await Promise.allSettled([get("/workflow-approvals"),get("/youtube/items"),get(`/approvals?workspaceId=${encodeURIComponent(workspaceId)}&status=pending`)]);
      if(generation.current!==current)return;
      const failed:Record<string,string>={};const names=["workflow","youtube","content"],labels=["تأییدهای جریان","محتواهای یوتیوب","تأییدهای انتشار"];
      results.forEach((result,index)=>{if(result.status==="rejected")failed[names[index]]=labels[index];else if(index===0)setWorkflows(result.value);else if(index===1)setYoutube(result.value);else setContent(result.value);});
      setErrors(failed);if(results.some(result=>result.status==="fulfilled"))setUpdatedAt(Date.now());setLoading(false);
    })();flight.current=task;
    try{await task;}finally{if(generation.current===current){flight.current=null;setRefreshing(false);}}
  },[workspaceId]);
  useEffect(()=>{
    scope.current=workspaceId;
    setWorkflows([]);setYoutube([]);setContent([]);setErrors({});setLoading(true);setUpdatedAt(null);
    void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh();},15000);
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};document.addEventListener("visibilitychange",visible);
    return()=>{scope.current="";generation.current++;controller.current?.abort();flight.current=null;window.clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
  },[refresh]);
  return{workflows,youtube,content,errors,loading,refreshing,updatedAt,refresh};
}
