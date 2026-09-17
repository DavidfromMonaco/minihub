import { escapeHtml } from '../../core/html.js';
import {
  CAPTURE_MODE, LONGEST_DURATION, NOTE_ORDER, ROOT_NAMES, SCALE_NAMES, SHORTEST_DURATION, TICKS_PER_BAR,
  TICKS_PER_BEAT, VOICE_COUNT, VOICE_RULES, WRITE_MODE
} from '../../core/oneRingSequence.js';
import { pearlKeycap, pearlLcd, pearlLegend } from '../../ui/omniPearl.js';
import { act, field, knobControl, lever, noteName, optionTag, selectBox, selectorControl } from './oneRingParts.js';

/**
 * Part two's tabs of the One Ring page: MEMORY (what MIDI IN captures, and the
 * notes the voices play from), VOICES (what each voice does to them, per
 * scene) and WRITER (the generations written into the Sequencer, and
 * feedback). Drawn from the same `view` as the rest of the page
 * (oneRingFaceplate.js), in the same faceplate.
 *
 * What the engine reports -- a capture armed, notes sounding, generations
 * sent, feedback running -- is not drawn here: each carries a `data-ring-live*`
 * hook the panel lights in place, as the deck's display is.
 */

// ---------- memory ----------

const CAPTURE_STATES = Object.freeze({ off: 'OFF', armed: 'ARMED', capturing: 'CAPTURING' });

export function renderCapture(view) {
  const { capture } = view.content;
  const adding = capture.mode === CAPTURE_MODE.add;
  const status = view.status;
  const state = view.ready ? CAPTURE_STATES[status?.capture] ?? 'OFF' : '—';
  const readout = (label, value, hook) => `<span class="op-legend">${escapeHtml(label)}</span>${pearlLcd({ value, size: 'readout', attrs: `data-ring-live="${hook}"` })}`;
  return `<div class="op-panel-head"><span class="op-label accent">Capture</span><span class="op-hint">What reaches MIDI IN: a Sequencer track aimed at this node, or a controller cabled to it</span></div>
    <div class="op-ring-controls">
      <div class="op-ring-control">${pearlKeycap({ label: 'Capture', size: 'tall', title: 'Capture: at the next bar of what plays, or at once when nothing plays', disabled: !view.ready, attrs: `${act('capture')} data-ring-live-key="capture"` })}${pearlLegend(adding ? 'Adds to the origin' : 'Replaces the origin')}</div>
      <div class="op-ring-control">${pearlKeycap({ label: 'End', size: 'tall', title: 'End the capture now', disabled: !view.ready, attrs: act('capture-end') })}${pearlLegend('Ends it now')}</div>
      <span class="op-ring-sep"></span>
      <div class="op-ring-control op-ring-control--lever">${lever('capture-mode', 'Replace', 'Add', adding)}${pearlLegend('What it takes')}</div>
      <span class="op-ring-sep"></span>
      ${knobControl('capture-bars', view)}
    </div>
    <div class="op-ring-readouts">
      ${readout('State', state, 'capture-state')}
      ${readout('Notes taken', String(status?.captured ?? 0), 'capture-taken')}
      ${readout('Refused', String(status?.captureRefused ?? 0), 'capture-refused')}
    </div>
    <p class="op-ring-note">A capture keeps what starts inside its window; a note still held when it ends ends there. Past 256 notes the rest is refused. A sequence captures too, through One Ring · Memory.</p>`;
}

/**
 * The notes of a list over its length, as a small piano roll. Everything that
 * varies is SVG geometry, since the page may carry no style attribute.
 */
function materialRoll(list, label) {
  const length = Math.max(1, list.length);
  if (!list.notes.length) {
    return `<div class="op-ring-roll is-empty" role="img" aria-label="${escapeHtml(`${label}: no notes`)}"><span>No notes</span></div>`;
  }
  const pitches = list.notes.map((note) => note.pitch);
  let low = Math.min(...pitches) - 2;
  let high = Math.max(...pitches) + 2;
  if (high - low < 24) {
    const widen = Math.ceil((24 - (high - low)) / 2);
    low -= widen;
    high += widen;
  }
  low = Math.max(0, low);
  high = Math.min(127, high);
  const rows = high - low + 1;
  const shaded = [];
  for (let pitch = low; pitch <= high; pitch += 1) {
    if (pitch % 12 === 0) shaded.push(`<rect class="c-row" x="0" y="${high - pitch}" width="${length}" height="1"></rect>`);
  }
  const lines = [];
  for (let tick = 0; tick <= length; tick += TICKS_PER_BEAT) {
    lines.push(`<line class="${tick % TICKS_PER_BAR === 0 ? 'bar' : 'beat'}" x1="${tick}" y1="0" x2="${tick}" y2="${rows}"></line>`);
  }
  const minimum = length / 400;
  const notes = list.notes.map((note) => `<rect class="note" x="${note.start}" y="${high - note.pitch + 0.12}" width="${Math.max(minimum, note.duration)}" height="0.76"><title>${escapeHtml(`${noteName(note.pitch)} · velocity ${note.velocity} · channel ${note.channel}`)}</title></rect>`);
  return `<div class="op-ring-rollframe">
      <span class="op-ring-rollpitch"><span>${escapeHtml(noteName(high))}</span><span>${escapeHtml(noteName(low))}</span></span>
      <svg class="op-ring-roll" viewBox="0 0 ${length} ${rows}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(`${label}: ${list.notes.length} notes`)}">${shaded.join('')}${lines.join('')}${notes.join('')}</svg>
    </div>`;
}

const barsOf = (ticks) => {
  const bars = ticks / TICKS_PER_BAR;
  return `${Number.isInteger(bars) ? bars : bars.toFixed(2)} bar${bars === 1 ? '' : 's'}`;
};

export function renderMaterial(view) {
  const { material } = view.content;
  const current = view.materialView === 'current' && material.current !== null;
  const list = current ? material.current : material.origin;
  const origin = `origin: ${material.origin.notes.length} notes, ${barsOf(material.origin.length)}`;
  const generation = material.current
    ? `generation ${material.generation}: ${material.current.notes.length} notes, ${barsOf(material.current.length)}`
    : 'no generation yet: the voices play the origin';
  const shown = [
    pearlKeycap({ label: 'Origin', size: 'sm', state: current ? '' : 'white', pressed: !current, attrs: act('material-view', 'origin') }),
    pearlKeycap({ label: 'Current', size: 'sm', state: current ? 'white' : '', pressed: current, disabled: material.current === null, attrs: act('material-view', 'current') })
  ].join('');
  const empty = material.origin.notes.length === 0 && material.current === null;
  const keys = [
    pearlKeycap({ label: 'Freeze', size: 'sm', led: material.frozen, pressed: material.frozen, title: 'Frozen, nothing a sequence does changes the material', attrs: act('freeze') }),
    pearlKeycap({ label: 'Revert', size: 'sm', disabled: material.current === null, title: 'Drop the current generation: the voices play the origin again', attrs: act('revert') }),
    pearlKeycap({ label: 'Clear', size: 'sm', disabled: empty, title: 'Empty the origin and the current generation', attrs: act('clear') })
  ].join('');
  const clips = view.clips.map((clip) => optionTag(clip.id, clip.label, clip.id === view.loadChoice)).join('');
  const chosen = view.clips.some((clip) => clip.id === view.loadChoice);
  const load = `${selectBox(`${optionTag('', view.clips.length ? '— A MIDI clip —' : 'No MIDI clip in the Sequencer', !chosen, true)}${clips}`,
    `${view.clips.length ? '' : 'disabled '}${act('load-choice')} data-ring-focus="load-choice"`, 'A MIDI clip to load', 'op-select--wide')}
    ${pearlKeycap({ label: 'Load', size: 'sm', disabled: !chosen, title: 'The clip\'s notes become the origin', attrs: act('load-clip') })}`;
  const error = view.materialError ? pearlLegend(view.materialError, { state: 'error' }) : '';
  return `<div class="op-panel-head"><span class="op-label accent">Material</span><span class="op-hint">${escapeHtml(`${origin} · ${generation}${material.frozen ? ' · frozen' : ''}`)}</span></div>
    <div class="op-ring-materialbar">
      ${field('Showing', `<span class="op-keycap-row">${shown}</span>`)}
      ${field('The material', `<span class="op-keycap-row">${keys}</span>`)}
      <span class="op-spacer"></span>
      ${field('Load a clip as the origin', `<span class="op-ring-load">${load}</span>`)}
    </div>
    ${error ? `<div class="op-ring-materialerror">${error}</div>` : ''}
    ${materialRoll(list, current ? 'The current generation' : 'The origin')}`;
}

// ---------- voices ----------

const ORDER_OPTIONS = [
  { value: NOTE_ORDER.asPlayed, label: 'Played' },
  { value: NOTE_ORDER.rising, label: 'Up' },
  { value: NOTE_ORDER.falling, label: 'Down' },
  { value: NOTE_ORDER.shuffled, label: 'Shuffle' }
];
const DURATIONS = [
  [SHORTEST_DURATION, '1/64'], [TICKS_PER_BEAT / 8, '1/32'], [TICKS_PER_BEAT / 4, '1/16'], [TICKS_PER_BEAT / 2, '1/8'],
  [TICKS_PER_BEAT, '1/4'], [TICKS_PER_BEAT * 2, '1/2'], [TICKS_PER_BAR, '1 bar'], [TICKS_PER_BAR * 2, '2 bars'],
  [TICKS_PER_BAR * 4, '4 bars'], [TICKS_PER_BAR * 8, '8 bars'], [LONGEST_DURATION, '16 bars']
];
/** The rules a channel's commands move while the voice plays, and how the page shows them. */
const LIVE_RULES = [
  ['transpose', (v) => `transpose ${v > 0 ? '+' : ''}${v}`],
  ['octave', (v) => `octave ${v > 0 ? '+' : ''}${v}`],
  ['root', (v) => `root ${ROOT_NAMES[v]}`],
  ['scale', (v) => SCALE_NAMES[v]],
  ['velocityScale', (v) => `velocity ${v} %`],
  ['gateScale', (v) => `gate ${v} %`],
  ['density', (v) => `density ${v} %`]
];

/** What a running voice plays by now, where it differs from its scene's rules. */
export function liveRulesText(live, rules) {
  if (!live || !rules) return '—';
  const moved = LIVE_RULES.filter(([rule]) => live[rule] !== rules[rule]).map(([rule, text]) => text(live[rule]));
  return moved.length ? moved.join(' · ') : 'as the scene sets it';
}

function durationSelect(rule, value, label) {
  const listed = DURATIONS.some(([ticks]) => ticks === value);
  const other = listed ? '' : optionTag(value, `${value / TICKS_PER_BEAT} beats`, true);
  const options = DURATIONS.map(([ticks, text]) => optionTag(ticks, text, ticks === value)).join('');
  return field(label, selectBox(`${other}${options}`, `${act('voice-rule', rule)} data-ring-focus="voice-${rule}"`, label));
}

function group(label, controls) {
  return `<div class="op-ring-voicegroup"><span class="op-label">${escapeHtml(label)}</span><div class="op-ring-voicecontrols">${controls}</div></div>`;
}

export function renderVoices(view) {
  const voice = view.voiceIndex;
  const rules = view.voiceRules;
  const keys = Array.from({ length: VOICE_COUNT }, (_, v) => `<div class="op-ring-keyset">${pearlKeycap({
    label: String(v + 1), size: 'sq', state: v === voice ? 'white' : '', pressed: v === voice, led: false,
    ledAttrs: `data-ring-live-voice="${v}"`, title: `Voice ${v + 1}`, attrs: act('voice', v)
  })}<span class="op-legend" data-ring-live="voice-sounding-${v}">${view.status?.sounding?.[v] ?? 0} sounding</span></div>`).join('');
  const channels = [optionTag(0, 'Their own', rules.channel === 0),
    ...Array.from({ length: 16 }, (_, c) => optionTag(c + 1, `Channel ${c + 1}`, rules.channel === c + 1))].join('');
  const roots = ROOT_NAMES.map((name, i) => optionTag(i, name, rules.root === i)).join('');
  const scales = SCALE_NAMES.map((name, i) => optionTag(i, name, rules.scale === i)).join('');
  const pitch = group('Pitch', `
      ${field('Root', selectBox(roots, `${act('voice-rule', 'root')} data-ring-focus="voice-root"`, 'Root'), 'op-ring-field--short')}
      ${field('Scale', selectBox(scales, `${act('voice-rule', 'scale')} data-ring-focus="voice-scale"`, 'Scale'))}
      <span class="op-ring-sep"></span>
      ${knobControl('voice-transpose', view)}
      ${knobControl('voice-octave', view)}
      ${knobControl('voice-octaveSpread', view)}
      ${knobControl('voice-octaveChance', view)}`);
  const range = group('Range', `${knobControl('voice-low', view)}${knobControl('voice-high', view)}`);
  const velocity = group('Velocity', `
      ${knobControl('voice-velocityScale', view)}
      ${knobControl('voice-velocitySpread', view)}
      ${knobControl('voice-velocityLow', view)}
      ${knobControl('voice-velocityHigh', view)}`);
  const length = group('Length', `
      ${knobControl('voice-gateScale', view)}
      ${knobControl('voice-gateSpread', view)}
      <span class="op-ring-sep"></span>
      <div class="op-ring-fieldstack">
        ${durationSelect('shortest', rules.shortest, 'Shortest')}
        ${durationSelect('longest', rules.longest, 'Longest')}
      </div>`);
  const play = group('Playing', `
      ${selectorControl('voice-order', 'Order', ORDER_OPTIONS, rules.order)}
      ${knobControl('voice-density', view)}
      <span class="op-ring-sep"></span>
      ${field('MIDI channel', selectBox(channels, `${act('voice-rule', 'channel')} data-ring-focus="voice-channel"`, 'MIDI channel'))}`);
  const neutral = Object.entries(VOICE_RULES).every(([rule, { neutral: value }]) => rules[rule] === value);
  const live = view.ready ? liveRulesText(view.status?.voices?.[voice], rules) : '—';
  return `<div class="op-panel-head"><span class="op-label accent">Voices</span><span class="op-hint">Scene ${escapeHtml(view.sceneData.id)} · a channel plays a voice by aiming at One Ring · Voice N: PLAY a slot of the material, NOTE one of its notes</span></div>
    <div class="op-ring-voicehead">
      <div class="op-ring-keys">${keys}</div>
      <span class="op-ring-sep"></span>
      ${field(`Voice ${voice + 1} now`, pearlLcd({ value: live, size: 'live', attrs: 'data-ring-live="voice-live"' }))}
      ${field('Refused', pearlLcd({ value: String(view.status?.notesRefused ?? 0), size: 'readout', attrs: 'data-ring-live="voice-refused"' }))}
      <span class="op-spacer"></span>
      ${pearlKeycap({ label: `Reset voice ${voice + 1}`, size: 'sm', disabled: neutral, title: 'Every rule back to what changes nothing', attrs: act('voice-reset') })}
    </div>
    <div class="op-ring-voicegroups">${pitch}${range}${velocity}${length}${play}</div>`;
}

// ---------- writer ----------

const WRITE_MODES = [
  [WRITE_MODE.newTrack, 'New track', 'Each generation becomes a MIDI track of its own'],
  [WRITE_MODE.replace, 'Replace clip', 'Each generation replaces the notes of the clip chosen'],
  [WRITE_MODE.add, 'Add to clip', 'Each generation joins the notes of the clip chosen']
];

export function renderWriter(view) {
  const { writer } = view;
  const status = view.status;
  const newTrack = writer.mode === WRITE_MODE.newTrack;
  const modes = WRITE_MODES.map(([mode, label, title]) => pearlKeycap({
    label, size: 'sm', state: writer.mode === mode ? 'lit' : '', pressed: writer.mode === mode, title, attrs: act('write-mode', mode)
  })).join('');
  const clipKnown = view.clips.some((clip) => clip.id === writer.clipId);
  const gone = writer.clipId && !clipKnown ? optionTag(writer.clipId, 'A clip no longer there', true) : '';
  const clips = view.clips.map((clip) => optionTag(clip.id, clip.label, clip.id === writer.clipId)).join('');
  const clipSelect = selectBox(`${optionTag('', view.clips.length ? '— Choose a MIDI clip —' : 'No MIDI clip in the Sequencer', !writer.clipId)}${gone}${clips}`,
    `${act('writer-clip')} data-ring-focus="writer-clip"`, 'The clip written into', `op-select--wide${newTrack ? ' is-idle' : ''}`);
  const destinationKnown = view.destinations.some((node) => node.id === writer.destination);
  const lost = writer.destination && !destinationKnown ? optionTag(writer.destination, `${writer.destination} (gone)`, true) : '';
  const destinations = view.destinations.map((node) => optionTag(node.id, node.label, node.id === writer.destination)).join('');
  const destinationSelect = selectBox(`${optionTag('', '— None: give it one later —', !writer.destination)}${lost}${destinations}`,
    `${act('writer-destination')} data-ring-focus="writer-destination"`, 'What a new track plays', `op-select--wide${newTrack ? '' : ' is-idle'}`);
  const readout = (label, value, hook) => `<span class="op-legend">${escapeHtml(label)}</span>${pearlLcd({ value, size: 'readout', attrs: `data-ring-live="${hook}"` })}`;
  const next = newTrack ? `The next one: “${view.name} Generation ${writer.written + 1}”` : `${writer.written} written so far`;
  return `<div class="op-panel-head"><span class="op-label accent">Writer</span><span class="op-hint">A channel aimed at One Ring · Writer WRITEs what the voices played over the window; a step at a bar's start is the boundary</span></div>
    <div class="op-ring-writergrid">
      <div class="op-ring-writerplay">
        <div class="op-ring-keys">
          <div class="op-ring-control">${pearlKeycap({ label: 'Write', size: 'tall', disabled: !view.ready, title: 'Write what the voices played over the window, now', attrs: act('write') })}${pearlLegend('Now')}</div>
          <div class="op-ring-control">${pearlKeycap({ label: 'Feedback', size: 'tall', disabled: !view.ready, title: 'Feedback on or off while the node runs', attrs: `${act('feedback-live')} data-ring-live-key="feedback"` })}${pearlLegend('While it runs')}</div>
        </div>
        <div class="op-ring-readouts">
          ${readout('Feedback', view.ready ? (status?.feedbackStopped ? 'STOPPED AT ITS LIMIT' : status?.feedback ? 'ON' : 'OFF') : '—', 'writer-feedback')}
          ${readout('Sent', String(status?.writes ?? 0), 'writer-sent')}
          ${readout('Written', String(view.writes?.written ?? 0), 'writer-written')}
          ${readout('Refused', String(view.writes?.refused ?? 0), 'writer-refused')}
          ${readout('Heard nothing', String(status?.writesEmpty ?? 0), 'writer-empty')}
          ${readout('Last refusal', view.writes?.lastRefusal || '—', 'writer-last')}
        </div>
      </div>
      <div class="op-ring-writerset">
        <div class="op-ring-writerrow">
          ${field('Where a generation goes', `<span class="op-keycap-row">${modes}</span>`)}
          ${knobControl('writer-bars', view)}
          <span class="op-ring-sep"></span>
          ${field('Clip (replace, add)', clipSelect)}
          ${field('Track plays (new track)', destinationSelect)}
        </div>
        <div class="op-ring-writerrow">
          ${field('Feedback', `<label class="op-switch"><input class="op-native" type="checkbox" aria-label="Feedback, as the sequence starts"${writer.feedback ? ' checked' : ''} ${act('writer-feedback')}><span class="op-switch-track"><span class="op-switch-thumb"></span></span></label>`)}
          <div class="op-ring-control op-ring-control--lever">${lever('writer-feedback-mode', 'Replace', 'Add', writer.feedbackMode === CAPTURE_MODE.add)}${pearlLegend('The generation')}</div>
          <span class="op-ring-sep"></span>
          ${knobControl('writer-delay', view)}
          ${knobControl('writer-limit', view)}
          <span class="op-spacer"></span>
          <span class="op-legend">${escapeHtml(next)}</span>
        </div>
        <p class="op-ring-note">With feedback on, each generation also becomes what the voices play — replacing the current generation or joining it — no sooner than the delay after the last, and at most the limit's number of times; then it turns itself off. The origin is never touched, and frozen material takes nothing.</p>
      </div>
    </div>`;
}
