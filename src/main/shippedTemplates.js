'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The templates MiniHub comes with, and how they reach the user's folder.
 *
 * WHY THEY ARE COPIED OUT RATHER THAN LISTED FROM THE PACKAGE
 * ----------------------------------------------------------
 * A template is chosen through a native file dialog, which can show one folder
 * and knows nothing about the application's own resources. A shipped template
 * that stayed inside `resources/app` would therefore be a template nobody can
 * open. So it is written into the templates folder on startup, where it is an
 * ordinary file the user can rename, edit or delete like any of their own.
 *
 * WHY "ONLY WHEN IT IS NOT THERE" IS THE WHOLE RULE
 * ------------------------------------------------
 * That is what makes this safe to run at every launch. A template the user has
 * edited and saved under the same name is theirs; overwriting it would throw
 * their work away at the next start, silently, and they would have no way to
 * tell what happened. The cost is the other direction: a shipped template the
 * user deletes comes back next launch. Between losing somebody's work and
 * restoring a file they can delete again, that is the trade this makes.
 *
 * Deliberately free of Electron, so the rule can be tested with node:test.
 */

/** The shipped template files, by name, in a stable order. */
function shippedTemplateFiles(sourceDir, io = fs) {
  try {
    return io.readdirSync(sourceDir)
      .filter((entry) => entry.toLowerCase().endsWith('.minihub'))
      .sort();
  } catch (_) {
    // No templates folder in the package is a build without them, not a fault
    // worth stopping a launch for.
    return [];
  }
}

/**
 * Put every shipped template into `targetDir` that is not already there.
 *
 * @returns {string[]} the names actually written, for the startup log. A folder
 *   that cannot be written to -- read-only, on a drive that has gone away --
 *   answers with fewer names and nothing else: the user still has every
 *   template they made themselves, and MiniHub still starts.
 */
function installShippedTemplates(sourceDir, targetDir, io = fs) {
  const written = [];
  for (const name of shippedTemplateFiles(sourceDir, io)) {
    const destination = path.join(targetDir, name);
    try {
      if (io.existsSync(destination)) continue;
      io.mkdirSync(targetDir, { recursive: true });
      io.copyFileSync(path.join(sourceDir, name), destination);
      written.push(name);
    } catch (_) {
      // Next launch will try again. One template that cannot be written must
      // not stop the ones after it.
    }
  }
  return written;
}

module.exports = { shippedTemplateFiles, installShippedTemplates };
