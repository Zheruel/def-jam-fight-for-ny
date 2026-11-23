// Capture the first playable retail Free For All frame using the headless reference harness on macOS.
import path from "node:path";
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {launch, REPO} from "../ps2/battle/e2e/harness.mjs";

const count=process.argv.includes("--three") ? 3 : 4;
const iso=path.resolve(process.argv[2] ?? "private/ps2/reference.iso");
const outDir=path.resolve(process.argv[3] ?? ("private/verification/ffa-"+count));
const run=await launch({iso,outDir});
try {
  const ocr=path.join(outDir,"recognize-text");
  execFileSync("swiftc",["-O",path.join(REPO,"verification/recognize-text.swift"),"-o",ocr]);
  async function screen(pattern,advance) {
    let text;
    for(let i=0;i<50;i++) {
      const file=await run.shot("menu");
      text=JSON.parse(execFileSync(ocr,[file])).join(" ");
      if(pattern.test(text))return text;
      if(i%8===0) console.log("Waiting for",pattern,"on",text.slice(0,160));
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
  await press("right");
  const mode=await screen(/DOUBLE UP|FOR HIMSELF/i);
  if(!/FOR HIMSELF/i.test(mode))await press("right");
  await screen(/FOR HIMSELF/i);await press("cross");
  await screen(/STANDARD RULES/i,"cross");await press("cross");
  await screen(/pick MEMORY CARD/i);await press("cross");
  await screen(/PRESS START BUTTON/i);await press("start");
  await screen(/ENTER USER ID/i);await press("cross");
  await screen(/NO USER ID SELECTED/i);await press("cross");
  await screen(/NUMBER OF/i);
  if(count===3) await press("left");
  await press("cross");
  await screen(/CHOOSE FIGHTER/i);
  for(const directions of [[],["right"],["right","right"],["down"]].slice(0,count)) {
    for(const direction of directions)await press(direction);
    await press("cross");await press("cross");
  }
  await screen(/FOUNDATION/i,"cross");await press("cross");
  await run.page.waitForFunction(seats=>{
    const vm=window.referenceVm,heap=vm.HEAPU8,words=new Uint32Array(heap.buffer);
    const signature=[0x8c830000,0x3c02ff7f,0x3442ffff,0x03e00008];
    for(let i=0;i<words.length;i++) {
      if(words[i]!==signature[0] || !signature.every((n,j)=>words[i+j]===n))continue;
      const base=i*4-0x360990;
      if(base<0 || base+0x2000000>heap.length || words[(base+0x471230)/4]!==0x445330)continue;
      const timer=setInterval(()=>{
        const lastActor=0x4bc170+(seats-1)*0x12f8;
        const formation=seats===3 ? 0x40000 : 0x80000;
        if((words[(base+0x4bbd2c)/4]&0xf0000)!==formation || words[(base+0x4bbf98)/4]!==1
            || words[(base+lastActor+0x80)/4]===0xffffffff)return;
        const snapshot=heap.slice(base,base+0x2000000);
        window.readFourSnapshot=offset=>snapshot.subarray(offset,offset+1048576).toBase64();
        clearInterval(timer);
      },10);
      return true;
    }
    return false;
  },count,{polling:750,timeout:90000});
  for(let i=0;i<80;i++) {
    if(await run.page.evaluate(()=>!!window.readFourSnapshot))break;
    await run.press("cross",{hold:6,after:80});
  }
  const chunks=[];
  for(let offset=0;offset<0x2000000;offset+=1048576) {
    const bytes=await run.page.evaluate(at=>window.readFourSnapshot(at),offset);
    chunks.push(Buffer.from(bytes,"base64"));
  }
  writeFileSync(path.join(outDir,"fight-start.bin"),Buffer.concat(chunks));
  await run.shot(count+"-player-fight");
} finally {await run.close();}
