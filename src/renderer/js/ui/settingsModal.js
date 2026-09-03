import { icon } from './icons.js';
import { escapeHtml } from '../core/html.js';

/**
 * The folders shown in Settings, in the order they matter to the user.
 *
 * Only destinations appear here: places MiniHub *writes* to. A file written
 * somewhere the user never chose is a file they have to hunt for, so every one
 * of these is theirs to set, and the choice outlives the session. The import
 * folder is remembered too, but it is a browsing convenience, not a
 * destination, so it stays out of this panel.
 */
const FOLDER_ROWS = [
  { purpose: 'audioRecordings', label: 'Recordings', hint: 'Recorded takes are filed here.' },
  { purpose: 'audioExport', label: 'Audio exports', hint: 'Where the export dialog opens.' },
  { purpose: 'project', label: 'Projects', hint: 'Where the project dialogs open.' }
];

/**
 * Simple settings modal showing current persisted preferences and
 * allowing them to be reset. Kept intentionally small for the MVP.
 */
export function buildSettingsModal(hub, rootEl, openButton) {
  let folders = {};

  const folderRow = ({ purpose, label, hint }) => `
        <div class="folder">
          <div class="folder-head">
            <span class="k">${escapeHtml(label)}</span>
            <span class="folder-buttons">
              <button class="btn" data-choose="${escapeHtml(purpose)}">Change…</button>
              <button class="btn" data-open="${escapeHtml(purpose)}">Open</button>
            </span>
          </div>
          <div class="folder-path" title="${escapeHtml(folders[purpose] || '')}">${
            escapeHtml(folders[purpose] || 'Not set')
          }</div>
          <div class="folder-hint">${escapeHtml(hint)}</div>
        </div>`;

  const render = () => {
    const input = hub.midi.getInput(hub.midi.selectedInputId);
    const output = hub.midi.getOutput(hub.midi.selectedOutputId);

    rootEl.innerHTML = `
      <div class="modal">
        <h2>Settings</h2>
        <div class="modal-sub">Application preferences are saved locally.</div>
        <div class="kv"><span class="k">MIDI Input</span><span class="v">${
          input ? escapeHtml(input.name) : 'None'
        }</span></div>
        <div class="kv"><span class="k">MIDI Output</span><span class="v">${
          output ? escapeHtml(output.name) : 'None'
        }</span></div>
        ${FOLDER_ROWS.map(folderRow).join('')}
        <div class="kv"><span class="k">Settings file</span><span class="v faint">userData/settings.json</span></div>
        <div class="modal-actions">
          <button class="btn" id="reset-settings">Reset to defaults</button>
          <button class="btn primary" id="close-settings">Close</button>
        </div>
      </div>`;

    rootEl.querySelector('#close-settings').addEventListener('click', hide);
    rootEl.querySelector('#reset-settings').addEventListener('click', async () => {
      hub.midi.selectInput(null, { remember: true });
      await hub.settings.set('selectedOutputId', null);
      hub.midi.selectOutput(null);
      hub.events.emit('midi:ports', {
        inputs: hub.midi.listInputs(),
        outputs: hub.midi.listOutputs()
      });
      render();
    });
    // Changing a folder is the one action here that must show its own result:
    // the point of the panel is to make the destination visible.
    for (const button of rootEl.querySelectorAll('[data-choose]')) {
      button.addEventListener('click', async () => {
        const chosen = await hub.api.chooseDirectory?.(button.dataset.choose);
        if (!chosen) return;
        folders = { ...folders, [button.dataset.choose]: chosen };
        render();
      });
    }
    for (const button of rootEl.querySelectorAll('[data-open]')) {
      button.addEventListener('click', () => hub.api.openDirectory?.(button.dataset.open));
    }
  };

  const show = async () => {
    rootEl.classList.remove('hidden');
    // Paths belong to the main process; render once without them rather than
    // leaving the panel blank while the IPC round trip completes.
    render();
    try {
      folders = (await hub.api.listDirectories?.()) || {};
    } catch (_) {
      folders = {};
    }
    if (!rootEl.classList.contains('hidden')) render();
  };
  const hide = () => rootEl.classList.add('hidden');

  // Bound once, not per render: re-rendering the panel used to stack a new
  // backdrop listener on the same element every time.
  rootEl.addEventListener('click', (e) => {
    if (e.target === rootEl) hide();
  });

  openButton.addEventListener('click', show);
  return { show, hide };
}
