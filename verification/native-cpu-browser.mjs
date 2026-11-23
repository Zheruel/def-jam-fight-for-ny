// Explicit CPU seats in the browser: the retail AI plays the last seats unaided, only the person seats are offered to
// guests (no phantom seat), a guest drives exactly its own seat and a lone person cannot host.
//   node verification/native-cpu-browser.mjs [mode:cpu:guests ...]     default: 1v1:1:0 ffa3:1:1 ffa:2:1 ffa:1:2
import assert from "node:assert/strict";
import {once} from "node:events";
import {chromium} from "../netplay/node_modules/playwright/index.mjs";
import {gameServer} from "../tools/serve.mjs";
import {attachNetplay} from "../netplay/server.mjs";
import {MODES} from "../port/battle/modes.mjs";

const cases=(process.argv.length>2 ? process.argv.slice(2) : ["1v1:1:0","ffa3:1:1","ffa:2:1","ffa:1:2"]).map(spec=>{
  const [mode,cpu,guests]=spec.split(":");
  return {mode,cpu:Number(cpu),guests:Number(guests)};
});
const server=gameServer();
attachNetplay(server);
let browser;
try {
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const origin="http://127.0.0.1:"+server.address().port+"/";
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
  for(const {mode,cpu,guests} of cases) {
    const fighters=MODES[mode].fighters, people=fighters-cpu;
    assert.ok(guests<=people-1,"Cases cannot ask for more guests than person seats");
    const url=new URL(origin);
    url.searchParams.set("mode",mode);
    url.searchParams.set("cpu",String(cpu));
    const host=await open(url.href);
    await host.waitForFunction(()=>window.nativeBattle?.diagnostics().ticks>5,null,{timeout:90000});
    const positions=()=>host.evaluate(()=>nativeBattle.diagnostics().actors.map(actor=>[actor.position[0],actor.position[2]]));
    const names=await host.evaluate(()=>nativeBattle.diagnostics().actors.map(a=>a.name));
    assert.equal(names.length,fighters);
    const spawn=await positions();
    const moved=(now,i)=>Math.hypot(now[i][0]-spawn[i][0],now[i][1]-spawn[i][1]);
    // Every CPU seat acts on its own while the person seats, untouched, stay where they spawned.
    await host.waitForFunction(({people,fighters})=>{
      const actors=nativeBattle.diagnostics().actors;
      return Array.from({length:fighters-people},(_,k)=>actors[people+k]).every(a=>a.score>0 || Math.abs(a.position[0])+Math.abs(a.position[2])>0);
    },{people,fighters},{timeout:10000}).catch(()=>{});
    const deadline=Date.now()+45000;
    let now=spawn;
    while(Date.now()<deadline) {
      now=await positions();
      if(Array.from({length:cpu},(_,k)=>moved(now,people+k)).every(d=>d>1)) break;
      await host.waitForTimeout(250);
    }
    for(let k=0;k<cpu;k++) assert.ok(moved(now,people+k)>1,`${mode}: CPU seat ${people+k+1} moves on its own`);
    const hostButton=host.locator("#host");
    if(people<2) {
      await hostButton.click();
      await host.waitForFunction(()=>/CPU opponent/.test(document.querySelector("#network").textContent),null,{timeout:10000});
      assert.equal(await host.locator("#code").inputValue(),"");
      console.log(`${mode} cpu=${cpu}:`,names.join(", "),"· hosting refused,",await host.locator("#network").textContent());
      continue;
    }
    await hostButton.click();
    await host.waitForFunction(()=>document.querySelector("#code").value.length===8);
    const invite=new URL(await host.locator("#invite").getAttribute("href"));
    assert.equal(invite.searchParams.get("cpu"),String(cpu),"The invite keeps the CPU seats");
    const pages=[];
    for(let slot=1;slot<=guests;slot++) {
      invite.searchParams.set("seat",String(slot+1));
      const page=await open(invite.href);
      await page.waitForFunction(()=>window.nativeBattle?.diagnostics().network==="connected" && document.querySelector("#remote").videoWidth>0,null,{timeout:60000});
      pages.push(page);
    }
    // No phantom seat: one label per seat, the host's first, and the CPU seats are labelled as such.
    const seats=await host.locator("#seats").textContent();
    const labels=seats.split(" · ");
    assert.equal(labels.length,fighters,`${mode}: ${seats}`);
    assert.equal(labels.filter(label=>/ host$/.test(label)).length,1,seats);
    assert.equal(labels.filter(label=>/ CPU$/.test(label)).length,cpu,seats);
    assert.equal(labels.filter(label=>/ (connected|open)$/.test(label)).length,people-1,seats);
    // A guest drives its own seat and no other person seat; the CPU seats keep playing.
    for(const [index,page] of pages.entries()) {
      const slot=index+1;
      await host.locator("#restart").click();
      const before=await positions();
      await page.locator("h1").click();
      await page.keyboard.down("ArrowRight");
      try {
        await host.waitForFunction(({slot,before})=>{
          const [x,,z]=nativeBattle.diagnostics().actors[slot].position;
          return Math.hypot(x-before[slot][0],z-before[slot][1])>1;
        },{slot,before},{timeout:10000});
      } finally {await page.keyboard.up("ArrowRight");}
      (await positions()).forEach(([x,z],i)=>{
        if(i<people && i!==slot) assert.ok(Math.hypot(x-before[i][0],z-before[i][1])<0.1,`${mode}: only the requested person seat moved`);
      });
    }
    console.log(`${mode} cpu=${cpu} guests=${guests}:`,names.join(", "),"·",seats);
  }
  assert.deepEqual(errors,[]);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
