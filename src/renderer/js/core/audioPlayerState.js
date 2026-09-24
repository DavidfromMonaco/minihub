/**
 * An Audio Player node's content: the file it plays, whether it loops, its
 * level, and whether it is muted.
 *
 * The file is named by its full path and never copied, as a Sequencer audio
 * clip names its own: the project stays small, and a file moved away is said to
 * be missing rather than silently replaced. What the file holds -- its length,
 * its rate, its overview -- is not content: the engine reads it again from the
 * file every time it loads one (audioPlayers.js), so a file edited elsewhere is
 * never shown as it was.
 */

export const AUDIO_PLAYER_TYPE = 'audio-player';

/** What the file picker offers, and what the engine reads (JUCE's basic formats). */
export const AUDIO_PLAYER_EXTENSIONS = Object.freeze(['wav', 'mp3', 'aif', 'aiff', 'flac', 'ogg']);

export const LEVEL_MAX = 2;

export function defaultAudioPlayerContent() {
  return { filePath: '', loop: false, level: 1, muted: false };
}

/** Untrusted content -- a project file, an agent -- made safe to send the engine. */
export function normalizeAudioPlayerContent(value) {
  const source = value && typeof value === 'object' ? value : {};
  const filePath = typeof source.filePath === 'string' && !source.filePath.includes('\0')
    ? source.filePath.slice(0, 32767) : '';
  const level = Number.isFinite(source.level) ? Math.max(0, Math.min(LEVEL_MAX, source.level)) : 1;
  return { filePath, loop: source.loop === true, level, muted: source.muted === true };
}

/** The file's name, without its folder. */
export function fileNameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}

/** `m:ss.t`, the way a player shows where it is. */
export function formatPlayerTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const tenths = Math.floor(safe * 10 + 1e-6);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}
