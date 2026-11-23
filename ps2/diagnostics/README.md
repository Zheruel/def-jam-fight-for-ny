# Play! disc loading diagnostics

[The browser disc cache](../../runtime/play-build/browser-disc-cache.patch) adds a 4 MiB read cache to the emulation thread. Eight 512 KiB pages are populated through the existing browser disc API. A cached page can serve up to 256 consecutive DVD sectors without another browser main-thread request. The disc size and seek offset stay 64-bit, including reads past 4 GiB. The last page is clipped to the disc length.

Apply the patch to the pinned Play! source used by the browser runtime. The JavaScript disc API is unchanged.

`browser-disk-ready.patch` reduces the asynchronous CDVD `NDiskReady` reply delay from 16.7 ms to 1.04 ms only for `SLUS_210.04` in the browser. The game checks readiness before nearly every disc read, including thousands of single-sector reads during match loading. Both data transfer timing and busy replies are preserved.

| Play! build | Last loading card | First rendered Foundation frame |
| --- | ---: | ---: |
| Baseline | 75.18 s | 79.50 s |
| Native disc cache | 78.14 s | 83.05 s |
| Native disc cache and shorter `NDiskReady` | 28.28 s | 32.80 s |

These are headless Chrome observations with samples about every 4–5 seconds. At roughly 36 seconds into the loading card, the cache reduced browser read requests from 2,416 to 71 while the two builds advanced the same number of GS frames. The shorter readiness reply cut the time to the first recorded 3D frame by 47 seconds in this comparison.

A second run with both patches rendered the venue at 25.64 seconds and showed the fight HUD at 43.78 seconds. The match timer advanced from 00:01 to 00:09, and CPU Doc's score rose to 1,700 as Blaze was knocked down.

## Reproduce the match timing

Install the repository's Playwright dependency and use Chrome headless. On macOS, compile the small OCR helper, then run the benchmark against each build.

```sh
mkdir -p private/ps2-diagnostics
xcrun swiftc ps2/diagnostics/ocr.swift -o private/ps2-diagnostics/ocr
BENCHMARK_SAMPLES=45 node ps2/diagnostics/benchmark.mjs \
  /path/to/play-build-with-Play-js-and-wasm \
  private/ps2-diagnostics/screens
```

The benchmark uses the local `private/ps2/reference.iso` and starts a loopback-only server on an ephemeral port. It drives the retail menus to Battle, One on One, Standard, Blaze versus CPU Doc, then Foundation. It resets its wall clock and I/O counters before confirming the stage. Samples record GS frames, native-to-JavaScript disc requests, bytes and screenshots. Use the last loading screenshot and first frame of the 3D venue to bracket loading time. Set `BENCHMARK_COMBAT=1` to acknowledge tutorials with Cross and attempt Square attacks once the fight HUD appears. A 3D intro frame and an active fight are separate milestones.
