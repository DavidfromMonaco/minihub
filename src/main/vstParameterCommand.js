'use strict';

function validId(value, pattern, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
}

const isStableParameterId = (value) => validId(value, /^(0|[1-9][0-9]{0,9})$/, 10)
  && Number(value) <= 0xffffffff;

/**
 * The parameter read. `parameterIds` is optional and, when given, narrows the
 * answer to those parameters -- what the bindings bar asks for, a handful of
 * ids against a synth that may declare thousands.
 */
function isValidGetVstParametersCommand(msg) {
  return !!msg && msg.v === 1 && msg.type === 'getVstParameters'
    && validId(msg.requestId, /^[A-Za-z0-9._:-]+$/, 160)
    && validId(msg.chainId, /^[A-Za-z][A-Za-z0-9_-]*$/, 128)
    && validId(msg.instanceId, /^plugin-[1-9][0-9]*$/, 64)
    && (msg.parameterIds === undefined
      || (Array.isArray(msg.parameterIds) && msg.parameterIds.length <= 256
        && msg.parameterIds.every(isStableParameterId)));
}

/** Pure validator for the high-frequency renderer -> native CONTROL command. */
function isValidSetVstParameterCommand(msg) {
  const parameterIdValid = isStableParameterId(msg?.parameterId);
  return !!msg && msg.v === 1 && msg.type === 'setVstParameter'
    && validId(msg.chainId, /^[A-Za-z][A-Za-z0-9_-]*$/, 128)
    && validId(msg.instanceId, /^plugin-[1-9][0-9]*$/, 64)
    && typeof msg.pluginId === 'string' && msg.pluginId.length > 0 && msg.pluginId.length <= 2048
    && Number.isSafeInteger(msg.generation) && msg.generation > 0
    && parameterIdValid
    && Number.isFinite(msg.normalizedValue)
    && msg.normalizedValue >= 0 && msg.normalizedValue <= 1;
}

module.exports = { isValidSetVstParameterCommand, isValidGetVstParametersCommand };

