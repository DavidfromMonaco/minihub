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
const SITE_DESTINATIONS = Object.freeze({
  // ROADMAP item 15. `setups` is the word the user reads; `profile` is the word
  // of the format (DECISIONS.md D-026). The button that asks for this one names
  // the host in its own label (`ui/controllerProfileSection.js`), so the two
  // move together -- a test holds them to it.
  setups: 'https://minihub.site/setups/'
});

/** The URL for a named destination, or null when the name is not one of ours. */
function externalUrlFor(name) {
  if (typeof name !== 'string') return null;
  const url = Object.hasOwn(SITE_DESTINATIONS, name) ? SITE_DESTINATIONS[name] : null;
  if (!url) return null;
  return url.startsWith('https://') ? url : null;
}

module.exports = { SITE_DESTINATIONS, externalUrlFor };
