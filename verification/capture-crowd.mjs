// One headless reference run of a one-on-one Foundation match that records the spectators' poses on every VBlank.
//   node verification/capture-crowd.mjs [frames] [outDir]        (default 1800 frames = 30 s, private/verification/crowd)
// Writes crowd-recording.bin.gz (see ps2/battle/e2e/crowd-recorder.mjs for the layout; tools: port/scenery/crowd_bank.py) plus
// screenshots. Player one mashes attacks while recording so the crowd sees hits. Needs private/ps2/reference.iso and the macOS
// OCR helper like the other capture scripts. Uses the standard Battle overlay (no unlock), so one-on-one at the default venue.
import path from "node:path";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {gzipSync} from "node:zlib";
import {launch,REPO} from "../ps2/battle/e2e/harness.mjs";
import {startCrowdRecording,crowdRecordingProgress,finishCrowdRecording,packCrowdRecording} from "../ps2/battle/e2e/crowd-recorder.mjs";

const frames=+(process.argv[2] ?? 1800), outDir=path.resolve(process.argv[3] ?? "private/verification/crowd");
mkdirSync(outDir,{recursive:true});
const run=await launch({iso:path.resolve("private/ps2/reference.iso"),outDir});
try {
  const ocr=path.join(outDir,"recognize-text");
  execFileSync("swiftc",["-O",path.join(REPO,"verification/recognize-text.swift"),"-o",ocr]);
  const read=async()=>JSON.parse(execFileSync(ocr,[await run.shot("menu")])).join(" ");
  async function screen(pattern,advance) {
    let text;
    for(let i=0;i<60;i++) {
      text=await read();
      if(pattern.test(text))return text;
      if(advance)await run.press(advance);
      await run.waitFrames(70);
    }
    throw Error("Waiting for "+pattern+", last screen: "+text);
  }
  const press=async button=>{await run.waitFrames(30);await run.press(button,{hold:8,after:70});};
  await screen(/Autosave Warning/i);
  await press("cross");await screen(/enable the autosave/i,"cross");
  await press("cross");await screen(/which memory card slot/i,"cross");
  await press("cross");await screen(/NO EXCUSES/i,"start");
  await press("start");
  await screen(/MAIN MENU/i);
  await press("cross");
  await screen(/STANDARD RULES/i,"cross");await press("cross");
  await screen(/pick MEMORY CARD/i);await press("cross");
  await screen(/PRESS START BUTTON/i);await press("start");
  await screen(/ENTER USER ID/i);await press("cross");
  await screen(/NO USER ID SELECTED/i);await press("cross");
  await screen(/CHOOSE FIGHTER/i);
  await press("cross");await press("cross");   // player one's fighter, then the CPU's
  await press("right");await press("cross");
  await screen(/CHOOSE VENUE/i);
  console.log("VENUE",await read());
  await press("cross");
  // Wait for the match (referee phase 1) in the Foundation (venue word 0x4bbd34 = 2).
  const ready=()=>run.page.evaluate(()=>{
    const vm=window.referenceVm,heap=vm.HEAPU8,words=new Uint32Array(heap.buffer);
    const signature=[0x8c830000,0x3c02ff7f,0x3442ffff,0x03e00008];
    for(let i=0;i<words.length;i++) {
      if(words[i]!==signature[0] || !signature.every((n,j)=>words[i+j]===n))continue;
      const base=i*4-0x360990;
      if(base<0 || base+0x2000000>heap.length || words[(base+0x471230)/4]!==0x445330)continue;
      return {venue:words[(base+0x4bbd34)/4],phase:words[(base+0x4bbf98)/4]};
    }
    return null;
  });
  let state=null;
  for(let i=0;i<120;i++) { state=await ready(); if(state?.phase===1)break; await run.waitFrames(30); }
  if(state?.phase!==1)throw Error("the match did not start: "+JSON.stringify(state));
  if(state.venue!==2)throw Error("not the Foundation: venue word "+state.venue);
  await run.waitFrames(60);
  const info=await startCrowdRecording(run.page,{frames});
  console.log("recording",info.names.length,"spectators");
  await run.shot("recording-start");
  const strikes=["square","triangle","circle","cross"];
  for(let i=0;;i++) {
    const progress=await crowdRecordingProgress(run.page);
    if(!progress.running || progress.frames>=frames)break;
    await run.press(strikes[i%strikes.length],{hold:4,after:26});
  }
  const recording=await finishCrowdRecording(run.page);
  console.log("recorded",recording.counters.length,"frames; torn",recording.torn,"gaps",recording.gaps.length);
  writeFileSync(path.join(outDir,"crowd-recording.bin.gz"),gzipSync(packCrowdRecording(recording),{level:9}));
  await run.shot("recording-end");
  console.log("DONE");
} finally {await run.close();}
