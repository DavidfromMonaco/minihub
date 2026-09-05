import { escapeHtml } from '../core/html.js';
import { reviewProfileText } from '../core/profileImport.js';
import { PROFILE_ORIGINS, LOADED_PROFILES, SHIPPED_PROFILE, SHIPPED_FILE_NAME } from '../midi/loadedProfile.js';

/**
 * Which keyboard MiniHub is running, and how to run another one.
 *
 * WHY IT SITS ON THE CONTROLLER'S OWN PAGE
 * ----------------------------------------
 * It was in Settings first, next to the folders, and that was the wrong place:
 * Settings is where a user goes to say where files are written, and the page
 * that carries the device's name is where he goes when the KEYBOARD is what is
 * wrong. The VST editor's Learn panel points here for the same reason -- someone
 * hunting for a control that is not on the drawing needs one place to go.
 *
 * WHY EVERY ACTION HERE ENDS IN A WINDOW RELOAD
 * ---------------------------------------------
 * The profile is resolved before the renderer's first module evaluates, because
 * the controller node's id is a module-level constant derived from it. There is
 * therefore no such thing as changing profile in place -- see
 * `midi/loadedProfile.js`. The reload is not a shortcut around a harder problem;
 * it is what keeps thirty-odd consumers from becoming function calls, and the
 * application already survives one (`core/chainSync.js` rebuilds the engine's
 * chains).
 *
 * The panel says so before the user clicks, because a window that reloads
 * unannounced reads as a crash.
 *
 * WHY A REFUSED PROFILE IS SHOWN AND NOT SWALLOWED
 * ------------------------------------------------
 * MiniHub never launches without a controller, so a chosen profile that is gone
 * or invalid falls back to the one that ships. In silence that is the worst
 * possible outcome: a user whose keyboard has quietly become a MiniLab 3, with
 * every cable pointing at a node named after a device he does not own. So the
 * fallback is stated, with its reason and with the faults that caused it.
 */

/**
 * The shipped profile, as a row like any other.
 *
 * It used to be `fileName: null` -- an entry meaning "none of the above", with no
 * button of its own -- and that was the bug: a user could load a BeatStep or run
 * the MiniLab, never both, because there was no name to put in the list beside
 * the BeatStep's. It has a file name now (`midi/loadedProfile.js` explains why
 * that name), so it can be loaded, unloaded and listed like the rest.
 *
 * It cannot be REMOVED: there is no file to delete. `Remove` is therefore absent
 * from its row rather than offered and refused.
 */
const builtInEntry = () => ({
  fileName: SHIPPED_FILE_NAME,
  profileId: SHIPPED_PROFILE.profileId,
  name: SHIPPED_PROFILE.device?.model || SHIPPED_PROFILE.name,
  controls: SHIPPED_PROFILE.controls?.length ?? null,
  error: null,
  builtIn: true
});

/** Every keyboard running, not the keyboard running. */
const runningNames = () => LOADED_PROFILES
  .map((profile) => escapeHtml(profile.device?.model || profile.name))
  .join(' · ');

/**
 * Where each running profile came from, one line each, under the names.
 *
 * Kept out of the `.kv` row deliberately: that row is `space-between`, so a
 * third element in it is spread across the width instead of reading as a note
 * about the second.
 *
 * `missing` is the entry that only exists with more than one keyboard chosen:
 * this one did not load and the others did, so nothing stands in for it (the
 * shipped profile cannot, without registering its node id twice). Saying which
 * file and why is the whole point -- a keyboard that is simply absent from the
 * Patch Bay, with no line about it, is the silence this panel exists to break.
 */
const originNote = (origin) => {
  if (origin.origin === 'file') {
    return `<div class="profile-note faint">from ${escapeHtml(origin.fileName || 'a file')}</div>`;
  }
  const because = origin.reason === 'unreadable' ? 'could not be read' : 'is not a valid profile';
  if (origin.origin === 'missing') {
    return `<div class="profile-note warn">${
      escapeHtml(origin.fileName || 'a chosen profile')
    } ${because} — that keyboard is not loaded.</div>`;
  }
  if (!origin.reason) return '<div class="profile-note faint">built in</div>';

  // The chosen profile could not be honoured. Naming the file matters more than
  // naming the reason: it is the only thing the user can go and look at.
  return `<div class="profile-note warn">${
    escapeHtml(origin.fileName || 'the chosen profile')
  } ${because} — MiniHub started on the built-in profile.</div>`;
};

/**
 * One profile, and whether it is loaded.
 *
 * `Load` / `Unload` rather than `Use`, because using one no longer means not
 * using the others: several keyboards run at once, so this is a set the user
 * adds to and removes from. The built-in row has no button of its own -- it is
 * what runs when the set is empty, not a member of it, and a button that
 * "selects" it would really be a button that unloads everything else.
 */
const profileRow = (entry, selected) => {
  const builtIn = entry.builtIn === true;
  // The shipped profile runs when nothing is loaded, so its row says so even
  // while its name is not in the list. Unloading the last keyboard lands here.
  const loaded = selected.includes(entry.fileName) || (builtIn && selected.length === 0);
  const name = entry.name || entry.profileId || entry.fileName;
  const hint = builtIn
    ? `Ships with MiniHub · ${entry.controls ?? '?'} controls`
    : (entry.error ? `Unreadable — ${entry.error}` : `${entry.controls ?? '?'} controls · ${entry.fileName}`);
  const file = escapeHtml(entry.fileName);
  let actions;
  if (loaded) {
    // Unloading the built-in row when it is the only thing running would be a
    // button that does nothing: an empty list runs it anyway.
    actions = '<span class="pill">Loaded</span>'
      + (builtIn && selected.length === 0 ? ''
        : `<button class="btn" data-profile-unload="${file}">Unload</button>`);
  } else {
    actions = `<button class="btn" data-profile-load="${file}">Load</button>`
      + (builtIn ? '' : `<button class="btn" data-profile-forget="${file}">Remove</button>`);
  }
  // `data-profile-loaded` and not "has an Unload button": the shipped row is
  // running whenever the list is empty and deliberately has no Unload (there
  // would be nothing to unload to). Reading the set off the buttons therefore
  // missed it, and adding a second keyboard wrote a list without it -- which is
  // the very bug this row was added to fix, one layer up.
  return `
        <div class="folder${loaded ? ' current' : ''}"${loaded ? ` data-profile-loaded="${file}"` : ''}>
          <div class="folder-head">
            <span class="k">${escapeHtml(name)}</span>
            <span class="folder-buttons">${actions}</span>
          </div>
          <div class="folder-hint">${escapeHtml(hint)}</div>
        </div>`;
};

/**
 * `state` is `{ selected, profiles, faults, message }` — what main reported, plus
 * whatever the last action had to say. `selected` is a LIST of file names; a bare
 * string from an older main process reads as a list of one.
 */
export function controllerProfileSectionHtml(state) {
  const selected = Array.isArray(state.selected)
    ? state.selected
    : (typeof state.selected === 'string' ? [state.selected] : []);
  // The shipped profile first, unless a file has taken its name over -- an
  // imported `minilab-3.json` IS the MiniLab 3, and listing both would offer the
  // same keyboard twice under one node id.
  const listed = state.profiles || [];
  const entries = listed.some((entry) => entry.fileName === SHIPPED_FILE_NAME)
    ? [...listed]
    : [builtInEntry(), ...listed];
  const faults = (state.faults || []).length
    ? `<div class="profile-faults">${
      (state.faults || []).map((fault) => `<div>${escapeHtml(fault)}</div>`).join('')
    }</div>`
    : '';
  const message = state.message
    ? `<div class="profile-note ${state.message.ok ? 'faint' : 'warn'}">${escapeHtml(state.message.text)}</div>`
    : '';
  return `
      <div class="kv"><span class="k">Running</span><span class="v">${runningNames()}</span></div>
      ${PROFILE_ORIGINS.map(originNote).join('')}
      ${entries.map((entry) => profileRow(entry, selected)).join('')}
      ${faults}${message}
      <div class="profile-actions">
        <button class="btn" id="profile-import">Import a profile…</button>
        <span class="folder-hint">Loading or unloading a controller reloads the window.</span>
      </div>`;
}

/**
 * Bind the section's buttons. `refresh` re-reads main and re-renders; `reload` is
 * how the window is restarted, injectable so a test can watch for it instead of
 * navigating.
 */
export function bindControllerProfileSection(rootEl, hub, { refresh, reload = () => globalThis.location?.reload() }) {
  const api = hub.api || {};

  const importButton = rootEl.querySelector('#profile-import');
  if (importButton) {
    importButton.addEventListener('click', async () => {
      const picked = await api.profilePick?.();
      if (!picked) return; // cancelled: not a failure, and not worth a message
      if (picked.error || typeof picked.text !== 'string') {
        refresh({ faults: [picked.error || 'That file could not be read.'] });
        return;
      }
      // Judged before it is stored, so a refused file leaves nothing behind.
      const review = reviewProfileText(picked.text);
      if (!review.ok) {
        refresh({ faults: review.faults, message: { ok: false, text: `${picked.fileName} was not imported.` } });
        return;
      }
      const stored = await api.profileImport?.(picked.text);
      if (!stored?.ok) {
        refresh({ message: { ok: false, text: stored?.error || 'The profile could not be saved.' } });
        return;
      }
      reload();
    });
  }

  // The set as it is DRAWN, read back from the markup rather than carried in a
  // variable: the panel and the list would otherwise be two copies of one truth,
  // and a refresh that redrew one without the other would load a keyboard the
  // user had just unloaded. Read from the row, not from its Unload button --
  // see `profileRow`.
  const loadedNow = () => [...rootEl.querySelectorAll('[data-profile-loaded]')]
    .map((element) => element.dataset.profileLoaded);

  const apply = async (fileNames) => {
    const chosen = await api.profileSelect?.(fileNames);
    if (!chosen?.ok) {
      refresh({ message: { ok: false, text: chosen?.error || 'That profile could not be selected.' } });
      return;
    }
    reload();
  };

  for (const button of rootEl.querySelectorAll('[data-profile-load]')) {
    button.addEventListener('click', () => apply([...loadedNow(), button.dataset.profileLoad]));
  }

  for (const button of rootEl.querySelectorAll('[data-profile-unload]')) {
    button.addEventListener('click', () =>
      apply(loadedNow().filter((name) => name !== button.dataset.profileUnload)));
  }

  for (const button of rootEl.querySelectorAll('[data-profile-forget]')) {
    button.addEventListener('click', async () => {
      const removed = await api.profileForget?.(button.dataset.profileForget);
      refresh(removed?.ok
        ? { message: { ok: true, text: `${button.dataset.profileForget} removed.` } }
        : { message: { ok: false, text: removed?.error || 'That profile could not be removed.' } });
    });
  }
}
