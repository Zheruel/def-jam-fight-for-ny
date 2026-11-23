// Online fighter selection in isolated browsers: a host opens a room from the Choose Fighter screen, every guest picks and
// confirms its own fighter on its own seat (the host's keys leave that seat alone), the host chooses the venue, and the same
// connection, seats and controller channels carry on into the native match without anyone rejoining.
//   node verification/native-online-select-browser.mjs [type:cpu:guests ...]     default: 1v1:0:1 ffa3:1:1 ffa:0:3 team:1:2
import assert from "node:assert/strict";
import {once} from "node:events";
import {chromium} from "../netplay/node_modules/playwright/index.mjs";
import {gameServer} from "../tools/serve.mjs";
import {attachNetplay} from "../netplay/server.mjs";
import {MODES} from "../port/battle/modes.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};

const cases=(process.argv.length>2 ? process.argv.slice(2) : ["1v1:0:1","ffa3:1:1","ffa:0:3","team:1:2"]).map(spec=>{
  const [type,cpu,guests]=spec.split(":");
  return {type,cpu:Number(cpu),guests:Number(guests)};
});
const nameOf=handle=>inventory.fighters.find(f=>f.handle===handle).name;
const server=gameServer();
attachNetplay(server);
let browser;
// The match type step: card by index, then the size for Free For All (see native-menu-browser.mjs).
async function chooseType(page,type) {
  for(let i=0;i<["1v1","team","ffa"].indexOf(type==="ffa3" ? "ffa" : type);i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  if(type.startsWith("ffa")) {
    if(type==="ffa3") await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
  }
}
try {
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const origin = process.env.BATTLE_URL ?? `http://127.0.0.1:${server.address().port}/`;
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
  for(const {type,cpu,guests} of cases) {
    const fighters=MODES[type].fighters, people=fighters-cpu;
    assert.ok(guests<=people-1,"more guests than person seats");
    const host=await open(origin);
    await host.waitForSelector("canvas[aria-label='Choose fighter and venue']");
    await host.waitForFunction(()=>document.fonts.check("12px BattleNames"));
    await host.waitForTimeout(500);
    assert.equal(await host.locator("#host").isDisabled(),true,"no room before a match type is chosen");
    await chooseType(host,type);
    await host.waitForFunction(()=>window.nativeMenu?.screen==="fighters");
    for(let i=0;i<cpu;i++) await host.keyboard.press("c");
    assert.equal(await host.evaluate(()=>nativeMenu.cpu),cpu);
    assert.equal(await host.evaluate(()=>nativeMenu.seats.length),fighters);

    // Open the room from the selector; the invite is the page's own link plus the room.
    await host.locator("#host").click();
    await host.waitForFunction(()=>document.querySelector("#code").value.length===8);
    const invite=new URL(await host.locator("#invite").getAttribute("href"));
    const pages=[];
    for(let slot=1;slot<=guests;slot++) {
      invite.searchParams.set("seat",String(slot+1));
      const page=await open(invite.href);
      await page.waitForFunction(()=>window.nativeBattle?.diagnostics().network==="connected" && document.querySelector("#remote").videoWidth>0,null,{timeout:60000});
      pages.push(page);
    }
    await host.waitForFunction(({guests})=>nativeMenu.seats.filter(s=>s.remote).length===guests,{guests});
    const defaults=await host.evaluate(()=>nativeMenu.seats.map(s=>s.handle));

    // A seat a guest holds ignores the host's keys for it (seat 2 is the arrow keys' seat).
    await host.keyboard.press("ArrowRight");
    assert.equal(await host.evaluate(()=>nativeMenu.seats[1].handle),defaults[1],"the host's arrow keys leave a guest's seat alone");
    assert.equal(await host.evaluate(()=>nativeMenu.seats[1].ready),false);
    // The CPU key steps through the counts the room allows: never one that takes a guest's seat, and it still wraps to none.
    if(guests && type!=="1v1") {
      const seen=new Set();
      for(let i=0;i<fighters;i++) {
        await host.keyboard.press("c");
        const now=await host.evaluate(()=>nativeMenu.cpu);
        assert.ok(fighters-now>=guests+1,`the CPU never takes a guest's seat (cpu ${now})`);
        seen.add(now);
      }
      assert.ok(seen.has(0),"the CPU key wraps back to no CPU");
      while(await host.evaluate(()=>nativeMenu.cpu)!==cpu) await host.keyboard.press("c");
    }

    // Every guest picks (its own number of steps right) and confirms with Enter on its own page.
    for(const [index,page] of pages.entries()) {
      await page.locator("h1").click();
      for(let step=0;step<index+2;step++) await page.keyboard.press("ArrowRight");
      await host.waitForFunction(({seat,from})=>nativeMenu.seats[seat].handle!==from,{seat:index+1,from:defaults[index+1]});
      const picked=await host.evaluate(seat=>nativeMenu.seats[seat].handle,index+1);
      await page.keyboard.press("Enter");
      await host.waitForFunction(seat=>nativeMenu.seats[seat].ready,index+1);
      assert.equal(await host.evaluate(seat=>nativeMenu.seats[seat].handle,index+1),picked);
    }
    // The host confirms every seat that is not a guest's (its own and the CPU seats).
    const local=fighters-guests;
    for(let i=0;i<local;i++) await host.keyboard.press("Enter");
    const selection=await host.evaluate(()=>nativeMenu.seats.map(s=>s.handle));
    assert.equal(new Set(selection.map(nameOf)).size,fighters>2 ? fighters : new Set(selection.map(nameOf)).size);
    // A guest cannot choose the venue; the host does.
    if(type==="team") for(let i=0;i<8 && await host.evaluate(()=>nativeMenu.screen)!=="venue";i++) await host.keyboard.press("Enter");
    await host.waitForFunction(()=>nativeMenu.screen==="venue");
    await pages[0]?.keyboard.press("Enter");
    assert.equal(await host.evaluate(()=>nativeMenu.screen),"venue","a guest's Enter does not pick the venue");
    await host.keyboard.press("Enter");

    // The same room carries into the match: names are the selected fighters, guests never reconnected, picture and sound switched.
    await host.waitForFunction(()=>window.nativeBattle?.diagnostics().ticks>30,null,{timeout:120000});
    const names=await host.evaluate(()=>nativeBattle.diagnostics().actors.map(a=>a.name));
    assert.deepEqual(names,selection.map(nameOf),"the match starts with the selected fighters");
    const labels=(await host.locator("#seats").textContent()).split(" · ");
    assert.equal(labels.length,fighters,labels.join(" · "));
    assert.equal(labels.filter(label=>/ connected$/.test(label)).length,guests);
    assert.equal(labels.filter(label=>/ CPU$/.test(label)).length,cpu);
    for(const page of pages) {
      assert.equal(await page.evaluate(()=>nativeBattle.diagnostics().network),"connected","the guest never left");
      const first=await page.evaluate(()=>document.querySelector("#remote").currentTime);
      await page.waitForTimeout(700);
      assert.ok(await page.evaluate(first=>document.querySelector("#remote").currentTime>first,first),"the guest's picture keeps playing");
    }
    // Each guest drives its own fighter in the match and nobody else's person seat.
    for(const [index,page] of pages.entries()) {
      const slot=index+1;
      const before=await host.evaluate(()=>nativeBattle.diagnostics().actors.map(a=>[a.position[0],a.position[2]]));
      await page.locator("h1").click();
      await page.keyboard.down("ArrowRight");
      try {
        await host.waitForFunction(({slot,before})=>{
          const [x,,z]=nativeBattle.diagnostics().actors[slot].position;
          return Math.hypot(x-before[slot][0],z-before[slot][1])>1;
        },{slot,before},{timeout:15000});
      } finally {await page.keyboard.up("ArrowRight");}
    }
    console.log(`${type} cpu=${cpu} guests=${guests}:`,names.join(", "),"·",labels.join(" · "));
    await host.context().close();
    for(const page of pages) await page.context().close();
  }
  assert.deepEqual(errors,[]);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
