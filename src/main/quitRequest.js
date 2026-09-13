'use strict';

/**
 * Quit because a request asked, rather than because Exit was clicked.
 *
 * It takes Exit's own road -- `app.quit()`, then `before-quit`, then the close
 * guard -- so a project that has a file is written on the way out exactly as it
 * is for a person (projectCloseGuard.js). Nothing here decides anything about
 * saving.
 *
 * The one answer a request may bring with it is the one a person gives in the
 * guard's dialog: "Quit without saving", for a project that has never been
 * saved. That dialog is the only question the guard ever asks on a clean save,
 * and a modal raised by a request is a modal nobody is there to answer. So the
 * authorization is given only in that exact case -- unsaved, and no file. A
 * project with a file cannot be quit without being saved, because Exit cannot
 * do that either; and a flag left armed on a clean project would let some later
 * close walk past the guard.
 */
function quitOnRequest({ app, guard, discardUnsaved = false }) {
  if (discardUnsaved === true && guard?.isDirty() && !guard.hasFile()) guard.allowCloseOnce();
  app.quit();
  return true;
}

module.exports = { quitOnRequest };
