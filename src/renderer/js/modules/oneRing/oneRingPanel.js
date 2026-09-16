import { escapeHtml } from '../../core/html.js';
import { registerNodeEditor } from '../../core/nodeEditors.js';

/**
 * A One Ring node's page, for now.
 *
 * What the node needs to be tried before its real page exists: whether it
 * runs, where each channel of the playing scene is, and the controls that run
 * it, stop it and change its scene. The faceplate after the author's hardware
 * references -- every control of the VST's editor -- is steps 6 to 8 of
 * plans/active/one-ring-native.md, and replaces this file's markup.
 *
 * The status arrives up to sixty times a second, so it moves classes on the
 * cells already drawn; only a change of scene or of the sequence redraws.
 */

function channelTarget(channel) {
  const { target, command } = channel.target;
  return target || command ? `${target} · ${command}` : 'no target';
}

function channelRow(channel, index, status) {
  const listed = new Map(channel.steps.map((step) => [step.index, step]));
  const cells = Array.from({ length: channel.length }, (_, k) => {
    const on = (listed.get(k) ?? channel.blank).enabled;
    const playing = status?.playheads[index] === k;
    return `<i class="one-ring-cell${on ? ' on' : ''}${playing ? ' playing' : ''}" data-one-ring-cell="${k}"></i>`;
  }).join('');
  const classes = ['one-ring-channel', channel.enabled ? '' : 'disabled', status?.active[index] ? 'active' : '']
    .filter(Boolean).join(' ');
  return `<li class="${classes}" data-one-ring-channel="${index}">
    <span class="one-ring-channel-name">CH${String(index + 1).padStart(2, '0')}</span>
    <span class="one-ring-channel-target">${escapeHtml(channelTarget(channel))}</span>
    <span class="one-ring-cells">${cells}</span>
  </li>`;
}

function stateText(status, ready) {
  if (!ready) return 'Not running in the engine';
  if (!status) return 'Ready';
  const parts = [status.playing ? 'Running' : 'Stopped', `beat ${status.beat.toFixed(2)}`, `${Math.round(status.bpm)} BPM`];
  if (status.rejected > 0) parts.push(`${status.rejected} refused`);
  return parts.join(' · ');
}

function render({ instance, hub }) {
  const content = instance.content;
  const ready = hub.oneRing?.generationOf(instance.id) !== null;
  const status = hub.oneRing?.statusOf(instance.id) ?? null;
  const shown = content.scenes[status?.scene] ? status.scene : content.selectedScene;
  const scene = content.scenes[shown] ?? content.scenes[0];
  const disabled = ready ? '' : ' disabled';
  const scenes = content.scenes.map((item, i) => `<button type="button" class="btn one-ring-scene${i === shown ? ' active' : ''}" data-one-ring-scene="${i}" aria-pressed="${i === shown}" title="${escapeHtml(item.name)}"${disabled}>${escapeHtml(item.id)}</button>`).join('');
  return `<section class="panel one-ring-panel" data-one-ring data-one-ring-shown="${shown}">
    <div class="one-ring-head">
      <button type="button" class="btn" data-one-ring-command="run"${disabled}>RUN</button>
      <button type="button" class="btn" data-one-ring-command="stop"${disabled}>STOP</button>
      <span class="one-ring-state" data-one-ring-state>${escapeHtml(stateText(status, ready))}</span>
      <span class="one-ring-scenes">${scenes}</span>
    </div>
    <p class="one-ring-refusal" data-one-ring-refusal hidden></p>
    <ol class="one-ring-channels">${scene.channels.map((channel, c) => channelRow(channel, c, status)).join('')}</ol>
  </section>`;
}

function update(container, status, ready) {
  const state = container.querySelector('[data-one-ring-state]');
  if (state) state.textContent = stateText(status, ready);
  for (const row of container.querySelectorAll('[data-one-ring-channel]')) {
    const index = Number(row.dataset.oneRingChannel);
    row.classList.toggle('active', status.active[index] === true);
    for (const cell of row.querySelectorAll('[data-one-ring-cell]')) {
      cell.classList.toggle('playing', Number(cell.dataset.oneRingCell) === status.playheads[index]);
    }
  }
}

function showRefusal(container, message) {
  const line = container.querySelector('[data-one-ring-refusal]');
  if (!line) return;
  line.textContent = message;
  line.hidden = !message;
}

function bind(container, context) {
  const { instance, hub } = context;
  const nodeId = instance.id;
  const repaint = () => { container.innerHTML = render(context); };
  const onClick = (event) => {
    const button = event.target?.closest?.('[data-one-ring-command], [data-one-ring-scene]');
    if (!button || !container.contains(button) || button.disabled) return;
    if (button.dataset.oneRingCommand) hub.oneRing.command(nodeId, button.dataset.oneRingCommand);
    else hub.oneRing.command(nodeId, 'scene', { scene: Number(button.dataset.oneRingScene) });
  };
  container.addEventListener('click', onClick);
  const mine = (handler) => (msg) => { if (msg?.nodeId === nodeId) handler(msg); };
  const offs = [
    hub.events.on('oneRing:status', mine(({ status }) => {
      const shown = container.querySelector('[data-one-ring]')?.dataset.oneRingShown;
      if (String(status.scene) !== shown) repaint();
      else update(container, status, true);
    })),
    hub.events.on('oneRing:ready', mine(repaint)),
    hub.events.on('oneRing:gone', mine(repaint)),
    hub.events.on('oneRing:contentChanged', mine(repaint)),
    hub.events.on('oneRing:refusal', mine(({ message }) => showRefusal(container, message))),
    hub.events.on('oneRing:refused', mine(({ message }) => showRefusal(container, `Sequence refused: ${message}`)))
  ];
  return () => {
    container.removeEventListener('click', onClick);
    for (const off of offs) off();
  };
}

/** Install the page. Returns its unregister function, as `registerNodeEditor` does. */
export function registerOneRingPanel() {
  return registerNodeEditor('one-ring', { render, bind });
}
