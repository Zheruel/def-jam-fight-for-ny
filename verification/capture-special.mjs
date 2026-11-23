// Headless retail capture of a special Battle format (Subway, Ringout, ...) with the reference harness.
//   node verification/capture-special.mjs <type> [venue] [outDir]      (type: demolition|inferno|subway|window|cage|ringout|single)
// Uses the Battle overlay merged with the unlock overlay so every special card and venue is offered. Menu text is read by OCR.
import path from "node:path";
import {execFileSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {launch,REPO} from "../ps2/battle/e2e/harness.mjs";

const type=(process.argv[2] ?? "subway").toLowerCase(), venue=process.argv[3] ?? "";
const outDir=path.resolve(process.argv[4] ?? `private/verification/special/${type}`);
mkdirSync(outDir,{recursive:true});
const battle=JSON.parse(readFileSync(path.join(REPO,"ps2/battle/battle-patch.json"),"utf8"));
const unlock=JSON.parse(readFileSync(path.join(REPO,"ps2/content/unlock-disc-patch.json"),"utf8"));
const manifest=path.join(outDir,"patch.json");
writeFileSync(manifest,JSON.stringify({...battle,patches:[...battle.patches,...unlock.patches]}));
const run=await launch({iso:path.resolve("private/ps2/reference.iso"),outDir,manifest});
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
  await press("cross");await press("cross");   // player one's fighter, then the CPU's (a different one)
  await press("right");await press("cross");
  await screen(/CHOOSE VENUE/i);   // the venue map asks the unlock sets, which fills them
  for(let i=0;i<12;i++) { const text=await read();console.log("B",i,text);if(/CHOOSE MATCH TYPE/i.test(text))break; await press("triangle"); }
  // Special cards: row two is Window, Subway, Demolition, Inferno; row three is Cage, Ringout. From Free For All, "down" lands on
  // Window, each "right" steps along the row and Cage / Ringout sit under Subway / Demolition; the right-hand panel names the highlighted card.
  if(type==="cards") {   // survey: walk the card grid and print each panel
    for(const move of ["down","right","right","right","down","left","left","left","up","right","right","up"]) { await press(move);console.log("CARD",move,await read()); }
    process.exit(0);
  }
  const route=type==="single"?["left","left"]:{window:["down"],subway:["down","right"],demolition:["down","right","right"],inferno:["down","right","right","right"],
    cage:["down","right","down"],ringout:["down","right","right","down"]}[type];
  for(const move of route)await press(move);
  console.log("TYPE",await read());
  await press("cross");
  if(type==="single") { await screen(/STANDARD RULES/i);await press("cross"); }
  await screen(/pick MEMORY CARD/i);await press("cross");
  await screen(/PRESS START BUTTON/i);await press("start");
  await screen(/ENTER USER ID/i);await press("cross");
  await screen(/NO USER ID SELECTED/i);await press("cross");
  await screen(/CHOOSE FIGHTER/i);
  await press("cross");await press("cross");await press("right");await press("cross");
  for(let i=0;i<4;i++) { const text=await read();console.log("V",i,text);if(/CHOOSE VENUE/i.test(text))break;await run.waitFrames(60); }
  if(venue) {   // moves from a comma list, e.g. "down,left"
    for(const move of venue.split(","))await press(move);
    console.log("VENUE",await read());
  }
  await press("cross");
  // The match is up once the retail referee is in phase 1; dump the whole 32 MiB of EE RAM then and again a little later.
  await run.page.waitForFunction(()=>{
    const vm=window.referenceVm,heap=vm.HEAPU8,words=new Uint32Array(heap.buffer);
    const signature=[0x8c830000,0x3c02ff7f,0x3442ffff,0x03e00008];
    for(let i=0;i<words.length;i++) {
      if(words[i]!==signature[0] || !signature.every((n,j)=>words[i+j]===n))continue;
      const base=i*4-0x360990;
      if(base<0 || base+0x2000000>heap.length || words[(base+0x471230)/4]!==0x445330)continue;
      window.readEe=offset=>heap.slice(base+offset,base+offset+1048576).toBase64();
      window.eeWord=address=>words[(base+address)/4];
      return true;
    }
    return false;
  },null,{polling:750,timeout:120000});
  const dump=async name=>{
    const chunks=[];
    for(let offset=0;offset<0x2000000;offset+=1048576)chunks.push(Buffer.from(await run.page.evaluate(at=>window.readEe(at),offset),"base64"));
    writeFileSync(path.join(outDir,name),Buffer.concat(chunks));
  };
  for(let i=0;i<120;i++) { if(await run.page.evaluate(()=>window.eeWord(0x4bbf98)===1))break; await run.waitFrames(15); }
  await run.waitFrames(60);
  await dump("fight-start.bin");await run.shot("fight-start");
  await run.waitFrames(600);
  await dump("fight-later.bin");await run.shot("fight-later");
  console.log("DONE");
} finally {await run.close();}
