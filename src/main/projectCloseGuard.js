'use strict';

/**
 * Own the operating-system close for one BrowserWindow.
 *
 * A project that already has a file on disk is written on the way out, without
 * asking: closing an application is not how anyone chooses to discard an
 * afternoon of work, and a modal standing between the user and the close
 * button teaches them to click "Discard" without reading. A project that has
 * never been saved anywhere is the only case with a real question to ask,
 * because there is no destination to write it to.
 *
 * The renderer owns the project (VST state capture, snapshot, atomic write),
 * so saving is a round trip: main asks, the renderer answers, the window
 * closes only once the answer is in. Anything that is not a confirmed save --
 * a refusal, a write failure, a renderer that never answers -- ends in an
 * explicit dialog rather than in silent data loss.
 */
function installProjectCloseGuard({ window, dialog, requestSave, log = () => {} }) {
  if (!window || typeof window.on !== 'function') throw new Error('project close guard requires a window');
  if (!dialog || typeof dialog.showMessageBox !== 'function') throw new Error('project close guard requires a dialog');
  if (typeof requestSave !== 'function') throw new Error('project close guard requires a save request');

  let dirty = false;
  let hasFile = false;
  let projectName = 'Untitled';
  let allowNextClose = false;
  let resolving = false;
  let disposed = false;

  const alive = () => !disposed && !window.isDestroyed?.();

  /** Last resort: the save did not happen, so the loss must be deliberate. */
  async function confirmCloseWithoutSaving(reason) {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'MiniHub could not save this project',
      message: `"${projectName}" could not be saved.`,
      detail: `${reason}\n\nClose MiniHub anyway? The changes since the last save will be lost.`,
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    return result?.response === 0;
  }

  /** Resolve one close attempt into a decision: true closes, false stays open. */
  async function resolveClose() {
    if (hasFile) {
      const saved = await requestSave('save');
      if (saved?.ok) return true;
      return confirmCloseWithoutSaving(saved?.reason || 'The project window did not confirm the save.');
    }

    const choice = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Save this MiniHub project?',
      message: `"${projectName}" has never been saved.`,
      detail: 'Choose where to save it, or quit and lose it.',
      buttons: ['Save…', 'Quit without saving', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (choice?.response === 2) return false;
    if (choice?.response === 1) return true;
    if (!alive()) return false;

    const saved = await requestSave('save-as');
    if (saved?.ok) return true;
    // Dismissing the file picker is a step back into the application, not a
    // decision to lose the project: no second dialog, the window stays open.
    if (saved?.reason === 'cancelled') return false;
    return confirmCloseWithoutSaving(saved?.reason || 'The project window did not confirm the save.');
  }

  const onClose = (event) => {
    if (disposed || allowNextClose || !dirty) {
      allowNextClose = false;
      return;
    }

    event?.preventDefault?.();
    // Every further close attempt lands on the decision already in flight;
    // clicking the close button twice must not open two dialogs or start two
    // saves of the same project.
    if (resolving) return;
    resolving = true;

    // Called, not deferred: an async function starts synchronously, so the
    // save request leaves before this close event returns to Electron.
    resolveClose()
      .then((shouldClose) => {
        if (!shouldClose || !alive()) return;
        // The decision is a one-shot authorization. Clearing dirty also keeps a
        // later app.quit() pass from resolving the same close a second time.
        dirty = false;
        allowNextClose = true;
        window.close();
      })
      .catch((error) => {
        log(`project-close-guard failed: ${error?.message || String(error)}`);
      })
      .finally(() => {
        resolving = false;
      });
  };

  window.on('close', onClose);

  return {
    /** The renderer's canonical project identity: what to save, and whether it has a home. */
    setProjectState(state) {
      dirty = state?.dirty === true;
      hasFile = state?.hasFile === true;
      if (typeof state?.name === 'string' && state.name !== '') projectName = state.name;
    },
    isDirty() { return dirty; },
    hasFile() { return hasFile; },
    isResolving() { return resolving; },
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
