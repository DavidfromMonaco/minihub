/**
 * Refresh the packaged app under `dist/MiniHub` with the current sources.
 *
 * `dist/MiniHub/MiniHub.exe` is an Electron runtime that loads its OWN copy of
 * the app from `dist/MiniHub/resources/app`. Editing `src/` therefore changes
 * nothing in the built exe until that copy is refreshed - which is exactly the
 * trap this script exists to remove.
 *
 * The current app payload (`src/` + `package.json` + `build/`) and the one
 * authoritative Release native engine are copied together. A generated
 * provenance manifest records exactly what was promoted.
 *
 * The packaged executable is the stock Electron binary (renamed), so it ships
 * with the default Electron icon embedded. To brand it properly this script
 * also:
 *   - copies the app icon assets (`build/`) into `resources/app/build/` so the
 *     renderer/main process can reference them at runtime, and
 *   - stamps the custom `.ico` onto the executable's embedded icon resource via
 *     `rcedit`, so the exe, taskbar and file-explorer icon stop using Electron.
 *
 * Executable refresh strategy
 * ---------------------------
 * To avoid Windows Explorer icon caching, the executable is NEVER patched in
 * place. Every sync starts from a FRESH Electron binary (the pristine
 * `node_modules/electron/dist/electron.exe`), stamps the icon onto that fresh
 * copy at a temporary path, and only then atomically promotes it over the old
 * `MiniHub.exe`. The final user-facing filename stays `MiniHub.exe`.
 *
 *   npm run sync:dist            -> dist/MiniHub
 *   npm run sync:dist -- <path>  -> another build directory
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(repo, process.argv[2] || 'dist/MiniHub');
const app = path.join(target, 'resources', 'app');
const electronDist = path.join(repo, 'node_modules', 'electron', 'dist');
const nativeSource = path.join(repo, 'native', 'audio-engine', 'build', 'Release', 'mlh-audio-engine.exe');
const nativeTarget = path.join(target, 'resources', 'native', 'mlh-audio-engine.exe');
const scannerSource = path.join(repo, 'native', 'audio-engine', 'build', 'Release', 'mlh-vst3-scanner.exe');
const scannerTarget = path.join(target, 'resources', 'native', 'mlh-vst3-scanner.exe');
const lameSource = path.join(repo, 'native', 'third_party', 'lame', 'bin', 'lame.exe');
const lameTarget = path.join(target, 'resources', 'native', 'lame.exe');
const lameLicenseSource = path.join(repo, 'native', 'third_party', 'lame', 'COPYING');
const lameLicenseTarget = path.join(target, 'resources', 'native', 'LAME-COPYING.txt');

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  console.error(`No Electron runtime at ${electronDist}. Run npm install first.`);
  process.exit(1);
}
if (!fs.existsSync(nativeSource)) {
  console.error(`No authoritative Release native engine at ${nativeSource}. Run npm run build:native first.`);
  process.exit(1);
}
if (!fs.existsSync(scannerSource)) {
  console.error(`No dedicated VST3 scanner at ${scannerSource}. Run npm run build:native first.`);
  process.exit(1);
}
if (!fs.existsSync(lameSource)) {
  console.error(`Bundled LAME encoder not found at ${lameSource}.`);
  process.exit(1);
}

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const relativeFiles = (root) => {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory()
      ? relativeFiles(absolute).map((child) => path.join(entry.name, child))
      : [entry.name];
  });
};
const gitOutput = (...args) => {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim(); }
  catch (_) { return 'unavailable'; }
};

// 1. Recreate every Electron support file from the same installation as the
// executable. Refreshing electron.exe alone can pair a new Chromium binary
// with stale DLL/PAK/locales and produce a package that dies before renderer
// startup. resources/app and resources/native remain MiniHub-owned below.
fs.mkdirSync(path.join(target, 'resources'), { recursive: true });
for (const entry of fs.readdirSync(electronDist, { withFileTypes: true })) {
  if (entry.name === 'electron.exe') continue;
  const source = path.join(electronDist, entry.name);
  const destination = path.join(target, entry.name);
  if (entry.name === 'resources') {
    for (const resource of fs.readdirSync(source, { withFileTypes: true })) {
      const resourceSource = path.join(source, resource.name);
      const resourceTarget = path.join(destination, resource.name);
      fs.rmSync(resourceTarget, { recursive: true, force: true });
      fs.cpSync(resourceSource, resourceTarget, { recursive: resource.isDirectory() });
    }
  } else {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: entry.isDirectory() });
  }
}
console.log(`synced coherent Electron runtime ${JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', 'electron', 'package.json'), 'utf8')).version} -> ${target}`);

// 2. Copy the app payload (src + package.json + build resources).
fs.mkdirSync(app, { recursive: true });
fs.rmSync(path.join(app, 'src'), { recursive: true, force: true });
fs.cpSync(path.join(repo, 'src'), path.join(app, 'src'), { recursive: true });
fs.copyFileSync(path.join(repo, 'package.json'), path.join(app, 'package.json'));

// Copy build resources (app icon) so the packaged app can load them at runtime.
const buildDir = path.join(repo, 'build');
if (fs.existsSync(buildDir)) {
  fs.rmSync(path.join(app, 'build'), { recursive: true, force: true });
  fs.cpSync(buildDir, path.join(app, 'build'), { recursive: true });
}

// Keep packaged native execution tied to the same canonical Release build used
// by the regression suite. This was previously left stale across renderer syncs.
fs.mkdirSync(path.dirname(nativeTarget), { recursive: true });
if (fs.existsSync(nativeTarget) && sha256(nativeSource) === sha256(nativeTarget)) {
  // Windows can retain a terminated scan helper as an inaccessible zombie for
  // a while. Its loaded image is safe to keep only when it is already exactly
  // the authoritative Release binary; attempting to overwrite that identical
  // locked file would fail EBUSY and strand an otherwise coherent package.
  console.log(`retained byte-identical native engine -> ${nativeTarget}`);
} else {
  fs.copyFileSync(nativeSource, nativeTarget);
  console.log(`synced native engine -> ${nativeTarget}`);
}
fs.copyFileSync(scannerSource, scannerTarget);
console.log(`synced no-audio VST3 scanner -> ${scannerTarget}`);
fs.copyFileSync(lameSource, lameTarget);
fs.copyFileSync(lameLicenseSource, lameLicenseTarget);
console.log(`synced bundled LAME encoder + LGPL notice -> ${path.dirname(lameTarget)}`);

const provenanceFiles = {
  main: 'src/main/main.js',
  preload: 'src/main/preload.js',
  clipEditorMain: 'src/main/clipEditorWindows.js',
  clipEditorPreload: 'src/main/clipEditorPreload.js',
  rendererEntry: 'src/renderer/index.html',
  rendererApp: 'src/renderer/js/app.js',
  rendererCss: 'src/renderer/styles/base.css',
  sequencerRenderer: 'src/renderer/js/modules/sequencer/sequencerModule.js',
  clipEditorHtml: 'src/renderer/clip-editor.html',
  clipEditorRenderer: 'src/renderer/js/clipEditor.js',
  clipEditorCss: 'src/renderer/styles/clip-editor.css'
};
const fileHashes = Object.fromEntries(Object.entries(provenanceFiles).map(([role, relativePath]) => {
  const packagedPath = path.join(app, ...relativePath.split('/'));
  return [role, { path: relativePath, sha256: fs.existsSync(packagedPath) ? sha256(packagedPath) : 'missing' }];
}));
const manifest = {
  schemaVersion: 1,
  syncedAt: new Date().toISOString(),
  sourceRoot: repo,
  targetRoot: target,
  gitHead: gitOutput('rev-parse', 'HEAD'),
  worktreeDirty: gitOutput('status', '--porcelain') !== '',
  files: fileHashes,
  applicationFiles: Object.fromEntries(
    relativeFiles(app)
      .filter((relativePath) => relativePath !== 'runtime-provenance.json')
      .map((relativePath) => [relativePath.replaceAll('\\', '/'), sha256(path.join(app, relativePath))])
  ),
  nativeEngine: {
    source: nativeSource,
    target: nativeTarget,
    sha256: sha256(nativeTarget)
  },
  vst3Scanner: {
    implementation: 'dedicated no-audio-device helper',
    target: scannerTarget,
    sha256: sha256(scannerTarget)
  },
  mp3Encoder: {
    implementation: 'LAME 3.100.1 via JUCE LAMEEncoderAudioFormat',
    target: lameTarget,
    sha256: sha256(lameTarget),
    license: lameLicenseTarget,
    licenseSha256: sha256(lameLicenseTarget)
  },
  electronRuntime: {
    version: JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
    source: electronDist,
    files: Object.fromEntries(relativeFiles(electronDist)
      .filter((relativePath) => relativePath !== 'electron.exe')
      .map((relativePath) => [relativePath.replaceAll('\\', '/'), sha256(path.join(target, relativePath))]))
  }
};

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((total, entry) => total + (entry.isDirectory() ? count(path.join(dir, entry.name)) : 1), 0);
console.log(`synced ${count(path.join(app, 'src'))} files -> ${app}`);

// 3. Recreate the branded executable from a FRESH Electron binary.
const exeName = `${path.basename(target)}.exe`;   // final name: MiniHub.exe
const exePath = path.join(target, exeName);
const tempPath = path.join(target, `.${exeName}.stamping.tmp`);
const iconPath = path.join(buildDir, 'icon.ico');
const pristineExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');

// Prefer the pristine Electron binary so every build starts from a clean file.
// If it is unavailable (e.g. built on another machine), fall back to copying the
// current exe - still a fresh file, never an in-place patch.
const sourceExe = fs.existsSync(pristineExe) ? pristineExe : (fs.existsSync(exePath) ? exePath : null);

if (!sourceExe) {
  console.warn(`No executable source found (${pristineExe} or ${exePath}); skipping exe refresh.`);
} else if (!fs.existsSync(iconPath)) {
  console.warn(`No icon at ${iconPath}; skipping exe refresh.`);
} else {
  try {
    // 2a. Copy the fresh Electron binary to a temporary path.
    fs.copyFileSync(sourceExe, tempPath);
    console.log(`copied fresh exe (${sourceExe === pristineExe ? 'pristine electron' : 'existing'}) -> ${tempPath}`);

    // 2b. Stamp the MiniHub icon onto the fresh copy.
    const { rcedit } = await import('rcedit');
    await rcedit(tempPath, { icon: iconPath });
    console.log(`stamped ${iconPath} onto ${tempPath}`);

    // 2c. Stamp succeeded - atomically promote the fresh exe over the old one.
    fs.rmSync(exePath, { force: true });
    fs.renameSync(tempPath, exePath);
    console.log(`promoted fresh exe -> ${exePath}`);
  } catch (err) {
    console.error(`Failed to refresh executable ${exePath}:`, err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    // Never leave a temporary executable behind.
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
      console.log(`removed temporary exe ${tempPath}`);
    }
  }
}

if (!fs.existsSync(exePath)) {
  console.error(`No packaged executable was produced at ${exePath}.`);
  process.exit(1);
}
manifest.packagedExecutable = {
  path: exePath,
  sha256: sha256(exePath),
  sourceElectronSha256: sha256(pristineExe)
};
fs.writeFileSync(path.join(app, 'runtime-provenance.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote runtime provenance -> ${path.join(app, 'runtime-provenance.json')}`);
