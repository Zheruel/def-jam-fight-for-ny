# Retail audio

Everything here is decoded from the verified US retail disc (SLUS-21004). `extract.py` builds it, `verify.py` re-reads the disc and checks the committed files, `venue.test.mjs` and `browser-check.mjs` check the browser side.

```sh
python3 port/audio/extract.py private/ps2/reference.iso --decoder private/vgmstream/build/cli/vgmstream-cli
python3 port/audio/verify.py  private/ps2/reference.iso --decoder private/vgmstream/build/cli/vgmstream-cli
node --test port/audio/venue.test.mjs
node port/audio/browser-check.mjs      # headless Chrome, all 24 venues
```

Needs FFmpeg (libopus) and vgmstream-cli (revision r2168 used). `--only venues cues data music speech` rebuilds a part; `--music TUNE` and `--speech SET` export one tune or one speech set on demand.

## Venue ambience (`venues.json`, `ambience/`)

CGameAudio keeps a per-stage table in `SLUS_210.04` (`0x375d20`, `0x2c` bytes per record, indexed by the core venue id; the stage-start routine at `0x127270` indexes it). Each record names the venue's announcer set and speech id, crowd bank, SFX archive, ambient bed, second ambient and SFX bank. `venues.json` carries that record for all 24 selectable venues next to the `VENUE.XML` entry. Where they differ the executable wins: it names beds that the XML leaves as `*` (Hunt's Point, The Pit, Club Murder) and the Inferno's `fire` stream.

A bed is subsong 1 of the venue's ambient `.abk` (the last subsong of `fire.abk` for the Inferno): a segmented 2- or 4-channel EA-XA stream at 36 kHz with an intro section and a loop section. The intro audio equals the loop in 20 of the 22 beds, so only the loop section `[loopStart, loopEnd)` is stored, with the retail loop points recorded in `beds[].loopStart/loopEnd` (source frames) and `loopSeconds`. Dragon House/Gauntlet intros differ from their loop only in the last 127 frames; Inferno's loop ends 22,499 frames before the stream does. Both are kept exactly as retail. 4-channel beds are the two stereo layers averaged (`L = (c0+c2)/2`, `R = (c1+c3)/2`). Stored as 48 kb/s Opus, 48 kHz.

Gauntlet A/B and 7th Heaven A/B share their bed file, so there are 22 beds for 24 venues (13 MB).

## Browser API (`venue.mjs`)

```js
import { venueAudio } from "../audio/venue.mjs";
const audio = venueAudio(arena.file);   // any of the 24 venue files; fetches nothing yet
audio.stream();                          // starts on demand, returns the host's MediaStream
audio.setActive(bool); audio.restart();  // same contract as foundationAudio()
audio.setMuted(bool);                    // local speakers only; guests keep hearing the host mix
await audio.cue("Fighter_Big_Hits_Ring", 3, { gain: 0.6 }); // retail subsong 3, plays into the same stream
```

Cold boot loads nothing. `stream()` (or the first key press/click, or the `#sound` button) fetches `venues.json` and that venue's one bed, decodes it and loops it on the exact retail loop length. Cue banks, `cues.json`, `mix.json` and `animtags.json.gz` load on first use only. Everything goes through one bus that feeds both the local output and a `MediaStreamDestination`, which is what `hostMatch({audioStream})` sends to guests. `loadAnimTags()` returns the animation tags, `venueManifest()`, `cueManifest()` and `mixLevels()` return the manifests.

`files.mjs` (Node) exports `audioFiles` (`audioCore`, `audioBeds`, `audioCues`) for the publication list. `foundation.mjs` and `foundation-loop.ogg` are the previous Foundation-only version; nothing here reads them any more.

## Cue banks (`cues.json`, `cues/`)

57 banks, 1,244 cues, each bank packed into one Opus file (48 kHz stereo, 24 ms gaps) with `start`/`frames` per cue (`i` is the retail subsong number). Groups: `impact` (`Fighter_{Small,Med,Big}_Hits_{Ring,Out}`, `Spec_*`, `Chops`, `WCommon1/2`, `Train_Kill_*`, `randomr`), `voice` (`Grunts_*`), `crowd` (`csmall`, `cmed`, `csmall_out`, `crlarge`, `cmomets`), `venue` (the 22 distinct venue SFX banks, `train`, `fire`). Each cue records `peak`, source `rate`/`channels`/`samples`. The compiled event behaviour inside a bank (which sample plays for which event, pitch, volume, randomisation) is MIPS code (`ABKC` banks), not data, so cue choice is by subsong number.

## Mix levels (`mix.json`)

`AUDIO/TV.TXT` as read by the engine: `raw` values and `gain` (linear) for every level that is a gain. Ambience is 30000/32767, crowd stream 13000, punch/kick 32767, bone crunch 16000, face hits 16242, grunts 13142, female grunts 14000, speech and music percentages are in `/100`.

## Event dispatch (`events.json`, `animtags.json.gz`)

Gameplay audio reaches the SND service through one post function, stored in the pointer at `0x389748` by `0x24b9fc` (target `0x24cd38`): `post(eventWord, argc, args…)` queues `{eventWord, args[argc]}`. `eventWord` comes from `0x24d5d8` as `a0<<24 | a1<<16 | id`. `events.json.dispatch` lists all 32 call sites with their function, constant arguments and callers, e.g. the Endurance path `0x131988` posts id `0x2034` at `0x131a94`, and `0x12be80` is the playback query (`0x10d110`: is the sound still playing) that gates a repeat announcer event `0x2016` carrying the venue's speech id (record word 1). `eventSystem` is `DefJam2_eventsys.csi` (33 event classes `A1c[pbe]*`, 76 sound objects); `soundClasses` is the retail 104-entry table of class values and flags that follows the venue records.

`animtags.json.gz` is `ANIMTAGS.DAT` fully decoded: 2,669 animations, each with tags `[frame, n, …n+1 words]`. Type 5 tags (`n=5`) are the sound events `[class, id, variant, 0, 0, 0]`; frames count in animation frames. Which event name a class/id pair selects is compiled into the banks and is not decoded.

## Not decoded

- Music: `music.json` lists all 33 tunes with their MPF section tables (`--music TUNE` exports the main track). The MPF node graph that sequences sections, so the retail music loop points, is not decoded, and the track chosen for a fight is not recovered.
- Speech: `speech.json` indexes the 535 speech sets (`SPEECH1–3.VIV`); lines are SCHl streams (`--speech SET` exports a set). Announcer selection logic beyond the venue record's speech id is not decoded.
- The ambient banks' mono one-shots (`--shots`) and the random scheduler.
