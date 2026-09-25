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
 * eye); `tag` is a small right-aligned mark, such as a plugin's role. Pure: the
 * caller passes the content, nothing here reads the hub.
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

function vstLines(content) {
  const plugins = Array.isArray(content?.plugins) ? content.plugins : [];
  if (!plugins.length) return [line('No plugin', 'dim')];
  const shown = plugins.length > MAX_LINES ? plugins.slice(0, MAX_LINES - 1) : plugins;
  const lines = shown.map((plugin) => line(plugin?.name || 'Plugin', 'value', getVstRole(plugin?.role).badge));
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
  if (!content) return [];
  const parts = [content.mode, content.rate].filter(Boolean).map(String);
  return parts.length ? [line(parts.join('  ').toUpperCase(), 'accent')] : [];
}

function audioInputsLines(content, noun) {
  const count = Array.isArray(content?.inputs) ? content.inputs.length : 0;
  return [line(`${count} ${noun}${count === 1 ? '' : 's'}`, count ? 'value' : 'dim')];
}

function oneRingLines(content) {
  const scenes = Array.isArray(content?.scenes) ? content.scenes : [];
  const scene = scenes[Number.isSafeInteger(content?.selectedScene) ? content.selectedScene : 0];
  return scene?.id ? [line(`Scene ${scene.id}`, 'accent')] : [];
}

export function nodeSummaryLines(typeId, content) {
  if (typeId === 'vst') return vstLines(content);
  if (typeId === AUDIO_PLAYER_TYPE) return playerLines(content);
  if (typeId === 'arpeggiator') return arpeggiatorLines(content);
  if (typeId === 'mixer') return audioInputsLines(content, 'input');
  if (typeId === 'morpher') return audioInputsLines(content, 'input');
  if (typeId === 'one-ring') return oneRingLines(content);
  return [];
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

