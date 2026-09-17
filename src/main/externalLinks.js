/**
 * The places outside MiniHub the application is allowed to open, by name.
 *
 * WHY THE RENDERER NEVER PASSES A URL
 * -----------------------------------
 * `shell.openExternal` hands a string to the operating system's handler for
 * that string's scheme. A renderer that chooses the string chooses which
 * program Windows launches -- and MiniHub's renderer is the process that
 * displays a profile file written by a stranger (D-020). So the renderer asks
 * for a NAMED destination and this file answers with the URL, exactly as
 * `directories:open` takes a purpose rather than a path.
 *
 * `https:` is re-checked here even though every entry below is written by hand:
 * the check is what keeps the guarantee true of the file rather than of today's
 * contents, and a `file:` URL slipped into this table would otherwise open
 * anything on the disk.
 *
 * To add a destination, add a line. Nothing else changes -- the renderer names
 * it, the handler looks it up, and an unknown name is refused rather than
 * opened.
 */
const os = require('node:os');

const REPOSITORY = 'https://github.com/DavidfromMonaco/minihub';

/**
 * The body a bug report starts with.
 *
 * WHY THE ENVIRONMENT IS WRITTEN HERE RATHER THAN ASKED FOR
 * ---------------------------------------------------------
 * "Which version?" is the first question every report needs and the one nobody
 * can answer from memory, so the three lines that matter are filled in before
 * the page opens. They are facts of the running process -- the version Electron
 * itself reports (`package.json`), the Windows build, the Electron build --
 * which is why they are read here, in main, and not passed in by a renderer
 * that could be showing anything.
 *
 * Nothing is sent by MiniHub: this text becomes the query string of a GitHub
 * issue form, and the report exists only once the reporter posts it. That is
 * the whole reason this destination is a link and not a network call
 * ([INTENT.md](INTENT.md) §7).
 */
function reportBody() {
  const { version } = require('../../package.json');
  return [
    '### What happened', '', '', '### What you expected', '', '',
    '### Steps to reproduce', '', '1. ', '2. ', '',
    '### Environment', '',
    `- MiniHub ${version}`,
    `- Windows ${os.release()}`,
    `- Electron ${process.versions.electron || 'unknown'}`,
    ''
  ].join('\n');
}

const SITE_DESTINATIONS = Object.freeze({
  // ROADMAP item 15. `setups` is the word the user reads; `profile` is the word
  // of the format (DECISIONS.md D-026). The button that asks for this one names
  // the host in its own label (`ui/controllerProfileSection.js`), so the two
  // move together -- a test holds them to it.
  setups: 'https://minihub.site/setups/',
  // The three destinations Home offers. `source` and `report` are the same
  // repository: one to read the code, one to open a pre-filled issue form on
  // it. A report travels through GitHub rather than through a form of ours
  // because a static site cannot send mail, and a form inside MiniHub would be
  // its first network call.
  site: 'https://minihub.site/',
  source: REPOSITORY,
  report: `${REPOSITORY}/issues/new?${new URLSearchParams({ title: 'Bug: ', body: reportBody() })}`
});

/** The URL for a named destination, or null when the name is not one of ours. */
function externalUrlFor(name) {
  if (typeof name !== 'string') return null;
  const url = Object.hasOwn(SITE_DESTINATIONS, name) ? SITE_DESTINATIONS[name] : null;
  if (!url) return null;
  return url.startsWith('https://') ? url : null;
}

module.exports = { SITE_DESTINATIONS, externalUrlFor };
