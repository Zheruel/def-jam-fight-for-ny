// Verify the GPU atlas replacement against the decoded retail tile, including the surrounding intact pixels.
import {strict as assert} from "node:assert";
import {once} from "node:events";
import {chromium} from "../netplay/node_modules/playwright/index.mjs";
import {gameServer} from "../tools/serve.mjs";
const server=gameServer().listen(0,"127.0.0.1");await once(server,"listening");
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.platform==="darwin"&&{channel:"chrome"})});
  const page=await browser.newPage();
  // Use an inert same-origin document for the actual production WebGL adapter.
  await page.goto(`http://127.0.0.1:${server.address().port}/port/render/damage/tiles.json`);
  const results=await page.evaluate(async()=>{
    const {damageTextures}=await import("/port/render/damage.mjs");
    const {default:manifest}=await import("/port/render/damage/tiles.json",{with:{type:"json"}});
    const canvas=document.createElement("canvas"), gl=canvas.getContext("webgl2"), model="V2IP_113A";
    const base=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,base);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,512,512,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(512*512*4).fill(42));
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    const atlas=manifest[model][1].atlas, changes=damageTextures(gl,model,new Map([[atlas,base]]));
    const out=[];
    for(const level of [1,2]){
      const tile=manifest[model][level];
      let texture;
      for(let i=0;i<150;i++){
        texture=changes.get(level,atlas);
        if(texture!==base) break;
        await new Promise(requestAnimationFrame);
      }
      if(texture===base) throw Error("Damage texture did not load");
      const image=await createImageBitmap(await (await fetch("/port/render/damage/"+tile.file)).blob(),
        {premultiplyAlpha:"none",colorSpaceConversion:"none"});
      const reference=gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D,reference);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,image);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      const frame=gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,frame);
      function pixels(t,x,y,w,h){
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
        const bytes=new Uint8Array(w*h*4);
        gl.readPixels(x,y,w,h,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
        return bytes;
      }
      const actual=pixels(texture,tile.x,tile.y,image.width,image.height), expected=pixels(reference,0,0,image.width,image.height);
      out.push(actual.every((v,i)=>v===expected[i])&&pixels(texture,0,0,1,1).every(v=>v===42)&&changes.get(0,atlas)===base);
      image.close();gl.deleteFramebuffer(frame);gl.deleteTexture(reference);
    }
    changes.dispose();gl.deleteTexture(base);
    return {out,error:gl.getError()};
  });
  assert.deepEqual(results,{out:[true,true],error:0});
  console.log("Both damage levels matched every original tile pixel on the GPU. The intact atlas survived the reset.");
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
