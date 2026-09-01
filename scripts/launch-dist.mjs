/**
 * Authoritative MiniHub launcher.
 *
 * `npm start` builds the native Release target and synchronizes the packaged
 * payload before reaching this file. The desktop shortcut points at the same
 * executable, so development acceptance and ordinary user launch converge on
 * one runtime tree instead of source Electron versus stale `resources/app`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(repo, 'dist', 'MiniHub', 'MiniHub.exe');

if (!fs.existsSync(executable)) {
  console.error(`MiniHub runtime not found at ${executable}. Run npm run sync:dist first.`);
  process.exit(1);
}

const child = spawn(executable, process.argv.slice(2), {
  cwd: path.dirname(executable),
  stdio: 'inherit',
  windowsHide: false
});

child.on('error', (error) => {
  console.error(`Failed to launch ${executable}: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`MiniHub exited via signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
