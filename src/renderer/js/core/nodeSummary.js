/**
 * What a node's readout on the Patch Bay says: two short lines at most, read
 * from the node's content.
 *
 * The card used to carry two badges (the type again, and EMPTY or a role) and
 * a grey subtitle. The title already names the type, so the space goes to what
 * tells two nodes of a type apart -- the plugins in a chain, the file a player
 * holds, the mode an arpeggiator runs -- printed on the black screen the One
 * Ring uses for a value (D-055).
 *
 * A line is `{ text, tone, tag }`: `tone` is `value` (a thing set), `dim` (an
 * absence, or a fact about it) or `accent` (the one value worth catching the
 * eye); `tag` is a small right-aligned mark, such as a plugin's role. Two
 * optional fields: `num`, a position printed dim before the text (a plugin's
 * place in its chain), and `segments`, the text in parts that each carry their
 * own tone -- `text` is then their words joined. Pure: the caller passes the
 * content and what the hub knows (`context`), nothing here reads the hub.
 */
import { getVstRole } from './vstChain.js';
import { AUDIO_PLAYER_TYPE, fileNameOf } from './audioPlayerState.js';

/** Characters a readout line holds before it is cut, on a 200 px card. */
export const SUMMARY_LINE_CHARS = 24;
const MAX_LINES = 2;

function cut(text, max = SUMMARY_LINE_CHARS) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function line(text, tone = 'value', tag = '') {
  return { text: cut(text, tag ? SUMMARY_LINE_CHARS - tag.length - 1 : SUMMARY_LINE_CHARS), tone, tag };
}

/** A line in parts: `[[text, tone], ...]`, two spaces between them. */
function segmented(parts, tag = '') {
  const segments = parts.filter(([text]) => text).map(([text, tone]) => ({ text: String(text), tone }));
  return { text: segments.map((part) => part.text).join('  '), tone: segments[0]?.tone || 'value', tag, segments };
}

function vstLines(content) {
  const plugins = Array.isArray(content?.plugins) ? content.plugins : [];
  if (!plugins.length) return [line('No plugin', 'dim')];
  const shown = plugins.length > MAX_LINES ? plugins.slice(0, MAX_LINES - 1) : plugins;
  // Numbered, as the chain runs: 1 plays into 2. The number takes two
  // characters of the line.
  const lines = shown.map((plugin, i) => {
    const role = getVstRole(plugin?.role).badge;
    return { ...line(plugin?.name || 'Plugin', 'value', role), text: cut(plugin?.name || 'Plugin', SUMMARY_LINE_CHARS - role.length - 3), num: String(i + 1) };
  });
  if (plugins.length > shown.length) lines.push(line(`+ ${plugins.length - shown.length} more`, 'dim'));
  return lines;
}

function playerLines(content) {
  const name = fileNameOf(content?.filePath);
  if (!name) return [line('No file', 'dim')];
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toUpperCase() || 'FILE';
  return [line(name.replace(/\.[A-Za-z0-9]{1,5}$/, ''), 'value', extension)];
}

function arpeggiatorLines(content) {
  if (!content?.mode && !content?.rate) return [];
  const steps = Number.isSafeInteger(content.patternLength) ? `${content.patternLength} STEPS` : '';
  return [segmented([[String(content.mode || '').toUpperCase(), 'accent'], [content.rate, 'value'], [steps, 'value']])];
}

function audioInputsLines(content, noun) {
  const count = Array.isArray(content?.inputs) ? content.inputs.length : 0;
  return [line(`${count} ${noun}${count === 1 ? '' : 's'}`, count ? 'value' : 'dim')];
}

/**
 * The scene that plays -- the runtime's, when it has reported one, else the
 * one the file keeps -- and whether it runs, as the One Ring's own screen
 * says it: STOPPED, or PLAYING in the accent.
 */
export function oneRingSceneId(content, status) {
  const scenes = Array.isArray(content?.scenes) ? content.scenes : [];
  const index = Number.isSafeInteger(status?.scene) ? status.scene
    : Number.isSafeInteger(content?.selectedScene) ? content.selectedScene : 0;
  return scenes[index]?.id || '';
}

function oneRingLines(content, status) {
  const id = oneRingSceneId(content, status);
  if (!id) return [];
  return [segmented([['SCENE', 'dim'], [id, 'value']], status?.playing ? 'PLAYING' : 'STOPPED')];
}

function sequencerLines(trackCount) {
  if (!Number.isSafeInteger(trackCount)) return [];
  return [line(`${trackCount} track${trackCount === 1 ? '' : 's'}`, trackCount ? 'value' : 'dim')];
}

/**
 * `context` carries what is not in the content: `ringStatus` (a One Ring's
 * last report) and `trackCount` (the Sequencer's). Mixer and Morpher are not
 * lines: their card draws a strip per input (routingModule).
 */
export function nodeSummaryLines(typeId, content, context = {}) {
  if (typeId === 'vst') return vstLines(content);
  if (typeId === AUDIO_PLAYER_TYPE) return playerLines(content);
  if (typeId === 'arpeggiator') return arpeggiatorLines(content);
  if (typeId === 'mixer') return audioInputsLines(content, 'input');
  if (typeId === 'morpher') return audioInputsLines(content, 'input');
  if (typeId === 'one-ring') return oneRingLines(content, context.ringStatus);
  if (typeId === 'sequencer') return sequencerLines(context.trackCount);
  if (typeId === 'audio-input') return [line('Live input', 'dim')];
  return [];
}

/**
 * A card's meter, from a linear peak: the fraction of its height, over the
 * last 60 dB, and how hot it is -- `ok`, `warn` from -6 dB, `hot` from -1 dB.
 */
export function meterReading(peak) {
  const value = Number(peak);
  if (!Number.isFinite(value) || value <= 0) return { fraction: 0, level: 'ok' };
  const db = 20 * Math.log10(value);
  const fraction = Math.max(0, Math.min(1, (db + 60) / 60));
  return { fraction, level: db >= -1 ? 'hot' : db >= -6 ? 'warn' : 'ok' };
}

/** A gain as the card prints it: "−6.0", "+2.5", "0.0", or "−∞". */
export function gainDb(gain) {
  const value = Number(gain);
  if (!Number.isFinite(value) || value <= 0) return '−∞';
  const db = 20 * Math.log10(value);
  const rounded = Math.abs(db) < 0.05 ? 0 : db;
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(1)}`;
}

/**
 * The Audio Output's readout: the device the engine plays through, and how.
 * It is a system node with no content; what sets it apart is the hardware,
 * which the engine reports (`engine:deviceState`).
 */
export function audioOutputLines(deviceState) {
  if (!deviceState?.running || !deviceState.device) return [line('No audio device', 'dim')];
  const rate = Number(deviceState.sampleRate);
  const buffer = Number(deviceState.bufferSize);
  const how = [
    Number.isFinite(rate) && rate > 0 ? `${Number.isInteger(rate / 1000) ? rate / 1000 : (rate / 1000).toFixed(1)} kHz` : '',
    Number.isSafeInteger(buffer) && buffer > 0 ? `${buffer} smp` : ''
  ].filter(Boolean).join(' · ');
  return how ? [line(deviceState.device), line(how, 'dim')] : [line(deviceState.device)];
}

