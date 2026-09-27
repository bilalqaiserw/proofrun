import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bobEnvironment } from '../src/qa/bob.ts';
const entry = fileURLToPath(new URL('../.tools/bob/node_modules/bobshell/dist/bob.js', import.meta.url));
if (!existsSync(entry)) {
  console.error('Install IBM Bob Shell first with npm run setup:bob. See SETUP.md.');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit', shell: false, windowsHide: true, env: bobEnvironment(),
  });
  if (result.error) console.error('Bob Shell could not start: ' + result.error.message);
  process.exitCode = result.status ?? 1;
}
