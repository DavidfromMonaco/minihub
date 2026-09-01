'use strict';

function validId(value, pattern, maxLength) {
  return typeof value === 'string' && value.length > 0
    && value.length <= maxLength && pattern.test(value);
}

/** Fixed IPC shape for the native gesture-aware Learn operation. */
function isValidSetVstParameterLearnCommand(msg) {
  return !!msg && msg.v === 1 && msg.type === 'setVstParameterLearn'
    && validId(msg.learnId, /^[A-Za-z0-9._:-]+$/, 160)
    && validId(msg.chainId, /^[A-Za-z][A-Za-z0-9_-]*$/, 128)
    && validId(msg.instanceId, /^plugin-[1-9][0-9]*$/, 64)
    && typeof msg.pluginId === 'string' && msg.pluginId.length > 0 && msg.pluginId.length <= 2048
    && Number.isSafeInteger(msg.generation) && msg.generation > 0
    && typeof msg.armed === 'boolean';
}

module.exports = { isValidSetVstParameterLearnCommand };
