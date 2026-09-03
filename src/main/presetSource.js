'use strict';

/**
 * Remote preset sources: fetching a catalogue, and downloading one file from it.
 *
 * Two kinds of source, because they answer different needs and share almost all
 * their machinery:
 *
 *   `index`  a JSON document MiniHub defines, at a URL the user controls.
 *   `github` a folder in a public repository, read through the contents API,
 *            which needs no index to be authored and no account to be read.
 *
 * They are an internal table, not an extension point: INTENT.md section 6 rules
 * out a plugin system, and adding a third kind means editing this file.
 *
 * Everything below treats the network as hostile. Sizes are capped before a
 * body is accumulated, only HTTPS is followed, a redirect that leaves HTTPS is
 * refused rather than downgraded, and a declared SHA-256 is verified before the
 * bytes are handed anywhere. Nothing here writes to disk or talks to the
 * engine; it returns values, so it can be tested without either.
 *
 * The transport is injected. `require('electron')` happens only inside the
 * default factory, so a test supplies its own and never loads Electron.
 */

const crypto = require('crypto');

/** A catalogue document is text; this bounds what is accumulated before parse. */
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
/** A single preset file. Far above a real one, and it bounds one download. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** A catalogue may not list more than this. */
const MAX_ENTRIES = 2000;
const MAX_REDIRECTS = 3;

/** Extensions a source may offer. `.vstpreset` is the only one the engine can
 *  apply live; the others exist to be installed where the plugin looks for its
 *  own presets. */
const APPLICABLE_EXTENSION = '.vstpreset';
const ALLOWED_EXTENSIONS = ['.vstpreset', '.fxp', '.fxb', '.vital', '.syx'];

const CLASS_ID = /^[0-9A-Fa-f]{32}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;

const fail = (reason) => ({ ok: false, reason });

/** Lazily resolved so this module loads outside Electron. */
function defaultTransport() {
  // eslint-disable-next-line global-require
  const { net } = require('electron');
  return (url, { maxBytes, onBody }) => new Promise((resolve) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual' });
    let size = 0;
    const chunks = [];
    request.on('redirect', (status, method, redirectUrl) => {
      resolve({ ok: false, reason: 'redirect', redirectUrl });
      request.abort();
    });
    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        resolve(fail(`http-${response.statusCode}`));
        response.resume();
        return;
      }
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          resolve(fail('too-large'));
          request.abort();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks) }));
      response.on('error', () => resolve(fail('response-error')));
    });
    request.on('error', () => resolve(fail('request-failed')));
    request.end();
    if (typeof onBody === 'function') onBody(request);
  });
}

/**
 * HTTPS only, and no credentials in the URL.
 *
 * A downgrade to http would send a request MiniHub cannot vouch for, and
 * userinfo in a URL is how a link smuggles a host past a reader's eye.
 */
function isAllowedUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
}

function extensionOf(name) {
  const lower = String(name || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot === -1 ? '' : lower.slice(dot);
}

/** Normalized catalogue entry, or null when the source described nonsense. */
function normalizeEntry(raw, sourceId) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length === 0 || name.length > 200) return null;
  if (!isAllowedUrl(raw.url)) return null;

  const extension = extensionOf(raw.fileName || name);
  if (!ALLOWED_EXTENSIONS.includes(extension)) return null;

  const classId = typeof raw.classId === 'string' && CLASS_ID.test(raw.classId)
    ? raw.classId.toUpperCase()
    : null;
  const sha256 = typeof raw.sha256 === 'string' && SHA256.test(raw.sha256)
    ? raw.sha256.toLowerCase()
    : null;
  const size = Number.isSafeInteger(raw.size) && raw.size > 0 && raw.size <= MAX_FILE_BYTES
    ? raw.size
    : null;

  return {
    source: sourceId,
    name: name.slice(0, 200),
    fileName: String(raw.fileName || name).slice(0, 200),
    extension,
    // Only a .vstpreset can be handed to a live plugin. The rest are downloads
    // that the plugin's own browser has to find on disk.
    applicable: extension === APPLICABLE_EXTENSION,
    url: raw.url,
    classId,
    plugin: typeof raw.plugin === 'string' ? raw.plugin.slice(0, 120) : null,
    vendor: typeof raw.vendor === 'string' ? raw.vendor.slice(0, 120) : null,
    license: typeof raw.license === 'string' ? raw.license.slice(0, 120) : null,
    sha256,
    size
  };
}

/**
 * Parse a MiniHub catalogue document.
 *
 * Strict on purpose: an unrecognised shape is refused whole rather than
 * salvaged, because a half-understood catalogue is how a source starts deciding
 * what MiniHub does.
 */
function parseIndex(text, sourceId = 'index') {
  let document;
  try {
    document = JSON.parse(text);
  } catch (err) {
    return fail('invalid-json');
  }
  if (!document || typeof document !== 'object') return fail('invalid-index');
  if (document.format !== 'minihub-preset-index') return fail('unknown-format');
  if (document.version !== 1) return fail('unsupported-version');
  if (!Array.isArray(document.presets)) return fail('invalid-index');
  if (document.presets.length > MAX_ENTRIES) return fail('too-many-entries');

  const entries = [];
  for (const raw of document.presets) {
    const entry = normalizeEntry(raw, sourceId);
    if (entry) entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * Parse a GitHub contents listing into the same entry shape.
 *
 * The API answers with one object per directory item; only files with an
 * allowed extension and a direct download URL become entries. `sha` is git's
 * blob hash, not a SHA-256 of the content, so it is deliberately NOT carried
 * into `sha256`: claiming a verified digest we cannot check would be worse than
 * having none.
 */
function parseGithubContents(text, sourceId = 'github', context = {}) {
  let listing;
  try {
    listing = JSON.parse(text);
  } catch (err) {
    return fail('invalid-json');
  }
  if (!Array.isArray(listing)) return fail('invalid-listing');
  if (listing.length > MAX_ENTRIES) return fail('too-many-entries');

  const entries = [];
  for (const item of listing) {
    if (!item || item.type !== 'file') continue;
    const entry = normalizeEntry({
      name: typeof item.name === 'string' ? item.name.replace(/\.[^.]+$/, '') : '',
      fileName: item.name,
      url: item.download_url,
      size: item.size,
      plugin: context.plugin || null,
      vendor: context.vendor || null,
      license: context.license || null
    }, sourceId);
    if (entry) entries.push(entry);
  }
  return { ok: true, entries };
}

/** The contents URL for `owner/repo` at `path`, or null when ill-formed. */
function githubContentsUrl({ owner, repo, path = '', ref = null } = {}) {
  // Must start with an alphanumeric, which is GitHub's own rule and, more to
  // the point here, refuses `.` and `..`: those are accepted by a naive
  // character class and turn this into a path-traversing URL.
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  if (!segment.test(String(owner || '')) || !segment.test(String(repo || ''))) return null;
  const cleaned = String(path || '').replace(/^\/+|\/+$/g, '');
  if (cleaned.length > 400 || /(^|\/)\.\.(\/|$)/.test(cleaned)) return null;
  const encoded = cleaned.length === 0
    ? ''
    : '/' + cleaned.split('/').map((part) => encodeURIComponent(part)).join('/');
  const query = ref && segment.test(ref) ? `?ref=${encodeURIComponent(ref)}` : '';
  return `https://api.github.com/repos/${owner}/${repo}/contents${encoded}${query}`;
}

/** Follow at most a few redirects, refusing any that leaves HTTPS. */
async function get(url, { transport, maxBytes }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedUrl(current)) return fail('insecure-url');
    const answer = await transport(current, { maxBytes });
    if (!answer || answer.ok !== false || answer.reason !== 'redirect') return answer || fail('no-answer');
    // A redirect out of HTTPS is refused rather than followed: it is the one
    // moment a fetch can quietly stop being the fetch that was authorised.
    current = answer.redirectUrl;
  }
  return fail('too-many-redirects');
}

/**
 * Fetch and parse a source's catalogue.
 *
 * `source` is `{ id, kind: 'index' | 'github', url }` or
 * `{ id, kind: 'github', owner, repo, path, ref }`.
 */
async function fetchCatalogue(source, { transport = null } = {}) {
  const send = transport || defaultTransport();
  if (!source || typeof source !== 'object') return fail('invalid-source');

  if (source.kind === 'index') {
    const answer = await get(source.url, { transport: send, maxBytes: MAX_INDEX_BYTES });
    if (!answer.ok) return answer;
    return parseIndex(answer.body.toString('utf8'), source.id || 'index');
  }
  if (source.kind === 'github') {
    const url = source.url && isAllowedUrl(source.url) ? source.url : githubContentsUrl(source);
    if (!url) return fail('invalid-source');
    const answer = await get(url, { transport: send, maxBytes: MAX_INDEX_BYTES });
    if (!answer.ok) return answer;
    return parseGithubContents(answer.body.toString('utf8'), source.id || 'github', source);
  }
  return fail('unknown-source-kind');
}

/**
 * Download one catalogue entry and return its bytes.
 *
 * When the entry declares a SHA-256 it is verified here, before the bytes reach
 * a parser, a plugin or the disk. A mismatch is a refusal, never a warning.
 */
async function downloadEntry(entry, { transport = null } = {}) {
  const send = transport || defaultTransport();
  if (!entry || !isAllowedUrl(entry.url)) return fail('insecure-url');

  const answer = await get(entry.url, { transport: send, maxBytes: MAX_FILE_BYTES });
  if (!answer.ok) return answer;

  const bytes = answer.body;
  if (bytes.length === 0) return fail('empty-download');
  if (entry.sha256) {
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) return fail('digest-mismatch');
  }
  return { ok: true, bytes };
}

module.exports = {
  fetchCatalogue,
  downloadEntry,
  parseIndex,
  parseGithubContents,
  githubContentsUrl,
  isAllowedUrl,
  normalizeEntry,
  ALLOWED_EXTENSIONS,
  APPLICABLE_EXTENSION,
  MAX_INDEX_BYTES,
  MAX_FILE_BYTES,
  MAX_ENTRIES,
  MAX_REDIRECTS
};
