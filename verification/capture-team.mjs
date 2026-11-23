// Capture the first playable retail TEAM (DOUBLE UP, 2 v 2) Foundation frame with the headless reference harness on macOS.
//   node verification/capture-team.mjs [iso] [outDir]      (default private/ps2/reference.iso, private/verification/team)
// Writes fight-start.bin (the 32 MiB match memory) and a screenshot. Menu flow, read from the retail screens: MAIN MENU
// -> TEAM MATCH / DOUBLE UP -> STANDARD RULES -> memory card -> user id -> CHOOSE FIGHTER (four seats, player 1 picks all
// four) -> CHOOSE TEAMS (the four fighters are placed in order: team 1 gets the first two) -> venue -> fight.
import path from "node:path";
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {launch, REPO} from "../ps2/battle/e2e/harness.mjs";

const iso=path.resolve(process.argv[2] ?? "private/ps2/reference.iso");
const outDir=path.resolve(process.argv[3] ?? "private/verification/team");
const run=await launch({iso,outDir});
try {
  const ocr=path.join(outDir,"recognize-text");
  execFileSync("swiftc",["-O",path.join(REPO,"verification/recognize-text.swift"),"-o",ocr]);
  async function screen(pattern,advance) {
    let text;
    for(let i=0;i<60;i++) {
      const file=await run.shot("menu");
      text=JSON.parse(execFileSync(ocr,[file])).join(" ");
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
  await press("start");await screen(/MAIN MENU/i);
  // The menu opens on one-on-one; step right until the TEAM MATCH / DOUBLE UP card is up.
  await screen(/DOUBLE UP/i,"right");
  await press("cross");
  await screen(/STANDARD RULES/i,"cross");await press("cross");
  await screen(/pick MEMORY CARD/i);await press("cross");
  await screen(/PRESS START BUTTON/i);await press("start");
  await screen(/ENTER USER ID/i);await press("cross");
  await screen(/NO USER ID SELECTED/i);await press("cross");
  await screen(/CHOOSE FIGHTER/i);
  for(const directions of [[],["right"],["right","right"],["down"]]) {
    for(const direction of directions)await press(direction);
    await press("cross");await press("cross");
  }
  // Place the four fighters in order, then confirm: team 1 is the first two, team 2 the last two.
  await screen(/CHOOSE TEAMS/i);
  await screen(/CHOOSE VENUE|FOUNDATION/i,"cross");
  await screen(/FOUNDATION/i);await press("cross");
  await run.page.waitForFunction(()=>{
    const vm=window.referenceVm,heap=vm.HEAPU8,words=new Uint32Array(heap.buffer);
    const signature=[0x8c830000,0x3c02ff7f,0x3442ffff,0x03e00008];
    for(let i=0;i<words.length;i++) {
      if(words[i]!==signature[0] || !signature.every((n,j)=>words[i+j]===n))continue;
      const base=i*4-0x360990;
      if(base<0 || base+0x2000000>heap.length || words[(base+0x471230)/4]!==0x445330)continue;
      const timer=setInterval(()=>{
        // Formation bits 0x20000 = team. First active frame: phase 1 with the fourth actor's action set.
        if((words[(base+0x4bbd2c)/4]&0xf0000)!==0x20000 || words[(base+0x4bbf98)/4]!==1
            || words[(base+0x4bfa58+0x80)/4]===0xffffffff)return;
        const snapshot=heap.slice(base,base+0x2000000);
        window.readTeamSnapshot=offset=>snapshot.subarray(offset,offset+1048576).toBase64();
        clearInterval(timer);
      },10);
      return true;
    }
    return false;
  },null,{polling:750,timeout:90000});
  for(let i=0;i<80;i++) {
    if(await run.page.evaluate(()=>!!window.readTeamSnapshot))break;
    await run.press("cross",{hold:6,after:80});
  }
  const chunks=[];
  for(let offset=0;offset<0x2000000;offset+=1048576) {
    const bytes=await run.page.evaluate(at=>window.readTeamSnapshot(at),offset);
    chunks.push(Buffer.from(bytes,"base64"));
  }
  writeFileSync(path.join(outDir,"fight-start.bin"),Buffer.concat(chunks));
  await run.shot("team-fight");
} finally {await run.close();}
