'use strict';

function isValidSelectDeviceCommand(msg) {
  const name = msg?.device?.name;
  return !!msg && msg.v === 1 && msg.type === 'selectDevice'
    && typeof name === 'string' && name.length > 0 && name.length <= 256
    && typeof msg.sampleRate === 'number' && Number.isFinite(msg.sampleRate)
    && msg.sampleRate >= 8000 && msg.sampleRate <= 384000
    && Number.isSafeInteger(msg.bufferSize) && msg.bufferSize >= 16 && msg.bufferSize <= 8192;
}

module.exports = { isValidSelectDeviceCommand };
