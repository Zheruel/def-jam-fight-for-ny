const keys = new Set();
const keyPads = [
  {axes:[["KeyA","KeyD"],["KeyW","KeyS"],["KeyZ","KeyC"],["KeyT","KeyV"]], buttons:{KeyJ:0x1000,KeyU:0x8000,KeyI:0x4000,KeyO:0x2000,
    KeyQ:0x0400,KeyE:0x0800,KeyR:0x0100,KeyF:0x0200}},
  {axes:[["ArrowLeft","ArrowRight"],["ArrowUp","ArrowDown"],["Numpad4","Numpad6"],["Numpad8","Numpad2"]], buttons:{Escape:8,KeyL:0x1000,KeyK:0x8000,
    BracketLeft:0x4000,BracketRight:0x2000,Comma:0x0400,Period:0x0800,Slash:0x0100,Semicolon:0x0200}},
];
// A guest's keyboard also has Enter and Backspace for cross and circle, the buttons the shared selector uses to confirm and go back.
const guestPad = {...keyPads[1], buttons:{...keyPads[1].buttons, Enter:0x4000, Backspace:0x2000}};
const controlled = new Set(keyPads.flatMap(p=>[...p.axes.flat(),...Object.keys(p.buttons)]));
const guestOnly = new Set(["Enter","Backspace"]);
// Standard Gamepad order to PS2 pad bits, as read by the retail Battle update.
const gamepadBits=[0x4000,0x2000,0x8000,0x1000,0x0400,0x0800,0x0100,0x0200,1,8,2,4,0x10,0x40,0x80,0x20];
const IDLE={buttons:0,x:0,z:0};
const readDevices=()=>Array.from(navigator.getGamepads?.() ?? []).map(p => p?.connected ? p : null);

const guestDevice = () => readDevices().find(Boolean);
function vibrate(device, level) {
  const actuator = device?.vibrationActuator;
  if (!actuator?.playEffect) return;
  // 0x1ea2e8 reads VibLvl0..3. 0x1eaa58 writes the second float to the
  // small (on/off) DualShock motor and the first to the variable large motor.
  const strong = [0, 0.4, 0.8, 1][level];
  actuator.playEffect("dual-rumble", {
    duration:level ? 160 : 0, strongMagnitude:strong, weakMagnitude:level === 3 ? 1 : 0,
  }).catch(() => {});
}

// One room per page, shared by the match selector and the match: a host that opens it from the selector keeps the same
// connections, seats and controller channels into the match (its picture and sound are switched with replaceTrack).
let shared;
export const roomSession = () => (shared ??= createSession());

function createSession() {
  const button = id => document.getElementById(id);
  let remote = {}, room, guest = false, poll = 0, lastPacket = "", state = "local", bound = false;
  let seats = 0, cpu = 0, audio = null, cover = null, canvas = () => document.querySelector("canvas"), redraw = () => {}, slots = [], quiet;
  const pads = [], listeners = new Set();
  const people = () => seats - cpu;
  let devices = [];

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
  function input(slot) {
    if (slot>=people()) return IDLE;
    if (pads[slot]) return pads[slot];
    if (slot >= 1 && remote[slot]) return remote[slot];
    return read(keyPads[slot], devices[slot]);
  }
  function send() {
    if (!guest || !room) return;
    const p = pads[1] ?? read(guestPad, guestDevice());
    const axes = [p.x,p.z,p.rx??0,p.rz??0];
    const packet=[p.buttons,...axes].join(",");
    if(packet!==lastPacket) room.setInput({buttons:p.buttons,axes});
    lastPacket=packet;
  }
  function press(event) {
    if ((!controlled.has(event.code) && !(guest && guestOnly.has(event.code))) || event.target.tagName === "INPUT") return;
    event.preventDefault();
    if (event.type === "keydown") keys.add(event.code);
    else keys.delete(event.code);
    send();
  }

  // The seat labels in the footer: the host's seat, each guest seat's state, then the CPU seats.
  function showSeats() {
    const out = button("seats");
    if (out && room) out.textContent = [...slots.map(s=>"P"+(s.slot+1)+" "+s.state),...Array.from({length:cpu},(_,i)=>"P"+(people()+i+1)+" CPU")].join(" · ");
  }
  const silence = () => (quiet ??= new AudioContext().createMediaStreamDestination().stream);
  const media = () => ({canvas:cover ?? canvas(), audioStream:audio?.stream() ?? silence()});
  const hostable = () => state === "local" && seats > 0 && !guest;
  function refresh() {
    const host = button("host");
    if (host && !room) host.disabled = !hostable();
  }

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
        onState,onVibration:level => vibrate(guestDevice(), level),onPlaybackBlocked:()=>button("remote").controls = true});
      lastPacket="";
      const scan=()=>{if(guest){send();poll=requestAnimationFrame(scan);}};
      poll=requestAnimationFrame(scan);
      button("remote").hidden = false;
      if (audio) { button("sound").hidden=true; button("remote").controls=true; }
      document.querySelector("canvas").hidden = true;
    } else {
      if (people() < 2) throw new Error("Every other seat is a CPU opponent, so there is no seat for a guest.");
      room = await transport.hostMatch({...options,...media(),onState,
        players:people(),
        onInput(p,slot){
          remote[slot]={buttons:p.buttons,x:p.axes[0],z:p.axes[1],rx:p.axes[2],rz:p.axes[3]};
          listeners.forEach(listener=>listener(slot,remote[slot]));
        },
        // A seat whose guest left goes back to the local controls instead of holding the last remote state.
        onPeer({slot,state}){ if(state==="open") { delete remote[slot]; listeners.forEach(listener=>listener(slot,null)); }
          else remote[slot] ??= IDLE; },
        onSlots(list){ slots=list; showSeats(); redraw(); }});
      slots = room.slots();
      showSeats();
      button("code").value = room.code;
      const invite=new URL(location.href);
      invite.searchParams.set("room",room.code);
      button("invite").href=invite.href;
      button("invite").hidden=false;
    }
    button("host").disabled = true; button("join").disabled = true;
    button("leave").hidden = false;
  }
  function leave() {
    cancelAnimationFrame(poll); room?.close(); guest=false; remote={}; room=undefined; state="local"; slots=[];
    button("leave").hidden=true; button("remote").hidden=true; document.querySelector("canvas").hidden=false;
    button("join").disabled=false; refresh();
    button("network").textContent=""; if(button("seats")) button("seats").textContent=""; button("code").value=""; button("invite").hidden=true;
    button("sound").hidden=false; audio?.setActive(true); redraw();
  }
  // The page's buttons and the keyboard drive the session; battleControls and the selector can both call this.
  function bind() {
    for (const [id,join] of [["host",false],["join",true]]) {
      button(id).onclick = async () => {
        button("host").disabled = button("join").disabled = true;
        try { await connect(join); }
        catch (error) {
          button("network").textContent = error.message;
          button("join").disabled = false; refresh();
          guest = false; audio?.setActive(true);
        }
      };
    }
    button("leave").onclick = leave;
    if (bound) return;
    bound = true;
    window.addEventListener("keydown",press);
    window.addEventListener("keyup",press);
    window.addEventListener("blur",() => { keys.clear(); send(); });
  }

  // Diagnostics for headless checks: the room's code and how many picture captures it still runs.
  window.nativeRoom = () => ({ code: room?.code ?? null, captures: room?.liveCaptures?.() ?? null, slots: slots.map(s => s.state), guest });
  return {
    bind, refresh,
    // Declare what the page shows and plays: how many seats (and how many of the last ones are CPU), the sound bus and the
    // canvas guests should see. A room that is already open follows: its seat count, and its picture and sound (replaceTrack).
    use({seats:count=seats, cpu:cpus=cpu, audio:sound=audio, canvas:source=canvas, redraw:draw=redraw}={}) {
      const next = typeof source === "function" ? source : () => source;
      const changed = count !== seats || cpus !== cpu, viewing = !cover && (next() !== canvas() || sound !== audio);
      seats = count; cpu = cpus; audio = sound; canvas = next; redraw = draw;
      if (room && !guest) {
        if (changed && people() >= 2) { room.setPlayers(people()); showSeats(); }
        if (viewing) room.setMedia(media()).catch(error => { button("network").textContent = error.message; });
      }
      refresh();
    },
    // While a picture covers the match (the loading poster), a hosted room sends it instead of the page's canvas; null hands
    // the canvas back.
    cover(element) {
      cover = element;
      if (room && !guest) room.setMedia(media()).catch(error => { button("network").textContent = error.message; });
    },
    // Remote controller states (slot, pad) for the selector; pad is null when that guest's seat went back to open.
    onPad(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // Whether a guest holds the seat (a person, not the host's keyboard), and whether the host may take back seats for the CPU.
    occupied(seat) { return seat >= 1 && slots.some(s => s.slot === seat && s.state !== "open"); },
    hosted: () => Boolean(room) && !guest,
    // Whether a match of `count` seats leaves every seated guest a seat.
    fits: count => !room || guest || slots.every(s => s.state === "open" || s.slot < count),
    // The CPU takes the last `count` seats: refused while a guest holds one of them or when no seat would stay open to a guest.
    setCpu(count) {
      if (!room || guest) { cpu = count; refresh(); return true; }
      const next = seats - count;
      if (next < 2 || slots.some(s => s.slot >= next && s.state !== "open")) return false;
      cpu = count; room.setPlayers(next); showSeats();
      return true;
    },
    pad: slot => remote[slot],
    inputs() { devices = readDevices(); return Array.from({length:seats},(_,slot)=>input(slot)); },
    vibration(slot,level) {
      if (slot >= people() || guest) return;
      if (remote[slot]) room?.setVibration(slot, level);
      else vibrate(devices[slot], level);
    },
    isGuest:()=>guest, connection:()=>state,
    setInput(slot,value) { pads[slot]=value; if (guest) send(); },
    release() { keys.clear(); pads.fill(null); if (guest) send(); },
  };
}

// seats: 2 for one-on-one, 3 or 4 for Free For All and Team. Seat 0 is the host's; seats 1..seats-1 go to guests, to a local
// gamepad of the same number, or (seats 0 and 1) to the keyboard. A seat with none of those holds still.
// cpu: how many of the last seats the retail CPU plays (port/battle/cpu.mjs). Those seats read no keyboard, gamepad or
// guest, so a controller that is plugged in is never taken over, and only the person seats are offered to guests.
export function battleControls(redraw,audio,{seats=2,cpu=0}={}) {
  const session = roomSession();
  session.bind();
  session.use({seats,cpu,audio,redraw,canvas:()=>document.querySelector("canvas")});
  return session;
}
