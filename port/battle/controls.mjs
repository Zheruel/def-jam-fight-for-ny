const keys = new Set();
const keyPads = [
  {axes:[["KeyA","KeyD"],["KeyW","KeyS"],["KeyZ","KeyC"],["KeyT","KeyV"]], buttons:{KeyJ:0x1000,KeyU:0x8000,KeyI:0x4000,KeyO:0x2000,
    KeyQ:0x0400,KeyE:0x0800,KeyR:0x0100,KeyF:0x0200}},
  {axes:[["ArrowLeft","ArrowRight"],["ArrowUp","ArrowDown"],["Numpad4","Numpad6"],["Numpad8","Numpad2"]], buttons:{Escape:8,KeyL:0x1000,KeyK:0x8000,
    BracketLeft:0x4000,BracketRight:0x2000,Comma:0x0400,Period:0x0800,Slash:0x0100,Semicolon:0x0200}},
];
const controlled = new Set(keyPads.flatMap(p=>[...p.axes.flat(),...Object.keys(p.buttons)]));
// Standard Gamepad order to PS2 pad bits, as read by the retail Battle update.
const gamepadBits=[0x4000,0x2000,0x8000,0x1000,0x0400,0x0800,0x0100,0x0200,1,8,2,4,0x10,0x40,0x80,0x20];
// seats: 2 for one-on-one, 4 for Free For All. Seat 0 is the host's; seats 1..seats-1 go to guests, to a local
// gamepad of the same number, or (seats 0 and 1) to the keyboard. A seat with none of those holds still.
// cpu: how many of the last seats the retail CPU plays (port/battle/cpu.mjs). Those seats read no keyboard, gamepad or
// guest, so a controller that is plugged in is never taken over, and only the person seats are offered to guests.
export function battleControls(redraw,audio,{seats=2,cpu=0}={}) {
  const people=seats-cpu;
  let remote = {}, room, guest = false, poll=0, lastPacket="";
  const pads = Array(seats).fill(null);
  let state = "local";
  const button = id => document.getElementById(id);
  const IDLE={buttons:0,x:0,z:0};
  let devices = [];
  function readDevices() { return Array.from(navigator.getGamepads?.() ?? []).filter(p => p?.connected); }
  function input(slot) {
    if (slot>=people) return IDLE;
    if (pads[slot]) return pads[slot];
    if (slot >= 1 && remote[slot]) return remote[slot];
    return read(keyPads[slot], devices[slot]);
  }
  // A guest always plays from its own first controller and the second keyboard map, whichever seat it holds.
  function read(config, controller) {
    let buttons=0;
    Object.entries(config?.buttons??{}).forEach(([key,mask])=>{if(keys.has(key)) buttons|=mask;});
    controller?.buttons.forEach((b,i)=>{if(b.pressed) buttons|=gamepadBits[i]??0;});
    const [x,z,rx,rz]=(config?.axes??[[],[],[],[]]).map(([negative,positive],i)=>{
      const axis=controller?.axes[i]??0;
      return Number(keys.has(positive))-Number(keys.has(negative)) || (Math.abs(axis)>0.15 ? axis : 0);
    });
    // The native pad record expresses forward as positive. Browser Y increases downwards.
    return {buttons,x,z:-z,rx,rz:-rz};
  }
  function send() {
    if (!guest || !room) return;
    const p = pads[1] ?? read(keyPads[1], readDevices()[0]);
    const axes = [p.x,p.z,p.rx??0,p.rz??0];
    const packet=[p.buttons,...axes].join(",");
    if(packet!==lastPacket) room.setInput({buttons:p.buttons,axes});
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
      const seat = Number(new URLSearchParams(location.search).get("seat"));
      room = await transport.joinMatch({...options,code:button("code").value,video:button("remote"),
        ...(Number.isInteger(seat) && seat >= 2 && seat <= 4 ? {slot:seat-1} : {}),
        onState,onPlaybackBlocked:()=>button("remote").controls = true});
      lastPacket="";
      const scan=()=>{if(guest){send();poll=requestAnimationFrame(scan);}};
      poll=requestAnimationFrame(scan);
      button("remote").hidden = false;
      if (audio) { button("sound").hidden=true; button("remote").controls=true; }
      document.querySelector("canvas").hidden = true;
    } else {
      if (people < 2) throw new Error("Every other seat is a CPU opponent, so there is no seat for a guest.");
      room = await transport.hostMatch({...options,canvas:document.querySelector("canvas"),audioStream:audio?.stream(),onState,
        players:people,
        onInput(p,slot){remote[slot]={buttons:p.buttons,x:p.axes[0],z:p.axes[1],rx:p.axes[2],rz:p.axes[3]};},
        // A seat whose guest left goes back to the local controls instead of holding the last remote state.
        onPeer({slot,state}){ if(state==="open") delete remote[slot]; },
        onSlots(list){ const out=button("seats"); if(out) out.textContent=[...list.map(s=>"P"+(s.slot+1)+" "+s.state),...Array.from({length:cpu},(_,i)=>"P"+(people+i+1)+" CPU")].join(" · "); }});
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
    cancelAnimationFrame(poll); room?.close(); guest=false; remote={}; room=undefined; state="local";
    button("host").disabled=button("join").disabled=false;
    button("leave").hidden=true; button("remote").hidden=true; document.querySelector("canvas").hidden=false;
    button("network").textContent=""; if(button("seats")) button("seats").textContent=""; button("code").value=""; button("invite").hidden=true;
    button("sound").hidden=false; audio?.setActive(true); redraw();
  };
  return { inputs() { devices = readDevices(); return Array.from({length:seats},(_,slot)=>input(slot)); },
    impact(slot,strength) {
      if (slot >= people || remote[slot]) return;
      const actuator = devices[slot]?.vibrationActuator;
      if (actuator?.playEffect) actuator.playEffect("dual-rumble", {
        duration:80, strongMagnitude:strength, weakMagnitude:strength/2,
      }).catch(()=>{});
    }, isGuest:()=>guest, connection:()=>state,
    setInput(slot,value) { pads[slot]=value; if (guest) send(); },
    release() { keys.clear(); pads.fill(null); if (guest) send(); } };
}
