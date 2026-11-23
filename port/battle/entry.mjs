const params=new URLSearchParams(location.search),code=params.get("room");
// A direct link (?p1=&p2=&venue= or ?mode=) starts that match; a bare page opens the retail fighter and venue selector (?menu=1 forces it).
const direct=!params.has("menu")&&["p1","p2","p3","p4","venue","mode"].some(key=>params.has(key));
if(!code) {
  if(!direct) await (await import("../menu/launch.mjs")).chooseMatch(params);
  await import("../viewer/viewer.mjs");
} else {
  const {battleControls}=await import("./controls.mjs");
  document.querySelector("#status").textContent="Online guest · arrow keys move, Enter confirms your fighter in the selector · K to kick in the match";
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
