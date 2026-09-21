'use strict';

/**
 * The commands that drive the Audio Player nodes in the engine.
 *
 * `syncAudioPlayers` is the whole list of a project's players, each with the
 * file it plays; the engine decodes a file itself, so what crosses here is a
 * path and never a sample (invariant 1). `audioPlayerTransport` plays, pauses,
 * stops or places one of them. What is checked is the shape of each message and
 * its size, for the reason D-007 gives every command: the IPC surface is a list
 * that can be read, not whatever the renderer serialises.
 */

const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
// The engine refuses more; so does the renderer, which has no more nodes.
const MAX_PLAYERS = 64;
// Longer than any path Windows opens, even with the long-path prefix.
const MAX_PATH_CHARS = 32767;
const ACTIONS = new Set(['play', 'pause', 'stop', 'seek']);

function validNodeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && NODE_ID.test(value);
}

function validPath(value) {
  return typeof value === 'string' && value.length <= MAX_PATH_CHARS && !value.includes('\0');
}

const optionalFlag = (value) => value === undefined || typeof value === 'boolean';

function isValidSyncAudioPlayersCommand(msg) {
  if (!msg || msg.v !== 1 || msg.type !== 'syncAudioPlayers' || !Array.isArray(msg.players)
      || msg.players.length > MAX_PLAYERS) return false;
  return msg.players.every((player) => !!player && typeof player === 'object'
    && validNodeId(player.nodeId) && validPath(player.filePath) && typeof player.loop === 'boolean'
    && optionalFlag(player.describe) && optionalFlag(player.reload));
}

function isValidAudioPlayerTransportCommand(msg) {
  if (!msg || msg.v !== 1 || msg.type !== 'audioPlayerTransport' || !validNodeId(msg.nodeId)
      || !ACTIONS.has(msg.action)) return false;
  if (msg.action === 'seek') return Number.isFinite(msg.seconds) && msg.seconds >= 0;
  return msg.seconds === undefined;
}

module.exports = {
  isValidSyncAudioPlayersCommand,
  isValidAudioPlayerTransportCommand
};
