import { videoComparison, youtubeAnalysisConfig } from "@socialyar/shared";
import { youtubeToken } from "./youtube";

const count = (value: unknown): number | null => value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Number(value);
export function analysisWindows(days: number, now = new Date()) {
  // YouTube Analytics dates follow Pacific time; UTC is used for stored timestamps.
  const today = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
  const shift = (n:number) => new Date(Date.parse(`${today}T12:00:00Z`)+n*86400000).toISOString().slice(0,10);
  return {current:{start:shift(-days),end:shift(-1)},previous:{start:shift(-2*days),end:shift(-days-1)}};
}
export async function collectYoutubeAnalysis(token: string, channelId: string, raw: unknown, request: typeof fetch = fetch, now = new Date()) {
  const config = youtubeAnalysisConfig.parse(raw);
  const warnings: string[] = [];
  const get = async (base:string, params:Record<string,string>) => {
    const response = await request(`${base}?${new URLSearchParams(params)}`, {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
    const data = await response.json() as any;
    if (!response.ok) throw new Error(`خواندن گزارش یوتیوب ناموفق بود (${response.status}، ${String(data?.error?.errors?.[0]?.reason ?? "خطای سرویس")}).`);
    return data;
  };
  const api = (path:string,params:Record<string,string>) => get(`https://www.googleapis.com/youtube/v3/${path}`,params);
  const channels = await api("channels",{part:"snippet,statistics,contentDetails",id:channelId});
  const channel = channels.items?.find((item:any)=>item.id===channelId);
  if (!channel) throw new Error("کانال متصل‌شده پیدا نشد؛ اتصال یوتیوب را بررسی کنید.");
  const windows = analysisWindows(config.days,now);
  const ids:string[]=[];
  let pageToken="";
  const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (playlistId) {
    // Bound API use independently of channel size.
    for(let page=0;page<4 && ids.length<config.videoLimit;page++) {
      const data=await api("playlistItems",{part:"contentDetails",playlistId,maxResults:"50",...(pageToken?{pageToken}:{})});
      for(const item of data.items??[]) {const id=item.contentDetails?.videoId;if(id && !ids.includes(id))ids.push(id);if(ids.length===config.videoLimit)break;}
      pageToken=data.nextPageToken??"";if(!pageToken)break;
    }
  }
  const data=ids.length?await api("videos",{part:"snippet,statistics,contentDetails",id:ids.join(",")}):{items:[]};
  const videos=(data.items??[]).map((v:any)=>({id:v.id,title:String(v.snippet?.title??"").slice(0,300),publishedAt:v.snippet?.publishedAt,
    duration:v.contentDetails?.duration,views:count(v.statistics?.viewCount),likes:count(v.statistics?.likeCount),comments:count(v.statistics?.commentCount),...videoComparison(v.contentDetails?.duration,v.snippet?.publishedAt,count(v.statistics?.viewCount),now)}))
    .sort((a:any,b:any)=>(b.views??0)-(a.views??0));
  const comments:Array<{id:string;videoId:string;text:string;publishedAt:string}>=[];
  if(config.commentLimit>0) {
    pageToken="";
    try {
      for(let page=0;page<4 && comments.length<config.commentLimit;page++) {
        const result=await api("commentThreads",{part:"snippet",allThreadsRelatedToChannelId:channelId,order:"time",textFormat:"plainText",maxResults:"100",...(pageToken?{pageToken}:{})});
        let older=false;
        for(const item of result.items??[]) {
          const c=item.snippet?.topLevelComment;
          if(!c?.snippet)continue;
          if(c.snippet.publishedAt.slice(0,10)<windows.current.start){older=true;continue;}
          if(c.snippet.authorChannelId?.value===channelId)continue;
          comments.push({id:c.id,videoId:item.snippet.videoId,text:String(c.snippet.textDisplay??"").slice(0,1500),publishedAt:c.snippet.publishedAt});
          if(comments.length===config.commentLimit)break;
        }
        pageToken=result.nextPageToken??"";if(!pageToken||older)break;
      }
    }catch {warnings.push("نمونه کامنت‌ها کامل خوانده نشد؛ مجوز، سهمیه و فعال‌بودن کامنت‌ها را بررسی کنید.");}
  }
  const metrics="views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained,subscribersLost";
  const period=async(range:{start:string;end:string})=>{
    const result=await get("https://youtubeanalytics.googleapis.com/v2/reports",{ids:`channel==${channelId}`,startDate:range.start,endDate:range.end,metrics});
    if(!result.rows?.length)return null;
    return Object.fromEntries((result.columnHeaders??[]).map((header:any,i:number)=>[header.name,count(result.rows[0][i])]));
  };
  let current:Record<string,number|null>|null=null,previous:Record<string,number|null>|null=null;
  try { current=await period(windows.current);previous=await period(windows.previous); }
  catch {warnings.push("Analytics در دسترس نیست؛ API آن را فعال و اتصال کانال را برای مجوز تحلیل دوباره برقرار کنید. آمار تجمعی جایگزین آمار بازه نیست.");}
  const changes:Record<string,number|null>={};
  for(const metric of ["views","estimatedMinutesWatched","subscribersGained"]) {
    const a=current?.[metric],b=previous?.[metric];changes[metric]=a!=null&&b!=null&&b>0?Math.round((a-b)/b*10000)/100:null;
  }
  warnings.push("آمار ویدئوها تجمعی و مربوط به آخرین ویدئوهای نمونه است؛ کل بازدید بازه یا رتبه‌بندی همه ویدئوهای کانال نیست. نمونه کامنت‌ها شامل پاسخ‌ها نیست و ممکن است نماینده همه مخاطبان نباشد.","تاریخ Analytics به وقت اقیانوس آرام است؛ داده‌ها ممکن است با تأخیر تکمیل شوند. CTR و نمودار ماندگاری مخاطب در این گزارش دریافت نمی‌شوند.");
  return {generatedAt:now.toISOString(),channel:{id:channelId,title:channel.snippet?.title,views:count(channel.statistics?.viewCount),subscribers:channel.statistics?.hiddenSubscriberCount?null:count(channel.statistics?.subscriberCount),videos:count(channel.statistics?.videoCount)},
    windows,analytics:{current,previous,changesPercent:changes},sample:{requestedVideos:config.videoLimit,readVideos:videos.length,requestedComments:config.commentLimit,readComments:comments.length},videos,comments,warnings};
}
export async function readYoutubeAnalysis(workspaceId:string, raw:unknown) {
  const config=youtubeAnalysisConfig.parse(raw);
  const {token,account}=await youtubeToken(config.accountId,workspaceId);
  return collectYoutubeAnalysis(token,account.externalAccountId,config);
}
