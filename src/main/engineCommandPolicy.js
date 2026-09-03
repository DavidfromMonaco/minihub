'use strict';

const ALLOWED_ENGINE_COMMANDS = new Set([
  'hello','listDevices','selectDevice','selectMidiOutput','getDeviceState','scanVst3','listPlugins',
  'createInstance','removeInstance','reorderChain','setBypass','midi',
  'setChainMidiEnabled','setChainOutputEnabled','openEditor','closeEditor',
  'getState','setState','loadPresetChunks','getVstParameters','setVstParameter','setVstParameterLearn',
  'setTransport','getTransport','foregroundEditors','syncAudioGraph','setAudioNodeValues','syncMidiGraph',
  'midiNode','setMetronome','setMasterOutput','resetMasterClip','syncSequencer','setSequencerTrackControl','sequencerMidiInput',
  'sequencerRecord','sequencerExport','sequencerCancelExport','sequencerQuiesce','sequencerPanic'
]);

module.exports = { ALLOWED_ENGINE_COMMANDS };
