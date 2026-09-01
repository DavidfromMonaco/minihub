import { icon } from './icons.js';

/**
 * Simple settings modal showing current persisted preferences and
 * allowing them to be reset. Kept intentionally small for the MVP.
 */
export function buildSettingsModal(hub, rootEl, openButton) {
  const render = () => {
    const input = hub.midi.getInput(hub.midi.selectedInputId);
    const output = hub.midi.getOutput(hub.midi.selectedOutputId);

    rootEl.innerHTML = `
      <div class="modal">
        <h2>Settings</h2>
        <div class="modal-sub">Application preferences are saved locally.</div>
        <div class="kv"><span class="k">MIDI Input</span><span class="v">${
          input ? input.name : 'None'
        }</span></div>
        <div class="kv"><span class="k">MIDI Output</span><span class="v">${
          output ? output.name : 'None'
        }</span></div>
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

    rootEl.addEventListener('click', (e) => {
      if (e.target === rootEl) hide();
    });
  };

  const show = () => {
    rootEl.classList.remove('hidden');
    render();
  };
  const hide = () => rootEl.classList.add('hidden');

  openButton.addEventListener('click', show);
  return { show, hide };
}
