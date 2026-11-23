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
  // Four-fighter matches add a second strip along the bottom edge for seats 3 and 4 (see drawSeat).
  const lower=new OffscreenCanvas(640,96),lowerCtx=lower.getContext("2d");
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
  const texture=makeTexture(640,96), lowerTexture=makeTexture(640,96), bannerTexture=makeTexture(BANNER.width,BANNER.height);
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
  let last, lastLower, lastBanner="", lastCard=-1;
  // Bonus popups ("+1000" beside a score) of a four-fighter match: retail fades them over about a second.
  const POPUP=75;
  let scores=[], popups=[];
  // Seats 3 and 4 are seats 1 and 2 turned over a horizontal axis: bar container and fills flip vertically, the name
  // sits below the bar and the score above it (retail four-way capture, private/ps2-battle/four-way/035-menu.png).
  // `top` is the strip's first row in the 640x448 picture.
  const LOWER={top:352,axis:444.5,nameHeight:17,scoreHeight:20};
  function drawSeat(context,actor,seat,[hp,mp,score],popup,tick) {
    const id="p"+(seat%2+1),lowerSeat=seat>=2,right=seat%2===1;
    const out=actor.eliminated;
    context.save();
    context.setTransform(right?-1:1,0,0,lowerSeat?-1:1,right?640:0,lowerSeat?LOWER.axis-LOWER.top:0);
    context.drawImage(border,...anchors.pos_p1_mainBarContainer);
    if(hp>0)context.drawImage(green,0,0,hp,8,...anchors.pos_p1_healthBar,hp,8);
    if(mp>0)context.drawImage(gold,0,0,mp,8,...anchors.pos_p1_momentumBar,mp,8);
    context.restore();
    const [nx,ny]=anchors["text_"+id+"_name"],[sx,sy]=anchors["text_"+id+"_totalscore"];
    // The retail referee marks eliminated fighters independently of the health bar.
    context.globalAlpha=out?0.45:1;
    const align=right?"right":"left";
    const row=(y,height)=>lowerSeat?LOWER.axis-LOWER.top-y-height:y;
    if(actor.blazin)context.drawImage(blazin,...(lowerSeat?[anchors["pos_"+id+"_blazin"][0],row(anchors["pos_"+id+"_blazin"][1],blazin.height)]:anchors["pos_"+id+"_blazin"]));
    label(actor.name.toUpperCase(),nx,row(ny,LOWER.nameHeight),14,"names",align,context);
    label(String(score),sx,row(sy,LOWER.scoreHeight),18,"numbers",align,context);
    context.globalAlpha=1;
    if(out) {
      const [bx,by]=anchors.pos_p1_healthBar;
      label("K.O.",right?640-bx-100:bx+100,row(by-4,12),12,"names","center",context);
    }
    if(popup) {
      const age=tick-popup.tick;
      context.globalAlpha=Math.max(0,1-age/POPUP)*0.8;
      context.fillStyle="#dc9e0a";
      context.font="14px Battlenumbers";context.textBaseline="top";context.textAlign=align;
      context.fillText("+"+popup.delta,right?sx-70:sx+70,row(sy+2,14));
      context.globalAlpha=1;
    }
  }
  // `rematch` (port/hud/rematch.mjs) is the YES/NO choice; its card replaces the banner's plain rematch line.
  return function draw({actors,ticks,outcome,rematch}) {
    const {minutes,seconds}=outcome.clock;
    const bars=actors.map(a=>[Math.round(208*a.health/a.maxHealth),Math.round(125*a.momentum/100),a.score,a.blazin,a.eliminated]);
    const four=actors.length>2;
    if(four) {
      actors.forEach((a,i)=>{
        if(scores[i]!==undefined && ticks<popups[i]?.tick) popups[i]=undefined; // the match restarted
        if(scores[i]!==undefined && a.score>scores[i]) popups[i]={delta:a.score-scores[i],tick:ticks};
        else if(popups[i] && ticks-popups[i].tick>=POPUP) popups[i]=undefined;
        scores[i]=a.score;
      });
    }
    const fade=i=>popups[i]?Math.floor((ticks-popups[i].tick)/5)+":"+popups[i].delta:"";
    // Only upload the HUD strip whose visible pixels changed. The clock belongs to the top strip.
    const seatKey=(bar,i)=>four ? bar.join(",")+"/"+fade(i) : bar.join(",");
    const topKey=minutes+":"+seconds+"/"+seatKey(bars[0],0)+"/"+seatKey(bars[1],1);
    const lowerKey=four ? seatKey(bars[2],2)+(bars[3] ? "/"+seatKey(bars[3],3) : "") : "";
    gl.bindTexture(gl.TEXTURE_2D,texture);
    if(four && lowerKey!==lastLower) {
      lastLower=lowerKey;
      lowerCtx.clearRect(0,0,640,96);
      for(let seat=2;seat<actors.length;seat++) drawSeat(lowerCtx,actors[seat],seat,bars[seat],popups[seat],ticks);
      gl.bindTexture(gl.TEXTURE_2D,lowerTexture);
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,lower);
      gl.bindTexture(gl.TEXTURE_2D,texture);
    }
    if(topKey!==last) {
      last=topKey;
      ctx.clearRect(0,0,640,96);
      if(four) for(let seat=0;seat<2;seat++) drawSeat(ctx,actors[seat],seat,bars[seat],popups[seat],ticks);
      else for(let i=0;i<2;i++) {
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
      const clock=[minutes,seconds].map(n=>String(n).padStart(2,"0")).join(":");
      label(clock,320,37,30,"numbers","center");
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,surface);
    }
    gl.useProgram(program);gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(band,1,192/448);
    gl.drawArrays(gl.TRIANGLES,0,3);
    if(four) {
      gl.bindTexture(gl.TEXTURE_2D,lowerTexture);
      gl.uniform2f(band,1-2*LOWER.top/448,192/448);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
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
