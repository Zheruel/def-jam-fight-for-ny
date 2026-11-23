// Render the production HUD at its original resolution. Compare the actual GL backbuffer
// with the decoded retail art, independently of the fight camera and WebRTC resampling.
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "../netplay/node_modules/playwright/index.mjs";
import { gameServer } from "../tools/serve.mjs";

const server = gameServer().listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({headless:true, ...(process.platform === "darwin" && {channel:"chrome"})});
  const page = await browser.newPage();
  const base = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/`;
  const probe = new URL("__hud_check", base).href;
  await page.route(probe, route => route.fulfill({contentType:"text/html",body:'<canvas width="640" height="448"></canvas>'}));
  await page.goto(probe);
  const result = await page.evaluate(async () => {
    const gl = document.querySelector("canvas").getContext("webgl2", {antialias:false, alpha:false});
    const {createHud} = await import("./port/hud/hud.mjs");
    const hud = await createHud(gl);
    const {overlays, anchors} = await (await fetch("./port/hud/layout.json")).json();
    const atlas = await createImageBitmap(await (await fetch("./port/hud/Overlays.png")).blob());
    const actors = ["Doc","Blaze","Crow","Magic"].map(name=>({name,health:100,maxHealth:100,score:0,momentum:0}));
    const clock = {minutes:0,seconds:15};
    const running = {displayClock:clock,clock,over:false};
    const draw = (extra = {}) => {
      gl.clearColor(0,0,0,1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      hud({actors,ticks:15,outcome:{...running,...extra}});
    };
    function row(x,y,width) {
      const data = new Uint8Array(width*4);
      gl.readPixels(x,447-y,width,1,gl.RGBA,gl.UNSIGNED_BYTE,data);
      return data;
    }
    function differences(rect,previous) {
      let changes=0;
      const [x,y,w,h]=rect;
      for(let dy=0;dy<h;dy++) {
        const data=row(x,y+dy,w);
        for(let i=0;i<w;i++) if(Math.abs(data[i*4]-previous[dy][i*4])>30) changes++;
      }
      return changes;
    }
    function snapshot([x,y,w,h]) { return Array.from({length:h},(_,dy)=>row(x,y+dy,w)); }
    const titleScores = {};
    for (const [method,drawn,words,finishFlags] of [
      ["ko",false,["ko"]],["submission",false,["submit"]],["time",true,["time","over"]],["ko",true,["double","dko"]],
      ["ko",false,["totalled"],0x401],["ko",false,["ring","out"],0x801],["opening",false,["fight"]]
    ]) {
      draw(method === "opening" ? {openingFrame:68} : {over:true,result:true,ticksSinceOver:2,draw:drawn,method,finishFlags});
      for(const word of words) {
        const [u,v] = overlays["uv_over_"+word+"1"], [u2,v2] = overlays["uv_over_"+word+"2"];
        const [x,y] = overlays["pos_over_"+word], w=u2-u, h=v2-v;
        const ctx = new OffscreenCanvas(w,h).getContext("2d");
        ctx.fillStyle="black"; ctx.fillRect(0,0,w,h);
        ctx.drawImage(atlas,u,v,w,h,0,0,w,h);
        const expected=ctx.getImageData(0,0,w,h).data;
        let match=0,bright=0;
        for(let dy=0;dy<h;dy++) {
          const actual=row(x,y+dy,w);
          for(let dx=0;dx<w;dx++) {
            const white=expected[4*(dy*w+dx)]>180;
            if(white) bright++;
            if(white === (actual[4*dx]>180)) match++;
          }
        }
        titleScores[word]={agreement:match/(w*h),bright};
      }
    }
    const danger=[...anchors.pos_p1_danger,60,16], hold=[23,107,125,15], lower=[492,322,125,20];
    draw();
    const normalDanger=snapshot(danger), normalHold=snapshot(hold), normalLower=snapshot(lower);
    actors[0].health=9; actors[0].hold={limb:2,health:0.25,escape:0.5};
    actors[3].hold={limb:3,health:0.5,escape:0.75};
    draw();
    const warning=differences(danger,normalDanger), upperGauge=differences(hold,normalHold), lowerGauge=differences(lower,normalLower);
    const partial=snapshot(hold);
    actors[0].hold.health=0.9; actors[0].hold.escape=0.85;
    draw();
    const gaugeChange=differences(hold,partial);
    actors[0].health=100; actors[0].hold=actors[3].hold=null;
    draw();
    return {titleScores,warning,upperGauge,lowerGauge,gaugeChange,afterRelease:differences(hold,normalHold),glError:gl.getError()};
  });
  for(const [word,{agreement,bright}] of Object.entries(result.titleScores)) {
    assert.ok(bright>500 && agreement>0.98,word+" "+JSON.stringify(result));
  }
  for(const key of ["warning","upperGauge","lowerGauge","gaugeChange"]) assert.ok(result[key]>30,key+" "+JSON.stringify(result));
  assert.equal(result.afterRelease,0);
  assert.equal(result.glError,0);
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
