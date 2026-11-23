// Retail SND selects a speech set and a byte offset. Each offset identifies one SCHl line.
const category = {announcer:"Announcer",character:"Character",taunts:"Taunt",heckles:"Heckle",enviro:"LoudMouth"};

export function createVoicePlayer(index, mix, audio) {
  const channels = new Map();
  let count = 0, last = null;
  function reset() {
    for(const entry of channels.values()) entry.handle?.stop();
    channels.clear();
    count=0;
    last=null;
  }
  return {
    reset,
    playing(channel,tick) {return (channels.get(channel)?.until ?? -1)>tick;},
    play(name,offset,channel,tick) {
      const key=name.replaceAll("\\","/").toLowerCase();
      const bank=index[key], range=bank?.lines[offset];
      if(!range)return false;
      const [start,length]=range;
      const duration=length/bank.rate;
      channels.get(channel)?.handle?.stop();
      const entry={until:tick+Math.ceil(duration*60)};
      channels.set(channel,entry);
      count++;
      last={name:key,offset,channel,tick};
      const gain=mix.gain["Speech_"+category[key.split("/")[1]]]*mix.gain.Master_Vol;
      const current=()=>channels.get(channel)===entry;
      audio.track("voice/"+bank.file,{gain,group:key.split("/")[1] === "announcer" ? "announcer" : "effects",offset:start/bank.rate,duration,current}).then(handle=>{
        if(current())entry.handle=handle;
        else handle?.stop();
      }).catch(error=>console.error("Could not play "+key,error));
      return true;
    },
    diagnostics:()=>({count,last})
  };
}

export async function loadVoicePlayer(audio) {
  const [index,mix]=await Promise.all(["voice/index.json","mix.json"].map(async file=>{
    const response=await fetch(new URL(file,import.meta.url));
    if(!response.ok)throw Error("Unable to load "+file);
    return response.json();
  }));
  return createVoicePlayer(index,mix,audio);
}
