// One headless reference run of a one-on-one Foundation match (player one against the CPU seat) taken to the retail post-match
// screens: the time-up is forced by advancing the match clock and the two scores in RAM, then screenshots are taken every
// 45 frames through the result word, the score sheet (if the human won) and the REMATCH? card, and the EE RAM is dumped when
// the score sheet text appears (the summary counters and the session are in it).
//   RESULT=win|lose node verification/capture-postmatch.mjs [outDir]       (default private/verification/postmatch-<result>)
// Same overlay and menu route as capture-crowd.mjs; needs private/ps2/reference.iso and the macOS OCR helper.
import path from "node:path";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {launch,REPO} from "../ps2/battle/e2e/harness.mjs";

const result0=process.env.RESULT==="lose"?"lose":"win", outDir=path.resolve(process.argv[2] ?? `private/verification/postmatch-${result0}`);
mkdirSync(outDir,{recursive:true});
const rule=process.env.BATTLE_RULE ?? "votes";
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
  await screen(/STANDARD RULES/i,"cross");
  
  if (!["standard", "votes", "no-submissions"].includes(rule)) throw Error("Unknown rules "+rule);
  if (rule !== "standard") {
    await press("right");
    await screen(/CROWD VOTES|FAN FAVORITE/i);
    if (rule === "no-submissions") {
      await press("right");
      await screen(/NO SUBMISSIONS/i);
    }
  }
  await press("cross");
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
      window.battleReferenceBase = base;
      return {venue:words[(base+0x4bbd34)/4],phase:words[(base+0x4bbf98)/4], rules:words[(base+0x4bbd2c)/4], timer:words[(base+0x4bbd30)/4], config:Array.from(words.slice((base+0x4bbcf0)/4,(base+0x4bbd48)/4))};
    }
    return null;
  });
  let state=null;
  for(let i=0;i<120;i++) { state=await ready(); if(state?.phase===1)break; await run.waitFrames(30); }
  if(state?.phase!==1)throw Error("the match did not start: "+JSON.stringify(state));
  if(state.venue!==2)throw Error("not the Foundation: venue word "+state.venue);
  console.log("RULES",state);
  writeFileSync(path.join(outDir,"rules.json"),JSON.stringify(state)+"\n");
  // Force the time-up: the clock to the end, the human (seat 0) ahead or behind on points, under the Crowd Votes rules.
  const result=process.env.RESULT==="lose"?"lose":"win";
  await run.waitFrames(60);
  await run.page.evaluate(result => {
    const view = new DataView(window.referenceVm.HEAPU8.buffer), base = window.battleReferenceBase;
    for (const clock of [0x4bbf90+0x1a4, 0x4bbf90+0x1b4]) view.setFloat32(base+clock, 299*60, true);
    view.setUint32(base+0x4bc170+0x480, result==="win" ? 300 : 100, true);
    view.setUint32(base+0x4bd468+0x480, result==="win" ? 100 : 300, true);
  }, result);
  const dump=async name=>{
    const chunks=[];
    for(let offset=0;offset<0x2000000;offset+=1048576)chunks.push(Buffer.from(await run.page.evaluate(at=>window.readEe(at),offset),"base64"));
    writeFileSync(path.join(outDir,name),Buffer.concat(chunks));
  };
  await run.page.evaluate(()=>{const vm=window.referenceVm,heap=vm.HEAPU8,b=window.battleReferenceBase;window.readEe=o=>heap.slice(b+o,b+o+1048576).toBase64();});
  const log=[];
  let dumped=false;
  for(let i=0;i<60;i++) {
    await run.waitFrames(45);
    const name=await run.shot("post-"+String(i).padStart(2,"0"));
    const text=JSON.parse(execFileSync(ocr,[name])).join(" ");
    const phase=await run.page.evaluate(()=>new DataView(window.referenceVm.HEAPU8.buffer).getUint32(window.battleReferenceBase+0x4bbf98,true));
    log.push({i,phase,text});console.log("POST",i,phase,text);
    if(!dumped && /SCORE|TOTAL|EARNINGS|WINNER/i.test(text)) { await dump("sheet.bin"); dumped=true; }
    // after a few looks at each screen, step on with Cross so the later screens are reached too
    if(i%6===5) await run.press("cross",{hold:8,after:30});
    if(/REMATCH/i.test(text) && i>6) { await run.shot("rematch-card"); break; }
  }
  writeFileSync(path.join(outDir,"postmatch.json"),JSON.stringify({result,log},null,1)+"\n");
  console.log("DONE");
} finally {await run.close();}
