const keys = new Set();
const keyPads = [
  {axes:[["KeyA","KeyD"],["KeyW","KeyS"]], buttons:{KeyJ:0x1000,KeyU:0x8000,KeyI:0x4000,KeyO:0x2000,
    KeyQ:0x0400,KeyE:0x0800,KeyR:0x0100,KeyF:0x0200}},
  {axes:[["ArrowLeft","ArrowRight"],["ArrowUp","ArrowDown"]], buttons:{KeyL:0x1000,KeyK:0x8000,
    BracketLeft:0x4000,BracketRight:0x2000,Comma:0x0400,Period:0x0800,Slash:0x0100,Semicolon:0x0200}},
];
const controlled = new Set(keyPads.flatMap(p=>[...p.axes.flat(),...Object.keys(p.buttons)]));
// Standard Gamepad order to PS2 pad bits, as read by the retail Battle update.
const gamepadBits=[0x4000,0x2000,0x8000,0x1000,0x0400,0x0800,0x0100,0x0200,1,8,2,4,0x10,0x40,0x80,0x20];
export function battleControls(redraw,audio) {
  let remote, room, guest = false, poll=0, lastPacket="";
  const pads = [null,null];
  let state = "local";
  const button = id => document.getElementById(id);
  function input(slot) {
    if (pads[slot]) return pads[slot];
    if (slot === 1 && remote) return remote;
    const config=keyPads[slot];
    const controller=Array.from(navigator.getGamepads?.()??[]).filter(p=>p?.connected)[guest ? 0 : slot];
    let buttons=0;
    Object.entries(config.buttons).forEach(([key,mask])=>{if(keys.has(key)) buttons|=mask;});
    controller?.buttons.forEach((b,i)=>{if(b.pressed) buttons|=gamepadBits[i]??0;});
    const [x,z]=config.axes.map(([negative,positive],i)=>{
      const axis=controller?.axes[i]??0;
      return Number(keys.has(positive))-Number(keys.has(negative)) || (Math.abs(axis)>0.15 ? axis : 0);
    });
    return {buttons,x,z};
  }
  function send() {
    if (!guest || !room) return;
    const p = input(1);
    const packet=[p.buttons,p.x,p.z].join(",");
    if(packet!==lastPacket) room.setInput({buttons:p.buttons,axes:[p.x,p.z,0,0]});
    lastPacket=packet;
  }
  function press(event) {
    if (!controlled.has(event.code) || event.target.tagName === "INPUT") return;
    event.preventDefault();
    if (event.type === "keydown") keys.add(event.code);
    else keys.delete(event.code);
    send();
  }
  window.addEventListener("keydown",press);
  window.addEventListener("keyup",press);
  window.addEventListener("blur",() => { keys.clear(); send(); });
  async function connect(join) {
    const published = location.hostname.endsWith(".github.io");
    const transport = await import(published ? "../../netplay/peerjs.mjs" : "../../netplay/client.mjs");
    const options = published ? {} : await (await fetch(new URL("../../netplay/config",import.meta.url))).json();
    guest = join;
    audio?.setActive(!join);
    const onState = (next,error) => {
      state = next;
      button("network").textContent = error?.message ?? (next==="connected" ? "Connected" : next);
    };
    if (join) {
      room = await transport.joinMatch({...options,code:button("code").value,video:button("remote"),
        onState,onPlaybackBlocked:()=>button("remote").controls = true});
      lastPacket="";
      const scan=()=>{if(guest){send();poll=requestAnimationFrame(scan);}};
      poll=requestAnimationFrame(scan);
      button("remote").hidden = false;
      if (audio) { button("sound").hidden=true; button("remote").controls=true; }
      document.querySelector("canvas").hidden = true;
    } else {
      room = await transport.hostMatch({...options,canvas:document.querySelector("canvas"),audioStream:audio?.stream(),onState,
        onInput(p){remote={buttons:p.buttons,x:p.axes[0],z:p.axes[1]};}});
      button("code").value = room.code;
      const invite=new URL(location.href);
      invite.searchParams.set("room",room.code);
      button("invite").href=invite.href;
      button("invite").hidden=false;
    }
    button("host").disabled = true; button("join").disabled = true;
    button("leave").hidden = false;
  }
  for (const [id,join] of [["host",false],["join",true]]) {
    button(id).onclick = async () => {
      button("host").disabled = button("join").disabled = true;
      try { await connect(join); }
      catch (error) {
        button("network").textContent = error.message;
        button("host").disabled = button("join").disabled = false;
        guest = false; audio?.setActive(true);
      }
    };
  }
  button("leave").onclick = () => {
    cancelAnimationFrame(poll); room?.close(); guest=false; remote=undefined; room=undefined; state="local";
    button("host").disabled=button("join").disabled=false;
    button("leave").hidden=true; button("remote").hidden=true; document.querySelector("canvas").hidden=false;
    button("network").textContent=""; button("code").value=""; button("invite").hidden=true;
    button("sound").hidden=false; audio?.setActive(true); redraw();
  };
  return { inputs:() => [input(0),input(1)], isGuest:()=>guest, connection:()=>state,
    setInput(slot,value) { pads[slot]=value; if (guest) send(); },
    release() { keys.clear(); pads.fill(null); if (guest) send(); } };
}
