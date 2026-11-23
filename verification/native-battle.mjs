import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { attachNetplay } from "../netplay/server.mjs";
import { gameServer } from "../tools/serve.mjs";

const server = gameServer();
attachNetplay(server);
server.listen(0,"127.0.0.1");
await once(server,"listening");
const url = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await chromium.launch({headless:true,...(process.platform==="darwin" && {channel:"chrome"})});
  const open = () => browser.newPage({viewport:{width:1024,height:824}});
  const host = await open();
  const errors = [], requests = [];
  host.on("pageerror",error => errors.push(error.message));
  host.on("request",request => requests.push(new URL(request.url()).pathname));
  await host.goto(url);
  await host.waitForFunction(()=>window.nativeBattle?.diagnostics().ticks>5);
  const bench = await host.evaluate(async () => {
    document.querySelector("#restart").click();
    const actions=[new Set(),new Set()];
    const initial=nativeBattle.diagnostics(), start=performance.now();
    let elapsed, previous=start;
    const samples=[];
    do {
      await new Promise(requestAnimationFrame);
      const now=performance.now(), d=nativeBattle.diagnostics(), i=d.ticks;
      samples.push(now-previous); previous=now;
      if(d.paused) throw Error(document.querySelector("#status").textContent);
      nativeBattle.setInput(0,{buttons:i>=142 && i<183 ? 0x2000 : i>=250 && i<267 ? 0x1000 : 0,
        x:i>=142 && i<183 ? 1 : 0,z:0});
      nativeBattle.setInput(1,{buttons:i>=196 && i<237 ? 0x2000 : i>=291 && i<310 ? 0x8000 : 0,
        x:i>=196 && i<237 ? -1 : 0,z:0});
      d.actors.forEach((actor,slot)=>actions[slot].add(actor.action));
      elapsed=now-start;
    } while(elapsed<7300);
    const final=nativeBattle.diagnostics(), canvas=document.querySelector("canvas");
    samples.sort((a,b)=>a-b);
    return {fps:(final.renderedFrames-initial.renderedFrames)*1000/elapsed,ticksPerSecond:final.ticks*1000/elapsed,
      p95FrameMs:samples[Math.floor(samples.length*.95)],size:[canvas.width,canvas.height],
      actions:actions.map(s=>[...s]),health:final.actors.map(a=>a.health),scores:final.actors.map(a=>a.score)};
  });
  assert.ok(bench.actions[0].includes(67) && bench.actions[1].includes(1069),"Both players must strike");
  assert.ok(bench.actions[0].includes(10334) && bench.actions[1].includes(10328),"Both players must react");
  assert.deepEqual(bench.scores,[250,250]);
  if(process.env.NATIVE_SCREENSHOT) await host.locator("canvas").screenshot({path:process.env.NATIVE_SCREENSHOT});
  assert.deepEqual(errors,[]);
  assert.ok(requests.every(p=>!/(?:\/runtime\/|\/game-assets\/|\.iso$)/.test(p)));
  console.log(JSON.stringify(bench));
  await host.locator("#restart").click();
  await host.locator("#host").click();
  await host.waitForFunction(()=>document.querySelector("#code").value.length===8);
  const guest=await open();
  const guestRequests=[];
  guest.on("request",request=>guestRequests.push(new URL(request.url()).pathname));
  await guest.goto(await host.locator("#invite").getAttribute("href"));
  await guest.waitForFunction(()=>window.nativeBattle);

  await guest.waitForFunction(()=>document.querySelector("#remote").videoWidth>0 && nativeBattle.diagnostics().network==="connected");
  assert.ok(guestRequests.every(p=>!/\.(gz|ogg|ttf)$|\/game-assets\//.test(p)),"Guest must only load the stream");
  await guest.waitForFunction(()=>document.querySelector("#remote").srcObject?.getAudioTracks().some(t=>t.readyState==="live"));
  await guest.locator("#sound").click();
  const rms = await guest.evaluate(async () => {
    const context=new AudioContext();
    await context.resume();
    const analyser=context.createAnalyser(),video=document.querySelector("#remote");
    context.createMediaStreamSource(video.srcObject).connect(analyser);
    const samples=new Float32Array(analyser.fftSize);
    let peak=0;
    for(let i=0;i<75 && peak<0.0001;i++){
      await new Promise(requestAnimationFrame);
      analyser.getFloatTimeDomainData(samples);
      peak=Math.max(peak,Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length));
    }
    await context.close();
    return peak;
  });
  assert.ok(rms>0.0001,"Guest should receive audible venue ambience");
  await guest.locator("h1").click();
  await guest.keyboard.down("ArrowLeft");
  try {
    await host.waitForFunction(()=>nativeBattle.diagnostics().actors[1].action!==10016 || nativeBattle.diagnostics().paused,undefined,{timeout:4000});
    const d = await host.evaluate(()=>({ ...nativeBattle.diagnostics(), status:document.querySelector("#status").textContent }));
    assert.ok(!d.paused,d.status);
  } catch (error) {
    console.error(await host.evaluate(()=>({ ...nativeBattle.diagnostics(), status:document.querySelector("#status").textContent })));
    throw error;
  }
  await guest.keyboard.up("ArrowLeft");
  await guest.locator("#leave").click();
  console.log("A second browser received host audio and video and moved Doc using the guest keyboard.");
  await host.locator("#leave").click();
  await host.selectOption("#venue","V2BG_21A");
  await host.waitForFunction(()=>document.querySelector("canvas").dataset.venue==="V2BG_21A" && window.nativeBattle?.diagnostics().ticks>=15);
  const ambienceRequest = host.waitForResponse(response =>
    response.url().endsWith("/port/audio/ambience/carib.ogg") && response.ok());
  await host.locator("#sound").click();
  await ambienceRequest;
  const babylon=await host.evaluate(()=>nativeBattle.diagnostics());
  assert.ok(!babylon.paused);
  assert.ok(babylon.actors.every(actor=>Math.abs(actor.position[2]+12)<1),"Babylon's starting line has Z = -12");
  await host.selectOption("#player1","0x07000000");
  await host.waitForFunction(()=>window.nativeBattle?.diagnostics().actors[0].name==="Erick Sermon" && nativeBattle.diagnostics().ticks>=15);
  assert.equal(await host.locator("#venue").inputValue(),"V2BG_21A");
  assert.ok(requests.every(path=>!path.includes("Play.wasm")&&!path.includes("/blocks/")));
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
