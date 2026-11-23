// Play the four-controller exchange and verify the actual Web Audio slice the retail speech driver requested.
import assert from "node:assert/strict";
import {once} from "node:events";
import {readFileSync} from "node:fs";
import {chromium} from "../netplay/node_modules/playwright/index.mjs";
import {gameServer} from "../tools/serve.mjs";
import inventory from "../ps2/content/inventory.json" with {type:"json"};
const server=gameServer();server.listen(0,"127.0.0.1");await once(server,"listening");
const url=new URL(process.argv[2]??("http://127.0.0.1:"+server.address().port+"/?p1=0x07000030&p2=0x07000025&venue=V2BG_02A"));
url.searchParams.set("mode","ffa");
[5,10,11,16].forEach((id,i)=>url.searchParams.set("p"+(i+1),inventory.fighters.find(f=>f.fighterXml.coreID===id).handle));
const browser=await chromium.launch({channel:process.platform==="darwin"?"chrome":undefined,headless:true});
try{
  const page=await browser.newPage({viewport:{width:640,height:480}});
  page.on("pageerror",e=>console.error(e.message));
  page.on("console",m=>{if(m.type()==="error")console.error(m.text());});
  page.on("response",r=>{if(r.status()>=400)console.error(r.status(),r.url());});
  await page.addInitScript(()=>{
    window.requestAnimationFrame=fn=>{window.advanceMatchFrame=fn;return 1;};
    const start=AudioBufferSourceNode.prototype.start;
    window.audioSlices=[];
    AudioBufferSourceNode.prototype.start=function(when,off,len) {
      if(len>0 && this.buffer){
        const rate=this.buffer.sampleRate, pcm=this.buffer.getChannelData(0);
        let energy=0, n=0;
        for(let i=Math.round(off*rate);i<Math.min(pcm.length,(off+len)*rate);i+=8){energy+=pcm[i]*pcm[i];n++;}
        window.audioSlices.push({off,len,rms:Math.sqrt(energy/n)});
      }
      return start.apply(this,arguments);
    };
  });
  await page.goto(url.href);
  await page.waitForFunction(()=>window.nativeBattle?.diagnostics().actors.length===4,null,{polling:100,timeout:35000}).catch(async err=>{throw Error(await page.locator("body").innerText(),{cause:err})});
  await page.mouse.click(10,10);
  await page.waitForFunction(()=>window.nativeBattle?.diagnostics().voice,null,{polling:100,timeout:20000});
  await page.evaluate(()=>document.querySelector("#restart").click());
  const voice=await page.evaluate(()=>{
    let time=0;const angles=[0,Math.PI,0,Math.PI];
    for(let tick=0;tick<3500;tick++) {
      const snap=nativeBattle.diagnostics(),t=snap.ticks;
      if(snap.voice.last)return snap.voice.last;
      snap.actors.forEach((a,i)=>{
        const others=snap.actors.filter((b,j)=>j!==i && b.health>0);
        const distance=b=>Math.hypot(b.position[0]-a.position[0],b.position[2]-a.position[2]);
        const target=others.sort((b,c)=>distance(b)-distance(c))[0];
        if(target)angles[i]=Math.atan2(target.position[2]-a.position[2],target.position[0]-a.position[0]);
        nativeBattle.setInput(i,{buttons:t%27<11?[0x1000,0x2000,0x4000,0x8000][(i+Math.floor(t/27))%4]:0,
          x:Math.cos(angles[i]),z:Math.sin(angles[i])});
      });
      window.advanceMatchFrame(time);time+=1000/60;
    }
    throw Error("The retail event did not request a line");
  });
  const index=JSON.parse(readFileSync(new URL("../port/audio/voice/index.json",import.meta.url)));
  const set=index[voice.name], [start,length]=set.lines[voice.offset];
  const slice=await page.waitForFunction(([off,len])=>window.audioSlices.find(s=>
    Math.abs(s.off-off)<1e-5 && Math.abs(s.len-len)<1e-5 && s.rms>0.005),[start/set.rate,length/set.rate],{timeout:60000,polling:100});
  assert.ok(await slice.jsonValue());
  console.log(voice,await slice.jsonValue());
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
