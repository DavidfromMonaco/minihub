'use strict';

/**
 * The two commands that talk to a plugin which commands MiniHub's modules.
 *
 * `setControlRegistry` carries a whole list of targets into a third-party
 * binary, and `setControlStatus` a sentence shown in its window. The engine
 * checks both again and the plugin checks the registry a third time -- this is
 * the first gate, here for the reason D-007 gives every sensitive command: the
 * IPC surface is a list that can be read, not whatever the renderer serialises.
 */

// The plugin refuses a registry above this size, so there is no point carrying
// one across two process boundaries to hear it.
const MAX_REGISTRY_CHARS = 4 * 1024 * 1024;
const MAX_STATUS_BYTES = 4096;
// The engine hands a plugin at most a megabyte of request.
const MAX_REQUEST_CHARS = 1024 * 1024;

function validId(value, pattern, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
}

function validSource(msg) {
  return validId(msg.chainId, /^[A-Za-z][A-Za-z0-9_-]*$/, 128)
    && validId(msg.instanceId, /^plugin-[1-9][0-9]*$/, 64)
    && typeof msg.pluginId === 'string' && msg.pluginId.length > 0 && msg.pluginId.length <= 2048
    && Number.isSafeInteger(msg.generation) && msg.generation > 0;
}

function isValidSetControlRegistryCommand(msg) {
  if (!msg || msg.v !== 1 || msg.type !== 'setControlRegistry' || !validSource(msg)) return false;
  const registry = msg.registry;
  if (!registry || typeof registry !== 'object' || registry.version !== 1
      || !Number.isSafeInteger(registry.revision) || registry.revision <= 0
      || !Array.isArray(registry.modules)) return false;
  try {
    return JSON.stringify(registry).length <= MAX_REGISTRY_CHARS;
  } catch (_) {
    return false;
  }
}

function isValidSetControlStatusCommand(msg) {
  return !!msg && msg.v === 1 && msg.type === 'setControlStatus' && validSource(msg)
    && typeof msg.message === 'string'
    && Buffer.byteLength(msg.message, 'utf8') <= MAX_STATUS_BYTES;
}

/**
 * A request an agent hands a plugin in the plugin's own vocabulary.
 *
 * What it says is the plugin's to judge; what is checked here is that it is one
 * object addressed to one instance, and small enough that the plugin's refusal
 * is the only thing standing between the agent and a plugin's memory.
 */
function isValidPluginRequestCommand(msg) {
  if (!msg || msg.v !== 1 || msg.type !== 'pluginRequest' || !validSource(msg)
      || !validId(msg.requestId, /^[A-Za-z0-9._:-]+$/, 160)) return false;
  const request = msg.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  try {
    return JSON.stringify(request).length <= MAX_REQUEST_CHARS;
  } catch (_) {
    return false;
  }
}

module.exports = { isValidSetControlRegistryCommand, isValidSetControlStatusCommand, isValidPluginRequestCommand };
