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
        `${rel(file)}:${index + 1} hard-codes 'minilab-3'. Import MINILAB_NODE_ID from core/systemNodes.js.`
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
console.error('\nEach rule maps to an invariant in ARCHITECTURE.md section 13.');
console.error('If a rule is wrong, fix the rule -- do not weaken the invariant it guards.');
process.exit(1);
