#!/usr/bin/env node
/**
 * Mechanical enforcement of the architectural invariants.
 *
 * ARCHITECTURE.md section 13 states twelve invariants. An invariant that lives
 * only in prose is one an agent breaks in good faith, with nothing in the
 * toolchain to contradict it. This script turns the statically checkable ones
 * into failures. See DECISIONS.md D-011.
 *
 * Rules here must be EXACT. A rule that produces false positives teaches
 * everyone to ignore the whole check, which is worse than not having it. When a
 * rule cannot be made exact, it does not belong here -- it belongs in a test or
 * in review. That is why invariant 9 (escape before innerHTML) is absent: every
 * heuristic for it flags roughly twenty legitimate log lines and window titles.
 *
 * Node stdlib only, no dependencies -- see DECISIONS.md D-003.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The one import that is not stdlib, and it is deliberate: the profile rules
// below run the application's own validator rather than a second opinion about
// what a profile may contain. controllerProfile.js imports nothing itself.
import { validateControllerProfile } from '../src/renderer/js/midi/controllerProfile.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checked = [];

const rel = (absolute) => path.relative(repo, absolute).split(path.sep).join('/');
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');

function walk(relativeRoot, extensions) {
  const out = [];
  const root = path.join(repo, relativeRoot);
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!extensions.includes(path.extname(entry.name))) continue;
    out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

/**
 * Lines that are wholly a comment, so a rule can skip them.
 *
 * Deliberately conservative: only a line whose first non-space characters open
 * or continue a comment is skipped. Trailing comments on code lines are still
 * scanned -- a shared identity literal in one of those is a defect anyway.
 */
const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);

function fail(rule, message) {
  failures.push({ rule, message });
}

const PROFILE_DIR = 'src/renderer/js/midi/profiles';
const profileFiles = () => walk(PROFILE_DIR, ['.json']).map(rel);

function rule(name, fn) {
  checked.push(name);
  fn();
}

// --- Invariant 7: a system node id comes from systemNodes.js ---------------
//
// 'minilab-3' is the one system id that is never also a node TYPE, so it can be
// matched exactly. 'audio-output', 'sequencer' and 'audio-input' are both ids
// and type names; lists of node types legitimately spell them out (see the
// header comment of core/systemNodes.js), so they cannot be checked this way.
rule('system node ids', () => {
  const owner = 'src/renderer/js/core/systemNodes.js';
  for (const file of walk('src', ['.js', '.mjs', '.cjs', '.html'])) {
    if (rel(file) === owner) continue;
    read(rel(file)).split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (!/['"`]minilab-3['"`]/.test(line)) return;
      fail(
        'system node ids',
        `${rel(file)}:${index + 1} hard-codes 'minilab-3'. Import CONTROLLER_NODE_IDS from core/systemNodes.js.`
      );
    });
  }
});

// --- Invariant 6: a project key is declared once, in projectKeys.js --------
//
// A project key that also sits in the main-process DEFAULTS fails in two
// opposite directions at once: a stale value survives into a new project, and
// project state is written into the machine-wide preferences file.
rule('project keys', () => {
  const source = read('src/renderer/js/core/projectKeys.js');
  const block = source.match(/export const PROJECT_KEYS = \[([\s\S]*?)\]/);
  if (!block) {
    fail('project keys', 'core/projectKeys.js no longer exports a literal PROJECT_KEYS array.');
    return;
  }
  const keys = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // MASTER_OUTPUT_KEY is imported rather than spelled out; resolve its value.
  const masterKey = read('src/renderer/js/core/masterOutput.js')
    .match(/export const MASTER_OUTPUT_KEY = '([^']+)'/);
  if (masterKey) keys.push(masterKey[1]);
  if (keys.length === 0) {
    fail('project keys', 'PROJECT_KEYS parsed as empty -- the check would silently pass.');
    return;
  }

  const defaults = read('src/main/settings.js').match(/const DEFAULTS = \{([\s\S]*?)\n\};/);
  if (!defaults) {
    fail('project keys', 'src/main/settings.js no longer declares a literal DEFAULTS object.');
    return;
  }
  for (const key of keys) {
    if (new RegExp(`(^|[\\s{,])${key}\\s*:`, 'm').test(defaults[1])) {
      fail(
        'project keys',
        `src/main/settings.js DEFAULTS contains '${key}', which is project state owned by core/projectKeys.js.`
      );
    }
  }
});

// --- Invariant 10: no inline style, the CSP rejects them -------------------
//
// Only the style ATTRIBUTE is checked. Assigning element.style.x from
// JavaScript goes through the CSSOM and is not blocked by style-src.
rule('no inline style', () => {
  for (const file of walk('src', ['.js', '.mjs', '.cjs', '.html'])) {
    read(rel(file)).split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (!/\sstyle\s*=\s*["'`]/.test(line)) return;
      fail(
        'no inline style',
        `${rel(file)}:${index + 1} emits a style attribute. The CSP drops it silently -- use a class.`
      );
    });
  }
});

// --- The CSP itself must stay restrictive ---------------------------------
rule('content security policy', () => {
  for (const page of ['src/renderer/index.html', 'src/renderer/clip-editor.html']) {
    const html = read(page);
    const meta = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/);
    if (!meta) {
      fail('content security policy', `${page} has no Content-Security-Policy meta tag.`);
      continue;
    }
    for (const hole of ['unsafe-inline', 'unsafe-eval']) {
      if (meta[1].includes(hole)) {
        fail('content security policy', `${page} weakens its CSP with '${hole}'.`);
      }
    }
  }
});

// --- A faceplate class only where its stylesheet is loaded ----------------
//
// The Clip Editor is a separate BrowserWindow with its own document, and
// clip-editor.html loads base.css alone. An `op-` class rendered there gets no
// style at all: no error, no warning, just an element that comes out wrong.
//
// The rule reads the document rather than assuming, so it disarms itself the
// day clip-editor.html starts loading the faceplate.
rule('faceplate scope', () => {
  const page = 'src/renderer/clip-editor.html';
  const html = read(page);
  if (/href="[^"]*omni-pearl\.css"/.test(html)) return; // faceplate available there now

  const classAttr = /class\s*=\s*["'`]([^"'`]*)["'`]/g;
  const classList = /classList\.(?:add|remove|toggle|contains)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const file of ['src/renderer/js/clipEditor.js', page]) {
    const source = read(file);
    for (const pattern of [classAttr, classList]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        if (!/\bop-[a-z]/.test(match[1]) && !/\bomni-pearl\b/.test(match[1])) continue;
        const line = source.slice(0, match.index).split('\n').length;
        fail(
          'faceplate scope',
          `${file}:${line} uses the Omni Pearl vocabulary, but ${page} does not load omni-pearl.css. It would render unstyled.`
        );
      }
    }
  }
});

// --- One shell, at most one faceplate -------------------------------------
//
// A second faceplate means a second full token set and a second component
// library, and the "never mix two vocabularies in one subtree" rule becomes
// that much harder to hold. See DECISIONS.md D-012.
rule('one faceplate', () => {
  const sheets = fs.readdirSync(path.join(repo, 'src/renderer/styles'))
    .filter((name) => name.endsWith('.css'));
  const known = new Set(['base.css', 'omni-pearl.css', 'clip-editor.css']);
  const extra = sheets.filter((name) => !known.has(name));
  if (extra.length > 0) {
    fail(
      'one faceplate',
      `new stylesheet(s) ${extra.join(', ')} -- MiniHub allows one shell (base.css) and one faceplate (omni-pearl.css). Extend the faceplate or replace it; do not add a third vocabulary without updating DECISIONS.md D-012.`
    );
  }
});

// --- Module boundary: renderer is ESM, main process is CommonJS -----------
//
// This split is what lets the tests import renderer modules with no build step
// (DECISIONS.md D-003). Mixing the two breaks the test suite before it breaks
// the application, but the message is then unhelpful, so name it here.
rule('module boundary', () => {
  for (const file of walk('src/renderer', ['.js', '.mjs'])) {
    read(rel(file)).split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (/\brequire\s*\(|\bmodule\.exports\b|\bexports\./.test(line)) {
        fail('module boundary', `${rel(file)}:${index + 1} uses CommonJS. The renderer is ES modules.`);
      }
    });
  }
  for (const file of walk('src/main', ['.js', '.cjs'])) {
    read(rel(file)).split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (/^\s*(import\s.+\sfrom\s|export\s(const|function|class|default)\s)/.test(line)) {
        fail('module boundary', `${rel(file)}:${index + 1} uses ES modules. The main process is CommonJS.`);
      }
    });
  }
});

// --- Renderer isolation: contextIsolation true, nodeIntegration false ------
//
// The renderer reaches the disk only through window.hubAPI. A Node global in a
// renderer file means either the isolation was loosened or the file drifted
// into the wrong process.
rule('renderer isolation', () => {
  for (const file of walk('src/renderer', ['.js', '.mjs'])) {
    read(rel(file)).split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return;
      const hit = line.match(/\b(?:__dirname|__filename)\b|\bprocess\.[a-zA-Z_$][\w$]*/);
      if (!hit) return;
      fail(
        'renderer isolation',
        `${rel(file)}:${index + 1} touches the Node global '${hit[0]}'. Go through window.hubAPI.`
      );
    });
  }
});

// --- D-020: a profile is data, and the validator is what decides -----------
//
// Specification section 9. A profile file is the one thing in MiniHub that may
// arrive from a stranger, and D-020's boundary is "extensible by data, never by
// code". The rule does not re-implement that sentence with a heuristic: it runs
// the same validator the application runs, over every profile in the folder, so
// a rule and a runtime can never disagree about what a profile is allowed to be.
rule('profile is data', () => {
  const files = profileFiles();
  if (files.length === 0) {
    fail('profile is data', `${PROFILE_DIR} holds no profile -- the rule would pass by checking nothing.`);
    return;
  }
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(read(file));
    } catch (error) {
      fail('profile is data', `${file} is not valid JSON: ${error.message}`);
      continue;
    }
    for (const error of validateControllerProfile(parsed).errors) {
      fail('profile is data', `${file} ${error.path}: ${error.message}`);
    }
  }
});

// --- Specification 3.2: a published control id is permanent ----------------
//
// A control id becomes a Patch Bay port id and a binding key, and both are
// written inside saved projects. Removing or renaming one cuts the cables of
// every project that used it -- in silence, because the network simply stops
// matching. So the ids that have shipped are recorded, and a profile is refused
// if it has lost one.
//
// The register is a RECORD, not a copy, and that distinction is the whole point:
// generating it from the profiles it guards would make it agree with them
// always, including the moment one of them is wrong. Adding a control therefore
// costs one deliberate line, which is the price of an id that can never quietly
// leave.
rule('immutable control ids', () => {
  const registerPath = 'test/conformance/published-control-ids.json';
  if (!fs.existsSync(path.join(repo, registerPath))) {
    fail('immutable control ids', `${registerPath} is missing -- nothing records what has shipped.`);
    return;
  }
  const register = JSON.parse(read(registerPath)).profiles ?? {};

  for (const file of profileFiles()) {
    let profile;
    try {
      profile = JSON.parse(read(file));
    } catch {
      continue; // 'profile is data' already reported this file
    }
    const declared = new Set((profile.controls ?? []).map((control) => control?.id));
    const published = register[profile.profileId];
    if (!Array.isArray(published)) {
      fail(
        'immutable control ids',
        `${file} declares the profile '${profile.profileId}', which ${registerPath} does not record. `
        + 'Add it with its control ids: an id becomes permanent the moment it ships.'
      );
      continue;
    }
    for (const id of published) {
      if (!declared.has(id)) {
        fail(
          'immutable control ids',
          `${file} no longer declares the control '${id}', which has already shipped. `
          + 'A revision may add, never remove: every project that cabled it would lose that cable in silence.'
        );
      }
    }
    for (const id of declared) {
      if (!published.includes(id)) {
        fail(
          'immutable control ids',
          `${file} declares the control '${id}', which ${registerPath} does not list. `
          + 'Record it there, so it can never quietly leave later.'
        );
      }
    }
  }
});

// --- Specification 9: no hardware literal in data --------------------------
//
// The 'system node ids' rule above covers code, where the answer is to import
// MINILAB_NODE_ID. This one covers DATA, where there is nothing to import: the
// only file that may name a device is the profile describing it. Any other JSON
// under src/ spelling that name is a copy of an identity -- typically a second
// profile claiming a profileId that is already taken, which would collide on the
// node id, the port ids and every binding key at once.
rule('no hardware literal', () => {
  const owner = `${PROFILE_DIR}/minilab-3.json`;
  for (const file of walk('src', ['.json'])) {
    if (rel(file) === owner) continue;
    read(rel(file)).split('\n').forEach((line, index) => {
      if (!/['"`]minilab-3['"`]/.test(line)) return;
      fail(
        'no hardware literal',
        `${rel(file)}:${index + 1} names 'minilab-3'. Only ${owner} describes that device.`
      );
    });
  }
});

// --- Specification 3.5: the shared decoder stays copyable -------------------
//
// MiniHub and the site Builder have to answer "what control is this message"
// identically, and the only thing keeping them identical is that one set of
// files is copied byte for byte from here into there, with a conformance corpus
// both sides run. That copy stops being possible the moment one of those files
// imports something outside the set -- and it stops being possible silently: the
// import is legitimate here, the corpus still passes here, and the breakage
// surfaces on the other side of a repository boundary as a profile that decodes
// differently. So the set is named, and its imports are checked.
rule('shared decoder', () => {
  const dir = 'src/renderer/js/midi';
  const set = ['parseMidi.js', 'controllerProfile.js', 'portRoles.js', 'decodeControl.js'];
  const allowed = new Set(set.map((name) => `./${name}`));
  for (const name of set) {
    const file = `${dir}/${name}`;
    if (!fs.existsSync(path.join(repo, file))) {
      fail('shared decoder', `${file} is gone. The set is named in ARCHITECTURE.md; name it there too.`);
      continue;
    }
    for (const [, specifier] of read(file).matchAll(/^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
      if (allowed.has(specifier)) continue;
      fail(
        'shared decoder',
        `${file} imports '${specifier}', which is outside the shared set (${set.join(', ')}). `
        + 'Specification section 3.5: these files travel as one artefact into the Builder.'
      );
    }
  }
});

// --- D-022: exactly one profile ships, and it is the fallback --------------
//
// The plural is refused until a second keyboard exists on a desk: N controller
// nodes, a multi-input MidiManager and a settings migration are a workstream,
// not a file drop. A second profile appearing under src/ would not break
// loudly -- `loadedProfile.js` names its file, so the newcomer is simply dead
// data that looks like support for a device MiniHub cannot actually select.
//
// This rule used to call that static import "the decision". It is not, since a
// profile can now be chosen from a file and handed over by `preload.js`; the
// import is what the application falls back to when there is no choice, or when
// the choice cannot be honoured. So the rule checks the two things that are
// still mechanical, and one that has become load-bearing:
//
//   - exactly one profile ships, and the loader names THAT one as its fallback.
//     A test fixture belongs in test/, where `test/deviceAgnostic.test.mjs`
//     reads it;
//   - the loader validates. Once a foreign file can reach the decoder, this call
//     is the only thing between a hand-edited JSON and the routing node's id --
//     and its absence would not fail any test, because the profile that ships is
//     valid and every test runs on it.
rule('one profile ships', () => {
  const loader = 'src/renderer/js/midi/loadedProfile.js';
  const source = read(loader);
  const specifier = /import\s+profile\s+from\s*['"]([^'"]+)['"]/.exec(source)?.[1];
  if (!specifier) {
    fail(
      'one profile ships',
      `${loader} no longer imports a profile by name. That import is what MiniHub falls back to `
      + 'when no profile is chosen; without it there is no controller at all.'
    );
    return;
  }
  const loaded = `src/renderer/js/midi/${specifier.replace(/^\.\//, '')}`;
  const shipped = profileFiles();
  if (shipped.length !== 1) {
    fail(
      'one profile ships',
      `${PROFILE_DIR} holds ${shipped.length} profiles (${shipped.join(', ')}). `
      + 'DECISIONS.md D-022: one controller until a second keyboard exists. A fixture goes in test/.'
    );
  }
  if (!shipped.includes(loaded)) {
    fail('one profile ships', `${loader} falls back to '${loaded}', which is not among ${shipped.join(', ') || 'anything shipped'}.`);
  }
  if (!/validateControllerProfile\s*\(/.test(source)) {
    fail(
      'one profile ships',
      `${loader} does not call validateControllerProfile(). A profile arriving from a file would reach `
      + 'the decoder unchecked, and no test would notice: they all run on the profile that ships.'
    );
  }
});

// --- The shell never names a device ----------------------------------------
//
// A header that says "No MiniLab 3 detected" tells a user with another keyboard
// that his keyboard is broken. The shell -- core/ and ui/ -- therefore names the
// controller from its routing node (`core/controllerNode.js`), which takes its
// name from the loaded profile in `modules/minilab/minilabModule.js`. That is
// one file allowed to spell a device, and it is the device's own page.
//
// The words come from the shipped profiles themselves, so the rule follows a
// profile rather than a list someone has to maintain. What separates a name the
// user READS from a name the CODE uses is punctuation: `MINILAB_NODE_ID`,
// `minilab-control-surface` and `data-minilab-control-id` are single tokens once
// a word may contain `_` and `-`, while prose puts spaces around the device.
// So identifiers, CSS classes and data attributes pass untouched, and a sentence
// does not.
//
// A multi-word vendor is matched WHOLE and never word by word. "Nebula
// Instruments" must not turn the ordinary word "instruments" into a violation --
// that is the false-positive class this rule dies of, since a rule everyone has
// learned to ignore guards nothing. A model whose words are themselves ordinary
// English would reopen it; the answer that day is to name the exception here,
// with its reason, and not to delete the rule.
//
// One subtraction, and it is not an exception: MiniHub's own names (AGENTS.md
// section 2) contain the device's, for historical reasons that are now on the
// user's disk. "MiniLab Hub" is this application, not the hardware.
rule('device name out of the shell', () => {
  const appNames = ['MiniLab Hub', 'MiniHub', 'minilab-hub', 'mlh'];
  const words = new Set();
  const phrases = new Set();
  for (const file of profileFiles()) {
    const profile = JSON.parse(read(file));
    const model = profile?.device?.model;
    for (const text of [profile?.name, profile?.device?.vendor, model]) {
      if (typeof text !== 'string' || !text.trim()) continue;
      const parts = text.trim().split(/\s+/);
      if (parts.length > 1) phrases.add(parts.join(' ').toLowerCase());
      if (parts.length > 1 && text !== model) continue;
      for (const part of parts) if (part.length >= 4) words.add(part.toLowerCase());
    }
  }
  if (words.size === 0 && phrases.size === 0) {
    fail('device name out of the shell', `no profile under ${PROFILE_DIR} names a device to look for.`);
    return;
  }
  const say = (file, index, what) => fail(
    'device name out of the shell',
    `${file}:${index + 1} says '${what}'. The shell asks \`controllerName(network)\` for the `
    + "device it is talking about; only the controller's own module reads that from the profile."
  );
  for (const dir of ['src/renderer/js/core', 'src/renderer/js/ui']) {
    for (const file of walk(dir, ['.js'])) {
      read(rel(file)).split('\n').forEach((line, index) => {
        if (isCommentLine(line)) return;
        let text = line;
        for (const name of appNames) text = text.split(name).join(' ');
        for (const token of text.split(/[^A-Za-z0-9_-]+/)) {
          if (words.has(token.toLowerCase())) say(rel(file), index, token);
        }
        const flattened = text.toLowerCase().replace(/\s+/g, ' ');
        for (const phrase of phrases) {
          if (flattened.includes(phrase)) say(rel(file), index, phrase);
        }
      });
    }
  }
});

// --- No runtime dependency ------------------------------------------------
rule('no runtime dependency', () => {
  const pkg = JSON.parse(read('package.json'));
  const runtime = Object.keys(pkg.dependencies ?? {});
  if (runtime.length > 0) {
    fail(
      'no runtime dependency',
      `package.json declares runtime dependencies (${runtime.join(', ')}). MiniHub ships stdlib + Electron only.`
    );
  }
});

// --- Report ---------------------------------------------------------------

if (failures.length === 0) {
  console.log(`check-invariants: ${checked.length} rules, no violation.`);
  console.log(`  ${checked.join(' | ')}`);
  process.exit(0);
}

console.error(`check-invariants: ${failures.length} violation(s) across ${checked.length} rules.\n`);
for (const { rule: name, message } of failures) {
  console.error(`  [${name}] ${message}`);
}
console.error('\nEach rule maps to an invariant in ARCHITECTURE.md section 13, or to a rule of');
console.error('MINIHUB_CONTROLLER_PLATFORM_SPEC.md, sections 3.5 and 9, for the profile rules.');
console.error('If a rule is wrong, fix the rule -- do not weaken the invariant it guards.');
process.exit(1);
