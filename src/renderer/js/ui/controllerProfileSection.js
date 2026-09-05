import { escapeHtml } from '../core/html.js';
import { reviewProfileText } from '../core/profileImport.js';
import { PROFILE_ORIGIN, LOADED_PROFILE } from '../midi/loadedProfile.js';

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

const BUILT_IN = { fileName: null, label: 'Built in', hint: 'The profile that ships with MiniHub.' };

const runningName = () => escapeHtml(LOADED_PROFILE.device?.model || LOADED_PROFILE.name);

/**
 * Where the running profile came from, on its own line under the name.
 *
 * Kept out of the `.kv` row deliberately: that row is `space-between`, so a
 * third element in it is spread across the width instead of reading as a note
 * about the second.
 */
const originNote = () => {
  if (PROFILE_ORIGIN.origin === 'file') {
    return `<div class="profile-note faint">from ${escapeHtml(PROFILE_ORIGIN.fileName || 'a file')}</div>`;
  }
  if (!PROFILE_ORIGIN.reason) return '<div class="profile-note faint">built in</div>';

  // The chosen profile could not be honoured. Naming the file matters more than
  // naming the reason: it is the only thing the user can go and look at.
  const because = PROFILE_ORIGIN.reason === 'unreadable'
    ? 'could not be read'
    : 'is not a valid profile';
  return `<div class="profile-note warn">${
    escapeHtml(PROFILE_ORIGIN.fileName || 'the chosen profile')
  } ${because} — MiniHub started on the built-in profile.</div>`;
};

const profileRow = (entry, selected) => {
  const current = entry.fileName === selected;
  const name = entry.fileName === null
    ? BUILT_IN.label
    : (entry.name || entry.profileId || entry.fileName);
  const hint = entry.fileName === null
    ? BUILT_IN.hint
    : (entry.error ? `Unreadable — ${entry.error}` : `${entry.controls ?? '?'} controls · ${entry.fileName}`);
  const actions = current
    ? '<span class="pill">In use</span>'
    : `<button class="btn" data-profile-use="${escapeHtml(entry.fileName ?? '')}">Use</button>`
      + (entry.fileName === null ? ''
        : `<button class="btn" data-profile-forget="${escapeHtml(entry.fileName)}">Remove</button>`);
  return `
        <div class="folder${current ? ' current' : ''}">
          <div class="folder-head">
            <span class="k">${escapeHtml(name)}</span>
            <span class="folder-buttons">${actions}</span>
          </div>
          <div class="folder-hint">${escapeHtml(hint)}</div>
        </div>`;
};

/**
 * `state` is `{ selected, profiles, faults, message }` — what main reported, plus
 * whatever the last action had to say.
 */
export function controllerProfileSectionHtml(state) {
  const entries = [{ fileName: null }, ...(state.profiles || [])];
  const faults = (state.faults || []).length
    ? `<div class="profile-faults">${
      (state.faults || []).map((fault) => `<div>${escapeHtml(fault)}</div>`).join('')
    }</div>`
    : '';
  const message = state.message
    ? `<div class="profile-note ${state.message.ok ? 'faint' : 'warn'}">${escapeHtml(state.message.text)}</div>`
    : '';
  return `
      <div class="kv"><span class="k">Running</span><span class="v">${runningName()}</span></div>
      ${originNote()}
      ${entries.map((entry) => profileRow(entry, state.selected ?? null)).join('')}
      ${faults}${message}
      <div class="profile-actions">
        <button class="btn" id="profile-import">Import a profile…</button>
        <span class="folder-hint">Changing the controller reloads the window.</span>
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

  for (const button of rootEl.querySelectorAll('[data-profile-use]')) {
    button.addEventListener('click', async () => {
      const fileName = button.dataset.profileUse === '' ? null : button.dataset.profileUse;
      const chosen = await api.profileSelect?.(fileName);
      if (!chosen?.ok) {
        refresh({ message: { ok: false, text: chosen?.error || 'That profile could not be selected.' } });
        return;
      }
      reload();
    });
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
