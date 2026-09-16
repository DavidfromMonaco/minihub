'use strict';

/**
 * MiniHub runs with the person's AppData, whoever opens it. DECISIONS D-045.
 *
 * A packaged application -- Codex Desktop, the Claude app -- files every NEW
 * folder that a program it launched creates at the top of AppData inside its
 * own storage (`%LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\...`), and
 * shows that program its private copy over the real one. A plugin that keeps
 * its login there is logged out for the person, and the other way round:
 * Splice asked the author to log in again for exactly that reason. Package
 * identity does not reveal it -- the Claude app starts its tools without one,
 * and they are redirected all the same -- so the question is put to the file
 * system: create a folder where a plugin would, and ask Windows where it is.
 *
 * When it is somewhere else, MiniHub hands its own launch to the Windows shell,
 * as a double-click would, and leaves before opening anything. The shell passes
 * neither the environment nor the command line, so the relaunched MiniHub
 * finds what it must keep in a note in the temp folder, which Windows does not
 * redirect: the agent channel switch and the command-line switches.
 *
 * No Electron here, so the tests can drive every branch.
 */

const PROBE_PREFIX = 'minihub-launch-check-';
const HANDOFF_NAME = 'minihub-relaunch.json';
// The shell's hand-off and a fresh start take a few seconds. A note older
// than this belongs to a relaunch that never arrived.
const HANDOFF_FRESH_MS = 20000;
const SPAWN_WAIT_MS = 5000;
const MAX_SWITCHES = 32;
const SWITCH_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The package whose storage a resolved path lies in, or ''. */
function packageStorageOf(resolvedPath) {
  const match = /[\\/]Packages[\\/]([^\\/]+)[\\/]LocalCache[\\/]/i.exec(String(resolvedPath || ''));
  return match ? match[1] : '';
}

/**
 * Where a folder created at the top of `appData` really lands: `redirectedTo`
 * names the package holding it, and is '' when it lands where it was asked.
 * The probe never outlives the call.
 */
function probeAppData({ fs, path, appData, tag }) {
  const probe = path.join(appData, `${PROBE_PREFIX}${tag}`);
  try {
    fs.mkdirSync(probe);
  } catch (error) {
    return { redirectedTo: '', error: String(error?.message || error) };
  }
  try {
    const resolved = fs.realpathSync.native(probe);
    const moved = path.resolve(resolved).toLowerCase() !== path.resolve(probe).toLowerCase();
    return { redirectedTo: moved ? packageStorageOf(resolved) : '' };
  } catch (error) {
    return { redirectedTo: '', error: String(error?.message || error) };
  } finally {
    try { fs.rmdirSync(probe); } catch (_) { /* the probe was never made twice */ }
  }
}

/** `--name` and `--name=value` from a command line, as [name, value] pairs. */
function switchesOf(argv) {
  const switches = [];
  for (const arg of Array.isArray(argv) ? argv : []) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(String(arg));
    if (match && SWITCH_NAME.test(match[1])) switches.push([match[1], match[2] ?? '']);
  }
  return switches.slice(0, MAX_SWITCHES);
}

function handoffPath(path, tempDir) {
  return path.join(tempDir, HANDOFF_NAME);
}

/**
 * The note a relaunching MiniHub left, when it is fresh and was written for
 * this executable -- another copy of MiniHub on the machine is not its reader.
 * Read once: the file is removed whatever it held, so no later launch inherits
 * it.
 */
function takeHandoff({ fs, path, tempDir, now, execPath }) {
  const file = handoffPath(path, tempDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  try { fs.rmSync(file, { force: true }); } catch (_) { /* read once all the same */ }
  let note;
  try {
    note = JSON.parse(text);
  } catch (_) {
    return null;
  }
  const age = now - Number(note?.at);
  if (!(age >= 0 && age <= HANDOFF_FRESH_MS)) return null;
  if (String(note.exe || '').toLowerCase() !== String(execPath || '').toLowerCase()) return null;
  const switches = (Array.isArray(note.switches) ? note.switches : [])
    .filter((entry) => Array.isArray(entry)
      && typeof entry[0] === 'string' && SWITCH_NAME.test(entry[0])
      && typeof entry[1] === 'string' && entry[1].length <= 1024)
    .slice(0, MAX_SWITCHES)
    .map(([name, value]) => [name, value]);
  return {
    from: String(note.from || '').slice(0, 256),
    agentChannel: note.agentChannel === true,
    switches
  };
}

/**
 * Put back what the shell did not pass on. Before `app.whenReady()`: Chromium
 * reads its switches once.
 */
function applyHandoff({ note, app, env }) {
  if (!note) return;
  if (note.agentChannel) env.MINIHUB_AGENT_CHANNEL = '1';
  for (const [name, value] of note.switches) {
    if (value) app.commandLine.appendSwitch(name, value);
    else app.commandLine.appendSwitch(name);
  }
}

/**
 * Decide where this MiniHub runs. Resolves `{ leave: true }` once the shell has
 * taken the launch over -- this process must then exit without opening
 * anything -- and `{ leave: false, redirectedTo }` to start here, with
 * `redirectedTo` naming the package still holding AppData, if any.
 *
 * `relaunched` is the note this process arrived with: a MiniHub the shell
 * started a moment ago and still redirected does not ask again, or it would
 * never stop. An unpackaged run (`electron .`) is not relaunched either: the
 * shell would start Electron's default app, not MiniHub.
 */
function settleLaunchPlace({
  app, fs, path, spawn, env, argv, execPath, packaged, tag, now, relaunched, log, spawnWaitMs = SPAWN_WAIT_MS
}) {
  const check = probeAppData({ fs, path, appData: app.getPath('appData'), tag });
  if (check.error) log(`launch:appdata-check failed error=${check.error.slice(0, 256)}`);
  const redirectedTo = check.redirectedTo;
  if (!redirectedTo) {
    if (!check.error) log(`launch:appdata-check redirected=false${relaunched ? ` relaunched-from=${relaunched.from}` : ''}`);
    return Promise.resolve({ leave: false, redirectedTo: '' });
  }
  if (relaunched || !packaged) {
    log(`launch:still-inside-package name=${redirectedTo} ${relaunched ? `relaunched-from=${relaunched.from}` : 'unpackaged'}`);
    return Promise.resolve({ leave: false, redirectedTo });
  }
  const tempDir = app.getPath('temp');
  const note = handoffPath(path, tempDir);
  const stay = (reason) => {
    try { fs.rmSync(note, { force: true }); } catch (_) { /* nothing to take back */ }
    log(`launch:relaunch-failed name=${redirectedTo} error=${String(reason).slice(0, 256)}`);
    return { leave: false, redirectedTo };
  };
  try {
    fs.writeFileSync(note, JSON.stringify({
      from: redirectedTo,
      at: now,
      exe: execPath,
      agentChannel: env.MINIHUB_AGENT_CHANNEL === '1',
      switches: switchesOf(argv)
    }), 'utf8');
  } catch (error) {
    return Promise.resolve(stay(error?.message || error));
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const settle = (decide) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(decide());
    };
    let child;
    try {
      // `explorer.exe <program>` asks the shell the person is already running to
      // start the program: it is then theirs, outside any package. D-041.
      child = spawn('explorer.exe', [execPath], { detached: true, stdio: 'ignore' });
    } catch (error) {
      settle(() => stay(error?.message || error));
      return;
    }
    // Node reports one of the two at once. The timer only keeps a startup that
    // hears neither from waiting forever; it then starts here.
    timer = setTimeout(() => settle(() => stay('explorer.exe did not start')), spawnWaitMs);
    child.once('error', (error) => settle(() => stay(error?.message || error)));
    child.once('spawn', () => settle(() => {
      child.unref();
      log(`launch:relaunching-outside name=${redirectedTo}`);
      return { leave: true, redirectedTo };
    }));
  });
}

module.exports = {
  HANDOFF_FRESH_MS,
  packageStorageOf,
  probeAppData,
  switchesOf,
  takeHandoff,
  applyHandoff,
  settleLaunchPlace
};
