import { registerNodeEditor } from '../../core/nodeEditors.js';
import { escapeHtml } from '../../core/html.js';
import { LEVEL_MAX, fileNameOf, formatPlayerTime } from '../../core/audioPlayerState.js';

/**
 * The Audio Player node's page: its file, the file's overview, and a player.
 *
 * PLAYING IS NOT EDITING
 * ----------------------
 * Play, Pause, Stop, the steps back and forward and a click on the overview go
 * to the engine's player (`hub.audioPlayers`) and leave the project alone. The
 * file, the loop, the level and the mute are the node's content, written through
 * `hub.nodes.setContent`: an undo step each. A level being dragged is heard as it moves -- the engine is given
 * each value at once -- and written once, when the slider is let go.
 *
 * WHAT IS REDRAWN
 * ---------------
 * The page is drawn again when what the engine says of the file changes, or the
 * content does. Where the player is arrives ten times a second and never
 * redraws: it moves the playhead and the time in place, and between two reports
 * the playhead runs on by itself, one frame at a time, as the file does.
 */

const WAVE_WIDTH = 512;
const WAVE_HEIGHT = 100;
/**
 * How far the step buttons move the player. What a media player's skip does:
 * enough to hear a passage again, short enough not to lose where you were.
 */
export const SKIP_SECONDS = 5;

/**
 * Where a step lands. Back stops at the start, as any player's does -- a loop
 * is not a reason to be thrown to the end of the file. Forward past the end
 * goes round a looping player, which is where it would be playing, and stops
 * at the end of one that does not loop.
 */
export function skipTarget(seconds, delta, durationSeconds, loop) {
  const duration = Number(durationSeconds);
  if (!(duration > 0)) return 0;
  const target = Math.max(0, (Number(seconds) || 0) + delta);
  if (target < duration) return target;
  return loop ? target % duration : duration;
}

const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;

const now = () => globalThis.performance?.now?.() ?? Date.now();

/** The overview as one closed shape: the peaks above the middle, mirrored below. */
export function waveformPath(peaks) {
  if (!Array.isArray(peaks) || peaks.length === 0) return '';
  const middle = WAVE_HEIGHT / 2;
  const reach = middle - 2;
  const x = (i) => ((i + 0.5) * WAVE_WIDTH / peaks.length).toFixed(2);
  const height = (peak) => Math.max(0.5, Math.min(1, Number(peak) || 0) * reach);
  let path = '';
  peaks.forEach((peak, i) => { path += `${i === 0 ? 'M' : 'L'}${x(i)} ${(middle - height(peak)).toFixed(2)}`; });
  for (let i = peaks.length - 1; i >= 0; i -= 1) path += `L${x(i)} ${(middle + height(peaks[i])).toFixed(2)}`;
  return `${path}Z`;
}

/** What the page shows: the node's file, and what the engine said of that file. */
function viewOf(hub, instance) {
  const content = instance.content || {};
  const path = content.filePath || '';
  const answer = hub.audioPlayers?.fileOf?.(instance.id) ?? null;
  // An answer about another path is an old one: the file named now is loading.
  const file = answer && answer.filePath === path ? answer : null;
  let state;
  if (!path) state = 'empty';
  else if (hub.engine?.state !== 'running') state = 'offline';
  else state = file?.state ?? 'loading';
  const ready = state === 'ready' && file.durationSeconds > 0;
  return { content, path, file, state: state === 'ready' && !ready ? 'error' : state, ready };
}

function noteOf(view) {
  switch (view.state) {
    case 'empty': return 'No file yet. Choose a WAV, MP3, AIFF, FLAC or OGG file.';
    case 'offline': return 'The audio engine is not running.';
    case 'loading': return `Loading ${fileNameOf(view.path)}…`;
    case 'error': return view.file?.message || 'MiniHub cannot play this file.';
    default: return '';
  }
}

function describeFile(file) {
  const channels = file.channels === 1 ? 'mono' : file.channels === 2 ? 'stereo'
    : file.channels > 2 ? `${file.channels} channels, the first two played` : '';
  const rate = file.sampleRate > 0 ? `${Number((file.sampleRate / 1000).toFixed(1))} kHz` : '';
  return [formatPlayerTime(file.durationSeconds), rate, channels].filter(Boolean).join(' · ');
}

const levelText = (level) => `${Math.round(level * 100)}%`;

function render({ instance, type, hub }) {
  const view = viewOf(hub, instance);
  const level = Number.isFinite(view.content.level) ? view.content.level : 1;
  const name = view.path ? fileNameOf(view.path) : 'No file';
  const overview = view.ready
    ? `<svg class="ap-wave-svg" viewBox="0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}" preserveAspectRatio="none" aria-hidden="true">`
      + `<path class="ap-wave-shape" d="${waveformPath(view.file.peaks)}"/>`
      + `<line class="ap-playhead" data-ap-playhead x1="0" x2="0" y1="0" y2="${WAVE_HEIGHT}"/></svg>`
    : `<p class="ap-wave-note">${escapeHtml(noteOf(view))}</p>`;
  const disabled = view.ready ? '' : ' disabled';
  const muted = view.content.muted === true;
  return `<div class="panel audio-player" data-audio-player>
    <div class="row"><h1 class="page-title">${escapeHtml(instance.name)}</h1><span class="spacer"></span><span class="pill accent-${type.id}">${escapeHtml(type.label)}</span></div>
    <div class="panel mt-16 ap-deck">
      <div class="ap-file-row">
        <div class="ap-file">
          <div class="ap-file-name"${view.path ? ` title="${escapeHtml(view.path)}"` : ''}>${escapeHtml(name)}</div>
          <div class="ap-file-meta muted">${view.ready ? escapeHtml(describeFile(view.file)) : ''}</div>
        </div>
        <button type="button" class="btn" data-ap-act="choose">${view.path ? 'Replace File…' : 'Choose File…'}</button>
      </div>
      <div class="ap-wave ap-wave--${view.state}" data-ap-wave${view.ready ? ' title="Click to move the player here"' : ''}>${overview}</div>
      <div class="ap-transport">
        <button type="button" class="btn ap-nav" data-ap-act="start" title="Back to the start" aria-label="Back to the start"${disabled}>${icon('M5 4v16M19 5l-10 7 10 7z')}</button>
        <button type="button" class="btn ap-nav" data-ap-act="back" title="Back ${SKIP_SECONDS} seconds" aria-label="Back ${SKIP_SECONDS} seconds"${disabled}>${icon('M11 5l-7 7 7 7zM20 5l-7 7 7 7z')}</button>
        <button type="button" class="btn ap-play" data-ap-act="play" aria-pressed="false"${disabled}>Play</button>
        <button type="button" class="btn" data-ap-act="stop"${disabled}>Stop</button>
        <button type="button" class="btn ap-nav" data-ap-act="forward" title="Forward ${SKIP_SECONDS} seconds" aria-label="Forward ${SKIP_SECONDS} seconds"${disabled}>${icon('M13 5l7 7-7 7zM4 5l7 7-7 7z')}</button>
        <span class="ap-time" data-ap-time>${view.ready ? `0:00.0 / ${formatPlayerTime(view.file.durationSeconds)}` : ''}</span>
        <span class="spacer"></span>
        <label class="ap-check"><input type="checkbox" data-ap-act="loop"${view.content.loop ? ' checked' : ''}> Loop</label>
        <button type="button" class="btn ap-mute${muted ? ' active' : ''}" data-ap-act="mute" aria-pressed="${muted}" title="${muted ? 'Muted: this player alone is silent. Click to hear it' : 'Mute this player, and nothing else'}">Mute</button>
        <label class="ap-level">Level <input type="range" min="0" max="${LEVEL_MAX}" step="0.01" value="${level}" data-ap-act="level"></label>
        <span class="ap-level-value" data-ap-level>${levelText(level)}</span>
      </div>
      <p class="muted ap-hint">Cable AUDIO OUT into a VST node's AUDIO IN to process the file. The Play, Pause and Stop at the top of MiniHub drive this player too.</p>
    </div>
    <div class="row mt-16"><span class="spacer"></span><button id="node-delete" class="btn danger">Delete Node</button></div>
  </div>`;
}

function bind(container, context) {
  const { instance, hub } = context;
  const nodeId = instance.id;
  let frame = 0;
  let running = hub.engine?.state === 'running';

  /** Where the player is now: its last report, carried on while it plays. */
  const position = () => {
    const view = viewOf(hub, instance);
    const status = hub.audioPlayers?.statusOf?.(nodeId) ?? null;
    if (!view.ready || !status) return { view, seconds: 0, playing: false };
    const duration = view.file.durationSeconds;
    const playing = status.state === 'playing';
    let seconds = status.positionSeconds;
    if (playing) {
      seconds += Math.max(0, now() - status.at) / 1000;
      if (seconds >= duration) seconds = view.content.loop ? seconds % duration : duration;
    }
    return { view, seconds: Math.min(seconds, duration), playing };
  };

  const applyStatus = () => {
    const { view, seconds, playing } = position();
    const play = container.querySelector('[data-ap-act="play"]');
    if (play) {
      const text = playing ? 'Pause' : 'Play';
      if (play.textContent !== text) play.textContent = text;
      play.setAttribute('aria-pressed', String(playing));
      play.classList.toggle('playing', playing);
    }
    if (view.ready) {
      const duration = view.file.durationSeconds;
      const time = container.querySelector('[data-ap-time]');
      const text = `${formatPlayerTime(seconds)} / ${formatPlayerTime(duration)}`;
      if (time && time.textContent !== text) time.textContent = text;
      const head = container.querySelector('[data-ap-playhead]');
      if (head) {
        const x = ((seconds / duration) * WAVE_WIDTH).toFixed(2);
        head.setAttribute('x1', x);
        head.setAttribute('x2', x);
      }
    }
    if (playing && !frame && typeof globalThis.requestAnimationFrame === 'function') {
      frame = globalThis.requestAnimationFrame(() => {
        frame = 0;
        applyStatus();
      });
    }
  };

  const repaint = () => {
    container.innerHTML = render(context);
    applyStatus();
  };

  const write = (changes) => hub.nodes.setContent(nodeId, { ...instance.content, ...changes });

  const choose = async () => {
    const path = await hub.api?.audioPickOpen?.();
    if (!path || !hub.nodes.get(nodeId)) return;
    // The same file chosen again is read again: it may have been saved since.
    if (path === instance.content.filePath) hub.audioPlayers?.reload?.(nodeId);
    else write({ filePath: path });
  };

  const onClick = (event) => {
    const control = event.target?.closest?.('[data-ap-act]');
    if (control && container.contains(control)) {
      if (control.disabled) return;
      const act = control.dataset.apAct;
      if (act === 'choose') choose();
      else if (act === 'play') {
        if (hub.audioPlayers?.statusOf?.(nodeId)?.state === 'playing') hub.audioPlayers.pause(nodeId);
        else hub.audioPlayers?.play?.(nodeId);
      } else if (act === 'stop') hub.audioPlayers?.stop?.(nodeId);
      else if (act === 'start') hub.audioPlayers?.seek?.(nodeId, 0);
      else if (act === 'back' || act === 'forward') {
        const { view, seconds } = position();
        if (!view.ready) return;
        const delta = act === 'back' ? -SKIP_SECONDS : SKIP_SECONDS;
        hub.audioPlayers?.seek?.(nodeId, skipTarget(seconds, delta, view.file.durationSeconds, view.content.loop === true));
      } else if (act === 'mute') write({ muted: instance.content.muted !== true });
      return;
    }
    const wave = event.target?.closest?.('[data-ap-wave]');
    if (!wave || !container.contains(wave)) return;
    const view = viewOf(hub, instance);
    const box = wave.getBoundingClientRect?.();
    if (!view.ready || !(box?.width > 0)) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    hub.audioPlayers?.seek?.(nodeId, fraction * view.file.durationSeconds);
  };

  const levelOf = (input) => Math.max(0, Math.min(LEVEL_MAX, Number(input.value) || 0));

  const onInput = (event) => {
    const input = event.target;
    if (input?.dataset?.apAct !== 'level' || !container.contains(input)) return;
    const level = levelOf(input);
    const label = container.querySelector('[data-ap-level]');
    if (label) label.textContent = levelText(level);
    // Heard as it moves: a value of the running network, not a new one. A
    // muted player's level moves in silence, and is heard once unmuted.
    if (instance.content.muted === true) return;
    hub.engine?.setAudioNodeValues?.([{ id: nodeId, inputs: [], masterLevel: level }]);
  };

  const onChange = (event) => {
    const input = event.target;
    if (!input?.dataset?.apAct || !container.contains(input)) return;
    if (input.dataset.apAct === 'loop') write({ loop: input.checked === true });
    else if (input.dataset.apAct === 'level') write({ level: levelOf(input) });
  };

  const listeners = [['click', onClick], ['input', onInput], ['change', onChange]];
  for (const [type, listener] of listeners) container.addEventListener(type, listener);

  const mine = (handler) => (message) => {
    if (message?.nodeId === nodeId) handler(message);
  };
  const offs = [
    hub.events.on('audioPlayer:file', mine(repaint)),
    hub.events.on('audioPlayer:status', mine(applyStatus)),
    hub.events.on('audioPlayer:gone', mine(repaint)),
    hub.events.on('audioPlayer:contentChanged', mine(repaint)),
    hub.events.on('engine:state', (state) => {
      const up = state?.state === 'running';
      if (up === running) return;
      running = up;
      repaint();
    }),
    // nodeInstances.js has just drawn the page again from `render`.
    hub.events.on('history:applied', applyStatus)
  ];
  applyStatus();

  return () => {
    for (const [type, listener] of listeners) container.removeEventListener(type, listener);
    for (const off of offs) off();
    if (frame && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(frame);
    frame = 0;
  };
}

/** Install the page. Returns its unregister function, as `registerNodeEditor` does. */
export function registerAudioPlayerPanel() {
  return registerNodeEditor('audio-player', { render, bind });
}
