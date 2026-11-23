const code=new URLSearchParams(location.search).get("room");
if(!code) {
  await import("../viewer/viewer.mjs");
} else {
  const {battleControls}=await import("./controls.mjs");
  document.querySelector("#status").textContent="Arrow keys to move · K to kick";
  document.querySelector("#code").value=code;
  for(const id of ["venue","mode","player1","player2","player3","player4"]) document.getElementById(id).hidden=true;
  document.querySelector("header span").hidden=true;
  document.querySelector("#host").hidden=true;
  document.querySelector("#restart").hidden=true;
  const sound=document.querySelector("#sound"),video=document.querySelector("#remote");
  sound.textContent="Unmute";
  sound.onclick=()=>{video.muted=!video.muted;sound.textContent=video.muted?"Unmute":"Mute";video.play().catch(()=>{});};
  const controls=battleControls(()=>location.assign(location.pathname));
  window.nativeBattle=Object.freeze({setInput:controls.setInput,diagnostics:()=>({network:controls.connection()})});
  document.querySelector("#join").click();
}
