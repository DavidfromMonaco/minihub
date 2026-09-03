'use strict';

/**
 * Remote preset sources.
 *
 * This is the only module in MiniHub that reads bytes it did not choose, so
 * most of what follows is refusals: what a source may not make the application
 * do. The transport is injected, so nothing here touches the network.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  fetchCatalogue,
  downloadEntry,
  parseIndex,
  parseGithubContents,
  githubContentsUrl,
  isAllowedUrl,
  normalizeEntry,
  MAX_ENTRIES,
  MAX_REDIRECTS
} = require('../src/main/presetSource.js');

const CLASS_ID = '5653544E6924486D6173736976652078';
const URL_OK = 'https://example.org/presets/Deep%20Bass.vstpreset';

const indexDoc = (presets) => JSON.stringify({
  format: 'minihub-preset-index', version: 1, presets
});

/** A transport that answers from a table, and records what it was asked. */
function fakeTransport(table) {
  const calls = [];
  const send = async (url, options) => {
    calls.push({ url, options });
    const answer = table[url];
    if (!answer) return { ok: false, reason: 'http-404' };
    return typeof answer === 'function' ? answer(url, options) : answer;
  };
  send.calls = calls;
  return send;
}

const body = (text) => ({ ok: true, body: Buffer.from(text, 'utf8') });

// ---- What a URL may be ------------------------------------------------------

test('only plain HTTPS URLs are ever fetched', () => {
  assert.equal(isAllowedUrl('https://example.org/a.vstpreset'), true);
  assert.equal(isAllowedUrl('http://example.org/a.vstpreset'), false, 'no downgrade');
  assert.equal(isAllowedUrl('file:///C:/secret'), false);
  assert.equal(isAllowedUrl('ftp://example.org/a'), false);
  // Credentials in a URL are how a link smuggles a host past a reader's eye.
  assert.equal(isAllowedUrl('https://user:pw@example.org/a.vstpreset'), false);
  assert.equal(isAllowedUrl('https://user@example.org/a.vstpreset'), false);
  assert.equal(isAllowedUrl('not a url'), false);
  assert.equal(isAllowedUrl(''), false);
  assert.equal(isAllowedUrl(null), false);
  assert.equal(isAllowedUrl(`https://example.org/${'a'.repeat(3000)}`), false);
});

// ---- The MiniHub catalogue document -----------------------------------------

test('a well-formed catalogue yields normalized entries', () => {
  const result = parseIndex(indexDoc([{
    name: 'Deep Bass', fileName: 'Deep Bass.vstpreset', url: URL_OK,
    classId: CLASS_ID.toLowerCase(), plugin: 'Massive X', vendor: 'NI',
    sha256: 'A'.repeat(64), size: 4096, license: 'CC0'
  }]), 'mine');

  assert.equal(result.ok, true, result.reason);
  const [entry] = result.entries;
  assert.equal(entry.name, 'Deep Bass');
  assert.equal(entry.classId, CLASS_ID, 'class ids are upper-cased for comparison');
  assert.equal(entry.sha256, 'a'.repeat(64), 'digests are lower-cased');
  assert.equal(entry.applicable, true, '.vstpreset can be applied live');
  assert.equal(entry.source, 'mine');
});

test('a document that is not our catalogue is refused whole', () => {
  assert.equal(parseIndex('{').reason, 'invalid-json');
  assert.equal(parseIndex('"a string"').reason, 'invalid-index');
  assert.equal(parseIndex('[]').reason, 'unknown-format', 'an array declares no format');
  assert.equal(parseIndex(JSON.stringify({ format: 'other', version: 1, presets: [] })).reason, 'unknown-format');
  assert.equal(parseIndex(JSON.stringify({ format: 'minihub-preset-index', version: 2, presets: [] })).reason, 'unsupported-version');
  assert.equal(parseIndex(JSON.stringify({ format: 'minihub-preset-index', version: 1, presets: {} })).reason, 'invalid-index');
  const many = Array.from({ length: MAX_ENTRIES + 1 }, () => ({ name: 'x', url: URL_OK }));
  assert.equal(parseIndex(indexDoc(many)).reason, 'too-many-entries');
});

test('an entry the source got wrong is dropped, not obeyed', () => {
  const result = parseIndex(indexDoc([
    { name: 'ok', fileName: 'ok.vstpreset', url: URL_OK },
    { name: 'insecure', fileName: 'a.vstpreset', url: 'http://example.org/a.vstpreset' },
    { name: 'local', fileName: 'a.vstpreset', url: 'file:///C:/Windows/system.ini' },
    { name: 'executable', fileName: 'evil.exe', url: 'https://example.org/evil.exe' },
    { name: 'script', fileName: 'evil.bat', url: 'https://example.org/evil.bat' },
    { name: '', fileName: 'blank.vstpreset', url: URL_OK },
    { name: 'no url', fileName: 'x.vstpreset' },
    'not an object'
  ]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((e) => e.name), ['ok'],
    'only a plausible entry survives; the rest are silently dropped');
});

test('a nonsense class id or digest becomes null rather than a lie', () => {
  const entry = normalizeEntry({
    name: 'x', fileName: 'x.vstpreset', url: URL_OK, classId: 'zz', sha256: 'nope', size: -5
  }, 's');
  assert.equal(entry.classId, null);
  assert.equal(entry.sha256, null);
  assert.equal(entry.size, null);
});

test('formats the engine cannot apply are still offered, marked as such', () => {
  // Most free banks ship .fxp or .syx, which only the plugin's own browser can
  // read. Refusing them would leave the module empty for those plugins.
  const result = parseIndex(indexDoc([
    { name: 'a', fileName: 'a.fxp', url: 'https://example.org/a.fxp' },
    { name: 'b', fileName: 'b.vital', url: 'https://example.org/b.vital' }
  ]));
  assert.equal(result.entries.length, 2);
  assert.ok(result.entries.every((e) => e.applicable === false));
});

// ---- A GitHub folder --------------------------------------------------------

test('a contents listing becomes the same entry shape', () => {
  const result = parseGithubContents(JSON.stringify([
    { type: 'file', name: 'Bass.vstpreset', download_url: 'https://raw.githubusercontent.com/o/r/main/Bass.vstpreset', size: 900, sha: 'b'.repeat(40) },
    { type: 'dir', name: 'more', download_url: null },
    { type: 'file', name: 'README.md', download_url: 'https://raw.githubusercontent.com/o/r/main/README.md', size: 10 }
  ]), 'gh', { plugin: 'Surge XT' });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.entries.map((e) => e.name), ['Bass']);
  assert.equal(result.entries[0].plugin, 'Surge XT');
  // git's blob sha is not a SHA-256 of the content: claiming a digest we cannot
  // verify would be worse than carrying none.
  assert.equal(result.entries[0].sha256, null);
});

test('a contents URL is built safely or not at all', () => {
  assert.equal(
    githubContentsUrl({ owner: 'surge-synthesizer', repo: 'surge', path: 'resources/data' }),
    'https://api.github.com/repos/surge-synthesizer/surge/contents/resources/data'
  );
  assert.match(githubContentsUrl({ owner: 'o', repo: 'r', path: 'a b' }), /contents\/a%20b$/);
  assert.match(githubContentsUrl({ owner: 'o', repo: 'r', ref: 'main' }), /\?ref=main$/);
  assert.equal(githubContentsUrl({ owner: '../../etc', repo: 'r' }), null);
  // A naive character class accepts these and yields a traversing URL.
  assert.equal(githubContentsUrl({ owner: '..', repo: 'r' }), null);
  assert.equal(githubContentsUrl({ owner: '.', repo: 'r' }), null);
  assert.equal(githubContentsUrl({ owner: 'o', repo: '..' }), null);
  assert.equal(githubContentsUrl({ owner: 'o', repo: 'r', path: 'a/../../../etc' }), null);
  assert.equal(githubContentsUrl({ owner: '', repo: 'r' }), null);
});

// ---- Fetching ---------------------------------------------------------------

test('a catalogue is fetched and parsed through the injected transport', async () => {
  const transport = fakeTransport({
    'https://example.org/index.json': body(indexDoc([{ name: 'a', fileName: 'a.vstpreset', url: URL_OK }]))
  });
  const result = await fetchCatalogue(
    { id: 's', kind: 'index', url: 'https://example.org/index.json' }, { transport });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.entries.length, 1);
});

test('a redirect is followed only while it stays on HTTPS', async () => {
  const transport = fakeTransport({
    'https://example.org/a': { ok: false, reason: 'redirect', redirectUrl: 'https://example.org/b' },
    'https://example.org/b': body(indexDoc([])),
    'https://example.org/down': { ok: false, reason: 'redirect', redirectUrl: 'http://example.org/plain' }
  });

  const followed = await fetchCatalogue({ id: 's', kind: 'index', url: 'https://example.org/a' }, { transport });
  assert.equal(followed.ok, true, followed.reason);

  const downgraded = await fetchCatalogue({ id: 's', kind: 'index', url: 'https://example.org/down' }, { transport });
  assert.equal(downgraded.reason, 'insecure-url', 'a downgrade is refused, never followed');
});

test('a redirect loop ends in a refusal', async () => {
  const transport = fakeTransport({
    'https://example.org/loop': { ok: false, reason: 'redirect', redirectUrl: 'https://example.org/loop' }
  });
  const result = await fetchCatalogue({ id: 's', kind: 'index', url: 'https://example.org/loop' }, { transport });
  assert.equal(result.reason, 'too-many-redirects');
  assert.equal(transport.calls.length, MAX_REDIRECTS + 1, 'bounded, not endless');
});

test('an unknown source kind and a bad source are refused', async () => {
  const transport = fakeTransport({});
  assert.equal((await fetchCatalogue(null, { transport })).reason, 'invalid-source');
  assert.equal((await fetchCatalogue({ kind: 'ftp' }, { transport })).reason, 'unknown-source-kind');
  assert.equal((await fetchCatalogue({ kind: 'github', owner: '..', repo: 'r' }, { transport })).reason, 'invalid-source');
  assert.equal((await fetchCatalogue({ kind: 'index', url: 'http://example.org/i' }, { transport })).reason, 'insecure-url');
});

test('an HTTP error and an oversized body both surface as reasons', async () => {
  const transport = fakeTransport({
    'https://example.org/big': { ok: false, reason: 'too-large' }
  });
  assert.equal((await fetchCatalogue({ kind: 'index', url: 'https://example.org/big' }, { transport })).reason, 'too-large');
  assert.equal((await fetchCatalogue({ kind: 'index', url: 'https://example.org/missing' }, { transport })).reason, 'http-404');
});

// ---- Downloading ------------------------------------------------------------

test('a declared digest is verified before the bytes go anywhere', async () => {
  const bytes = Buffer.from('preset-bytes');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const transport = fakeTransport({ [URL_OK]: { ok: true, body: bytes } });

  const good = await downloadEntry({ url: URL_OK, sha256: digest }, { transport });
  assert.equal(good.ok, true, good.reason);
  assert.deepEqual(good.bytes, bytes);

  const bad = await downloadEntry({ url: URL_OK, sha256: 'f'.repeat(64) }, { transport });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'digest-mismatch', 'a mismatch is a refusal, not a warning');
});

test('an entry with no digest still downloads, and an empty body does not', async () => {
  const transport = fakeTransport({
    [URL_OK]: { ok: true, body: Buffer.from('x') },
    'https://example.org/empty.vstpreset': { ok: true, body: Buffer.alloc(0) }
  });
  assert.equal((await downloadEntry({ url: URL_OK, sha256: null }, { transport })).ok, true);
  assert.equal((await downloadEntry({ url: 'https://example.org/empty.vstpreset' }, { transport })).reason, 'empty-download');
  assert.equal((await downloadEntry({ url: 'http://example.org/a' }, { transport })).reason, 'insecure-url');
});
