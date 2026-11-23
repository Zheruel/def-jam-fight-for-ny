const code=new URLSearchParams(location.search).get("room");
if(!code) {
  await import("../viewer/viewer.mjs");
} else {
  const {battleControls}=await import("./controls.mjs");
  document.querySelector("#status").textContent="Left arrow to advance Doc · K to kick";
  document.querySelector("#code").value=code;
  document.querySelector("#venue").hidden=true;
  document.querySelector("#host").hidden=true;
  document.querySelector("#restart").hidden=true;
  const sound=document.querySelector("#sound"),video=document.querySelector("#remote");
  sound.textContent="Unmute";
  sound.onclick=()=>{video.muted=!video.muted;sound.textContent=video.muted?"Unmute":"Mute";video.play().catch(()=>{});};
  const controls=battleControls(()=>location.assign(location.pathname));
  window.nativeBattle=Object.freeze({setInput:controls.setInput,diagnostics:()=>({network:controls.connection()})});
  document.querySelector("#join").click();
}
