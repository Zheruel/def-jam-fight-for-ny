// Check the actual match start and guest inputs for the selected multi-fighter formation.
import assert from "node:assert/strict";
import {once} from "node:events";
import {chromium} from "../netplay/node_modules/playwright/index.mjs";
import {gameServer} from "../tools/serve.mjs";
import {attachNetplay} from "../netplay/server.mjs";
import {MODES} from "../port/battle/modes.mjs";
import lineups from "../port/battle/lineups.json" with {type:"json"};

const mode=process.argv[2] ?? "ffa3", options=MODES[mode];
assert.ok(options?.fighters>2,"Specify a supported multi-fighter mode");
const server=gameServer();
attachNetplay(server);
let browser;
try {
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const url=new URL(process.argv[3] ?? "http://127.0.0.1:"+server.address().port+"/");
  url.searchParams.set("mode",mode);
  browser=await chromium.launch({headless:true,...(process.platform==="darwin" && {channel:"chrome"})});
  const errors=[];
  async function open(url) {
    const context=await browser.newContext({viewport:{width:1024,height:824}});
    const page=await context.newPage();
    page.on("pageerror",error=>errors.push(error.message));
    page.on("response",response=>{if(response.status()>=400) errors.push(response.status()+" "+response.url());});
    await page.goto(url);
    return page;
  }
  const host=await open(url.href);
  await host.waitForFunction(()=>window.nativeBattle?.diagnostics().ticks>5,null,{timeout:90000});
  const positions=()=>host.evaluate(()=>nativeBattle.diagnostics().actors.map(actor=>[actor.position[0],actor.position[2]]));
  const original=lineups.V2BG_02A[options.formation];
  function atSpawn(actual) {
    assert.equal(actual.length,options.fighters);
    actual.forEach(([x,z],i)=>assert.ok(Math.hypot(x-original[i][0],z-original[i][1])<0.1));
  }
  atSpawn(await positions());
  await host.locator("#host").click();
  await host.waitForFunction(()=>document.querySelector("#code").value.length===8);
  const guests=[];
  for(let slot=1;slot<options.fighters;slot++) {
    const invite=new URL(await host.locator("#invite").getAttribute("href"));
    invite.searchParams.set("seat",String(slot+1));
    const page=await open(invite.href);
    await page.waitForFunction(()=>window.nativeBattle?.diagnostics().network==="connected" && document.querySelector("#remote").videoWidth>0,null,{timeout:60000});
    guests.push(page);
  }
  for(const [index,guest] of guests.entries()) {
    const slot=index+1;
    await host.locator("#restart").click();
    const before=await positions();
    atSpawn(before);
    await guest.locator("h1").click();
    await guest.keyboard.down("ArrowRight");
    try {
      await host.waitForFunction(({slot,before})=>{
        const [x,,z]=nativeBattle.diagnostics().actors[slot].position;
        return Math.hypot(x-before[slot][0],z-before[slot][1])>1;
      },{slot,before},{timeout:10000});
    } finally {await guest.keyboard.up("ArrowRight");}
    (await positions()).forEach(([x,z],i)=>{
      if(i!==slot)assert.ok(Math.hypot(x-before[i][0],z-before[i][1])<0.1,"Only the requested seat moved");
    });
  }
  assert.deepEqual(errors,[]);
  console.log(options.formation,await host.locator("#seats").textContent(),await host.evaluate(()=>nativeBattle.diagnostics().actors.map(a=>a.name)));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
