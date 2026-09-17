'use strict';

/**
 * The commands that drive a native One Ring node in the engine.
 *
 * A sequence is data -- scenes, channels, cells -- and the engine reads it
 * again and refuses one it cannot read. What is checked here is the shape of
 * each message and its size, for the reason D-007 gives every command: the IPC
 * surface is a list that can be read, not whatever the renderer serialises.
 */

// A whole VST state is about 700 KB; the node keeps a sparse one, far smaller.
const MAX_STATE_CHARS = 4 * 1024 * 1024;
// The same bound the engine and the VST put on a list of targets.
const MAX_REGISTRY_CHARS = 4 * 1024 * 1024;
const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CHANNEL_COMMANDS = new Set(['START', 'STOP', 'RESTART', 'RESET', 'TOGGLE', 'ENABLE', 'DISABLE']);
const MEMORY_COMMANDS = new Set(['CAPTURE_REPLACE', 'CAPTURE_ADD', 'CAPTURE_END', 'CLEAR', 'FREEZE', 'UNFREEZE', 'REVERT']);
// Two lists of at most 256 notes: far below this.
const MAX_MATERIAL_CHARS = 256 * 1024;
const CHANNELS = 16;
const MAX_SCENE_INDEX = 255;

function validNodeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && NODE_ID.test(value);
}

function validGeneration(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sizeWithin(value, limit) {
  try {
    return JSON.stringify(value).length <= limit;
  } catch (_) {
    return false;
  }
}

function isValidSyncOneRingCommand(msg) {
  if (!msg || msg.v !== 1 || msg.type !== 'syncOneRing' || !validNodeId(msg.nodeId)
      || typeof msg.restore !== 'boolean') return false;
  const state = msg.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || state.version !== 1 || !Array.isArray(state.scenes)) return false;
  return sizeWithin(state, MAX_STATE_CHARS);
}

function isValidSetOneRingTargetsCommand(msg) {
  if (!msg || msg.v !== 1 || msg.type !== 'setOneRingTargets'
      || !validNodeId(msg.nodeId) || !validGeneration(msg.generation)) return false;
  const registry = msg.registry;
  if (!registry || typeof registry !== 'object' || registry.version !== 1
      || !Number.isSafeInteger(registry.revision) || registry.revision <= 0
      || !Array.isArray(registry.modules)) return false;
  return sizeWithin(registry, MAX_REGISTRY_CHARS);
}

function isValidOneRingCommand(msg) {
  if (!msg || msg.v !== 1 || msg.type !== 'oneRingCommand'
      || !validNodeId(msg.nodeId) || !validGeneration(msg.generation)) return false;
  switch (msg.command) {
    case 'run':
    case 'stop':
      return true;
    case 'channel':
      return Number.isInteger(msg.channel) && msg.channel >= 1 && msg.channel <= CHANNELS
        && CHANNEL_COMMANDS.has(msg.name);
    case 'scene':
      return Number.isInteger(msg.scene) && msg.scene >= 0 && msg.scene <= MAX_SCENE_INDEX;
    case 'memory':
      return MEMORY_COMMANDS.has(msg.name);
    default:
      return false;
  }
}

function isValidSetOneRingMaterialCommand(msg) {
  if (!msg || msg.v !== 1 || msg.type !== 'setOneRingMaterial' || !validNodeId(msg.nodeId)) return false;
  const material = msg.material;
  if (!material || typeof material !== 'object' || Array.isArray(material)
      || !material.origin || typeof material.origin !== 'object' || !Array.isArray(material.origin.notes)) return false;
  return sizeWithin(material, MAX_MATERIAL_CHARS);
}

function isValidRemoveOneRingCommand(msg) {
  return !!msg && msg.v === 1 && msg.type === 'removeOneRing' && validNodeId(msg.nodeId);
}

module.exports = {
  isValidSyncOneRingCommand,
  isValidSetOneRingTargetsCommand,
  isValidOneRingCommand,
  isValidRemoveOneRingCommand,
  isValidSetOneRingMaterialCommand
};
