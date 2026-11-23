// Scripted headless run: follows a route of pad presses and prints the live unlock sets.
//
//   node ps2/content/e2e/explore.mjs --unlocks 1 --out private/ps2-content/e2e/x \
//     "wait:1800 shot:boot start wait:600 profile"
//
// Steps: wait:<frames>, shot:<name>, profile, ram:<hexaddr>:<words>,
// <button>[+<button>][*<n>] (press n times), hold:<button>:<frames>.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { launch, REPO } from './harness.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  unlocks: { type: 'string', default: '1' },
  iso: { type: 'string', default: path.join(REPO, 'private/ps2/reference.iso') },
  out: { type: 'string', default: path.join(REPO, 'private/ps2-content/e2e/explore') }
} });

const hex = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const run = await launch({ iso: values.iso, unlocks: values.unlocks === '1', outDir: values.out });
try {
  for (const step of positionals.join(' ').split(/\s+/).filter(Boolean)) {
    const [kind, arg, extra] = step.split(':');
    if (kind === 'wait') await run.waitFrames(Number(arg));
    else if (kind === 'shot') await run.shot(arg);
    else if (kind === 'hold') await run.press(arg, { hold: Number(extra), after: 30 });
    else if (kind === 'ram') console.log('ram', arg, (await run.read32(Number(arg), Number(extra ?? 1))).map(v => v.map(hex)));
    else if (kind === 'profile') {
      for (const view of await run.profile()) {
        if (!view.valid) { console.log('profile view', view.view, 'not live', JSON.stringify(view)); continue; }
        console.log('profile view', view.view, 'obj', hex(view.obj), 'body', hex(view.body), 'points', view.points);
        for (const kind of ['fighters', 'venues']) {
          const set = view[kind];
          const cov = run.coverage(set, kind);
          console.log(`  ${kind}: capacity ${set.capacity} count ${set.count} mirror ${set.mirror} ` +
            `coverage ${cov.present}/${cov.total}` + (cov.missing.length ? ` missing ${cov.missing.join(', ')}` : ''));
          if (set.entries) console.log('   ', set.entries.map(hex).join(' '));
        }
      }
    } else {
      const [combo, times = '1'] = kind.split('*');
      for (let i = 0; i < Number(times); i++) await run.press(combo.split('+'));
    }
  }
  console.log('state', JSON.stringify(await run.state()));
} finally {
  await run.close();
}
