import { withBattlePatch } from '../ps2/battle/overlay.mjs';
import { openGameAssets } from './game-assets.mjs';

const runtimeUrl = new URL('../runtime/play-build/Play.js', import.meta.url);

export function makeRuntime({ canvas, onStatus }) {
  let vm;
  let booted = false;
  let totalFrames = 0;
  let windowFrames = 0;
  let timer;
  let readCount = 0;
  let readBytes = 0;
  let failure = '';
  const pads = [null, null];
  async function start(source) {
    const paths = ['../ps2/battle/battle-patch.json', '../ps2/content/unlock-disc-patch.json'];
    const [battle, unlock] = await Promise.all(paths.map(async path => {
      const response = await fetch(new URL(path, import.meta.url));
      if (!response.ok) throw new Error('The PS2 Battle patch is missing. Check the project installation.');
      return response.json();
    }));
    source = await withBattlePatch(source, { ...battle, patches: [...battle.patches, ...unlock.patches] });
    if (!crossOriginIsolated) throw new Error('The game requires an isolated browser context. Reload this page.');
    if (vm) throw new Error('Reload the page to restart the emulator.');
    onStatus('Initializing the PS2');
    const { default: Play } = await import(runtimeUrl.href);
    const module = await Play({
      canvas,
      mainScriptUrlOrBlob: runtimeUrl.href,
      locateFile: name => new URL(name, runtimeUrl).href,
      onAbort: message => { failure = String(message); onStatus('Emulation stopped: ' + failure); }
    });
    vm = module;
    module.FS.mkdir('/work');
    let done = true;
    module.discImageDevice = {
      getFileSize: () => source.size,
      isDone: () => done,
      read(dst, offset, size) {
        readCount++;
        readBytes += size;
        done = false;
        source.read(offset, size).then(data => {
          if (data.length !== size) throw new Error('Unexpected end of disc.');
          module.HEAPU8.set(data, dst);
        }).catch(error => {
          failure = error.message;
          onStatus('Game data could not be read. Reload to retry. ' + failure);
        }).finally(() => { done = !failure; });
      }
    };
    module.ccall('initVm', '', [], []);
    module.bootDiscImage('reference.iso');
    const deadline = performance.now() + 45_000;
    while (!module._getVblanks()) {
      if (failure || performance.now() > deadline) throw new Error(failure || 'PS2 boot timed out. Reload to retry.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    booted = true;
    timer = setInterval(() => {
      windowFrames = module.getFrames();
      module.clearStats();
      totalFrames += windowFrames;
    }, 1000);
    return { gameId: 'SLUS-21004' };
  }
  const audio = () => vm?.getPlayAudioStream?.() ?? null;
  return {
    boot: async () => start(await openGameAssets()),
    prepareAudio: async () => vm?.resumePlayAudio?.(),
    getAudioStream: audio,
    setBackgroundPaused: paused => vm?._setBrowserPaused?.(paused),
    async setMuted(muted) {
      await vm?.resumePlayAudio?.();
      vm?.setPlayAudioMuted?.(muted);
    },
    setPad(port, { buttons, axes }) {
      if (!vm || (port !== 1 && port !== 2)) return;
      const last = pads[port - 1];
      if (last?.buttons === buttons && axes.every((v, i) => v === last.axes[i])) return;
      vm._setPad(port - 1, buttons, ...axes);
      pads[port - 1] = { buttons, axes: [...axes] };
    },
    diagnostics: () => ({ discId: booted ? 'SLUS-21004' : null, coreFrame: totalFrames,
      vblanks: vm?._getVblanks?.() ?? null, readCount, readBytes,
      framesLastSecond: windowFrames, secondController: !!vm?._setPad, error: failure }),
    getInputReadback: port => vm?._getPadReadback?.(port - 1) ?? null,
    getSecondInputReadback: () => vm?._getPadReadback?.(1) ?? null,
    close: () => clearInterval(timer)
  };
}
