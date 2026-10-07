export type CollectionSheet = { headers:string[];rows:string[][] };
export function googleSheetExport(raw:string,gidInput?:string) {
  const url=new URL(raw);
  if(url.protocol!=="https:" || url.hostname!=="docs.google.com" || url.username || url.password || url.port) throw new Error("لینک معتبر گوگل‌شیت را وارد کنید.");
  const match=url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if(!match) throw new Error("لینک معمولی گوگل‌شیت (نه لینک انتشار در وب) لازم است.");
  const gid=gidInput || url.searchParams.get("gid") || new URLSearchParams(url.hash.slice(1)).get("gid") || "0";
  if(!/^\d{1,15}$/.test(gid)) throw new Error("شناسه برگه باید عدد باشد.");
  return `https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv&gid=${gid}`;
}
/** RFC 4180 quoting, including commas, embedded newlines and doubled quotes. */
export function parseCollectionCSV(csv:string):CollectionSheet {
  if(csv.length>5_000_000) throw new Error("حجم شیت بیش از حد مجاز است.");
  const rows:string[][]=[];let row:string[]=[];let value="";let quoted=false;let closed=false;
  const cell=()=>{row.push(value);value="";closed=false;if(row.length>60)throw new Error("حداکثر ۶۰ ستون مجاز است.");};
  const line=()=>{cell();if(row.some((v)=>v.trim()))rows.push(row);row=[];if(rows.length>501)throw new Error("حداکثر ۵۰۰ ردیف محتوا مجاز است.");};
  csv=csv.replace(/^\uFEFF/,"");
  for(let i=0;i<csv.length;i++) {
    const c=csv[i];
    if(quoted){if(c==='"'){if(csv[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;continue;}
    if(c===',' ){cell();continue;}if(c==='\n' || c==='\r'){if(c==='\r' && csv[i+1]==='\n')i++;line();continue;}
    if(c==='"'){if(value || closed)throw new Error("ساختار CSV نامعتبر است.");quoted=true;continue;}
    if(closed)throw new Error("ساختار CSV نامعتبر است.");value+=c;
  }
  if(quoted)throw new Error("فایل CSV ناقص است.");if(value || row.length || closed)line();
  if(!rows.length)throw new Error("شیت خالی است یا سطر عنوان ندارد.");
  return {headers:rows[0],rows:rows.slice(1)};
}
