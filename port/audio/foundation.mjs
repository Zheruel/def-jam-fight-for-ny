// Stream the stereo downmix of the venue's four-channel bsmt ambience.
export function foundationAudio() {
  const track=new Audio();
  track.preload="none";
  track.loop=true;
  track.src=new URL("./foundation-loop.ogg",import.meta.url);
  let context, broadcast, active=true, requested=false;
  const button=document.querySelector("#sound");
  function start() {
    requested=true;
    if(!context) {
      context=new AudioContext();
      const source=context.createMediaElementSource(track), gain=context.createGain();
      broadcast=context.createMediaStreamDestination();
      gain.gain.value=30000/32767;
      source.connect(gain);
      gain.connect(context.destination);gain.connect(broadcast);
    }
    if(active && !document.hidden) {
      context.resume().then(()=>track.play()).catch(()=>{});
    }
    return broadcast.stream;
  }
  function mute() {
    track.muted=!track.muted;
    button.textContent=track.muted?"Unmute":"Mute";
    start();
  }
  button.onclick=mute;
  const unlock=event=>{
    if(event.target===button || event.target.id==="join" || !active)return;
    start();
    window.removeEventListener("pointerdown",unlock);
    window.removeEventListener("keydown",unlock);
  };
  window.addEventListener("pointerdown",unlock);
  window.addEventListener("keydown",unlock);
  function synchronize() {
    if(!active || document.hidden) track.pause();
    else if(requested) start();
  }
  document.addEventListener("visibilitychange",synchronize);
  return {stream:start,setActive(value){active=value;synchronize();},restart(){if(requested)track.currentTime=0;}};
}
