'use strict';

/**
 * Pure validator for the renderer -> native preset load.
 *
 * This command carries the least trusted bytes in the application. Everything
 * else the engine loads was picked by the user from their own disk; a preset
 * may have been downloaded, and it ends up inside a VST3 plugin's `setState`,
 * which runs in the audio engine process. So the shape is pinned here before
 * the bytes travel, and the engine checks the identity again on arrival
 * (`cmdLoadPresetChunks`) rather than trusting this side.
 *
 * `classId` is mandatory even though the engine re-checks it: a preset whose
 * target is unknown must not be sendable at all.
 */

/**
 * Per-chunk ceiling, in base64 characters (~12 MB of state).
 *
 * A `.vstpreset` is normally a few kilobytes; sample-based instruments push it
 * into megabytes. The cap is far above anything legitimate and still bounds the
 * newline-delimited JSON line the engine has to read in one piece.
 */
const MAX_CHUNK_CHARS = 16 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const CLASS_ID = /^[0-9A-Fa-f]{32}$/;

function validId(value, pattern, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
}

/** A non-empty, properly padded base64 payload within the size ceiling. */
function validChunk(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CHUNK_CHARS
    && value.length % 4 === 0
    && BASE64.test(value);
}

function isValidLoadPresetChunksCommand(msg) {
  return !!msg && msg.v === 1 && msg.type === 'loadPresetChunks'
    && validId(msg.chainId, /^[A-Za-z][A-Za-z0-9_-]*$/, 128)
    && validId(msg.instanceId, /^plugin-[1-9][0-9]*$/, 64)
    && typeof msg.pluginId === 'string' && msg.pluginId.length > 0 && msg.pluginId.length <= 2048
    && Number.isSafeInteger(msg.generation) && msg.generation > 0
    && validId(msg.classId, CLASS_ID, 32)
    && validChunk(msg.component)
    // The controller half is optional, as it is in the container itself.
    && (msg.controller === undefined || msg.controller === null || validChunk(msg.controller));
}

module.exports = { isValidLoadPresetChunksCommand, MAX_CHUNK_CHARS };
