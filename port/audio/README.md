# Foundation ambience

VENUE.XML selects the bsmt ambience bank for The Foundation. The browser streams the stereo downmix of its first four-channel ambience program. Both sections in the PS2 program contain identical encoded audio, so a single 97.97-second file covers the intro and loop. The host sends its mix to the guest over WebRTC. Music selection, crowd events and impact cues require separate event routing.

Rebuild from the repository root with FFmpeg and vgmstream-cli in PATH. The export used vgmstream revision 5d5574405d61876cb995c17d86ccb8fd0be3565e. [Decoder source](https://github.com/vgmstream/vgmstream/tree/5d5574405d61876cb995c17d86ccb8fd0be3565e)

```sh
python3 port/audio/extract.py private/ps2/reference.iso
```
