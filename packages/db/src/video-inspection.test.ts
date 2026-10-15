import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {inspectVideo} from "./video-inspection";

test("missing inspection tool and missing input produce distinct actionable errors; an existing input is preserved",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hoor-inspection-"));const path=join(directory,"video");
  const previousPath=process.env.PATH;
  try{
    await assert.rejects(inspectVideo(path),(error:NodeJS.ErrnoException)=>error.code==="ENOENT");
    await writeFile(path,Buffer.from("test video"));process.env.PATH=directory;
    await assert.rejects(inspectVideo(path),(error:NodeJS.ErrnoException)=>error.code==="VIDEO_INSPECTOR_UNAVAILABLE" && /ffprobe/.test(error.message));
    const {stat}=await import("node:fs/promises");assert.equal((await stat(path)).size,10);
  }finally{if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;await rm(directory,{recursive:true,force:true});}
});
