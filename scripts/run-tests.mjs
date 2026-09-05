/**
 * Run the JS suite on any Node that ships node:test.
 *
 * `node --test "test/*.test.mjs"` relies on NODE expanding the glob, which only
 * happens from Node 21 on. On Node 20 -- the version the README promises and
 * the workflow pinned -- the pattern reaches the runner verbatim and it stops
 * with "Could not find 'test/*.test.mjs'". The suite therefore passed on this
 * machine (Node 24) and had NEVER passed in CI: every run since the workflow
 * was added is red, for a reason that has nothing to do with the tests.
 *
 * Listing the files here removes the dependency on a Node version rather than
 * declaring one. This is not a test runner: node:test still runs the tests, and
 * every argument given to `npm test` is forwarded to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const files = fs
  .readdirSync(path.join(repo, 'test'))
  .filter((name) => name.endsWith('.test.mjs') || name.endsWith('.test.cjs'))
  .sort()
  .map((name) => path.posix.join('test', name));

if (files.length === 0) {
  console.error('No test files under test/. Expected *.test.mjs or *.test.cjs.');
  process.exit(1);
}

const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
  cwd: repo
});

process.exit(run.status ?? 1);
