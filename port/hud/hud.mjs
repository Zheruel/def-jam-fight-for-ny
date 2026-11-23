import layout from "./layout.json" with {type:"json"};
import { BANNER, resultLines } from "./result.mjs";
import { CARD, drawRematch } from "./rematch.mjs";
import { loadScreen } from "./screen.mjs";

// Keep the HUD in the host canvas so the WebRTC guest receives the same frame.
export async function createHud(gl) {
  const load = async name => {
    const response=await fetch(new URL(name,import.meta.url));
    if (!response.ok) throw Error("Unable to load HUD "+name);
    return response;
  };
  const [border,health,momentum,blazin] = await Promise.all(["mainBarContainer_1","healthBar","momentumBar","blazin"].map(async name=>
    createImageBitmap(await (await load(name+".png")).blob())));
  await Promise.all(["names","numbers"].map(async family=>{
    const face=new FontFace("Battle"+family,await (await load(family+".ttf")).arrayBuffer());
    document.fonts.add(await face.load());
  }));
  const rematchScreen=await loadScreen("rematch",new URL("./screens/",import.meta.url));
  const surface=new OffscreenCanvas(640,96),ctx=surface.getContext("2d");
  const tint=(image,color)=>{
    const tile=new OffscreenCanvas(image.width,image.height),ink=tile.getContext("2d");
    ink.drawImage(image,0,0);
    ink.globalCompositeOperation="source-in"; ink.fillStyle=color; ink.fillRect(0,0,tile.width,tile.height);
    return tile;
  };
  const green=tint(health,"#4a9b52"),gold=tint(momentum,"#dc9e0a");
  const program=gl.createProgram();
  const shaders=[
    [gl.VERTEX_SHADER,`#version 300 es
      uniform vec2 band; out vec2 uv;
      void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);
        uv=p;gl_Position=vec4(p.x*2.-1.,band.x-p.y*band.y,0.,1.); }`],
    [gl.FRAGMENT_SHADER,`#version 300 es
      precision mediump float; in vec2 uv; uniform sampler2D art;out vec4 color;
      void main(){if(uv.y>1.)discard;color=texture(art,uv);}`]];
  for(const [type,source] of shaders){
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program,shader);gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  const band=gl.getUniformLocation(program,"band");
  const makeTexture=(width,height)=>{
    const made=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,made);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,width,height);
    return made;
  };
  const texture=makeTexture(640,96), bannerTexture=makeTexture(BANNER.width,BANNER.height);
  const banner=new OffscreenCanvas(BANNER.width,BANNER.height), bannerCtx=banner.getContext("2d");
  const cardTexture=makeTexture(CARD.width,CARD.height);
  const card=new OffscreenCanvas(CARD.width,CARD.height), cardCtx=card.getContext("2d");
  const {anchors}=layout;
  function label(value,x,y,size,family,align,context=ctx) {
    context.font=size+"px Battle"+family;
    context.textAlign=align;context.textBaseline="top";context.fillStyle="#e6dfd0";
    context.lineWidth=2.5;context.strokeStyle="#3d352b";context.strokeText(value,x,y);
    context.fillText(value,x,y);
  }
  let last, lastBanner="", lastCard=-1;
  // `rematch` (port/hud/rematch.mjs) is the YES/NO choice; its card replaces the banner's plain rematch line.
  return function draw({actors,ticks,outcome,rematch}) {
    const second=Math.floor(ticks/60);
    const bars=actors.map(a=>[Math.round(208*a.health/a.maxHealth),Math.round(125*a.momentum/100),a.score,a.blazin]);
    const key=[second,...bars.flat()].join(",");
    gl.bindTexture(gl.TEXTURE_2D,texture);
    if(key!==last) {
      last=key;
      ctx.clearRect(0,0,640,96);
      for(let i=0;i<2;i++) {
        const id="p"+(i+1),[hp,mp,score]=bars[i];
        ctx.save();
        if(i) {ctx.translate(640,0);ctx.scale(-1,1);}
        ctx.drawImage(border,...anchors.pos_p1_mainBarContainer);
        if(hp>0)ctx.drawImage(green,0,0,hp,8,...anchors.pos_p1_healthBar,hp,8);
        if(mp>0)ctx.drawImage(gold,0,0,mp,8,...anchors.pos_p1_momentumBar,mp,8);
        ctx.restore();
        if(actors[i].blazin)ctx.drawImage(blazin,...anchors["pos_"+id+"_blazin"]);
        label(actors[i].name.toUpperCase(),...anchors["text_"+id+"_name"],14,"names",i?"right":"left");
        label(String(score),...anchors["text_"+id+"_totalscore"],18,"numbers",i?"right":"left");
      }
      const clock=[Math.floor(second/60),second%60].map(n=>String(n).padStart(2,"0")).join(":");
      label(clock,320,37,30,"numbers","center");
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,surface);
    }
    gl.useProgram(program);gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(band,1,192/448);
    gl.drawArrays(gl.TRIANGLES,0,3);
    const cardShown=Boolean(rematch?.shown);
    const lines=resultLines(outcome,actors.map(a=>a.name))?.filter(l=>!cardShown||l.text!=="ENTER  REMATCH");
    if(lines) {
      gl.bindTexture(gl.TEXTURE_2D,bannerTexture);
      const bannerKey=JSON.stringify(lines);
      if(bannerKey!==lastBanner) {
        lastBanner=bannerKey;
        bannerCtx.clearRect(0,0,BANNER.width,BANNER.height);
        lines.forEach(l=>label(l.text,l.x,l.y,l.size,l.family,l.align,bannerCtx));
        gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,banner);
      }
      gl.uniform2f(band,1-2*BANNER.top/448,BANNER.height/224);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    if(cardShown) {
      gl.bindTexture(gl.TEXTURE_2D,cardTexture);
      if(lastCard!==rematch.selected) {
        lastCard=rematch.selected;
        drawRematch(cardCtx,rematchScreen,rematch.selected);
        gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,card);
      }
      gl.uniform2f(band,1-2*CARD.top/448,CARD.height/224);
      gl.drawArrays(gl.TRIANGLES,0,3);
    } else lastCard=-1;
    gl.disable(gl.BLEND);gl.enable(gl.DEPTH_TEST);
  };
}
