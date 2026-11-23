// Party continuity in isolated browsers: a hosted room keeps its invite, seats and connections through two matches with a
// different lineup and venue (Quit from the pause menu returns to the selector in the same page), and nothing of a finished
// match lingers: one render loop, one simulation clock, one live audio graph and one picture capture.
//   node verification/native-party-browser.mjs
import assert from "node:assert/strict";
import {once} from "node:events";
import {chromium} from "../netplay/node_modules/playwright/index.mjs";
import {gameServer} from "../tools/serve.mjs";
import {attachNetplay} from "../netplay/server.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};

const nameOf=handle=>inventory.fighters.find(f=>f.handle===handle).name;
const server=gameServer();
attachNetplay(server);
let browser;
// Counts the audio graphs a page creates and closes (the host must never hold more than the live match's and the room's silence).
const counting=`(()=>{const Base=window.AudioContext;window.__contexts=[];
  window.AudioContext=class extends Base{constructor(...args){super(...args);window.__contexts.push(this);}};})();`;
async function chooseType(page,type) {
  for(let i=0;i<["1v1","team","ffa"].indexOf(type==="ffa3" ? "ffa" : type);i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  // The retail "Pick Your Rules" popup, when the menu shows it, is confirmed as it is.
  if(await page.evaluate(()=>window.nativeMenu?.popup==="rules")) await page.keyboard.press("Enter");
  if(type.startsWith("ffa")) {
    if(type==="ffa3") await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
  }
}
try {
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const origin="http://127.0.0.1:"+server.address().port+"/";
  browser=await chromium.launch({headless:true,...(process.platform==="darwin" && {channel:"chrome"})});
  const errors=[];
  async function open(url,label) {
    const context=await browser.newContext({viewport:{width:1024,height:824}});
    await context.addInitScript(counting);
    const page=await context.newPage();
    page.on("pageerror",error=>errors.push(label+": "+error.message));
    page.on("response",response=>{if(response.status()>=400) errors.push(response.status()+" "+response.url());});
    await page.goto(url);
    return page;
  }
  const host=await open(origin,"host");
  await host.waitForSelector("canvas[aria-label='Choose fighter and venue']");
  await host.waitForFunction(()=>document.fonts.check("12px BattleNames"));
  await host.waitForTimeout(500);

  // Selector 1: Free For All with three fighters, two guests.
  await chooseType(host,"ffa3");
  await host.waitForFunction(()=>window.nativeMenu?.screen==="fighters");
  await host.locator("#host").click();
  await host.waitForFunction(()=>document.querySelector("#code").value.length===8);
  const invite=await host.locator("#invite").getAttribute("href");
  const code=await host.locator("#code").inputValue();
  const link=new URL(invite);
  const guests=[];
  for(const slot of [1,2]) {
    link.searchParams.set("seat",String(slot+1));
    const page=await open(link.href,"guest "+slot);
    await page.waitForFunction(()=>window.nativeBattle?.diagnostics().network==="connected" && document.querySelector("#remote").videoWidth>0,null,{timeout:60000});
    guests.push(page);
  }
  await host.waitForFunction(()=>nativeMenu.seats.filter(s=>s.remote).length===2);

  async function pickAndConfirm(steps) {
    const defaults=await host.evaluate(()=>nativeMenu.seats.map(s=>s.handle));
    for(const [index,page] of guests.entries()) {
      await page.locator("h1").click();
      for(let step=0;step<steps+index;step++) await page.keyboard.press("ArrowRight");
      await host.waitForFunction(({seat,from})=>nativeMenu.seats[seat].handle!==from,{seat:index+1,from:defaults[index+1]});
      await page.keyboard.press("Enter");
      await host.waitForFunction(seat=>nativeMenu.seats[seat].ready,index+1);
    }
  }
  const seatsOf=async()=>host.evaluate(()=>nativeMenu.seats.map(s=>s.handle));
  const ticksPerSecond=async()=>{
    const first=await host.evaluate(()=>nativeBattle.diagnostics());
    await host.waitForTimeout(2000);
    const second=await host.evaluate(()=>nativeBattle.diagnostics());
    return {ticks:(second.ticks-first.ticks)/2,frames:(second.renderedFrames-first.renderedFrames)/2};
  };
  const live=()=>host.evaluate(()=>window.__contexts.filter(context=>context.state!=="closed").length);
  const guestTracks=page=>page.evaluate(()=>document.querySelector("#remote").srcObject.getTracks().filter(t=>t.readyState==="live").length);
  async function startMatch() {
    await host.waitForFunction(()=>nativeMenu.screen==="venue");
    return host.evaluate(()=>nativeMenu.seats.map(s=>s.handle));
  }

  await pickAndConfirm(2);
  const local=3-2;
  for(let i=0;i<local;i++) await host.keyboard.press("Enter");
  const first=await startMatch();
  await host.keyboard.press("Enter");
  await host.waitForFunction(()=>window.nativeBattle?.diagnostics().ticks>30,null,{timeout:120000});
  assert.deepEqual(await host.evaluate(()=>nativeBattle.diagnostics().actors.map(a=>a.name)),first.map(nameOf));
  const venueOne=await host.locator("#venue").inputValue();
  const clockOne=await ticksPerSecond();
  assert.ok(clockOne.ticks>45 && clockOne.ticks<75,`one simulation clock in match 1 (${clockOne.ticks}/s)`);
  const contextsOne=await live();
  assert.deepEqual(await host.evaluate(()=>nativeRoom().captures),1);
  const slotsOne=await host.evaluate(()=>nativeRoom().slots);

  // Quit from the pause menu: the host page goes back to the selector, the room stays.
  async function quit() {
    await host.locator("canvas").first().click({position:{x:5,y:5}}).catch(()=>{});
    await host.keyboard.press("Escape");
    await host.waitForFunction(()=>nativeBattle.diagnostics().pause!==null);
    for(let i=0;i<4;i++) await host.keyboard.press("ArrowDown");
    await host.keyboard.press("Enter");
    await host.keyboard.press("ArrowLeft");
    await host.keyboard.press("Enter");
    await host.waitForFunction(()=>window.nativeMenu?.screen==="type");
  }
  await quit();
  assert.equal(await host.evaluate(()=>typeof window.nativeBattle),"undefined","no match runs behind the selector");
  assert.equal(new URL(host.url()).search,"","the selector is on the bare page");
  assert.equal(await host.locator("#code").inputValue(),code,"same room code");
  assert.equal(await host.locator("#invite").getAttribute("href"),invite,"same invite");
  assert.deepEqual(await host.evaluate(()=>nativeRoom().slots),slotsOne,"guests keep their seats");
  assert.equal(await host.evaluate(()=>nativeRoom().captures),1,"the old picture capture is gone");
  for(const page of guests) {
    assert.equal(await page.evaluate(()=>nativeBattle.diagnostics().network),"connected","a guest never left");
    assert.equal(await guestTracks(page),2,"one picture and one sound track on the guest");
  }
  // The room's silence plus nothing of match 1 is left.
  assert.ok(await live()<=1,`match 1's audio is closed (${await live()} graphs live)`);

  // Selector 2: a different type (four fighters with one CPU seat), different picks and a different venue.
  await chooseType(host,"ffa");
  await host.waitForFunction(()=>window.nativeMenu?.screen==="fighters").catch(async error=>{
    throw new Error("selector 2 stuck: "+JSON.stringify(await host.evaluate(()=>({menu:window.nativeMenu,room:nativeRoom(),text:document.querySelector("#status").textContent}))),{cause:error});
  });
  assert.equal(await host.evaluate(()=>nativeMenu.seats.filter(s=>s.remote).length),2,"guests keep their seats in the new selector");
  await host.keyboard.press("c");
  assert.equal(await host.evaluate(()=>nativeMenu.cpu),1);
  await pickAndConfirm(4);
  for(let i=0;i<2;i++) await host.keyboard.press("Enter");   // the host's own seat and the CPU seat
  const second=await startMatch();
  assert.notDeepEqual(second.map(nameOf),first.map(nameOf),"a different lineup");
  await host.keyboard.press("ArrowRight");
  await host.keyboard.press("Enter");
  await host.waitForFunction(()=>window.nativeBattle?.diagnostics().ticks>30,null,{timeout:120000});
  assert.deepEqual(await host.evaluate(()=>nativeBattle.diagnostics().actors.map(a=>a.name)),second.map(nameOf));
  assert.notEqual(await host.locator("#venue").inputValue(),venueOne,"a different venue");
  const clockTwo=await ticksPerSecond();
  assert.ok(clockTwo.ticks>45 && clockTwo.ticks<75,`still one simulation clock in match 2 (${clockTwo.ticks}/s)`);
  assert.ok(clockTwo.frames<=75,`one render loop in match 2 (${clockTwo.frames} frames/s)`);
  assert.ok(await live()<=contextsOne,`match 2 holds no more audio graphs than match 1 (${await live()} vs ${contextsOne})`);
  assert.equal(await host.evaluate(()=>nativeRoom().captures),1);
  assert.equal(await host.locator("#code").inputValue(),code);
  const labels=(await host.locator("#seats").textContent()).split(" · ");
  assert.equal(labels.filter(label=>/ connected$/.test(label)).length,2);
  assert.equal(labels.filter(label=>/ CPU$/.test(label)).length,1);
  // The same guests drive their own seats in the second match.
  for(const [index,page] of guests.entries()) {
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
    assert.equal(await guestTracks(page),2);
  }

  // A third selector: an individual guest can leave, the room and the other guest stay.
  await quit();
  await guests[1].locator("#leave").click();
  await host.waitForFunction(()=>nativeRoom().slots.join()==="host,connected,open");
  assert.equal(await host.locator("#code").inputValue(),code);
  assert.equal(await guestTracks(guests[0]),2);
  // Closing the room ends the remaining guest and gives the host its buttons back.
  await host.locator("#leave").click();
  await guests[0].waitForFunction(()=>document.querySelector("#remote").srcObject===null);
  assert.equal(await host.locator("#host").isDisabled(),true,"no room can be opened before a match type is chosen");
  await chooseType(host,"1v1");
  await host.waitForFunction(()=>nativeMenu.screen==="fighters");
  assert.equal(await host.locator("#host").isDisabled(),false,"the host can open a new room");
  assert.deepEqual(errors,[]);
  console.log(`one invite ${code}: ${first.map(nameOf).join(", ")} on ${venueOne}, then ${second.map(nameOf).join(", ")} on another venue; ${clockOne.ticks}/${clockTwo.ticks} ticks/s`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
