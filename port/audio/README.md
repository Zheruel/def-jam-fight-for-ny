# Retail audio

Everything here is decoded from the verified US retail disc (SLUS-21004). `extract.py` builds it, `verify.py` re-reads the disc and checks the committed files, `venue.test.mjs` and `browser-check.mjs` check the browser side.

```sh
python3 port/audio/extract.py private/ps2/reference.iso --decoder private/vgmstream/build/cli/vgmstream-cli
python3 port/audio/verify.py  private/ps2/reference.iso --decoder private/vgmstream/build/cli/vgmstream-cli
node --test port/audio/*.test.mjs
node port/audio/browser-check.mjs      # headless Chrome, all 24 venues
```

Needs FFmpeg (libopus) and vgmstream-cli (revision r2168 used). `--only venues cues data combat music speech` rebuilds a part; `--music TUNE` and `--speech SET` export one tune or one speech set on demand.

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

`animtags.json.gz` is `ANIMTAGS.DAT` fully decoded: 2,669 animations keyed by the engine clip name (stored byte-reversed in the file, e.g. `A106`, `N0113AA1`), each with tags `[frame, n, class, …words]`.

## Combat audio (`combat.json`, `match.mjs`)

Retail runs ANIMTAGS every frame: the walker at `0x12c9f0` takes the fighter's playing clip name (actor `+0x74`, the same names `port/motion/library.json` resolves) and frame, resets on a clip change or a frame decrease, and fires each unfired tag whose frame has been reached, in order. The queue consumer `0x12dbb8` jumps through `0x3b2880` by the tag's class word; each handler posts a named event (handles registered at `0x11fb48..0x11ffd4`) with the remaining words clamped into its arguments. None of that is compiled into the native kernel, so `match.mjs` does the same walk host side, per tick, from the actor's live clip (`+0x84/+0x88/+0x8c`) and frame (`+0x9c`).

`combat.json` holds the recovered routing:

- `classes`: 45 tag classes → handler, event name(s), tag count and observed range of each payload word (`Punch_Kick` 10, `Chops` 14, `Face_Hits` 15, `Bone_Crunch` 16, `Body_Contacts` 17, `Hand_Slap` 18, `Falls` 19, `Feet` 22, `Whooshes` 25, `Grunts` 27, `Foley_Fx` 33, `Land` 37, `Special_*` 50-55, `Weapon_*` 46-49, …).
- `banks`: for the 51 banks that carry event names, each module's event, mix variables (as `mix.json` levels) and per-player cue numbers. Banks name their events in a trailer after the sample data (records of tag, hash, NUL-terminated string).
- `fighters`: by `coreID`, the fighter's hit size (`Small/Med/Big`), voice flag and grunt set from the retail table at `0x3761f0`.
- `venueOut`: core venue ids whose Punch_Kick banks are the `_Out` ones (venue record flag).

Routing the adapter applies: `Punch_Kick` → `Fighter_<hit>_Hits_<Ring|Out>`, `Grunts` → `Grunts_<set>`, `Whooshes/Body_Contacts/Face_Hits/Bone_Crunch/Groin_Punch/Land/Foley_Fx/Muscle/Omni_Event` → `WCommon1/2`, `Chops` and `Special_*` → their own banks, and every other event (`Feet`, `Falls`, `Hand_Slap`, `Weapon_*`, `Surface_Hit`, `Environmental_Smash`, `Turnbuckle_Hit`) → the venue's SFX bank. Tag word 1 picks the module's player (`Punch_Kick` 1 punch / 2 kick, `Body_Contacts` 1–5 = collide, grapple, head smack, block, contacts, `Whooshes` 1–4); the player's mix variable gives the gain. Reaction clips (`Q1xx`) open with `Grunts` and `Punch_Kick`, so the impact sound fires from the fighter being hit; attack clips carry the whoosh.

```js
import { venueAudio } from "../audio/venue.mjs";
import { loadMatchAudio } from "../audio/match.mjs";
import library from "../motion/library.json" with { type: "json" };
const audio = venueAudio(arena.file);
const match = await loadMatchAudio(audio, { file: arena.file, fighters: [{ coreID: 5 }, { coreID: 10 }], clips: library, seed });
// after each fight.tick():
match.tick(fight);            // reads actor clip + frame from fight.memory, plays cues through audio.cue()
match.drain();                // events fired since the last call: {tick, slot, clip, frame, class, event, bank, player, cue, gain}
```

`coreID` is `FIGHTER.XML`'s. Cue choice inside a player's retail set is a seeded pick (the selection is compiled into the ABKC banks), so a host and replays with the same seed agree. `match.test.mjs` runs the 460-tick native Blaze/Doc exchange headless and checks both fighters' whooshes, grunts and impacts and that every cue is a real subsong of its retail bank.

## Battle music (`music.json`, `music/`, `mpf.py`, `music.mjs`)

Each of the 33 tunes is an EA PathFinder pair: `tune.mpf` (the node graph, little-endian `PFDx` v4, decoded in `mpf.py`) and `main.mus` (streamed 36 kHz stereo EA-XA) plus `loading0.mus`/`overlay0.mus` (RAM banks, 24 kHz). `mpf.py` documents the layout. A node plays one sample (`sample` indexes the whole table; vgmstream subsong N is sample N-1, with a `.txtm` mapping the three `.mus` files) or is a marker. One sub-entry is "go to node X"; several are ranges of a 0..127 draw, i.e. four interchangeable remix lanes per bar; `(0,0,exit)` + `(1,127,loop)` is a loop router.

**Confirmed from the disc**
- The graph, sample table and `.mus` pairing: every main-track sample's table length equals its decoded length; the shipped tracks re-decode from the retail files at correlation 1.0000 (`verify.py`).
- Structure: a tune starts at node 0 in an intro/waiting loop, leaves it, then plays a song body of 88–134 bar-sized nodes whose bars draw one of four lanes, and the body closes back on its first node (a loop of 120–350 s). `nwa`, `minitrack2`, `asiandragon` and `venu` do not loop; they end after 114–142 s (none is in a captured battle list).
- Levels, from `AUDIO/TV.TXT`: `Music_Vol` 60 % × `Master_Vol` (32767) = gain 0.6; `FE_Music_Vol` 50 %; `Music_Fade_Time` 30; duckers `Crowd_Ducker` 65, `Crowd_Ducker_2` 50, `Ambient_Ducker` 50, `SFX_Ducker` 0. The engine also loads two music filters (`cribfilt1c.fx`, `djlopass1.fx`).
- The match-start routines (`0x110a38`, `0x111520`, called from the stage start at `0x127bec`/`0x127c04`) build a `BACKEND::BATTLESONGS` list from the profile's songs and, when it is empty, log "Setting primary song to default song" and use the tune `dirty`.

**Which tunes a match plays (BACKEND::BATTLESONGS)**
- Confirmed from live RAM captured in two retail VS matches (`private/verification/ps2-match/*/fighter-ram-0.bin`): the list is one 0x10-byte heap block per song name at `0x4e20a0`. Both matches hold the same 16 tunes (`dirty makeithurt nuffrespect flipside hitem getintoit whatshappening beezle mamasaid arewecuttin cnnyessir amermostwant pump popoff letsgo mother`, 17 entries with `dirty` twice), in a different shuffle each time, `dirty` first and `mother` last. `music.json` `battleSongs` records both lists and `extract.py` re-reads them (`verify.py` checks them when the dumps are present). The twelve names stored after the `BACKEND::BATTLESONGS` tag in the executable, which an earlier build guessed as the playlist, are not it and are no longer shipped.
- Retail fallback (confirmed from the code): an empty list logs "Setting primary song to default song" and uses `dirty`.
- Not confirmed: which listed tune plays and when the next starts (the music player is on the IOP, not in the EE RAM dump), and how the list depends on the profile. The captured profile came from a memory card save, song unlocks are not decoded, and the port has no song unlock state, so a fresh profile's list may be shorter. `createMusic` therefore plays `songs` if given (an empty list gives `dirty`), else the captured set: `dirty` first as in both captures, the rest in a seeded shuffle; non-looping tunes would hand over to the next entry.

**Other things not confirmed (also in `music.json`)**
- What retail's 27 music events (action lists after the nodes) send to leave a waiting loop. `fight_path` plays each waiting loop once and leaves it by the first loop router that leads back into the path.
- The lane draws. Retail draws them as it plays; each shipped track is one realization (`seed` 1, node list in `music.json`), and the song body repeats that realization.
- Ducking, fades and the two filters are recorded, not applied.
- `tunes[*].introSeconds/loopSeconds` come from the sample table, whose lengths are wrong for RAM-bank samples (up to ~8 s off for `pump`); the shipped files carry the decoded lengths.

16 tracks ship (the captured set, 40 kb/s Opus, 18 MB; `--only music` rebuilds them, `--music TUNE` builds any other tune). Nothing loads until the first gesture:

```js
import { venueAudio } from "../audio/venue.mjs";
import { createMusic } from "../audio/music.mjs";
const audio = venueAudio(arena.file, { onStart: () => createMusic(audio).start() });   // onStart runs on the first gesture
```

The game page (`port/viewer/viewer.mjs`) does exactly that, next to the combat-audio load. The track goes through the same bus as the ambience and cues, so it is in the host's `MediaStream` and WebRTC guests hear it. `browser-check.mjs` measures the host mix and a loopback guest in headless Chrome (`hitem`, `mother`), and `page-check.mjs` drives the real game page (host, WebRTC guest, a few seconds of fighting): no audio file loads before the gesture, the host's click brings in `music.json` and `music/dirty.ogg` only, the guest's audio level rises from 0.065 (bed) to 0.207 (bed and music), and the combat cue banks load as the fight is fought. `music.test.mjs` also runs the native Blaze/Doc exchange with the music playing and combat cues beside it.

## Stage environment sounds

Stage XML `<sound hit|break>` and `<weaponsound hit|break>` commands reach `createMatchAudio().environment(effects)` through the scenery adapter's `env.effects()` (the viewer already calls it each tick). Retail: `0x192a14` runs the `sound` command and calls `0x1b3e20`, which posts bus event `0xf100000b`; `0x1b3d98` posts `0xf100000a` for `weaponsound`. Their listeners (`0x131898`, `0x131690`) inject a tag into the dispatcher `0x12d310`: `sound` becomes class 64 `Environmental_Smash` (class 67 `Surface_Hit` when the request's second field is -1), `weaponsound hit` class 49 `Weapon_Drop`, `weaponsound break` class 48 `Weapon_Break` (class 47 `Weapon_Strike` for two weapon types, 73 `Falling_Wood` for one). Those are ordinary tag classes, so they play the venue SFX bank's module of that event exactly like animation tags do (`match.test.mjs` checks all 24 venues). Not decoded: the per-weapon variant byte (table at `0x3767a8`) that picks among a venue bank's repeated weapon modules, so the first module stands in, and the scenery effects carry no attacker, so `sound` uses the smash module and falls back to the surface hit.

## Not decoded

- Music: see above (selection, events, lane draws, ducking).
- Speech: `speech.json` indexes the 535 speech sets (`SPEECH1–3.VIV`); lines are SCHl streams (`--speech SET` exports a set). Announcer selection logic beyond the venue record's speech id is not decoded.
- Which sample inside a player plays (random, compiled in the ABKC banks), tag words after the first two, which floor/weapon module a venue bank's repeated `Feet`/`Falls`/`Weapon_*` event uses (the first stands in), crowd banks (their modules carry no event names; the crowd reactions are posted by game code, not tags), and events with no bank (`Rope`, `Rail_Hit`, `Burn_Yell`).
- The ambient banks' mono one-shots (`--shots`) and the random scheduler.

### Battle speech streams

The compiled PS2 sound event handler selects the announcer or fighter line. At stream start (`0x10cfa0`) it passes the resource name, byte offset of an SCHl stream and playback channel to Web Audio. The native player maps that pair to a sample interval in a per-set Opus file. The playback query (`0x10d110`) uses the original sample count and simulation clock. Up to four decoded sets are retained for repeated lines.

`voice/index.json` covers 11,435 line offsets across 447 announcer, character, taunt, environment and heckle sets. Only requested audio sets are fetched. At tick 2222 in the four-player fixture the original dispatcher asks for offset 29696 of ANN_Special_Meter_E1. The browser check confirms that Web Audio starts the corresponding 1.678-second interval and that it contains signal.

```sh
python3 port/audio/extract_voice.py private/ps2/reference.iso --decoder vgmstream-cli
node verification/native-voice-browser.mjs
```
