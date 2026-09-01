'use strict';

function validId(value, pattern, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
}

/** Pure validator for the high-frequency renderer -> native CONTROL command. */
function isValidSetVstParameterCommand(msg) {
  const parameterIdValid = validId(msg?.parameterId, /^(0|[1-9][0-9]{0,9})$/, 10)
    && Number(msg.parameterId) <= 0xffffffff;
  return !!msg && msg.v === 1 && msg.type === 'setVstParameter'
    && validId(msg.chainId, /^[A-Za-z][A-Za-z0-9_-]*$/, 128)
    && validId(msg.instanceId, /^plugin-[1-9][0-9]*$/, 64)
    && typeof msg.pluginId === 'string' && msg.pluginId.length > 0 && msg.pluginId.length <= 2048
    && Number.isSafeInteger(msg.generation) && msg.generation > 0
    && parameterIdValid
    && Number.isFinite(msg.normalizedValue)
    && msg.normalizedValue >= 0 && msg.normalizedValue <= 1;
}

module.exports = { isValidSetVstParameterCommand };

