import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent } from "undici";
import { requestPinnedMedia } from "./collection-media";

test("pinned downloads retain the virtual host and encoded Persian path instead of hitting the IP default site",async()=>{
  const agent=new MockAgent();agent.disableNetConnect();
  const url=new URL("https://files.hoorpluse.ir/مدرسه حفظ- جزء 30/03 tohid.mp4");
  agent.get("https://203.0.113.10").intercept({path:url.pathname,method:"GET",headers:{host:"files.hoorpluse.ir",range:"bytes=0-4095"}})
    .reply(206,Buffer.from("00000018667479706d703432000000006d7034326d703431","hex"),{headers:{"content-type":"video/mp4"}});
  try {
    const response=await requestPinnedMedia(url,"203.0.113.10",agent,AbortSignal.timeout(5000),true);
    assert.equal(response.statusCode,206);
    assert.equal(Buffer.from(await response.body.arrayBuffer()).subarray(4,8).toString(),"ftyp");
    agent.assertNoPendingInterceptors();
  } finally {await agent.close();}
});

test("redirects are returned to the downloader so the next host can be revalidated",async()=>{
  const agent=new MockAgent();agent.disableNetConnect();
  agent.get("https://203.0.113.10").intercept({path:"/video.mp4",method:"GET",headers:{host:"files.example.com"}})
    .reply(302,"",{headers:{location:"https://other.example.com/video.mp4"}});
  try {
    const response=await requestPinnedMedia(new URL("https://files.example.com/video.mp4"),"203.0.113.10",agent,AbortSignal.timeout(5000),false);
    assert.equal(response.statusCode,302);
    assert.equal(response.headers.location,"https://other.example.com/video.mp4");
    await response.body.dump();
    agent.assertNoPendingInterceptors();
  } finally {await agent.close();}
});
