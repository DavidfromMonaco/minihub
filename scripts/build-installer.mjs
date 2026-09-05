/**
 * Build the two distribution artefacts from the packaged tree.
 *
 * MiniHub is distributed two ways, deliberately: an installer for people who
 * want Start-menu entries and an entry in Add or remove programs, and a plain
 * folder for people who want to drop a new version over the old one. Both come
 * from the SAME `dist/MiniHub` produced by `npm run sync:dist`, so there is one
 * build and two wrappers -- never two builds.
 *
 * The installer half needs Inno Setup 6.3+ (ISCC.exe). It is an external tool on
 * purpose: packaging MiniHub through an npm packager would add a second producer
 * for `dist/MiniHub` and a tree of runtime-adjacent dependencies to a project
 * that ships stdlib and Electron only.
 *
 *   npm run build:installer
 *
 * Refuses to run on a stale tree: the provenance manifest written by sync:dist
 * must be present, so a release can never be cut from a payload nobody promoted.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repo, 'dist', 'MiniHub');
const output = path.join(repo, 'dist', 'release');
const script = path.join(repo, 'installer', 'MiniHub.iss');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// --- The tree must be one sync:dist has actually promoted -------------------

if (!fs.existsSync(path.join(source, 'MiniHub.exe'))) {
  fail(`No packaged application at ${source}. Run npm run sync:dist first.`);
}
const provenancePath = path.join(source, 'resources', 'app', 'runtime-provenance.json');
if (!fs.existsSync(provenancePath)) {
  fail(`No provenance manifest at ${provenancePath}. Run npm run sync:dist first.`);
}
const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

console.log(`MiniHub ${version}`);
console.log(`  payload   ${source}`);
console.log(`  promoted  ${provenance.syncedAt ?? 'unknown date'}`);
console.log(`  commit    ${provenance.gitHead ?? 'unknown'}${provenance.worktreeDirty ? ' (worktree dirty)' : ''}`);

fs.mkdirSync(output, { recursive: true });

// --- Installer --------------------------------------------------------------

const iscc = [
  process.env.ISCC,
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles ?? 'C:\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  // Where `winget install JRSoftware.InnoSetup` lands without elevation.
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe')
].find((candidate) => candidate && fs.existsSync(candidate));

if (!iscc) {
  fail(
    'Inno Setup 6 not found. Install it (winget install JRSoftware.InnoSetup)\n' +
    'or point the ISCC environment variable at ISCC.exe.'
  );
}

console.log(`\ncompiling installer with ${iscc}`);
execFileSync(
  iscc,
  [`/DAppVersion=${version}`, `/DSourceDir=${source}`, `/DOutputDir=${output}`, script],
  { stdio: 'inherit', cwd: repo }
);

// --- Portable archive -------------------------------------------------------
//
// bsdtar ships with Windows and compresses 360 MB in a fraction of the time
// Compress-Archive takes; the archive holds a single `MiniHub` folder, which is
// exactly what the portable route asks the user to copy.

const zip = path.join(output, `MiniHub-${version}-portable.zip`);
fs.rmSync(zip, { force: true });
console.log(`
compressing portable archive -> ${zip}`);

// A zip starts with PK. Checked because the fast path fails SILENTLY:
// bsdtar's `-a` selects a compression filter, not a container, so without
// `--format zip` it writes a tar under a .zip name and exits 0 -- an archive
// Windows refuses to open, produced by a build that reported success.
const isZip = () => {
  if (!fs.existsSync(zip)) return false;
  const head = Buffer.alloc(4);
  const handle = fs.openSync(zip, 'r');
  try {
    fs.readSync(handle, head, 0, 4, 0);
  } finally {
    fs.closeSync(handle);
  }
  return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
};

// Compress-Archive, not the bsdtar that ships with Windows: that build reads
// the zip container as an "Invalid archive format" and can only be coaxed into
// writing a TAR under a .zip name -- silently, exiting 0. Slower and correct
// beats fast and unopenable.
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${source}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`],
  { stdio: 'inherit' }
);

if (!isZip()) fail(`${zip} is not a zip archive. Refusing to publish it.`);

// --- Checksums --------------------------------------------------------------
//
// Published beside the downloads: an unsigned executable off a web page is
// something a user should be able to check, and there is no certificate here to
// check it for them.

const artefacts = fs
  .readdirSync(output)
  .filter((name) => name.endsWith('.exe') || name.endsWith('.zip'))
  .sort();

const lines = artefacts.map((name) => {
  const bytes = fs.readFileSync(path.join(output, name));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  console.log(`  ${(bytes.length / 1024 / 1024).toFixed(1).padStart(6)} MB  ${name}`);
  return `${digest}  ${name}`;
});

fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(`\nwrote ${path.join(output, 'SHA256SUMS.txt')}`);
