// Scripted exploration run: boots the disc headless and follows a route of key presses,
// taking a screenshot after each step.
//
//   node ps2/battle/e2e/explore.mjs --patch overlay --out private/ps2-battle/e2e/x \
//     "wait:1800 shot:boot Enter wait:600 shot:after-start"
//
// Steps: wait:<frames>, shot:<name>, <button>[+<button>][*<n>] (press n times),
// hold:<button>:<frames>. Buttons: cross circle square triangle start select up down left right ...

import path from 'node:path';
import { parseArgs } from 'node:util';
import { launch, REPO } from './harness.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  patch: { type: 'string', default: 'overlay' },
  iso: { type: 'string', default: path.join(REPO, 'private/ps2/reference.iso') },
  out: { type: 'string', default: path.join(REPO, 'private/ps2-battle/e2e/explore') },
  manifest: { type: 'string' }  // default: ps2/battle/battle-patch.json
} });

const run = await launch({ iso: values.iso, patch: values.patch, outDir: values.out,
  ...(values.manifest && { manifest: path.resolve(values.manifest) }) });
try {
  for (const step of positionals.join(' ').split(/\s+/).filter(Boolean)) {
    const [kind, arg, extra] = step.split(':');
    if (kind === 'wait') await run.waitFrames(Number(arg));
    else if (kind === 'shot') await run.shot(arg);
    else if (kind === 'hold') await run.press(arg, { hold: Number(extra), after: 30 });
    else {
      const [combo, times = '1'] = kind.split('*');
      for (let i = 0; i < Number(times); i++) await run.press(combo.split('+'));
    }
  }
  console.log('state', JSON.stringify(await run.state()));
} finally {
  await run.close();
}
