'use strict';

/**
 * Protect one BrowserWindow from silently discarding renderer-owned project
 * data. The renderer publishes only a boolean dirty flag; the main process
 * remains the authority for the operating-system close event and dialog.
 */
function installProjectCloseGuard({ window, dialog, log = () => {} }) {
  if (!window || typeof window.on !== 'function') throw new Error('project close guard requires a window');
  if (!dialog || typeof dialog.showMessageBox !== 'function') throw new Error('project close guard requires a dialog');

  let dirty = false;
  let allowNextClose = false;
  let promptPending = false;
  let disposed = false;

  const onClose = (event) => {
    if (disposed || allowNextClose || !dirty) {
      allowNextClose = false;
      return;
    }

    event?.preventDefault?.();
    if (promptPending) return;
    promptPending = true;

    Promise.resolve(dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Unsaved MiniHub project',
      message: 'This project has unsaved changes.',
      detail: 'Discard the changes and close MiniHub?',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })).then((result) => {
      if (result?.response !== 0 || disposed || window.isDestroyed?.()) return;
      // Discard is an explicit one-shot authorization. Clearing dirty also
      // prevents a later app.quit() pass from reopening the same prompt.
      dirty = false;
      allowNextClose = true;
      window.close();
    }).catch((error) => {
      log(`project-close-guard dialog failed: ${error?.message || String(error)}`);
    }).finally(() => {
      promptPending = false;
    });
  };

  window.on('close', onClose);

  return {
    setDirty(value) { dirty = value === true; },
    isDirty() { return dirty; },
    isPromptPending() { return promptPending; },
    /** Explicit internal authorization for a close already approved elsewhere. */
    allowCloseOnce() { allowNextClose = true; },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeListener?.('close', onClose);
    }
  };
}

module.exports = { installProjectCloseGuard };
