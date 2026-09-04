import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const engineSource = fs.readFileSync(new URL('../native/audio-engine/src/engine.cpp', import.meta.url), 'utf8');
const engineHeader = fs.readFileSync(new URL('../native/audio-engine/src/engine.h', import.meta.url), 'utf8');
const sequencerSource = fs.readFileSync(new URL('../native/audio-engine/src/sequencer.cpp', import.meta.url), 'utf8');
const sequencerHeader = fs.readFileSync(new URL('../native/audio-engine/src/sequencer.h', import.meta.url), 'utf8');
const masterSource = fs.readFileSync(new URL('../native/audio-engine/src/master_output.cpp', import.meta.url), 'utf8');
const signalMeterSource = fs.readFileSync(new URL('../native/audio-engine/src/audio_signal_meter.cpp', import.meta.url), 'utf8');
const pluginHostSource = fs.readFileSync(new URL('../native/audio-engine/src/plugin_host.cpp', import.meta.url), 'utf8');
const nativeMainSource = fs.readFileSync(new URL('../native/audio-engine/src/main.cpp', import.meta.url), 'utf8');
const scannerMainSource = fs.readFileSync(new URL('../native/audio-engine/src/scanner_main.cpp', import.meta.url), 'utf8');
const nativeCmake = fs.readFileSync(new URL('../native/audio-engine/CMakeLists.txt', import.meta.url), 'utf8');
const portAudioDeviceSource = fs.readFileSync(new URL('../native/audio-engine/src/engine2/portaudio_device.cpp', import.meta.url), 'utf8');
const realtimeOutputHeader = fs.readFileSync(new URL('../native/audio-engine/src/engine2/realtime_output_buffer.h', import.meta.url), 'utf8');

function bodyOf(signature) {
  const start = engineSource.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = engineSource.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < engineSource.length; i += 1) {
    if (engineSource[i] === '{') depth += 1;
    if (engineSource[i] === '}' && --depth === 0) return engineSource.slice(open + 1, i);
  }
  assert.fail(`unterminated ${signature}`);
}

test('message-thread MIDI panic is queued and plan mutation stays in audio callback', () => {
  const requestBody = bodyOf('void Engine::panicAllMidi()');
  const callbackBody = bodyOf('void Engine::processEngine2Block(');
  assert.match(engineHeader, /std::atomic<bool>\s+midiPanicPending_/);
  assert.match(requestBody, /midiPanicPending_\.store\(true/);
  assert.doesNotMatch(requestBody, /activeMidiPlan_|->panicAll\(/,
    'message thread must never mutate the live MIDI plan');
  assert.match(requestBody, /physicalMidiOutput_\.panic\(\)/,
    'hardware scheduling is cleared outside the real-time callback');
  assert.match(callbackBody, /midiPanicPending_\.exchange\(false/);
  assert.doesNotMatch(callbackBody, /physicalMidiOutput_\.panic\(\)/,
    'hardware panic may block and must stay off the real-time callback');
  assert.match(callbackBody, /midiPlan->panicAll\(nullptr\)/);
});

test('a rejected Sequencer sync fails closed and panics discarded destinations', () => {
  const syncBody = bodyOf('void Engine::cmdSyncSequencer(');
  assert.match(syncBody, /if\s*\(!sequencer_\.sync[\s\S]*?\)\s*\{panicAllMidi\(\);sendError/,
    'invalid project data must silence chains and physical MIDI before returning');
});

test('rejected native network syncs publish empty plans instead of retaining hidden routes', () => {
  const audioBody = bodyOf('void Engine::cmdSyncAudioNetwork(');
  const midiBody = bodyOf('void Engine::cmdSyncMidiNetwork(');
  assert.match(audioBody, /reject=\[this\][\s\S]*?clearAudioNetwork\(\)/);
  assert.match(audioBody, /if\s*\(!plan\)\s*\{\s*reject\(/);
  assert.match(midiBody, /reject=\[this\][\s\S]*?clearMidiNetwork\(\)/);
  assert.match(midiBody, /if\s*\(!plan\)\s*\{reject\(/);
});

test('native export transaction defers only device reconfiguration', () => {
  const commandBody = bodyOf('void Engine::handleCommand(');
  const timerBody = bodyOf('void Engine::timerCallback()');
  const quiesceBody = bodyOf('void Engine::cmdSequencerQuiesce(');
  assert.match(engineHeader, /std::vector<juce::var>\s+deferredExportCommands_/);
  assert.match(commandBody, /exportTransactionActive\(\)[\s\S]*?isExportMutation[\s\S]*?deferredExportCommands_/,
    'native IPC is authoritative even if a renderer bypasses its own export gate');
  const mutationBody = bodyOf('bool isExportMutation(');
  assert.match(mutationBody, /type == "selectDevice"/,
    'device prepare mutates the shared sample-rate contract even though it no longer clocks export');
  assert.doesNotMatch(mutationBody, /syncAudioNetwork|syncMidiNetwork|syncSequencer|setTransport|midi|setState|setBypass/,
    'cloned processors make every network, plugin, transport and MIDI command immediately live-safe');
  assert.match(timerBody, /sequencerExport[\s\S]*?flushDeferredExportCommands\(\)/,
    'deferred mutations publish only after the terminal export event');
  assert.match(quiesceBody, /deferredExportCommands_\.clear\(\)/,
    'project replacement discards commands that belong to the old project');
  assert.match(quiesceBody, /setProp\(out,"requestId",msg\["requestId"\]\)/,
    'project replacement waits for the exact native command acknowledgement');
  assert.match(quiesceBody, /setProp\(out,"wasRecording",wasRecording\)/,
    'the barrier reports a recording that raced the renderer-side precheck');
});

test('offline export owns a private transport and routes VST playhead timing to it per block', () => {
  const callbackBody = bodyOf('void Engine::processEngine2Block(');
  const renderBody = bodyOf('void Engine::renderOfflineExport(');
  const exportBody = bodyOf('void Engine::cmdSequencerExport(');
  assert.match(sequencerHeader, /Transport\s+offlineExportTransport_/);
  assert.match(sequencerHeader, /const Transport&\s+liveTransport/,
    'export receives the live transport read-only for tempo snapshotting');
  assert.match(callbackBody, /Transport&\s+blockTransport\s*=\s*transport_/);
  assert.match(callbackBody, /pluginPlayHead_\.select\(transport_\)/,
    'the audible VST network never receives the offline playhead');
  assert.match(exportBody, /setPlayHead\(&sequencer_\.exportTransport\(\)\)/,
    'only cloned VST chains receive the offline playhead');
  assert.match(engineHeader, /struct ExportContext[\s\S]*std::map<juce::String,\s*std::unique_ptr<Chain>>\s+chains[\s\S]*AudioBuffer<float>\s+audio/);
  assert.doesNotMatch(callbackBody, /ExportContext|processMaster|exportTransport/,
    'the hardware callback contains no export clock, network, writer or PCM');
  assert.match(renderBody, /ExportContext\*\s+context[\s\S]*context->audio\.getWritePointer[\s\S]*processMaster/,
    'private PCM is advanced by the dedicated offline worker');
  assert.doesNotMatch(renderBody, /sleep|waitFor|AudioDevice|outputChannelData/,
    'the bounce loop has no wall-clock pacing or hardware endpoint');
  assert.match(engineHeader, /TransportPlayHeadRouter\s+pluginPlayHead_/);
  assert.match(exportBody, /livePlaying[\s\S]*livePpqPosition[\s\S]*liveLoopEnabled/,
    'started diagnostics expose the untouched live state beside the offline range');
  assert.doesNotMatch(sequencerSource, /exportPreviousPlaying_|exportPreviousPpq_|exportPreviousLoop/,
    'there is no save-and-restore path because export never mutates live transport');
});

test('export is device-independent, publishes frame speed, and Cancel wakes the worker', () => {
  const exportBody = bodyOf('void Engine::cmdSequencerExport(');
  const cancelBody = bodyOf('void Engine::cmdSequencerCancelExport(');
  const timerBody = bodyOf('void Engine::timerCallback()');
  const renderBody = bodyOf('void Engine::renderOfflineExport(');
  assert.doesNotMatch(exportBody, /No active audio output|!engineRunning_/,
    'offline export does not require an open device or callback');
  assert.match(timerBody, /sequencer_\.exportFrames\(\)[\s\S]*sequencer_\.exportTargetFrames\(\)[\s\S]*makeExportStage\("progress"/,
    'the native protocol publishes monotonic frame progress instead of one opaque started state');
  assert.match(timerBody, /renderedAudioSeconds[\s\S]*projectDurationSeconds[\s\S]*realtimeSpeed/,
    'progress reports speed from rendered frames and total elapsed transaction time');
  assert.match(cancelBody, /sequencer_\.requestCancelExport\(true\)/);
  assert.match(renderBody, /sequencer_\.exporting\(\)[\s\S]*finalizeRequestedCancel\(\)[\s\S]*consumeExportCleanupRequest\(\)/,
    'Cancel is observed and cleaned by the CPU worker without awaiting hardware');
  for (const stage of ['START', 'preparation', 'snapshot-project', 'render-context',
    'prepare-vst', 'build-network', 'timeline', 'render-blocks', 'finalization', 'DONE']) {
    assert.match(engineSource, new RegExp(`"${stage}"`), `missing export trace stage ${stage}`);
  }
});

test('native export freezes asynchronous VST insertion and direct editor mutation', () => {
  const createBody = bodyOf('void Engine::cmdCreateInstance(');
  const removeBody = bodyOf('void Engine::cmdRemoveInstance(');
  const exportBody = bodyOf('void Engine::cmdSequencerExport(');
  const panicBody = bodyOf('void Engine::cmdSequencerPanic(');
  assert.match(engineHeader, /std::map<juce::String,\s*juce::int64>\s+pendingPluginLoads_/);
  assert.match(createBody, /pendingPluginLoads_\[instanceKey\(chainId, instanceId\)\]\s*=\s*generation/);
  assert.match(removeBody, /pendingPluginLoads_\.erase\(instanceKey\(chainId, instanceId\)\)/);
  assert.match(exportBody, /pendingPluginLoads_\.empty\(\)[\s\S]*?Wait for VST plugins to finish loading/,
    'a worker cannot install a processor after the export snapshot begins');
  assert.match(exportBody, /snapshot\.state=plugin->getState\(\)[\s\S]*?instance->create[\s\S]*?instance->setState/,
    'one captured state is restored into a distinct processor instance');
  assert.doesNotMatch(exportBody, /closeEditor\(/,
    'export snapshotting cannot close or disturb the live editor');
  assert.match(panicBody, /sequencer_\.exporting\(\)[\s\S]*?physicalMidiOutput_\.panic\(\)[\s\S]*?else[\s\S]*?panicAllMidi\(\)/,
    'physical safety remains immediate without mutating the in-flight render');
});

test('Sequencer arrangement render uses an export-owned immutable plan pointer', () => {
  assert.match(sequencerHeader, /std::atomic<Plan\*>\s+exportPlan_/);
  assert.match(sequencerSource, /prepareExportPlan[\s\S]*auto next=std::make_unique<Plan>[\s\S]*track\.midi=original\.midi[\s\S]*track\.audio=original\.audio/,
    'the arrangement is deep-cloned before export begins');
  assert.match(sequencerSource, /track\.destination=chainLookup\(track\.outputId\)/,
    'MIDI tracks are retargeted to export-only chains');
  assert.match(sequencerSource, /exportPlan_\.store\(preparedExportPlan_\.get\(\)/);
  assert.match(sequencerSource, /plan\s*=\s*exportContext\s*\?\s*exportPlan_\.load/,
    'audio and MIDI acquisition choose the frozen pointer only for the offline transport');
  assert.match(sequencerSource, /owned\.get\(\)!=exportPlan/,
    'a sync during export cannot reclaim the frozen arrangement');
});

test('terminal export cleanup targets clones while live Note Off commands remain accepted', () => {
  const renderBody = bodyOf('void Engine::renderOfflineExport(');
  const commandBody = bodyOf('void Engine::handleCommand(');
  assert.match(sequencerSource, /panicExport[\s\S]*allNotesOff|panicExport[\s\S]*destination->panic/);
  assert.match(renderBody, /consumeExportCleanupRequest\(\)[\s\S]*midiPlan->panicAll\(nullptr\)[\s\S]*item\.second->processBlock/,
    'Note Off, CC123 and CC120 are consumed by every cloned chain before release');
  assert.match(commandBody, /else if \(type == "midi"\) cmdMidi\(msg\)/);
  assert.doesNotMatch(bodyOf('bool isExportMutation('), /midi/,
    'a held live note can always deliver its matching Note Off during export');
});

test('linear float sum reaches meter-only Master and the exact export tap without hidden gain', () => {
  const callbackBody = bodyOf('void Engine::processEngine2Block(');
  const renderBody = bodyOf('void Engine::renderOfflineExport(');
  const passiveMeter = callbackBody.indexOf('audioOutputMeter_.observe(');
  const master = callbackBody.indexOf('masterOutput_.process(');
  const offlineMaster = renderBody.indexOf('context->master.process(');
  const recorder = renderBody.indexOf('sequencer_.processMaster(');
  assert.ok(passiveMeter >= 0 && master > passiveMeter && offlineMaster >= 0 && recorder > offlineMaster,
    'live and offline both preserve float sum -> Master Gain/Meter, with one post-Master export tap');
  assert.doesNotMatch(masterSource, /limiterGain_|requiredGain|setCeilingDb|gainReduction/,
    'no limiter may survive in the Master gain/meter stage');
  assert.doesNotMatch(signalMeterSource, /getWritePointer|setSample|applyGain|requiredGain|limiterGain_|releaseCoefficient_/,
    'passive audio-path diagnostics cannot write samples or own a gain envelope');
  assert.match(pluginHostSource, /signalMeter_\.observe[\s\S]*plugin_->process\(buffer,\s*numSamples,\s*midi,\s*assignedPlayHead_,\s*blockId\)[\s\S]*signalMeter_\.observe/,
    'VST and FX input/output are observed around one explicit-frame, block-identified process call');
  assert.doesNotMatch(pluginHostSource, /safety_|\.process\(buffer[\s\S]*NodeSafety/,
    'per-plugin safety processing is absent');
  assert.doesNotMatch(callbackBody, /outputSafety|audioOutputSafety|safetyCeiling|setCeilingDb/,
    'live and export paths contain no hidden output protection');
});

test('live engine and scan helper are distinct executables with hard no-device boundaries', () => {
  assert.match(nativeMainSource, /CreateMutexW[\s\S]*Local\\\\MiniHub\.LiveAudioEngine\.v1/,
    'the native live engine rejects a duplicate before PortAudio construction');
  assert.match(nativeMainSource, /rejected duplicate[\s\S]*audioDeviceOpen=false/);
  assert.doesNotMatch(nativeMainSource, /class ScanApplication|Vst3Scanner::scanFile/,
    'mlh-audio-engine no longer doubles as a scanner');
  assert.match(scannerMainSource, /audioDeviceOpen=false/);
  assert.doesNotMatch(scannerMainSource, /#include\s+["<]engine\.h|AudioDeviceManager\s+[A-Za-z_]|#include\s+<juce_audio_devices/,
    'the scanner source has no live Engine or hardware device manager');
  assert.match(nativeCmake, /add_executable\(mlh_vst3_scanner[\s\S]*scanner_main\.cpp[\s\S]*juce::juce_audio_processors/);
  const scannerTarget = /add_executable\(mlh_vst3_scanner([\s\S]*?)add_dependencies\(mlh_audio_engine/.exec(nativeCmake)?.[1] || '';
  assert.doesNotMatch(scannerTarget, /juce::juce_audio_devices/,
    'the scanner binary does not link the audio-device module');
});

test('Engine 2 final output is zeroed paFloat32 stereo interleaved using actual callback frames', () => {
  assert.match(portAudioDeviceSource, /output\.channelCount\s*=\s*2/);
  assert.match(portAudioDeviceSource, /output\.sampleFormat\s*=\s*paFloat32\s*;/,
    'output must be interleaved paFloat32, without paNonInterleaved');
  assert.doesNotMatch(portAudioDeviceSource,
    /output\.sampleFormat\s*=\s*paFloat32\s*\|\s*paNonInterleaved/);
  assert.match(portAudioDeviceSource,
    /auto\* const interleavedOutput\s*=\s*static_cast<float\*>\(output\)/,
    'the PortAudio void destination is cast to real float32 samples');
  const zero = portAudioDeviceSource.indexOf('zeroPortAudioStereoOutput(interleavedOutput, frames)');
  const process = portAudioDeviceSource.indexOf('self->engine_.processRealtime(');
  const interleave = portAudioDeviceSource.indexOf('interleaveMasterToPortAudio(');
  assert.ok(zero >= 0 && process > zero && interleave > process,
    'every actual PortAudio destination is zeroed before planar DSP and final interleaving');
  assert.match(realtimeOutputHeader,
    /output\[2u \* frame\]\s*=\s*left[\s\S]*output\[2u \* frame \+ 1u\]\s*=\s*right/);
  assert.match(realtimeOutputHeader,
    /frames\) \* kPortAudioOutputChannels \* sizeof\(float\)/,
    'memset size is frames × 2 × sizeof(float)');
  assert.doesNotMatch(realtimeOutputHeader, /std::clamp|jlimit|int16|double\s*\*/i,
    'the final copy contains no sample clamp or hidden integer/double conversion');
  assert.match(nativeCmake, /add_test\(NAME realtimeOutputBuffer COMMAND mlh_realtime_output_tests\)/,
    'the exact production interleaver has its own native regression target');
});
