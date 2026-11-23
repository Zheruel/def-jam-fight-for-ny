const keys = new Set();
const controlled = new Set(["KeyD","KeyJ","ArrowLeft","KeyK"]);

export function battleControls(redraw) {
  let remote, room, guest = false;
  const pads = [null,null];
  let state = "local";
  const button = id => document.getElementById(id);
  function input(slot) {
    if (pads[slot]) return pads[slot];
    if (slot === 1 && remote) return remote;
    const move = keys.has(slot === 0 ? "KeyD" : "ArrowLeft");
    const strike = keys.has(slot === 0 ? "KeyJ" : "KeyK");
    return { buttons:(move ? 0x2000 : 0) | (strike ? (slot===0 ? 0x1000 : 0x8000) : 0),
      x: move ? (slot===0 ? 1 : -1) : 0, z:0 };
  }
  function send() {
    if (!guest || !room) return;
    const p = input(1);
    room.setInput({buttons:p.buttons,axes:[p.x,p.z,0,0]});
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
    const onState = (next,error) => {
      state = next;
      button("network").textContent = error?.message ?? (next==="connected" ? "Connected" : next);
    };
    if (join) {
      room = await transport.joinMatch({...options,code:button("code").value,video:button("remote"),
        onState,onPlaybackBlocked:()=>button("remote").controls = true});
      button("remote").hidden = false;
      document.querySelector("canvas").hidden = true;
    } else {
      room = await transport.hostMatch({...options,canvas:document.querySelector("canvas"),onState,
        onInput(p){remote={buttons:p.buttons,x:p.axes[0],z:p.axes[1]};}});
      button("code").value = room.code;
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
        guest = false;
      }
    };
  }
  button("leave").onclick = () => {
    room?.close(); guest=false; remote=undefined; room=undefined; state="local";
    button("host").disabled=button("join").disabled=false;
    button("leave").hidden=true; button("remote").hidden=true; document.querySelector("canvas").hidden=false;
    button("network").textContent=""; button("code").value=""; redraw();
  };
  return { inputs:() => [input(0),input(1)], isGuest:()=>guest, connection:()=>state,
    setInput(slot,value) { pads[slot]=value; if (guest) send(); },
    release() { keys.clear(); pads.fill(null); if (guest) send(); } };
}
