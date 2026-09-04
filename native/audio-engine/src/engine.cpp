#include "engine.h"
#include "realtime_drops.h"
#include "var_util.h"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <thread>

namespace mlh {

namespace {

// Preallocated MIDI capacity so the audio callback never grows a MidiBuffer.
constexpr int kMidiBufferBytes = 8192;

bool isNumber(const juce::var& value)
{
    return value.isInt() || value.isInt64() || value.isDouble();
}

void publishMaximum(std::atomic<float>& destination, float value) noexcept
{
    float observed = destination.load(std::memory_order_relaxed);
    while (value > observed
           && !destination.compare_exchange_weak(observed, value,
                                                 std::memory_order_release,
                                                 std::memory_order_relaxed)) {}
}

void setSignalTelemetry(juce::var& out, const AudioSignalTelemetry& meter)
{
    setProp(out, "inputPeak", meter.inputPeak);
    setProp(out, "inputPeakDb", juce::Decibels::gainToDecibels(meter.inputPeak, -100.0f));
    setProp(out, "outputPeak", meter.outputPeak);
    setProp(out, "outputPeakDb", juce::Decibels::gainToDecibels(meter.outputPeak, -100.0f));
    setProp(out, "maximumInputPeak", meter.maximumInputPeak);
    setProp(out, "maximumOutputPeak", meter.maximumOutputPeak);
    setProp(out, "maximumObservedPeak", meter.maximumObservedPeak);
    // Explicit diagnostic proof that the host applies no hidden level-dependent gain.
    setProp(out, "automaticGainReduction", false);
    setProp(out, "gainReductionCoefficient", 1.0f);
    setProp(out, "gainReductionDb", 0.0f);
    setProp(out, "nonFiniteSamples", static_cast<juce::int64>(meter.nonFiniteSamples));
    setProp(out, "totalNonFiniteSamples", static_cast<juce::int64>(meter.totalNonFiniteSamples));
}

juce::var makeError(const juce::String& code, const juce::String& message)
{
    juce::var out = makeObject();
    setProp(out, "type", "error");
    setProp(out, "code", code);
    setProp(out, "message", message);
    return out;
}

juce::var makeExportStage(const juce::String& state,
                          const juce::String& stage,
                          const juce::File& file,
                          const juce::String& format,
                          const juce::String& phase = {})
{
    juce::var out = makeObject();
    setProp(out, "type", "sequencerExport");
    setProp(out, "state", state);
    setProp(out, "stage", stage);
    setProp(out, "filePath", file.getFullPathName());
    setProp(out, "format", format);
    if (phase.isNotEmpty()) setProp(out, "phase", phase);
    return out;
}

bool isProtocolChainId(const juce::String& value)
{
    if (value.isEmpty() || value.length() > 128)
        return false;
    const auto asciiLetter = [](juce::juce_wchar c)
    {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    };
    const auto asciiDigit = [](juce::juce_wchar c) { return c >= '0' && c <= '9'; };
    if (!asciiLetter(value[0]))
        return false;
    for (int i = 1; i < value.length(); ++i)
        if (!asciiLetter(value[i]) && !asciiDigit(value[i])
            && value[i] != '_' && value[i] != '-')
            return false;
    return true;
}

bool isProtocolInstanceId(const juce::String& value)
{
    if (!value.startsWith("plugin-") || value.length() > 64)
        return false;
    const auto suffix = value.substring(7);
    if (suffix.isEmpty() || suffix.startsWithChar('0'))
        return false;
    return suffix.containsOnly("0123456789");
}

bool isExportMutation(const juce::String& type)
{
    // The worker never waits for the callback, but AudioDeviceAboutToStart also
    // republishes Sequencer sample-rate/block-size state. Defer that one live
    // mutation so the captured export contract remains immutable; every network,
    // transport, gain, MIDI and plug-in command stays immediate.
    return type == "selectDevice";
}

} // namespace

Engine::Engine(Ipc& ipc, EngineRuntimeIdentity identity)
    : ipc_(ipc), runtimeIdentity_(std::move(identity)),
      audioEngine_(
          [this](double sampleRate, int blockSize)
          {
              audioEnginePrepared(sampleRate, blockSize);
          },
          [this](const float* const* input, int inputChannels,
                 float* const* output, int outputChannels, int frames)
          {
              processEngine2Block(input, inputChannels, output, outputChannels, frames);
          },
          [this]()
          {
              audioEngineStopped();
          }),
      transport_(audioEngine_.transport())
{
    pluginPlayHead_.select(audioEngine_.transport());
    // Drain sample-clocked metronome events quickly while keeping the existing
    // transport/meter/diagnostic cadence at 10 Hz below.
    startTimerHz(60);
    // Without this the engine came up with NO audio device at all: it waited
    // for a selectDevice that only arrives if the user has already saved an
    // audio configuration. No device means no audio callback, which means the
    // MIDI FIFO is never drained and the instrument never receives a note -
    // the chain looked healthy and was simply never running.
    openDefaultOutput();
}

void Engine::openDefaultOutput()
{
    std::string nativeError;
    if (!audioEngine_.openDefault(currentSampleRate_, engine2::kTargetBlockSize,
                                  audioInputRequested_, nativeError))
    {
        const juce::String err(nativeError);
        engineError_ = err;
        engineRunning_ = false;
        sendError("device-open", "No default audio output could be opened: " + err);
        return;
    }
}

void Engine::applyAudioInputRequirement(bool required)
{
    if (required == audioInputRequested_)
        return;
    audioInputRequested_ = required;
    if (!audioEngine_.running())
        return; // the next open() already picks the new requirement up

    // Reopening is a real interruption, which is why it is bound to a topology
    // change (adding or removing the Audio Input node) and never to a value.
    std::string nativeError;
    const auto device = currentOutputDevice_.toStdString();
    const auto frames = static_cast<std::uint32_t>(
        juce::jlimit(1, static_cast<int>(engine2::kMaximumBlockSize), currentBlockSize_));
    const bool ok = device.empty()
        ? audioEngine_.openDefault(currentSampleRate_, frames, required, nativeError)
        : audioEngine_.selectDevice(device, currentSampleRate_, frames, required, nativeError);
    if (!ok)
    {
        engineError_ = juce::String(nativeError);
        engineRunning_ = false;
        sendError("device-open",
                  "Could not reopen the audio device for the new Audio Input routing: "
                      + engineError_);
        sendStatus();
        return;
    }
    sendDeviceState();
}

Engine::~Engine()
{
    stopTimer();
    *alive_ = false;
    cancelWorkers_.store(true, std::memory_order_release);
    stopAudio();
    chains_.clear();
    for (auto& worker : workers_)
        if (worker->thread.joinable())
            worker->thread.join();
    workers_.clear();
}

void Engine::timerCallback()
{
    MetronomeTick tick;
    while (metronomeTicks_.pop(tick))
    {
        juce::var event = makeObject();
        setProp(event, "type", "metronomeTick");
        setProp(event, "sequence", static_cast<juce::int64>(tick.sequence));
        setProp(event, "timeInSamples", static_cast<juce::int64>(tick.timeInSamples));
        setProp(event, "ppqPosition", tick.ppqPosition);
        setProp(event, "beat", static_cast<juce::int64>(tick.beat));
        setProp(event, "beatInBar", tick.beatInBar);
        setProp(event, "numerator", 4);
        setProp(event, "denominator", 4);
        setProp(event, "accent", tick.accent);
        setProp(event, "preCount", tick.preCount);
        setProp(event, "dropped", static_cast<juce::int64>(metronomeTicks_.dropped()));
        ipc_.send(event);
    }
    if (preCountComplete_.exchange(false, std::memory_order_acq_rel))
    {
        // The audio callback owns count-in timing; allocation-heavy take setup
        // stays on the JUCE message thread and starts on the unchanged live
        // playhead immediately after the fourth real click.
        if (!shutdownRequested_ && !sequencer_.exporting() && !sequencer_.recording())
            sequencer_.beginRecording(transport_);
        cmdGetTransport(juce::var());
    }
    if (++uiTelemetryDivider_ < 6) return;
    uiTelemetryDivider_ = 0;
    if (transport_.playing()) cmdGetTransport(juce::var());
    const auto now = juce::Time::getMillisecondCounterHiRes();
    if (sequencer_.exporting())
    {
        const auto frames = sequencer_.exportFrames();
        const auto targetFrames = sequencer_.exportTargetFrames();
        if (exportProgressStartedAtMs_ <= 0.0)
            exportProgressStartedAtMs_ = exportLastAdvancedAtMs_ = now;
        if (frames != lastPublishedExportFrames_)
            exportLastAdvancedAtMs_ = now;
        lastPublishedExportFrames_ = frames;
        auto progress = makeExportStage("progress", "progress",
            juce::File(sequencer_.exportFilePath()), sequencer_.exportFormat(), "update");
        setProp(progress, "frames", static_cast<juce::int64>(frames));
        setProp(progress, "targetFrames", static_cast<juce::int64>(targetFrames));
        setProp(progress, "progress", targetFrames > 0
            ? juce::jlimit(0.0, 1.0, static_cast<double>(frames) / static_cast<double>(targetFrames))
            : 0.0);
        setProp(progress, "elapsedMs", now - exportProgressStartedAtMs_);
        setProp(progress, "stalledMs", now - exportLastAdvancedAtMs_);
        const double transactionElapsedMs = std::max(0.001, now - exportTransactionStartedAtMs_);
        const double renderedSeconds = static_cast<double>(frames) / std::max(1.0, exportSampleRate_);
        setProp(progress, "renderedAudioSeconds", renderedSeconds);
        setProp(progress, "projectDurationSeconds",
                static_cast<double>(targetFrames) / std::max(1.0, exportSampleRate_));
        setProp(progress, "realtimeSpeed", renderedSeconds * 1000.0 / transactionElapsedMs);
        ipc_.send(progress);
    }
    for (auto event : sequencer_.serviceEvents())
    {
        const bool exportTerminal = event["type"].toString() == "sequencerExport";
        if (exportTerminal)
        {
            // Publish the live transport exactly as it exists before replaying
            // any network mutations that arrived during the frozen transaction.
            // These fields make transport isolation directly observable in a
            // packaged-runtime gauntlet instead of inferred from UI labels.
            setProp(event, "livePlaying", transport_.playing());
            setProp(event, "liveRecording", transport_.recording());
            setProp(event, "livePpqPosition", transport_.ppqPosition());
            setProp(event, "liveSamplePosition", transport_.samplePosition());
            setProp(event, "liveLoopEnabled", transport_.loopEnabled());
            setProp(event, "liveLoopStartPpq", transport_.loopStart());
            setProp(event, "liveLoopEndPpq", transport_.loopEnd());
            setProp(event, "deferredMutationCount",
                    static_cast<int>(deferredExportCommands_.size()));
        }
        if (exportTerminal)
        {
            const juce::File exportFile(event["filePath"].toString());
            const auto exportFormat = event["format"].toString();
            for (const auto* stage : { "finish-timeline", "Master", "encoder", "midi-cleanup",
                                       "finalization", "close-stream", "close-file" })
            {
                auto finished = makeExportStage("finalizing", stage, exportFile, exportFormat, "end");
                setProp(finished, "frames", event["frames"]);
                ipc_.send(finished);
            }
            ipc_.send(makeExportStage("finalizing", "destroy-render-context",
                                      exportFile, exportFormat, "begin"));
            clearExportContext();
            ipc_.send(makeExportStage("finalizing", "destroy-render-context",
                                      exportFile, exportFormat, "end"));
            setProp(event, "stage", "DONE");
            setProp(event, "phase", "end");
            const double completedAtMs = juce::Time::getMillisecondCounterHiRes();
            const double renderDurationMs = std::max(0.001, completedAtMs - exportTransactionStartedAtMs_);
            const double projectDurationSeconds = static_cast<double>((juce::int64) event["frames"])
                / std::max(1.0, exportSampleRate_);
            setProp(event, "projectDurationSeconds", projectDurationSeconds);
            setProp(event, "renderDurationMs", renderDurationMs);
            setProp(event, "realtimeSpeed", projectDurationSeconds * 1000.0 / renderDurationMs);
            setProp(event, "deviceIndependent", true);
            setProp(event, "hardwareOutput", false);
            lastPublishedExportFrames_ = -1;
            exportProgressStartedAtMs_ = 0.0;
            exportLastAdvancedAtMs_ = 0.0;
            exportTransactionStartedAtMs_ = 0.0;
            ipc_.send(event);
            flushDeferredExportCommands();
        }
        else ipc_.send(event);
    }
    const auto meter = masterOutput_.takeMeterSnapshot();
    // Automatic state capture calls VST3 getState(), which holds the plugin
    // against the audio thread for the whole serialisation (tens of ms on a
    // wavetable synth) and turns every block in that window into silence.
    // It is therefore deferred until the output has been provably inaudible,
    // which keeps crash-recovery snapshots without ever cutting a note.
    if (transport_.playing() || meter.preGainPeak > kQuiescencePeak)
        quiescentTelemetryTicks_ = 0;
    else if (quiescentTelemetryTicks_ < kQuiescentTicksBeforeStateCapture)
        ++quiescentTelemetryTicks_;
    if (quiescentTelemetryTicks_ >= kQuiescentTicksBeforeStateCapture)
        capturePluginStates(false);
    const auto outputSignal = audioOutputMeter_.takeTelemetrySnapshot();
    juce::var master = makeObject();
    setProp(master, "type", "masterMeter");
    setProp(master, "peakLeft", meter.peakLeft);
    setProp(master, "peakRight", meter.peakRight);
    setProp(master, "peakLeftDb", juce::Decibels::gainToDecibels(meter.peakLeft, -100.0f));
    setProp(master, "peakRightDb", juce::Decibels::gainToDecibels(meter.peakRight, -100.0f));
    setProp(master, "preGainPeak", meter.preGainPeak);
    setProp(master, "preGainPeakDb", juce::Decibels::gainToDecibels(meter.preGainPeak, -100.0f));
    setProp(master, "maximumPeak", meter.maximumPeak);
    setProp(master, "overRangeSamples", static_cast<juce::int64>(meter.overRangeSamples));
    setProp(master, "totalOverRangeSamples", static_cast<juce::int64>(meter.totalOverRangeSamples));
    setProp(master, "nonFiniteSamples", static_cast<juce::int64>(meter.nonFiniteSamples));
    setProp(master, "totalNonFiniteSamples", static_cast<juce::int64>(meter.totalNonFiniteSamples));
    setProp(master, "clip", meter.clipLatched);
    setProp(master, "gainDb", masterOutput_.gainDb());
    setProp(master, "gainCoefficient", juce::Decibels::decibelsToGain(masterOutput_.gainDb()));
    setProp(master, "automaticGainReduction", false);
    setProp(master, "gainReductionCoefficient", 1.0f);
    juce::var outputObservation = makeObject();
    setSignalTelemetry(outputObservation, outputSignal);
    setProp(master, "audioOutputObservation", outputObservation);
    ipc_.send(master);
    if (++timingDiagnosticTicks_ >= 10) {
        timingDiagnosticTicks_=0;
        for(auto& chain:chains_) for(auto* plugin:chain.second->copyPlugins()) {
            juce::var out=makeObject();setProp(out,"type","hostTiming");setProp(out,"nodeId",chain.first);setProp(out,"chainId",chain.first);setProp(out,"instanceId",plugin->instanceId());setProp(out,"bpm",transport_.bpm());setProp(out,"playing",transport_.playing());setProp(out,"ppqPosition",transport_.ppqPosition());setProp(out,"timeInSamples",transport_.samplePosition());setProp(out,"numerator",4);setProp(out,"denominator",4);ipc_.send(out);
            const auto signal=plugin->takeSignalTelemetry();const auto processing=plugin->takeProcessingTelemetry();juce::var diagnostic=makeObject();setProp(diagnostic,"type","audioPathTelemetry");setProp(diagnostic,"scope","vst");setProp(diagnostic,"nodeId",chain.first);setProp(diagnostic,"chainId",chain.first);setProp(diagnostic,"instanceId",plugin->instanceId());setProp(diagnostic,"pluginId",plugin->pluginId());setProp(diagnostic,"name",plugin->name());setProp(diagnostic,"role",plugin->isInstrument()?"instrument":"effect");setProp(diagnostic,"gainCoefficient",1.0f);setSignalTelemetry(diagnostic,signal);setProp(diagnostic,"processMilliseconds",processing.lastMilliseconds);setProp(diagnostic,"maximumRecentProcessMilliseconds",processing.maximumRecentMilliseconds);setProp(diagnostic,"maximumProcessMilliseconds",processing.maximumMilliseconds);setProp(diagnostic,"processCalls",static_cast<juce::int64>(processing.processCalls));ipc_.send(diagnostic);
        }
        if(auto* plan=activeAudioPlan_.load(std::memory_order_acquire))for(const auto& node:plan->nodes())if(node.signalMeter){juce::var diagnostic=makeObject();setProp(diagnostic,"type","audioPathTelemetry");setProp(diagnostic,"scope","network");setProp(diagnostic,"nodeId",juce::String(node.id));setProp(diagnostic,"role",node.kind==AudioNodeKind::mixer?"mixer":"morpher");setProp(diagnostic,"gainCoefficient",node.masterLevel());juce::Array<juce::var> inputGains;for(size_t i=0;i<node.sources.size();++i)inputGains.add(node.muted(i)?0.0f:node.level(i)*node.masterLevel());setProp(diagnostic,"inputGainCoefficients",inputGains);setSignalTelemetry(diagnostic,node.signalMeter->takeTelemetrySnapshot());ipc_.send(diagnostic);}
        for(const auto& trace:sequencer_.trackSignalTrace(&transport_)){juce::var diagnostic=makeObject();setProp(diagnostic,"type","audioPathTelemetry");setProp(diagnostic,"scope","sequencer-track");setProp(diagnostic,"trackId",juce::String(trace.trackId));setProp(diagnostic,"trackType",juce::String(trace.trackType));setProp(diagnostic,"activeClips",trace.activeClips);setProp(diagnostic,"peakBeforeSum",trace.peakBeforeSum);setProp(diagnostic,"peakAfterSum",trace.peakAfterSum);setProp(diagnostic,"gainCoefficient",trace.gainApplied);setProp(diagnostic,"peakAfterGain",trace.peakAfterGain);setProp(diagnostic,"destinationBuffer",juce::String(trace.destinationBuffer));ipc_.send(diagnostic);}
        const float deadline = static_cast<float>(callbackDeadlineMilliseconds_);
        const float duration = callbackDurationMilliseconds_.load(std::memory_order_acquire);
        const auto realtime = audioEngine_.realtimeStats();
        juce::var runtime = makeObject();
        setProp(runtime, "type", "audioRuntimeTelemetry");
        setProp(runtime, "callbackMilliseconds", duration);
        setProp(runtime, "maximumRecentCallbackMilliseconds",
                maximumCallbackDurationSinceSnapshot_.exchange(0.0f, std::memory_order_acq_rel));
        setProp(runtime, "maximumCallbackMilliseconds",
                maximumCallbackDuration_.load(std::memory_order_acquire));
        setProp(runtime, "deadlineMilliseconds", deadline);
        setProp(runtime, "audioCpuPercent", deadline > 0.0f ? 100.0f * duration / deadline : 0.0f);
        setProp(runtime, "maximumRecentCallbackGapMilliseconds",
                maximumCallbackGapSinceSnapshot_.exchange(0.0f, std::memory_order_acq_rel));
        setProp(runtime, "deadlineMisses", static_cast<juce::int64>(
                    deadlineMissesSinceSnapshot_.exchange(0, std::memory_order_acq_rel)));
        setProp(runtime, "totalDeadlineMisses", static_cast<juce::int64>(
                    totalDeadlineMisses_.load(std::memory_order_acquire)));
        setProp(runtime, "estimatedSchedulingUnderruns", static_cast<juce::int64>(
                    schedulingGapsSinceSnapshot_.exchange(0, std::memory_order_acq_rel)));
        setProp(runtime, "totalEstimatedSchedulingUnderruns", static_cast<juce::int64>(
                    totalSchedulingGaps_.load(std::memory_order_acquire)));
        setProp(runtime, "portAudioFormat", "paFloat32");
        setProp(runtime, "portAudioOutputChannels", 2);
        setProp(runtime, "portAudioOutputInterleaved", true);
        setProp(runtime, "portAudioCallbacks", static_cast<juce::int64>(realtime.callbacks));
        setProp(runtime, "portAudioCallbackId", static_cast<juce::int64>(realtime.callbackSequenceId));
        setProp(runtime, "portAudioCallbackFrames", static_cast<int>(realtime.lastCallbackFrames));
        setProp(runtime, "maximumPortAudioCallbackFrames",
                static_cast<int>(realtime.maximumCallbackFrames));
        setProp(runtime, "audioNetworkProcessCalls",
                static_cast<juce::int64>(realtime.audioNetworkProcessCalls));
        setProp(runtime, "audioNetworkProcessId",
                static_cast<juce::int64>(realtime.audioNetworkSequenceId));
        setProp(runtime, "masterOutputProcessCalls",
                static_cast<juce::int64>(realtime.masterOutputProcessCalls));
        setProp(runtime, "masterOutputProcessId",
                static_cast<juce::int64>(realtime.masterOutputSequenceId));
        setProp(runtime, "portAudioOutputWrites", static_cast<juce::int64>(realtime.outputWrites));
        setProp(runtime, "portAudioOutputWriteId",
                static_cast<juce::int64>(realtime.outputWriteSequenceId));
        setProp(runtime, "oneNetworkMasterWritePerCallback",
                realtime.callbacks == realtime.audioNetworkProcessCalls
                    && realtime.callbacks == realtime.masterOutputProcessCalls
                    && realtime.callbacks == realtime.outputWrites
                    && realtime.callbackSequenceId == realtime.audioNetworkSequenceId
                    && realtime.callbackSequenceId == realtime.masterOutputSequenceId
                    && realtime.callbackSequenceId == realtime.outputWriteSequenceId);
        setProp(runtime, "paOutputUnderflows", static_cast<juce::int64>(realtime.outputUnderflows));
        setProp(runtime, "paOutputOverflows", static_cast<juce::int64>(realtime.outputOverflows));
        setProp(runtime, "paInputUnderflows", static_cast<juce::int64>(realtime.inputUnderflows));
        setProp(runtime, "paInputOverflows", static_cast<juce::int64>(realtime.inputOverflows));
        setProp(runtime, "paPrimingOutputs", static_cast<juce::int64>(realtime.primingOutputs));
        setProp(runtime, "paOtherStatusFlags", static_cast<juce::int64>(realtime.otherStatusFlags));
        setProp(runtime, "portAudioNanSamples", static_cast<juce::int64>(realtime.nanSamples));
        setProp(runtime, "portAudioPositiveInfinitySamples",
                static_cast<juce::int64>(realtime.positiveInfinitySamples));
        setProp(runtime, "portAudioNegativeInfinitySamples",
                static_cast<juce::int64>(realtime.negativeInfinitySamples));
        setProp(runtime, "portAudioNonFiniteSamples", static_cast<juce::int64>(
                    realtime.nanSamples + realtime.positiveInfinitySamples
                    + realtime.negativeInfinitySamples));
        setProp(runtime, "portAudioLastCopiedPeak", realtime.lastOutputPeak);
        setProp(runtime, "portAudioMaximumCopiedPeak", realtime.maximumOutputPeak);
        setProp(runtime, "portAudioCallbackMilliseconds", realtime.lastCallbackMilliseconds);
        setProp(runtime, "maximumPortAudioCallbackMilliseconds",
                realtime.maximumCallbackMilliseconds);
        setProp(runtime, "portAudioDeadlineMisses",
                static_cast<juce::int64>(realtime.deadlineMisses));
        setProp(runtime, "portAudioCapturedFrames",
                static_cast<juce::int64>(realtime.capturedFrames));
        setProp(runtime, "nativeWasapiXrunCounterAvailable", true);
        // Silent dropouts. These are the blocks that reach the device as clean,
        // on-time zeroes and are therefore invisible to every counter above.
        const auto chainSkipped =
            RealtimeDropCounters::chainBlocksSkipped().load(std::memory_order_relaxed);
        const auto pluginSkipped =
            RealtimeDropCounters::pluginBlocksSkipped().load(std::memory_order_relaxed);
        setProp(runtime, "chainBlocksSkipped", static_cast<juce::int64>(chainSkipped));
        setProp(runtime, "pluginBlocksSkipped", static_cast<juce::int64>(pluginSkipped));
        setProp(runtime, "chainBlocksSkippedSinceSnapshot",
                static_cast<juce::int64>(chainSkipped - lastChainBlocksSkipped_));
        setProp(runtime, "pluginBlocksSkippedSinceSnapshot",
                static_cast<juce::int64>(pluginSkipped - lastPluginBlocksSkipped_));
        setProp(runtime, "silentBlockDropouts",
                static_cast<juce::int64>(chainSkipped + pluginSkipped));
        lastChainBlocksSkipped_ = chainSkipped;
        lastPluginBlocksSkipped_ = pluginSkipped;
        ipc_.send(runtime);
    }
}

void Engine::capturePluginStates(bool force)
{
    for (auto& chain : chains_) for (auto* plugin : chain.second->copyPlugins()) {
        juce::var state; if(!plugin->takeStateSnapshotIfDue(state,force)) continue;
        juce::var out=makeObject();setProp(out,"type","pluginState");setProp(out,"chainId",plugin->chainId());setProp(out,"instanceId",plugin->instanceId());setProp(out,"pluginId",plugin->pluginId());setProp(out,"generation",plugin->generation());setProp(out,"state",state);ipc_.send(out);
    }
}

void Engine::stopAudio()
{
    // Stop/join the single PortAudio callback before dropping plugin ownership.
    audioEngine_.stop();
    audioChainCount_.store(0, std::memory_order_release);
}

void Engine::handleCommand(const juce::var& msg)
{
    const juce::String type = msg["type"].toString();

    if (shutdownRequested_ && type != "shutdown")
        return;

    if (exportTransactionActive() && !replayingDeferredExportCommands_)
    {
        // Only a device restart waits. Network, plugin, transport and live MIDI
        // commands address processors that are disjoint from the export clones.
        if (isExportMutation(type))
        {
            deferredExportCommands_.push_back(msg);
            return;
        }
    }

    if (type == "hello") cmdHello(msg);
    else if (type == "listDevices") cmdListDevices(msg);
    else if (type == "selectDevice") cmdSelectDevice(msg);
    else if (type == "selectMidiOutput") cmdSelectMidiOutput(msg);
    else if (type == "getDeviceState") cmdGetDeviceState(msg);
    else if (type == "scanVst3") cmdScanVst3(msg);
    else if (type == "listPlugins") cmdListPlugins(msg);
    else if (type == "createInstance") cmdCreateInstance(msg);
    else if (type == "removeInstance") cmdRemoveInstance(msg);
    else if (type == "reorderChain") cmdReorderChain(msg);
    else if (type == "setBypass") cmdSetBypass(msg);
    else if (type == "midi") cmdMidi(msg);
    else if (type == "midiNode") cmdMidiNode(msg);
    else if (type == "setChainMidiEnabled") cmdSetChainMidiEnabled(msg);
    else if (type == "setChainOutputEnabled") cmdSetChainOutputEnabled(msg);
    else if (type == "openEditor") cmdOpenEditor(msg);
    else if (type == "closeEditor") cmdCloseEditor(msg);
    else if (type == "getState") cmdGetState(msg);
    else if (type == "setState") cmdSetState(msg);
    else if (type == "getVstParameters") cmdGetVstParameters(msg);
    else if (type == "setVstParameter") cmdSetVstParameter(msg);
    else if (type == "setVstParameterLearn") cmdSetVstParameterLearn(msg);
    else if (type == "setTransport") cmdSetTransport(msg);
    else if (type == "getTransport") cmdGetTransport(msg);
    else if (type == "foregroundEditors") cmdForegroundEditors(msg);
    else if (type == "syncAudioNetwork") cmdSyncAudioNetwork(msg);
    else if (type == "setAudioNodeValues") cmdSetAudioNodeValues(msg);
    else if (type == "syncMidiNetwork") cmdSyncMidiNetwork(msg);
    else if (type == "setMetronome") cmdSetMetronome(msg);
    else if (type == "setMasterOutput") cmdSetMasterOutput(msg);
    else if (type == "resetMasterClip") cmdResetMasterClip(msg);
    else if (type == "syncSequencer") cmdSyncSequencer(msg);
    else if (type == "setSequencerTrackControl") cmdSetSequencerTrackControl(msg);
    else if (type == "sequencerMidiInput") cmdSequencerMidiInput(msg);
    else if (type == "sequencerRecord") cmdSequencerRecord(msg);
    else if (type == "sequencerExport") cmdSequencerExport(msg);
    else if (type == "sequencerCancelExport") cmdSequencerCancelExport(msg);
    else if (type == "sequencerQuiesce") cmdSequencerQuiesce(msg);
    else if (type == "sequencerPanic") cmdSequencerPanic(msg);
    else if (type == "capturePluginStates") cmdCapturePluginStates(msg);
    else if (type == "shutdown") cmdShutdown(msg);
    else
        sendError("unknown-command", "Unknown command type: " + type);
}

void Engine::flushDeferredExportCommands()
{
    auto commands = std::move(deferredExportCommands_);
    deferredExportCommands_.clear();
    replayingDeferredExportCommands_ = true;
    for (const auto& command : commands)
        handleCommand(command);
    replayingDeferredExportCommands_ = false;
}

void Engine::clearExportContext()
{
    while (!tryClearExportContext())
        juce::Thread::yield();
}

bool Engine::tryClearExportContext() noexcept
{
    // The offline worker publishes its pointer in exportContextHazard_ before any
    // dereference and rechecks activeExportContext_. Clearing active first is
    // therefore enough to reject a callback that has only loaded the pointer;
    // an already-active callback retains ownership until its hazard clears.
    activeExportContext_.store(nullptr, std::memory_order_release);
    if (exportContextHazard_.load(std::memory_order_acquire) != nullptr)
        return false;
    exportContext_.reset();
    return true;
}

void Engine::renderOfflineExport(uint64_t generation) noexcept
{
    ExportContext* context = nullptr;
    do
    {
        context = activeExportContext_.load(std::memory_order_acquire);
        exportContextHazard_.store(context, std::memory_order_release);
    }
    while (context != activeExportContext_.load(std::memory_order_acquire));

    if (context == nullptr || context->audioPlan == nullptr || context->midiPlan == nullptr)
    {
        exportContextHazard_.store(nullptr, std::memory_order_release);
        return;
    }

    auto& offline = sequencer_.exportTransport();
    const int blockSize = std::max(1, context->audio.getNumSamples());
    while (generation == exportGeneration_.load(std::memory_order_acquire)
           && !cancelWorkers_.load(std::memory_order_acquire)
           && sequencer_.exporting())
    {
        const auto remaining = sequencer_.exportTargetFrames() - sequencer_.exportFrames();
        const int numSamples = static_cast<int>(std::min<int64_t>(blockSize, std::max<int64_t>(0, remaining)));
        if (numSamples <= 0)
            break;

        context->audio.clear(0, numSamples);
        float* channels[2] = { context->audio.getWritePointer(0),
                               context->audio.getWritePointer(1) };
        offline.beginBlock();
        sequencer_.processMidi(numSamples, offline, context->midiPlan.get(), nullptr, 0);
        context->midiPlan->process(numSamples, offline, nullptr, 0, context->sampleRate);
        context->audioPlan->process(channels, 2, numSamples, offline,
                                    context->midiScratch, nullptr);
        context->master.process(channels, 2, numSamples);
        sequencer_.processMaster(channels, 2, numSamples, offline);
        offline.advance(numSamples);
    }

    if (!sequencer_.finalizeRequestedCancel()
        && cancelWorkers_.load(std::memory_order_acquire) && sequencer_.exporting())
        sequencer_.cancelExport(false);

    if (sequencer_.consumeExportCleanupRequest())
    {
        context->midiPlan->panicAll(nullptr);
        // Deliver Note Off/CC123/CC120 once to every export-only processor,
        // including destinations that are not connected to Audio Output.
        for (auto& item : context->chains)
        {
            context->audio.clear();
            context->midiScratch.clear();
            item.second->processBlock(context->audio, context->midiScratch,
                                      context->audio.getNumSamples(), 0);
        }
    }
    exportContextHazard_.store(nullptr, std::memory_order_release);
}

void Engine::sendStatus()
{
    juce::var out = makeObject();
    setProp(out, "type", "status");
    setProp(out, "engine",
            engineRunning_ ? "running" : (engineError_.isNotEmpty() ? "error" : "stopped"));
    setProp(out, "error", engineError_.isNotEmpty() ? engineError_ : juce::var());
    setProp(out, "scanning", scanning_);
    ipc_.send(out);
}

void Engine::sendError(const juce::String& code, const juce::String& message)
{
    ipc_.send(makeError(code, message));
}

void Engine::sendDeviceState()
{
    const auto& trace = audioEngine_.deviceTrace();
    juce::var out = makeObject();
    setProp(out, "type", "deviceState");
    setProp(out, "running", engineRunning_);
    setProp(out, "device", currentOutputDevice_);
    setProp(out, "inputDevice", juce::String(trace.inputDeviceName));
    setProp(out, "backend", juce::String(trace.backend));
    setProp(out, "sampleRate", currentSampleRate_);
    setProp(out, "bufferSize", currentBlockSize_);
    setProp(out, "portAudioSampleFormat", trace.outputFloat32 ? "paFloat32" : "unknown");
    setProp(out, "outputChannels", trace.outputChannels);
    setProp(out, "outputInterleaved", trace.outputInterleaved);
    setProp(out, "outputSampleBytes", static_cast<int>(trace.outputSampleBytes));
    setProp(out, "activeStreams", audioEngine_.activeStreamCount());
    setProp(out, "error", engineError_.isNotEmpty() ? engineError_ : juce::var());
    ipc_.send(out);
}

void Engine::sendChainChanged(const juce::String& chainId)
{
    Chain* chain = getChain(chainId);
    if (!chain)
        return;

    // Plugin order/bypass/removal can change cumulative latency. Publish a
    // freshly prepared immutable Engine 2 network before advertising the chain.
    republishActiveAudioNetwork();

    juce::var out = makeObject();
    setProp(out, "type", "chainChanged");
    setProp(out, "chainId", chainId);

    juce::Array<juce::var> instances;
    for (auto* p : chain->copyPlugins())
    {
        juce::var inst = makeObject();
        setProp(inst, "instanceId", p->instanceId());
        setProp(inst, "pluginId", p->pluginId());
        setProp(inst, "name", p->name());
        setProp(inst, "role", p->role());
        setProp(inst, "bypassed", p->bypassed());
        setProp(inst, "generation", p->generation());
        setProp(inst, "status", p->isReady() ? "ready" : "error");
        instances.add(inst);
    }
    setProp(out, "instances", instances);
    ipc_.send(out);
}

void Engine::sendInstanceStatus(const juce::String& chainId, PluginInstance* inst)
{
    juce::var out = makeObject();
    setProp(out, "type", "instanceStatus");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", inst->instanceId());
    setProp(out, "status", inst->isReady() ? "ready" : "error");
    setProp(out, "error", inst->isReady() ? juce::var() : inst->error());
    ipc_.send(out);
}

void Engine::sendParameterTouched(PluginInstance& inst,
                                  const PluginInstance::TouchedParameter& touched)
{
    if (shutdownRequested_
        || !isCurrentInstanceGeneration(inst.chainId(), inst.instanceId(), inst.generation()))
        return;
    juce::String code, message;
    if (lookupInstance(inst.chainId(), inst.instanceId(), code, message) != &inst)
        return; // replaced instance: ignore its queued/stale parameter event

    juce::var out = makeObject();
    setProp(out, "type", "vstParameterTouched");
    setProp(out, "chainId", inst.chainId());
    setProp(out, "instanceId", inst.instanceId());
    setProp(out, "pluginId", inst.pluginId());
    setProp(out, "generation", inst.generation());
    setProp(out, "parameterId", touched.parameterId);
    setProp(out, "name", touched.name);
    setProp(out, "normalizedValue", touched.normalizedValue);
    setProp(out, "gestureAware", touched.gestureAware);
    setProp(out, "capturedByLearn", touched.capturedByLearn);
    setProp(out, "learnId", touched.learnId.isNotEmpty()
        ? juce::var(touched.learnId) : juce::var());
    ipc_.send(out);
}

void Engine::sendEditorStatus(PluginInstance& inst, bool open, const juce::String& message)
{
    if (shutdownRequested_
        || !isCurrentInstanceGeneration(inst.chainId(), inst.instanceId(), inst.generation()))
        return;
    juce::var out = makeObject();
    setProp(out, "type", "editorStatus");
    setProp(out, "chainId", inst.chainId());
    setProp(out, "instanceId", inst.instanceId());
    setProp(out, "pluginId", inst.pluginId());
    setProp(out, "generation", inst.generation());
    setProp(out, "open", open);
    setProp(out, "width", open ? inst.editorWidth() : 0);
    setProp(out, "height", open ? inst.editorHeight() : 0);
    if (message.isNotEmpty())
        setProp(out, "message", message);
    ipc_.send(out);
}

void Engine::sendParameterLearnState(const juce::String& learnId,
                                     const juce::String& chainId,
                                     const juce::String& instanceId,
                                     const juce::String& pluginId,
                                     juce::int64 generation,
                                     bool armed,
                                     const juce::String& reason)
{
    juce::var out = makeObject();
    setProp(out, "type", "vstParameterLearnState");
    setProp(out, "learnId", learnId);
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);
    setProp(out, "pluginId", pluginId);
    setProp(out, "generation", generation);
    setProp(out, "armed", armed);
    if (reason.isNotEmpty())
        setProp(out, "reason", reason);
    ipc_.send(out);
}

void Engine::parameterLearnEnded(PluginInstance& inst,
                                 const juce::String& learnId,
                                 const juce::String& reason)
{
    if (!activeParameterLearn_ || activeParameterLearn_->learnId != learnId
        || activeParameterLearn_->chainId != inst.chainId()
        || activeParameterLearn_->instanceId != inst.instanceId()
        || activeParameterLearn_->pluginId != inst.pluginId()
        || activeParameterLearn_->generation != inst.generation())
        return;
    auto ended = std::move(activeParameterLearn_);
    sendParameterLearnState(ended->learnId, ended->chainId, ended->instanceId,
                            ended->pluginId, ended->generation, false, reason);
}

void Engine::cancelActiveParameterLearn(const juce::String& reason)
{
    if (!activeParameterLearn_)
        return;
    const auto active = *activeParameterLearn_;
    juce::String code, message;
    auto* inst = lookupInstance(active.chainId, active.instanceId, code, message);
    if (inst != nullptr && inst->pluginId() == active.pluginId
        && inst->generation() == active.generation
        && isCurrentInstanceGeneration(active.chainId, active.instanceId, active.generation))
    {
        inst->cancelParameterLearn(reason); // callback clears + reports the exact operation
        if (!activeParameterLearn_)
            return;
    }
    activeParameterLearn_.reset();
    sendParameterLearnState(active.learnId, active.chainId, active.instanceId,
                            active.pluginId, active.generation, false, reason);
}

void Engine::launchWorker(std::function<void()> work)
{
    auto slot = std::make_unique<WorkerSlot>();
    slot->done = std::make_shared<std::atomic<bool>>(false);
    const auto done = slot->done;
    auto alive = alive_;
    slot->thread = std::thread([this, alive, done, work = std::move(work)]() mutable
    {
        try
        {
            work();
        }
        catch (...)
        {
            // A worker must always reach the owned-worker completion path so
            // shutdown cannot wait forever on an exception.
        }
        done->store(true, std::memory_order_release);
        juce::MessageManager::callAsync([this, alive]()
        {
            if (*alive)
                workerFinished();
        });
    });
    workers_.push_back(std::move(slot));
}

void Engine::postWorkerResult(std::function<void()> result)
{
    pendingWorkerCallbacks_.fetch_add(1, std::memory_order_acq_rel);
    auto alive = alive_;
    const bool posted = juce::MessageManager::callAsync(
        [this, alive, result = std::move(result)]() mutable
        {
            if (!*alive)
                return;
            try
            {
                result();
            }
            catch (...)
            {
                // Completion accounting must run even if a plugin/JUCE result
                // handler throws. The engine is still alive on this thread.
            }
            pendingWorkerCallbacks_.fetch_sub(1, std::memory_order_acq_rel);
            workerFinished();
        });
    if (!posted)
        pendingWorkerCallbacks_.fetch_sub(1, std::memory_order_acq_rel);
}

void Engine::reapFinishedWorkers()
{
    for (auto it = workers_.begin(); it != workers_.end();)
    {
        if (!(*it)->done->load(std::memory_order_acquire))
        {
            ++it;
            continue;
        }
        if ((*it)->thread.joinable())
            (*it)->thread.join();
        it = workers_.erase(it);
    }
}

void Engine::workerFinished()
{
    reapFinishedWorkers();
    if (shutdownRequested_ && workers_.empty()
        && pendingWorkerCallbacks_.load(std::memory_order_acquire) == 0)
        finishShutdown();
}

void Engine::requestShutdown(bool sendAck)
{
    shutdownAckRequested_ = shutdownAckRequested_ || sendAck;
    if (shutdownRequested_)
        return;

    shutdownRequested_ = true;
    cancelWorkers_.store(true, std::memory_order_release);
    if (exportCancel_) exportCancel_->store(true, std::memory_order_release);
    exportPreparing_.store(false, std::memory_order_release);
    cancelActiveParameterLearn("engine-shutdown");
    stopAudio();
    capturePluginStates(true);
    instanceGenerations_.clear();
    pendingPluginLoads_.clear();
    chains_.clear();
    reapFinishedWorkers();
    if (workers_.empty() && pendingWorkerCallbacks_.load(std::memory_order_acquire) == 0)
        finishShutdown();
}

void Engine::finishShutdown()
{
    if (shutdownFinished_)
        return;
    shutdownFinished_ = true;
    if (shutdownAckRequested_)
    {
        juce::var out = makeObject();
        setProp(out, "type", "shutdownAck");
        ipc_.send(out);
    }
    if (auto* app = juce::JUCEApplicationBase::getInstance())
        app->quit();
}

// ---- commands ----

void Engine::cmdHello(const juce::var& msg)
{
    juce::var out = makeObject();
    setProp(out, "type", "hello");
    setProp(out, "protocolVersion", kProtocolVersion);
    setProp(out, "engineVersion", "2.0.0");
    setProp(out, "buildId", "engine2-minihub-integration-20260824");
    juce::Array<juce::var> features;features.add("engine2");features.add("portaudio-wasapi-shared");features.add("single-audio-stream");features.add("native-sequencer");features.add("midi-recording");features.add("audio-track-recording");features.add("master-wav-export");features.add("master-mp3-export");features.add("master-ogg-export");features.add("isolated-export-transport");features.add("native-metronome");features.add("native-metronome-precount");features.add("sample-clocked-midi-output");features.add("sequencer-arpeggiator-routing");features.add("per-node-vst-gain-staging");features.add("audio-runtime-telemetry");setProp(out,"features",features);
    juce::var exportCapabilities=makeObject();juce::Array<juce::var> formats;formats.add("wav");formats.add("mp3");formats.add("ogg");setProp(exportCapabilities,"formats",formats);juce::Array<juce::var> wavBits;wavBits.add(16);wavBits.add(24);wavBits.add(32);setProp(exportCapabilities,"wavBitDepths",wavBits);juce::Array<juce::var> mp3Bitrates;mp3Bitrates.add(128);mp3Bitrates.add(192);mp3Bitrates.add(256);mp3Bitrates.add(320);setProp(exportCapabilities,"mp3BitratesKbps",mp3Bitrates);juce::Array<juce::var> oggQualities;for(const auto& quality:SequencerEngine::oggQualityOptions())oggQualities.add(quality);setProp(exportCapabilities,"oggQualityOptions",oggQualities);setProp(exportCapabilities,"mp3Available",SequencerEngine::bundledLameExecutable().existsAsFile());setProp(exportCapabilities,"mp3Encoder","LAME 3.100.1 via JUCE LAMEEncoderAudioFormat");setProp(out,"sequencerExportCapabilities",exportCapabilities);
    setProp(out, "juceVersion", juce::SystemStats::getJUCEVersion());
    setProp(out, "platform", "win-x64");
    juce::var process = makeObject();
    setProp(process, "pid", runtimeIdentity_.processId);
    setProp(process, "parentPid", runtimeIdentity_.parentProcessId);
    setProp(process, "role", runtimeIdentity_.role);
    setProp(process, "createdAt", runtimeIdentity_.createdAt);
    setProp(process, "arguments", runtimeIdentity_.arguments);
    setProp(process, "audioDeviceOpen", audioEngine_.running());
    setProp(process, "audioBackend", "PortAudio / WASAPI shared");
    setProp(process, "activeAudioStreams", audioEngine_.activeStreamCount());
    setProp(process, "lifetime", "application");
    setProp(process, "reason", "Electron main-process singleton");
    setProp(out, "nativeProcess", process);
    ipc_.send(out);
}

void Engine::cmdListDevices(const juce::var& msg)
{
    juce::var out = makeObject();
    setProp(out, "type", "devices");

    juce::Array<juce::var> outputs;
    juce::Array<juce::var> inputs;
    std::string deviceError;
    for (const auto& device : audioEngine_.devices(deviceError))
    {
        juce::var dev = makeObject();
        setProp(dev, "name", juce::String(device.name));
        setProp(dev, "type", juce::String(device.backend));
        setProp(dev, "isWASAPI", device.isWasapi);
        setProp(dev, "defaultSampleRate", device.defaultSampleRate);
        if (device.hasOutput)
        {
            outputs.add(dev);
        }
        if (device.hasInput)
        {
            inputs.add(dev);
        }
    }
    setProp(out, "outputs", outputs);
    setProp(out, "inputs", inputs);
    setProp(out, "midiOutputs", PhysicalMidiOutput::describeAvailableDevices());
    setProp(out, "current", currentOutputDevice_);
    setProp(out, "currentMidiOutput", physicalMidiOutput_.selectedIdentifier());
    if (!deviceError.empty()) setProp(out, "error", juce::String(deviceError));
    ipc_.send(out);
}

void Engine::sendMidiOutputState()
{
    juce::var out=makeObject();setProp(out,"type","midiOutputState");
    setProp(out,"available",physicalMidiOutput_.available());
    setProp(out,"identifier",physicalMidiOutput_.selectedIdentifier());
    setProp(out,"name",physicalMidiOutput_.selectedName());ipc_.send(out);
}

void Engine::cmdSelectMidiOutput(const juce::var& msg)
{
    const auto identifier=msg["identifier"].toString(),name=msg["name"].toString();
    if(identifier.length()>512||name.length()>256){sendError("midi-output-invalid","Malformed MIDI output selection");return;}
    juce::String error;if(!physicalMidiOutput_.selectDevice(identifier,name,error)){sendError("midi-output-open",error);sendMidiOutputState();return;}sendMidiOutputState();
}

void Engine::panicAllMidi()
{
    sequencer_.panic();
    // MidiExecutionPlan owns mutable scheduled buffers and ArpeggiatorRuntime
    // state. Never touch it here on the message thread while the callback may
    // be processing the same plan. Every chain has its own atomic panic gate;
    // only the mutable plan state is reset at the next callback.
    for(auto& chain:chains_)chain.second->panic();
    midiPanicPending_.store(true,std::memory_order_release);
    // PhysicalMidiOutput::panic clears a scheduler and sends 32 immediate
    // messages. Keep that potentially blocking work off the real-time audio
    // thread. Its active JUCE port is atomically published and retained, so it
    // can be silenced safely here even while a callback holds the same port.
    physicalMidiOutput_.panic();
}

void Engine::clearAudioNetwork()
{
    activeAudioSpec_.nodes.clear();
    publishAudioPlan(std::make_unique<AudioExecutionPlan>());
    applyAudioInputRequirement(false);
}

void Engine::publishAudioPlan(std::unique_ptr<AudioExecutionPlan> plan)
{
    auto* published = plan.get();
    audioPlans_.push_back(std::move(plan));
    activeAudioPlan_.store(published, std::memory_order_release);
    // A callback increments before loading activeAudioPlan_. Old networks are
    // reclaimed only when there is provably no reader in that interval.
    if (audioNetworkReaders_.load(std::memory_order_acquire) == 0)
        audioPlans_.erase(std::remove_if(audioPlans_.begin(), audioPlans_.end(),
            [published](const auto& owned) { return owned.get() != published; }),
            audioPlans_.end());
}

void Engine::republishActiveAudioNetwork()
{
    if (activeAudioSpec_.nodes.empty())
        return;
    std::string error;
    auto plan = AudioExecutionPlan::compile(activeAudioSpec_,
        [this](const std::string& id) { return getOrCreateChain(juce::String(id)); },
        &sequencer_, currentBlockSize_, error);
    if (plan)
        publishAudioPlan(std::move(plan));
    else
        sendError("audio-network-rebuild", juce::String(error));
}

void Engine::clearMidiNetwork()
{
    activeMidiSpec_.nodes.clear();
    // Silence old processor/chain/hardware destinations before publishing the
    // empty immutable plan. The mutable old plan is reset by the callback gate.
    panicAllMidi();
    auto plan=std::make_unique<MidiExecutionPlan>();auto* published=plan.get();midiPlans_.push_back(std::move(plan));
    activeMidiPlan_.store(published,std::memory_order_release);
}

void Engine::cmdSelectDevice(const juce::var& msg)
{
    const juce::var deviceVar = msg["device"];
    const juce::String deviceName = deviceVar.isObject() ? deviceVar["name"].toString() : juce::String();
    const bool sampleRateIsNumber = msg["sampleRate"].isInt() || msg["sampleRate"].isInt64()
        || msg["sampleRate"].isDouble();
    const double sampleRate = sampleRateIsNumber ? static_cast<double>(msg["sampleRate"]) : 0.0;
    const bool bufferSizeIsInteger = msg["bufferSize"].isInt() || msg["bufferSize"].isInt64();
    const int bufferSize = bufferSizeIsInteger ? static_cast<int>(msg["bufferSize"]) : 0;

    if (deviceName.isEmpty() || deviceName.length() > 256
        || !sampleRateIsNumber || !std::isfinite(sampleRate)
        || sampleRate < 8000.0 || sampleRate > 384000.0
        || !bufferSizeIsInteger || bufferSize < 16
        || bufferSize > static_cast<int>(engine2::kMaximumBlockSize))
    {
        sendError("device-invalid", "Malformed audio output configuration");
        return;
    }

    std::string nativeError;
    if (!audioEngine_.selectDevice(deviceName.toStdString(), sampleRate,
                                   static_cast<std::uint32_t>(bufferSize),
                                   audioInputRequested_, nativeError))
    {
        const juce::String err(nativeError);
        engineError_ = err;
        engineRunning_ = false;
        sendError("device-open", err);
        sendStatus();
        return;
    }

    sendDeviceState();
    sendStatus();
}

void Engine::cmdGetDeviceState(const juce::var& msg)
{
    sendDeviceState();
    sendStatus();
}

void Engine::sendPlugins()
{
    juce::var out = makeObject();
    setProp(out, "type", "plugins");
    juce::Array<juce::var> plugins;
    for (const auto& r : scanner_.records())
    {
        juce::var p = makeObject();
        setProp(p, "pluginId", r.pluginId);
        setProp(p, "name", r.name);
        setProp(p, "manufacturer", r.manufacturer);
        setProp(p, "category", r.category);
        setProp(p, "path", r.path);
        setProp(p, "isInstrument", r.isInstrument);
        setProp(p, "numInputChannels", r.numInputChannels);
        setProp(p, "numOutputChannels", r.numOutputChannels);
        setProp(p, "role", r.role);
        plugins.add(p);
    }
    setProp(out, "plugins", plugins);
    setProp(out, "count", static_cast<int>(plugins.size()));
    ipc_.send(out);
}

void Engine::cmdScanVst3(const juce::var& msg)
{
    // Scanning spawns one child process per .vst3 file and takes tens of
    // seconds. Running it inline blocked the message thread, which is also the
    // thread that opens plugin editors and services every other command - a
    // click on "Open Plugin" during a scan simply sat in the queue. Do the work
    // on a worker thread and install the result back on the message thread.
    if (scanning_)
    {
        sendError("scan-busy", "A VST3 scan is already running");
        return;
    }
    scanning_ = true;

    {
        juce::var out = makeObject();
        setProp(out, "type", "status");
        setProp(out, "engine", engineRunning_ ? "running" : "stopped");
        setProp(out, "scanning", true);
        ipc_.send(out);
    }

    auto alive = alive_;
    launchWorker([this, alive]()
    {
        try
        {
            auto records = Vst3Scanner::scanAll(&cancelWorkers_);
            postWorkerResult([this, alive, records = std::move(records)]() mutable
            {
                if (!*alive || shutdownRequested_)
                    return;
                scanner_.setRecords(std::move(records));
                scanning_ = false;
                sendPlugins();
                sendStatus();
            });
        }
        catch (...)
        {
            postWorkerResult([this, alive]()
            {
                if (!*alive || shutdownRequested_)
                    return;
                scanning_ = false;
                sendError("scan-failed", "VST3 scan worker failed");
                sendStatus();
            });
        }
    });
}

void Engine::cmdListPlugins(const juce::var& msg)
{
    sendPlugins();
}

Chain* Engine::getOrCreateChain(const juce::String& chainId)
{
    auto it = chains_.find(chainId);
    if (it != chains_.end())
        return it->second.get();

    const int count = audioChainCount_.load(std::memory_order_relaxed);
    if (count >= kMaxChains)
    {
        sendError("chain-limit", "Too many VST chains (max " + juce::String(kMaxChains) + ")");
        return nullptr;
    }

    auto chain = std::make_unique<Chain>(chainId);
    chain->setPlayHead(&pluginPlayHead_);
    chain->prepareToPlay(currentSampleRate_, currentBlockSize_);
    Chain* raw = chain.get();
    chains_[chainId] = std::move(chain);

    // Publish to the audio thread last: the release store makes the fully
    // constructed chain visible before the callback can see the new count.
    audioChains_[static_cast<size_t>(count)] = raw;
    audioChainCount_.store(count + 1, std::memory_order_release);
    return raw;
}

Chain* Engine::getChain(const juce::String& chainId)
{
    auto it = chains_.find(chainId);
    return it == chains_.end() ? nullptr : it->second.get();
}

Chain* Engine::requireChain(const juce::String& chainId)
{
    Chain* chain = getChain(chainId);
    if (chain == nullptr)
        sendError("chain-not-found", "Unknown chain: " + chainId);
    return chain;
}

PluginInstance* Engine::lookupInstance(const juce::String& chainId,
                                       const juce::String& instanceId,
                                       juce::String& code,
                                       juce::String& message)
{
    Chain* chain = getChain(chainId);
    if (chain == nullptr)
    {
        code = "chain-not-found";
        message = "Unknown chain: " + chainId;
        return nullptr;
    }
    PluginInstance* inst = chain->find(instanceId);
    if (inst == nullptr)
    {
        code = "instance-not-found";
        message = "Unknown instance: " + instanceId;
        return nullptr;
    }
    return inst;
}

PluginInstance* Engine::requireInstance(const juce::String& chainId,
                                        const juce::String& instanceId)
{
    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr)
        sendError(code, message);
    return inst;
}

juce::String Engine::instanceKey(const juce::String& chainId,
                                 const juce::String& instanceId) const
{
    return chainId + juce::String::charToString(0x1f) + instanceId;
}

bool Engine::isCurrentInstanceGeneration(const juce::String& chainId,
                                         const juce::String& instanceId,
                                         juce::int64 generation) const
{
    const auto it = instanceGenerations_.find(instanceKey(chainId, instanceId));
    return it != instanceGenerations_.end() && it->second == generation;
}

void Engine::finishPendingPluginLoad(const juce::String& chainId,
                                     const juce::String& instanceId,
                                     juce::int64 generation)
{
    const auto key = instanceKey(chainId, instanceId);
    const auto it = pendingPluginLoads_.find(key);
    if (it != pendingPluginLoads_.end() && it->second == generation)
        pendingPluginLoads_.erase(it);
}

void Engine::cmdCreateInstance(const juce::var& msg)
{
    const juce::String requestId = msg["requestId"].toString();
    const juce::String chainId = msg["chainId"].toString();
    const juce::String pluginId = msg["pluginId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const int index = msg["index"].isInt() ? static_cast<int>(msg["index"]) : -1;

    if (chainId.isEmpty() || pluginId.isEmpty() || instanceId.isEmpty())
    {
        sendError("create-invalid", "chainId, pluginId and instanceId are required");
        return;
    }

    // `pluginId` is the plugin's absolute .vst3 path, so an instance can be
    // created without a completed registry scan. Requiring the registry made
    // every persisted chain unusable for the ~20s a full scan takes: the UI
    // showed the plugins, the engine had never heard of them, and opening an
    // editor answered "Unknown instance".
    const PluginRecord* rec = scanner_.find(pluginId);
    const bool resolved = rec != nullptr;
    const PluginRecord recCopy = resolved ? *rec : PluginRecord{};

    Chain* chain = getOrCreateChain(chainId);
    if (chain == nullptr)
        return;

    const juce::int64 generation = ++nextInstanceGeneration_;
    if (activeParameterLearn_ && activeParameterLearn_->chainId == chainId
        && activeParameterLearn_->instanceId == instanceId)
        cancelActiveParameterLearn("target-replaced");
    instanceGenerations_[instanceKey(chainId, instanceId)] = generation;
    pendingPluginLoads_[instanceKey(chainId, instanceId)] = generation;

    // Creating an instance id that already exists replaces it. The renderer
    // rebuilds its chains after an engine restart or a renderer reload, and a
    // rebuild must never end up with two live plugins sharing one instanceId.
    if (chain->find(instanceId) != nullptr)
        chain->removePlugin(instanceId);

    // Report "loading" immediately, then "ready"/"error" after creation.
    {
        juce::var out = makeObject();
        setProp(out, "type", "instanceStatus");
        setProp(out, "requestId", requestId);
        setProp(out, "chainId", chainId);
        setProp(out, "instanceId", instanceId);
        setProp(out, "pluginId", pluginId);
        setProp(out, "generation", generation);
        setProp(out, "status", "loading");
        ipc_.send(out);
    }

    const double sr = currentSampleRate_;
    const int bs = currentBlockSize_;

    auto* inst = new PluginInstance();
    inst->setRuntimeIdentity(chainId, instanceId, generation);
    inst->setParameterTouchedCallback(
        [this](PluginInstance& source, const PluginInstance::TouchedParameter& touched)
        {
            sendParameterTouched(source, touched);
        });
    inst->setParameterLearnEndedCallback(
        [this](PluginInstance& source, const juce::String& learnId, const juce::String& reason)
        {
            parameterLearnEnded(source, learnId, reason);
        });
    inst->setEditorClosedCallback(
        [this](PluginInstance& source)
        {
            sendEditorStatus(source, false);
        });
    auto alive = alive_;

    launchWorker([this, alive, requestId, chainId, instanceId, pluginId, generation,
                  recCopy, resolved, inst, index, sr, bs]()
    {
        try
        {
            PluginRecord record = recCopy;

            // Not in the registry: resolve this one file directly. Done here,
            // on the worker thread, so the message thread keeps serving.
            if (!resolved)
            {
                std::cerr << "[plugin-load] generation=" << generation
                          << " phase=resolve-isolated" << std::endl;
                // Resolving a persisted plug-in before the full registry scan
                // completes must retain the same crash boundary as scanAll().
                // Loading third-party metadata in the engine process turns a
                // bad scanner plug-in into an engine-wide access violation.
                const auto found = Vst3Scanner::scanFileIsolated(pluginId, &cancelWorkers_);
                if (found.empty())
                {
                    postWorkerResult([this, alive, requestId, chainId, instanceId,
                                      pluginId, generation, inst]()
                    {
                        if (*alive)
                            finishPendingPluginLoad(chainId, instanceId, generation);
                        if (*alive && isCurrentInstanceGeneration(chainId, instanceId, generation))
                        {
                            // Report a definite failure for this instance, not
                            // a loose error that leaves the card "loading".
                            juce::var out = makeObject();
                            setProp(out, "type", "instanceStatus");
                            setProp(out, "requestId", requestId);
                            setProp(out, "chainId", chainId);
                            setProp(out, "instanceId", instanceId);
                            setProp(out, "pluginId", pluginId);
                            setProp(out, "generation", generation);
                            setProp(out, "status", "error");
                            setProp(out, "error", "Plugin file not found: " + pluginId);
                            ipc_.send(out);
                            sendError("plugin-not-found", "Unknown plugin: " + pluginId);
                            instanceGenerations_.erase(instanceKey(chainId, instanceId));
                        }
                        delete inst;
                    });
                    return;
                }
                record = found.front();
            }

            postWorkerResult([this, alive, requestId, chainId, instanceId, pluginId,
                              generation, inst, record, index, sr, bs]() mutable
            {
                // The engine may have been torn down while the plugin loaded.
                if (!*alive)
                {
                    delete inst;
                    return;
                }

                finishPendingPluginLoad(chainId, instanceId, generation);

                if (!isCurrentInstanceGeneration(chainId, instanceId, generation))
                {
                    delete inst;
                    return;
                }

                Chain* c = getChain(chainId);
                if (c == nullptr)
                {
                    delete inst;
                    return;
                }

                // IEditController and IPlugView belong to the native control/UI
                // thread.  Creating the provider on this same thread prevents
                // JUCE-based VST3s (Dexed/Vital included) from binding their
                // private message manager to the metadata worker and then
                // deadlocking later in IPlugView::attached().  File discovery
                // remains isolated/off-thread; no work moves into the callback.
                juce::String error;
                std::cerr << "[plugin-load] generation=" << generation
                          << " phase=instantiate-control-thread" << std::endl;
                const bool ok = inst->create(record, sr, bs, error);
                std::cerr << "[plugin-load] generation=" << generation
                          << " phase=instance-created ok=" << (ok ? 1 : 0) << std::endl;

                if (!ok)
                {
                    sendError("plugin-load", "Failed to load '" + inst->name() + "': " + error);
                    juce::var out = makeObject();
                    setProp(out, "type", "instanceStatus");
                    setProp(out, "requestId", requestId);
                    setProp(out, "chainId", chainId);
                    setProp(out, "instanceId", instanceId);
                    setProp(out, "pluginId", pluginId);
                    setProp(out, "generation", generation);
                    setProp(out, "status", "error");
                    setProp(out, "error", error);
                    ipc_.send(out);
                    instanceGenerations_.erase(instanceKey(chainId, instanceId));
                    delete inst;
                    return;
                }

                std::cerr << "[plugin-load] generation=" << generation
                          << " phase=prepare" << std::endl;
                // Async-created plugins missed Chain::setPlayHead because the
                // chain was empty when it was first attached. Install the live
                // host transport before prepareToPlay and again on insertion.
                inst->setPlayHead(&pluginPlayHead_);
                inst->prepareToPlay(currentSampleRate_, currentBlockSize_);
                if (c->find(instanceId) != nullptr)
                    c->removePlugin(instanceId);
                const juce::String name = inst->name();
                if (!c->insertPlugin(index, std::unique_ptr<PluginInstance>(inst)))
                {
                    // The failed insert destroys `inst`; never touch it again.
                    sendError("chain-full", "Chain '" + chainId + "' is full, dropped '" + name + "'");
                    return;
                }
                sendChainChanged(chainId);
                juce::var out = makeObject();
                setProp(out, "type", "instanceStatus");
                setProp(out, "requestId", requestId);
                setProp(out, "chainId", chainId);
                setProp(out, "instanceId", instanceId);
                setProp(out, "pluginId", pluginId);
                setProp(out, "generation", generation);
                setProp(out, "status", "ready");
                setProp(out, "error", juce::var());
                ipc_.send(out);
                std::cerr << "[plugin-load] generation=" << generation
                          << " phase=ready" << std::endl;
            });
        }
        catch (...)
        {
            postWorkerResult([this, alive, requestId, chainId, instanceId,
                              pluginId, generation, inst]()
            {
                if (*alive)
                    finishPendingPluginLoad(chainId, instanceId, generation);
                if (*alive && isCurrentInstanceGeneration(chainId, instanceId, generation))
                {
                    juce::var out = makeObject();
                    setProp(out, "type", "instanceStatus");
                    setProp(out, "requestId", requestId);
                    setProp(out, "chainId", chainId);
                    setProp(out, "instanceId", instanceId);
                    setProp(out, "pluginId", pluginId);
                    setProp(out, "generation", generation);
                    setProp(out, "status", "error");
                    setProp(out, "error", "Plugin load worker failed");
                    ipc_.send(out);
                    instanceGenerations_.erase(instanceKey(chainId, instanceId));
                }
                delete inst;
            });
        }
    });
}

void Engine::cmdRemoveInstance(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    if (activeParameterLearn_ && activeParameterLearn_->chainId == chainId
        && activeParameterLearn_->instanceId == instanceId)
        cancelActiveParameterLearn("target-removed");
    // Invalidate even when the instance is still loading and therefore not in
    // the live chain yet. Its completion callback must never resurrect it.
    instanceGenerations_.erase(instanceKey(chainId, instanceId));
    pendingPluginLoads_.erase(instanceKey(chainId, instanceId));

    Chain* chain = getChain(chainId);
    if (chain == nullptr)
        return;

    // The destructor closes the editor and releases the plugin; removePlugin
    // holds the chain lock across it so the audio thread is never inside the
    // plugin while it goes away.
    if (!chain->removePlugin(instanceId))
        return;
    sendChainChanged(chainId);
}

void Engine::cmdReorderChain(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const int toIndex = msg["toIndex"].isInt() ? static_cast<int>(msg["toIndex"]) : 0;
    Chain* chain = requireChain(chainId);
    if (chain == nullptr)
        return;
    if (!chain->reorderPlugin(instanceId, toIndex))
    {
        sendError("instance-not-found", "Unknown instance: " + instanceId);
        return;
    }
    sendChainChanged(chainId);
}

void Engine::cmdSetBypass(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const bool bypassed = msg["bypassed"].isBool() ? static_cast<bool>(msg["bypassed"]) : false;
    Chain* chain = requireChain(chainId);
    if (chain == nullptr)
        return;
    if (!chain->setPluginBypass(instanceId, bypassed))
    {
        sendError("instance-not-found", "Unknown instance: " + instanceId);
        return;
    }
    sendChainChanged(chainId);
}

void Engine::cmdMidi(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    Chain* chain = requireChain(chainId);
    if (chain == nullptr)
        return;
    // Only forward MIDI to chains that are MIDI-connected in the Hub network.
    if (!chain->midiEnabled())
        return;

    const juce::var dataVar = msg["data"];
    const auto* arr = dataVar.getArray();
    if (arr == nullptr || arr->size() == 0)
        return;

    uint8_t bytes[3] = {};
    int n = 0;
    for (const auto& b : *arr)
    {
        if (n >= 3)
            break;
        bytes[n++] = static_cast<uint8_t>(static_cast<int>(b));
    }
    if (n == 0)
        return;

    juce::MidiBuffer buffer;
    buffer.addEvent(juce::MidiMessage(bytes, n, 0.0), 0);
    chain->pushMidi(buffer);
}

void Engine::cmdMidiNode(const juce::var& msg)
{
    const auto* arr=msg["data"].getArray(); if(!arr||arr->isEmpty())return;
    uint8_t bytes[3]{};int n=0;for(const auto&b:*arr){if(n==3)break;bytes[n++]=(uint8_t)(int)b;}
    auto* plan=activeMidiPlan_.load(std::memory_order_acquire);
    if(plan&&!plan->pushInput(msg["nodeId"].toString().toStdString(),juce::MidiMessage(bytes,n,0.0)))
        sendError("midi-node-not-found","Unknown MIDI processor node");
}

void Engine::cmdSetChainMidiEnabled(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const bool enabled = msg["enabled"].isBool() ? static_cast<bool>(msg["enabled"]) : false;
    Chain* chain = getOrCreateChain(chainId);
    if (chain == nullptr)
        return;
    chain->setMidiEnabled(enabled);
}

void Engine::cmdSetChainOutputEnabled(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const bool enabled = msg["enabled"].isBool() ? static_cast<bool>(msg["enabled"]) : false;
    Chain* chain = getOrCreateChain(chainId);
    if (chain == nullptr)
        return;
    chain->setOutputEnabled(enabled);
}

void Engine::cmdSetTransport(const juce::var& msg)
{
    const bool wasPlaying=transport_.playing();
    if (msg.hasProperty("bpm")) transport_.setBpm(static_cast<double>(msg["bpm"]));
    if(msg["loop"].isObject()){const auto loop=msg["loop"];transport_.setLoop(loop["enabled"].isBool()?(bool)loop["enabled"]:false,(double)loop["startPpq"],(double)loop["endPpq"]);}
    const bool seeking=msg.hasProperty("seekPpq")&&(msg["seekPpq"].isInt()||msg["seekPpq"].isInt64()||msg["seekPpq"].isDouble());
    if(seeking||(msg["playing"].isBool()&&!static_cast<bool>(msg["playing"]))) {
        preCountGeneration_.fetch_add(1,std::memory_order_acq_rel);
        preCountActive_.store(false,std::memory_order_release);
        preCountComplete_.store(false,std::memory_order_release);
    }
    if(seeking){if(sequencer_.recording())for(const auto& event:sequencer_.finishRecording(transport_))ipc_.send(event);transport_.seekPpq(std::max(0.0,(double)msg["seekPpq"]));panicAllMidi();}
    if (msg["playing"].isBool()) {const bool playing=static_cast<bool>(msg["playing"]);if(!playing&&wasPlaying&&sequencer_.recording())for(const auto& event:sequencer_.finishRecording(transport_))ipc_.send(event);transport_.setPlaying(playing);if(!playing)panicAllMidi();}
    cmdGetTransport(msg);
}

void Engine::cmdGetTransport(const juce::var&)
{
    juce::var out = makeObject();
    setProp(out, "type", "transport"); setProp(out, "bpm", transport_.bpm());
    setProp(out, "playing", transport_.playing());
    setProp(out, "recording", transport_.recording());
    setProp(out, "preCount", preCountActive_.load(std::memory_order_acquire));
    const auto preCountQps=preCountQuarterNotesPerSample_.load(std::memory_order_acquire);
    const auto preCountSample=preCountSamplePosition_.load(std::memory_order_acquire);
    setProp(out, "preCountBeat", preCountQps>0.0
        ? juce::jlimit(0,kPreCountBeats-1,(int)std::floor(preCountSample*preCountQps)) : 0);
    setProp(out, "preCountBeats", kPreCountBeats);
    setProp(out, "loopEnabled", transport_.loopEnabled());
    setProp(out, "loopStartPpq", transport_.loopStart());
    setProp(out, "loopEndPpq", transport_.loopEnd());
    setProp(out, "timeInSamples", transport_.samplePosition());
    setProp(out, "ppqPosition", transport_.ppqPosition());
    setProp(out, "numerator", 4); setProp(out, "denominator", 4); ipc_.send(out);
}

void Engine::cmdForegroundEditors(const juce::var&)
{
    for (auto& entry : chains_)
        for (auto* plugin : entry.second->copyPlugins())
            plugin->foregroundEditorIfAllowed();
}

void Engine::cmdSyncAudioNetwork(const juce::var& msg)
{
    AudioNetworkSpec spec;
    const auto reject=[this](const juce::String& message){clearAudioNetwork();sendError("audio-network-invalid",message);};
    const auto* nodes = msg["nodes"].getArray();
    if (nodes == nullptr) { reject("nodes must be an array"); return; }
    if (nodes->size() > 64) { reject("too many audio nodes"); return; }
    for (const auto& value : *nodes)
    {
        AudioNetworkNodeSpec node; node.id = value["id"].toString().toStdString();
        const auto type = value["nodeType"].toString();
        if (type == "audio-input") node.kind = AudioNodeKind::input;
        else if (type == "vst") node.kind = AudioNodeKind::vst;
        else if (type == "mixer") node.kind = AudioNodeKind::mixer;
        else if (type == "morpher") node.kind = AudioNodeKind::morpher;
        else if (type == "sequencer") node.kind = AudioNodeKind::sequencer;
        else if (type == "audio-output") node.kind = AudioNodeKind::output;
        else { reject("unknown audio node type: " + type); return; }
        node.masterLevel = value.hasProperty("masterLevel") ? (float)(double)value["masterLevel"] : 1.0f;
        node.stepCount = value.hasProperty("stepCount") ? (int)value["stepCount"] : 4;
        if (const auto* steps = value["steps"].getArray())
            for (int i=0;i<std::min(32,steps->size());++i) node.steps[(size_t)i]=juce::jlimit(0.0f,1.0f,(float)(double)(*steps)[i]);
        if (const auto* inputs = value["inputs"].getArray())
        {
            if (inputs->size() > 64) { reject("too many audio inputs"); return; }
            for (const auto& item : *inputs) { AudioNetworkInput input; input.portId=item["portId"].toString().toStdString(); input.sourceNodeId=item["sourceNodeId"].toString().toStdString(); input.sourcePortId=item["sourcePortId"].toString().toStdString(); input.level=item.hasProperty("level")?(float)(double)item["level"]:1.0f; input.muted=item["muted"].isBool()?(bool)item["muted"]:false; node.inputs.push_back(std::move(input)); }
        }
        spec.nodes.push_back(std::move(node));
    }
    std::string error;
    auto plan = AudioExecutionPlan::compile(spec, [this](const std::string& id) { return getOrCreateChain(juce::String(id)); }, &sequencer_, currentBlockSize_, error);
    if (!plan) { reject(juce::String(error)); return; }
    activeAudioSpec_ = spec;
    publishAudioPlan(std::move(plan));
    applyAudioInputRequirement(std::any_of(spec.nodes.begin(), spec.nodes.end(),
        [](const AudioNetworkNodeSpec& node) { return node.kind == AudioNodeKind::input; }));
    juce::var out=makeObject();setProp(out,"type","audioNetworkSynced");setProp(out,"nodeCount",(int)spec.nodes.size());ipc_.send(out);
}

void Engine::cmdSetAudioNodeValues(const juce::var& msg)
{
    // Values-only update of the LIVE plan. This exists so a fader drag stops
    // recompiling the network: a recompile rebuilds every SourceDelay, which
    // zeroed the PDC delay lines mid-stream on each gesture.
    const auto* nodes = msg["nodes"].getArray();
    if (nodes == nullptr)
    {
        sendError("audio-values-invalid", "nodes must be an array");
        return;
    }
    auto* plan = activeAudioPlan_.load(std::memory_order_acquire);
    if (plan == nullptr)
    {
        sendError("audio-values-stale", "no audio network is published");
        return;
    }

    // A values-only update must never invent topology. Anything that does not
    // line up with the published plan means the sender's view is stale, so it
    // is refused whole rather than applied in part; the renderer answers a
    // stale error with a full syncAudioNetwork.
    for (const auto& value : *nodes)
    {
        const auto id = value["id"].toString().toStdString();
        auto* node = plan->findNode(id);
        const auto spec = std::find_if(activeAudioSpec_.nodes.begin(),
                                       activeAudioSpec_.nodes.end(),
                                       [&id](const AudioNetworkNodeSpec& candidate)
                                       { return candidate.id == id; });
        if (node == nullptr || spec == activeAudioSpec_.nodes.end())
        {
            sendError("audio-values-stale", "unknown audio node: " + juce::String(id));
            return;
        }

        if (value.hasProperty("masterLevel"))
        {
            const auto master = static_cast<float>(static_cast<double>(value["masterLevel"]));
            node->setMasterLevel(master);
            // The spec is what republishActiveAudioNetwork() recompiles from, so
            // it has to carry the new value or a later rebuild would revert it.
            spec->masterLevel = std::clamp(master, 0.0f, 2.0f);
        }

        if (const auto* steps = value["steps"].getArray())
            for (int i = 0; i < std::min(static_cast<int>(NodeValues::kMaxSteps),
                                         steps->size()); ++i)
            {
                const auto step = juce::jlimit(0.0f, 1.0f,
                    static_cast<float>(static_cast<double>((*steps)[i])));
                node->setStep(static_cast<size_t>(i), step);
                spec->steps[static_cast<size_t>(i)] = step;
            }

        if (const auto* inputs = value["inputs"].getArray())
            for (const auto& item : *inputs)
            {
                // Matched by port id, not by position: correct even if the
                // sender ever reorders the array it sends.
                const auto portId = item["portId"].toString().toStdString();
                size_t inputIndex = spec->inputs.size();
                for (size_t i = 0; i < spec->inputs.size(); ++i)
                    if (spec->inputs[i].portId == portId) { inputIndex = i; break; }
                if (inputIndex >= spec->inputs.size() || inputIndex >= node->sources.size())
                {
                    sendError("audio-values-stale",
                              "unknown audio input port: " + juce::String(portId));
                    return;
                }
                const auto level = item.hasProperty("level")
                    ? static_cast<float>(static_cast<double>(item["level"])) : 1.0f;
                const bool muted = item["muted"].isBool() ? static_cast<bool>(item["muted"]) : false;
                node->setLevel(inputIndex, level);
                node->setMuted(inputIndex, muted);
                spec->inputs[inputIndex].level = std::clamp(level, 0.0f, 2.0f);
                spec->inputs[inputIndex].muted = muted;
            }
    }

    juce::var out = makeObject();
    setProp(out, "type", "audioNodeValuesApplied");
    setProp(out, "nodeCount", static_cast<int>(nodes->size()));
    ipc_.send(out);
}

void Engine::cmdSyncMidiNetwork(const juce::var& msg)
{
    const auto reject=[this](const juce::String& message){clearMidiNetwork();sendError("midi-network-invalid",message);};
    MidiNetworkSpec spec;const auto* nodes=msg["nodes"].getArray();if(!nodes){reject("nodes must be an array");return;}if(nodes->size()>64){reject("too many MIDI nodes");return;}
    const juce::StringArray scaleNames{"Chromatic","Major / Ionian","Natural Minor / Aeolian","Harmonic Minor","Dorian","Phrygian","Lydian","Mixolydian","Locrian","Major Pentatonic","Minor Pentatonic"};
    const juce::StringArray modeNames{"Up","Down","Up / Down","As Played","Random","Custom"};const juce::StringArray rateNames{"1/4","1/8","1/16","1/32"};
    for(const auto&v:*nodes){
    const auto nodeType=v["nodeType"].toString();
    // A hardware MIDI destination is carried through as a node of its own kind.
    // The plan needs it only to recognise the ids that mean "send this to the
    // hardware output"; it has no arpeggiator and no destinations of its own.
    if(nodeType=="midi-output"){MidiNetworkNodeSpec out;out.id=v["id"].toString().toStdString();if(out.id.empty())continue;out.kind="midi-output";spec.nodes.push_back(std::move(out));continue;}
    if(nodeType!="arpeggiator")continue;MidiNetworkNodeSpec n;n.id=v["id"].toString().toStdString();n.kind="arpeggiator";n.arp.root=juce::jlimit(0,11,(int)v["root"]);n.arp.scale=std::max(0,scaleNames.indexOf(v["scale"].toString()));n.arp.mode=std::max(0,modeNames.indexOf(v["mode"].toString()));n.arp.rate=std::max(0,rateNames.indexOf(v["rate"].toString()));n.arp.patternLength=(int)v["patternLength"];if(n.arp.patternLength!=4&&n.arp.patternLength!=8&&n.arp.patternLength!=16&&n.arp.patternLength!=32){reject("invalid pattern length");return;}n.arp.randomSeed=(uint32_t)(juce::int64)v["randomSeed"];if(const auto*a=v["customPattern"].getArray())for(int i=0;i<std::min(32,a->size());++i){const auto&s=(*a)[i];auto&d=n.arp.steps[(size_t)i];d.semitoneOffset=juce::jlimit(-127,127,(int)s["semitoneOffset"]);d.velocity=juce::jlimit(1,127,(int)s["velocity"]);d.gate=juce::jlimit(.05f,1.f,(float)(double)s["gate"]);d.rest=s["rest"].isBool()?(bool)s["rest"]:false;d.tie=s["tie"].isBool()?(bool)s["tie"]:false;}if(const auto*a=v["destinations"].getArray())for(const auto&d:*a)n.destinations.push_back(d.toString().toStdString());spec.nodes.push_back(std::move(n));}
    std::string error;auto plan=MidiExecutionPlan::compile(spec,[this](const std::string&id){return getOrCreateChain(juce::String(id));},error);if(!plan){reject(juce::String(error));return;}panicAllMidi();activeMidiSpec_=spec;auto*published=plan.get();midiPlans_.push_back(std::move(plan));activeMidiPlan_.store(published,std::memory_order_release);juce::var out=makeObject();setProp(out,"type","midiNetworkSynced");setProp(out,"nodeCount",(int)spec.nodes.size());ipc_.send(out);
}

void Engine::cmdCapturePluginStates(const juce::var&)
{
    capturePluginStates(true);
    juce::var out=makeObject();setProp(out,"type","pluginStateCaptureComplete");ipc_.send(out);
}

void Engine::cmdSetMetronome(const juce::var& msg)
{
    if(msg["enabled"].isBool())metronomeEnabled_.store((bool)msg["enabled"]);
    if(msg.hasProperty("volume"))metronomeVolume_.store(juce::jlimit(0.0f,1.0f,(float)(double)msg["volume"]));
}

void Engine::cmdSetMasterOutput(const juce::var& msg)
{
    if (msg.hasProperty("gainDb"))
    {
        if (!isNumber(msg["gainDb"]) || !std::isfinite((double)msg["gainDb"]))
        {
            sendError("master-output-invalid", "Master gain must be finite");
            return;
        }
        masterOutput_.setGainDb(static_cast<float>((double)msg["gainDb"]));
    }
}

void Engine::cmdResetMasterClip(const juce::var&)
{
    masterOutput_.resetClip();
}

void Engine::cmdSyncSequencer(const juce::var& msg)
{
    juce::Array<juce::var> info;std::string error;if(!sequencer_.sync(msg["project"],[this](const std::string&id){return id.empty()?nullptr:getOrCreateChain(juce::String(id));},currentSampleRate_,currentBlockSize_,info,error)){panicAllMidi();sendError("sequencer-invalid",juce::String(error));return;}panicAllMidi();for(const auto& event:info)ipc_.send(event);juce::var out=makeObject();setProp(out,"type","sequencerSynced");setProp(out,"trackCount",msg["project"]["tracks"].getArray()?msg["project"]["tracks"].getArray()->size():0);ipc_.send(out);
}

void Engine::cmdSetSequencerTrackControl(const juce::var& msg)
{
    const auto trackId=msg["trackId"].toString();
    const bool numeric=msg["gain"].isInt()||msg["gain"].isInt64()||msg["gain"].isDouble();
    if(trackId.isEmpty()||trackId.length()>160||!numeric||!msg["muted"].isBool()){
        sendError("sequencer-track-control-invalid","Malformed Sequencer track control");return;
    }
    const double rawGain=(double)msg["gain"];
    if(!std::isfinite(rawGain)||!sequencer_.setTrackControl(trackId.toStdString(),(float)rawGain,(bool)msg["muted"])){
        sendError("sequencer-track-not-found","Sequencer track is unavailable: "+trackId);return;
    }
    juce::var out=makeObject();setProp(out,"type","sequencerTrackControl");setProp(out,"trackId",trackId);setProp(out,"gain",juce::jlimit(0.0,2.0,rawGain));setProp(out,"muted",(bool)msg["muted"]);ipc_.send(out);
}

void Engine::cmdSequencerMidiInput(const juce::var& msg)
{
    const auto* data=msg["data"].getArray();if(!data||data->isEmpty())return;uint8_t bytes[3]{};int size=0;for(const auto& byte:*data){if(size==3)break;bytes[size++]=(uint8_t)juce::jlimit(0,255,(int)byte);}if(size<1)return;const double offset=(msg["offsetMs"].isInt()||msg["offsetMs"].isInt64()||msg["offsetMs"].isDouble())?juce::jlimit(-500.0,500.0,(double)msg["offsetMs"]):0;sequencer_.recordMidiInput(msg["sourceId"].toString().toStdString(),juce::MidiMessage(bytes,size,0.0),offset,transport_);
}

void Engine::cmdSequencerRecord(const juce::var& msg)
{
    const bool enabled=msg["enabled"].isBool()?(bool)msg["enabled"]:false;
    if(enabled){
        if(!sequencer_.recording()&&!preCountActive_.load(std::memory_order_acquire)
            &&metronomeEnabled_.load(std::memory_order_acquire)&&!transport_.playing()){
            preCountSamplePosition_.store(0,std::memory_order_relaxed);
            lastPreCountBeat_.store(-1,std::memory_order_relaxed);
            preCountGeneration_.fetch_add(1,std::memory_order_acq_rel);
            preCountQuarterNotesPerSample_.store(
                transport_.bpm()/(60.0*std::max(1.0,currentSampleRate_)),
                std::memory_order_relaxed);
            preCountComplete_.store(false,std::memory_order_relaxed);
            preCountActive_.store(true,std::memory_order_release);
        }else if(!preCountActive_.load(std::memory_order_acquire)){
            sequencer_.beginRecording(transport_);
        }
    }else{
        preCountGeneration_.fetch_add(1,std::memory_order_acq_rel);
        const bool cancelledPreCount=preCountActive_.exchange(false,std::memory_order_acq_rel);
        preCountComplete_.store(false,std::memory_order_release);
        if(!cancelledPreCount)
            for(const auto& event:sequencer_.finishRecording(transport_))ipc_.send(event);
        transport_.setPlaying(false);panicAllMidi();
    }
    cmdGetTransport(msg);
}

void Engine::cmdSequencerExport(const juce::var& msg)
{
    if(!msg["filePath"].isString()||msg["filePath"].toString().isEmpty()||!isNumber(msg["startPpq"])||!isNumber(msg["endPpq"])||!isNumber(msg["tailSeconds"])){
        const juce::String message("Malformed export request");
        sendError("sequencer-export",message);
        auto failed=makeExportStage("error","preparation",juce::File(),"wav","error");
        setProp(failed,"message",message);ipc_.send(failed);return;
    }
    juce::String error;
    if(exportTransactionActive())error="An export is already active";
    else if(preCountActive_.load(std::memory_order_acquire))error="Stop the recording pre-count before export";
    else if(sequencer_.recording())error="Stop recording before starting an export";
    else if(!pendingPluginLoads_.empty())error="Wait for VST plugins to finish loading before export";
    SequencerEngine::ExportOptions options;options.format=msg["format"].isString()?msg["format"].toString().trim().toLowerCase():juce::String("wav");if(isNumber(msg["bits"]))options.wavBits=(int)msg["bits"];if(isNumber(msg["bitrateKbps"]))options.mp3BitrateKbps=(int)msg["bitrateKbps"];if(isNumber(msg["qualityIndex"]))options.oggQualityIndex=(int)msg["qualityIndex"];
    const double start=(double)msg["startPpq"],end=(double)msg["endPpq"],tail=(double)msg["tailSeconds"];
    const juce::File file(msg["filePath"].toString());
    if(!std::isfinite(start)||!std::isfinite(end)||!std::isfinite(tail)||start<0||end<=start||tail<0||tail>30)error="Export range is invalid";
    if(error.isNotEmpty()){sendError("sequencer-export",error);auto failed=makeExportStage("error","preparation",file,options.format,"error");setProp(failed,"message",error);ipc_.send(failed);return;}

    ipc_.send(makeExportStage("preparing", "START", file, options.format, "begin"));
    exportTransactionStartedAtMs_=juce::Time::getMillisecondCounterHiRes();
    ipc_.send(makeExportStage("preparing", "preparation", file, options.format, "end"));
    ipc_.send(makeExportStage("preparing", "snapshot-project", file, options.format, "begin"));

    // Freeze reconstructable processor state on the message thread, then load
    // a second set of VST instances on a worker. The live chains never see the
    // offline clock or arrangement MIDI and remain dedicated to the device.
    std::vector<ExportPluginSnapshot> snapshots;std::vector<juce::String> chainIds;juce::Array<juce::var> vstTrace;
    for(auto& chain:chains_){chainIds.push_back(chain.first);const auto plugins=chain.second->copyPlugins();for(int index=0;index<(int)plugins.size();++index){auto* plugin=plugins[(size_t)index];ExportPluginSnapshot snapshot;snapshot.chainId=chain.first;snapshot.instanceId=plugin->instanceId();snapshot.pluginId=plugin->pluginId();snapshot.index=index;snapshot.generation=plugin->generation();snapshot.bypassed=plugin->bypassed();snapshot.state=plugin->getState();if(const auto* record=scanner_.find(snapshot.pluginId)){snapshot.record=*record;snapshot.recordResolved=true;}snapshots.push_back(snapshot);juce::var item=makeObject();setProp(item,"chainId",snapshot.chainId);setProp(item,"instanceId",snapshot.instanceId);setProp(item,"pluginId",snapshot.pluginId);setProp(item,"generation",snapshot.generation);setProp(item,"role",plugin->role());setProp(item,"bypassed",snapshot.bypassed);const auto stateJson=juce::JSON::toString(snapshot.state,true);setProp(item,"stateBytes",static_cast<juce::int64>(stateJson.getNumBytesAsUTF8()));setProp(item,"stateHash",juce::String::toHexString(stateJson.hashCode64()));setProp(item,"renderInstance","clone");vstTrace.add(item);}}

    ipc_.send(makeExportStage("preparing", "snapshot-project", file, options.format, "end"));
    ipc_.send(makeExportStage("preparing", "render-context", file, options.format, "begin"));
    ipc_.send(makeExportStage("preparing", "prepare-vst", file, options.format, "begin"));
    const auto audioSpec=activeAudioSpec_;const auto midiSpec=activeMidiSpec_;const double exportBpm=transport_.bpm();const float masterGainDb=masterOutput_.gainDb();const int blockSize=currentBlockSize_;const double sampleRate=currentSampleRate_;
    const uint64_t generation=exportGeneration_.fetch_add(1,std::memory_order_acq_rel)+1;auto cancel=std::make_shared<std::atomic<bool>>(false);exportCancel_=cancel;exportPreparing_.store(true,std::memory_order_release);preparingExportFile_=file;preparingExportFormat_=options.format;exportSampleRate_=sampleRate;
    auto alive=alive_;
    launchWorker([this,alive,generation,cancel,snapshots=std::move(snapshots),chainIds=std::move(chainIds),audioSpec,midiSpec,file,start,end,tail,options,exportBpm,masterGainDb,blockSize,sampleRate,vstTrace]() mutable {
        auto* context=new ExportContext();juce::String buildError;
        for(const auto& chainId:chainIds){auto chain=std::make_unique<Chain>(chainId);chain->setMidiEnabled(true);chain->setOutputEnabled(true);context->chains.emplace(chainId,std::move(chain));}
        for(auto snapshot:snapshots){if(cancel->load(std::memory_order_acquire))break;PluginRecord record=snapshot.record;if(!snapshot.recordResolved){const auto found=Vst3Scanner::scanFileIsolated(snapshot.pluginId,cancel.get());if(found.empty()){buildError="Could not resolve export plugin: "+snapshot.pluginId;break;}record=found.front();}auto instance=std::make_unique<PluginInstance>();juce::String pluginError;if(!instance->create(record,sampleRate,blockSize,pluginError)){buildError="Could not clone "+snapshot.pluginId+": "+pluginError;break;}instance->setRuntimeIdentity(snapshot.chainId,snapshot.instanceId,snapshot.generation);instance->setBypassed(snapshot.bypassed);if(snapshot.state.isString()&&!instance->setState(snapshot.state,pluginError)){buildError="Could not restore export state for "+snapshot.pluginId+": "+pluginError;break;}auto found=context->chains.find(snapshot.chainId);if(found==context->chains.end()||!found->second->insertPlugin(snapshot.index,std::move(instance))){buildError="Could not build export chain: "+snapshot.chainId;break;}}
        if(buildError.isEmpty()&&!cancel->load(std::memory_order_acquire)){for(auto& chain:context->chains){chain.second->setPlayHead(&sequencer_.exportTransport());chain.second->prepareToPlay(sampleRate,blockSize,true);}context->audio.setSize(2,blockSize,false,true,false);context->audio.clear();context->midiScratch.ensureSize(kMidiBufferBytes);context->master.setGainDb(masterGainDb);context->master.prepare(sampleRate);context->sampleRate=sampleRate;}
        postWorkerResult([this,alive,generation,cancel,context,buildError,audioSpec,midiSpec,file,start,end,tail,options,exportBpm,blockSize,sampleRate,vstTrace]() mutable {
            std::unique_ptr<ExportContext> owned(context);if(!*alive)return;if(generation!=exportGeneration_.load(std::memory_order_acquire)||cancel->load(std::memory_order_acquire))return;auto fail=[&](const juce::String& message){exportPreparing_.store(false,std::memory_order_release);exportCancel_.reset();exportTransactionStartedAtMs_=0.0;sendError("sequencer-export",message);auto failed=makeExportStage("error","render-context",file,options.format,"error");setProp(failed,"message",message);ipc_.send(failed);flushDeferredExportCommands();};if(buildError.isNotEmpty()){fail(buildError);return;}
            ipc_.send(makeExportStage("preparing", "prepare-vst", file, options.format, "end"));
            ipc_.send(makeExportStage("preparing", "build-network", file, options.format, "begin"));
            const auto lookup=[&](const std::string& id)->Chain*{auto found=owned->chains.find(juce::String(id));return found==owned->chains.end()?nullptr:found->second.get();};std::string compileError;owned->midiPlan=MidiExecutionPlan::compile(midiSpec,lookup,compileError);if(!owned->midiPlan){fail(juce::String(compileError));return;}owned->audioPlan=AudioExecutionPlan::compile(audioSpec,lookup,&sequencer_,blockSize,compileError);if(!owned->audioPlan){fail(juce::String(compileError));return;}if(!sequencer_.prepareExportPlan(lookup,compileError)){fail(juce::String(compileError));return;}ipc_.send(makeExportStage("preparing", "build-network", file, options.format, "end"));clearExportContext();exportContext_=std::move(owned);activeExportContext_.store(exportContext_.get(),std::memory_order_release);ipc_.send(makeExportStage("preparing", "render-context", file, options.format, "end"));ipc_.send(makeExportStage("preparing", "timeline", file, options.format, "begin"));Transport tempoSnapshot;tempoSnapshot.setSampleRate(sampleRate);tempoSnapshot.setBpm(exportBpm);juce::String startError;if(!sequencer_.startExport(file,start,end,tail,tempoSnapshot,options,startError)){clearExportContext();fail(startError);return;}ipc_.send(makeExportStage("preparing", "timeline", file, options.format, "end"));exportPreparing_.store(false,std::memory_order_release);exportCancel_.reset();lastPublishedExportFrames_=-1;exportProgressStartedAtMs_=juce::Time::getMillisecondCounterHiRes();exportLastAdvancedAtMs_=exportProgressStartedAtMs_;auto out=makeExportStage("started","render-blocks",file,options.format,"begin");setProp(out,"exportStartPpq",start);setProp(out,"exportEndPpq",end);setProp(out,"tailSeconds",tail);setProp(out,"livePlaying",transport_.playing());setProp(out,"liveRecording",transport_.recording());setProp(out,"livePpqPosition",transport_.ppqPosition());setProp(out,"liveSamplePosition",transport_.samplePosition());setProp(out,"liveLoopEnabled",transport_.loopEnabled());setProp(out,"liveLoopStartPpq",transport_.loopStart());setProp(out,"liveLoopEndPpq",transport_.loopEnd());auto& offline=sequencer_.exportTransport();setProp(out,"offlinePlaying",offline.playing());setProp(out,"offlinePpqPosition",offline.ppqPosition());setProp(out,"offlineSamplePosition",offline.samplePosition());setProp(out,"offlineLoopEnabled",offline.loopEnabled());setProp(out,"snapshot",sequencer_.exportSnapshotTrace());setProp(out,"vstSnapshot",vstTrace);setProp(out,"deferredMutationCount",0);setProp(out,"audibleTransport","live");setProp(out,"renderThread","offline-worker");setProp(out,"deviceIndependent",true);setProp(out,"hardwareOutput",false);ipc_.send(out);ipc_.send(makeExportStage("started","Master",file,options.format,"begin"));ipc_.send(makeExportStage("started","encoder",file,options.format,"begin"));launchWorker([this,generation](){renderOfflineExport(generation);});
        });
    });
}

void Engine::cmdSequencerCancelExport(const juce::var&)
{
    if(exportPreparing_.load(std::memory_order_acquire)){
        if(exportCancel_)exportCancel_->store(true,std::memory_order_release);
        exportGeneration_.fetch_add(1,std::memory_order_acq_rel);exportPreparing_.store(false,std::memory_order_release);preparingExportFile_.deleteFile();auto cancelled=makeExportStage("cancelled","DONE",preparingExportFile_,preparingExportFormat_,"end");setProp(cancelled,"frames",0);setProp(cancelled,"livePlaying",transport_.playing());setProp(cancelled,"liveRecording",transport_.recording());setProp(cancelled,"livePpqPosition",transport_.ppqPosition());setProp(cancelled,"deviceIndependent",true);setProp(cancelled,"hardwareOutput",false);ipc_.send(cancelled);exportCancel_.reset();lastPublishedExportFrames_=-1;exportProgressStartedAtMs_=0.0;exportLastAdvancedAtMs_=0.0;exportTransactionStartedAtMs_=0.0;flushDeferredExportCommands();return;
    }
    if(!sequencer_.requestCancelExport(true)){sendError("sequencer-export-cancel","No export is active");return;}
    // The CPU-driven worker observes exportActive_ and consumes the clone
    // panic block without depending on a future hardware callback.
}

void Engine::cmdSequencerQuiesce(const juce::var& msg)
{
    // These edits belong to the project being replaced. They must not land in
    // the fresh project once its renderer publishes a new network.
    deferredExportCommands_.clear();
    preCountGeneration_.fetch_add(1,std::memory_order_acq_rel);
    preCountActive_.store(false,std::memory_order_release);
    preCountComplete_.store(false,std::memory_order_release);
    const bool wasRecording = sequencer_.recording();
    if (wasRecording)
        for (const auto& event : sequencer_.finishRecording(transport_)) ipc_.send(event);
    const bool cancelledPreparing=exportPreparing_.exchange(false,std::memory_order_acq_rel);
    if(cancelledPreparing){if(exportCancel_)exportCancel_->store(true,std::memory_order_release);exportGeneration_.fetch_add(1,std::memory_order_acq_rel);preparingExportFile_.deleteFile();exportCancel_.reset();}
    const bool cancelledExport = sequencer_.requestCancelExport(false)||cancelledPreparing;
    clearExportContext();
    sequencer_.clearPlan();
    transport_.setPlaying(false);
    panicAllMidi();
    juce::var out=makeObject();setProp(out,"type","sequencerQuiesced");setProp(out,"requestId",msg["requestId"]);setProp(out,"wasRecording",wasRecording);setProp(out,"cancelledExport",cancelledExport);ipc_.send(out);
    cmdGetTransport(msg);
}

void Engine::cmdSequencerPanic(const juce::var&)
{
    // Cable deletion must silence physical hardware immediately, even during
    // a long offline bounce. The Sequencer/chain/Arpeggiator panic state is
    // part of the frozen render and is therefore left untouched until export
    // completion publishes the deferred network.
    if (sequencer_.exporting())
        physicalMidiOutput_.panic();
    else
        panicAllMidi();
}

void Engine::cmdOpenEditor(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const juce::String requestedPluginId = msg["pluginId"].toString();
    const bool hasGeneration = msg.hasProperty("generation");
    const bool generationIsInteger = msg["generation"].isInt() || msg["generation"].isInt64();
    const juce::int64 requestedGeneration = generationIsInteger
        ? static_cast<juce::int64>(msg["generation"]) : 0;

    juce::var out = makeObject();
    setProp(out, "type", "editorStatus");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);

    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr)
    {
        // Always answer the request: a silent failure leaves the UI showing
        // "opening editor..." forever.
        setProp(out, "open", false);
        setProp(out, "message", message);
        ipc_.send(out);
        sendError(code, message);
        return;
    }

    // Guided Learn includes the complete runtime identity. A delayed open/front
    // request must never land on a replacement instance from another engine
    // generation. Legacy/manual open commands omit these optional fields.
    if ((requestedPluginId.isNotEmpty() && inst->pluginId() != requestedPluginId)
        || (hasGeneration && (!generationIsInteger || requestedGeneration <= 0
            || inst->generation() != requestedGeneration
            || !isCurrentInstanceGeneration(chainId, instanceId, requestedGeneration))))
    {
        setProp(out, "pluginId", inst->pluginId());
        setProp(out, "generation", inst->generation());
        setProp(out, "open", false);
        setProp(out, "message", "editor target identity is stale");
        ipc_.send(out);
        return;
    }

    const bool ok = inst->openEditor(message);

    // Report what is actually on screen, not merely that the command ran.
    setProp(out, "pluginId", inst->pluginId());
    setProp(out, "generation", inst->generation());
    setProp(out, "open", ok && inst->editorVisible());
    setProp(out, "width", inst->editorWidth());
    setProp(out, "height", inst->editorHeight());
    if (!ok)
        setProp(out, "message", message.isNotEmpty() ? message : juce::String("editor could not be opened"));
    ipc_.send(out);

    if (!ok)
        sendError("editor-open", "Could not open the editor for '" + inst->name() + "': " + message);
}

void Engine::cmdCloseEditor(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr)
        return; // closing something that is already gone is not an error

    inst->closeEditor();

    juce::var out = makeObject();
    setProp(out, "type", "editorStatus");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);
    setProp(out, "pluginId", inst->pluginId());
    setProp(out, "generation", inst->generation());
    setProp(out, "open", inst->editorVisible());
    ipc_.send(out);
}

void Engine::cmdGetState(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    PluginInstance* inst = requireInstance(chainId, instanceId);
    if (inst == nullptr)
        return;

    juce::var out = makeObject();
    setProp(out, "type", "pluginState");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);
    setProp(out, "pluginId", inst->pluginId());
    setProp(out, "generation", inst->generation());
    setProp(out, "state", inst->getState());
    ipc_.send(out);
}

void Engine::cmdSetState(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    PluginInstance* inst = requireInstance(chainId, instanceId);
    if (inst == nullptr)
        return;
    if ((msg.hasProperty("pluginId") && msg["pluginId"].toString()!=inst->pluginId())
        || (msg.hasProperty("generation") && (juce::int64)msg["generation"]!=inst->generation()))
    { sendError("state-stale", "State target identity is stale"); return; }

    juce::String error;
    if (!inst->setState(msg["state"], error))
    {
        sendError("state-invalid", error);
        return;
    }
    juce::var out = makeObject();
    setProp(out, "type", "stateApplied");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);
    ipc_.send(out);
}

void Engine::cmdGetVstParameters(const juce::var& msg)
{
    const juce::String requestId = msg["requestId"].toString();
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();

    // Always answer the request with a controlled status so the renderer never
    // waits forever and never has to guess whether a silent failure happened.
    // A request against an unavailable runtime returns an explicit status, not
    // a fabricated empty "success" unless that is genuinely correct.
    juce::var out = makeObject();
    setProp(out, "type", "vstParameters");
    setProp(out, "requestId", requestId);
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);

    if (!msg["requestId"].isString() || requestId.isEmpty() || requestId.length() > 160
        || !msg["chainId"].isString() || chainId.isEmpty() || chainId.length() > 128
        || !msg["instanceId"].isString() || instanceId.isEmpty() || instanceId.length() > 64)
    {
        setProp(out, "status", "invalid-request");
        setProp(out, "message", "requestId, chainId and instanceId must be bounded strings");
        setProp(out, "parameters", juce::Array<juce::var>());
        ipc_.send(out);
        return;
    }

    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr)
    {
        setProp(out, "status", code); // "chain-not-found" | "instance-not-found"
        setProp(out, "message", message);
        setProp(out, "parameters", juce::Array<juce::var>());
        ipc_.send(out);
        sendError(code, message);
        return;
    }

    if (!inst->isReady())
    {
        setProp(out, "status", "not-ready");
        setProp(out, "message", inst->error().isNotEmpty() ? inst->error()
                                                             : juce::String("plugin is not ready"));
        setProp(out, "parameters", juce::Array<juce::var>());
        ipc_.send(out);
        return;
    }

    setProp(out, "status", "ok");
    setProp(out, "pluginId", inst->pluginId());
    setProp(out, "name", inst->name());
    setProp(out, "parameters", inst->getParameters());
    ipc_.send(out);
}

void Engine::cmdSetVstParameter(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const juce::String pluginId = msg["pluginId"].toString();
    const juce::String parameterId = msg["parameterId"].toString();
    const bool generationIsInteger = msg["generation"].isInt() || msg["generation"].isInt64();
    const juce::int64 generation = generationIsInteger
        ? static_cast<juce::int64>(msg["generation"]) : 0;
    const bool valueIsNumber = msg["normalizedValue"].isInt()
        || msg["normalizedValue"].isInt64() || msg["normalizedValue"].isDouble();
    const double normalizedValue = valueIsNumber
        ? static_cast<double>(msg["normalizedValue"]) : -1.0;

    const bool parameterIdShape = parameterId.isNotEmpty()
        && parameterId.length() <= 10
        && parameterId.containsOnly("0123456789")
        && (parameterId == "0" || !parameterId.startsWithChar('0'))
        && parameterId.getLargeIntValue() >= 0
        && parameterId.getLargeIntValue() <= static_cast<juce::int64>(0xffffffffu);
    if (!isProtocolChainId(chainId)
        || !isProtocolInstanceId(instanceId)
        || pluginId.isEmpty() || pluginId.length() > 2048
        || !generationIsInteger || generation <= 0
        || !parameterIdShape
        || !valueIsNumber || !std::isfinite(normalizedValue)
        || normalizedValue < 0.0 || normalizedValue > 1.0)
    {
        sendError("parameter-set-invalid", "Malformed VST parameter update");
        return;
    }

    // This handler and every chain mutation run on JUCE's message thread.
    // Resolve identity only now, then use the object synchronously; no pointer
    // is queued, returned, cached outside PluginInstance, or allowed to escape.
    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr)
    {
        sendError(code, message);
        return;
    }
    if (inst->pluginId() != pluginId)
    {
        sendError("plugin-identity-mismatch", "The instance no longer hosts the bound plugin");
        return;
    }
    if (!isCurrentInstanceGeneration(chainId, instanceId, generation)
        || inst->generation() != generation)
    {
        sendError("instance-generation-mismatch", "The bound plugin runtime has been replaced");
        return;
    }

    juce::String error;
    if (!inst->setParameterNormalized(parameterId,
                                      static_cast<float>(normalizedValue), error)
        && inst->shouldReportParameterSetFailure(parameterId))
        sendError("parameter-set-failed", error);
}

void Engine::cmdSetVstParameterLearn(const juce::var& msg)
{
    const juce::String learnId = msg["learnId"].toString();
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const juce::String pluginId = msg["pluginId"].toString();
    const bool generationIsInteger = msg["generation"].isInt() || msg["generation"].isInt64();
    const juce::int64 generation = generationIsInteger
        ? static_cast<juce::int64>(msg["generation"]) : 0;
    const bool armedShape = msg["armed"].isBool();
    const bool armed = armedShape ? static_cast<bool>(msg["armed"]) : false;

    if (learnId.isEmpty() || learnId.length() > 160
        || !learnId.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")
        || !isProtocolChainId(chainId) || !isProtocolInstanceId(instanceId)
        || pluginId.isEmpty() || pluginId.length() > 2048
        || !generationIsInteger || generation <= 0 || !armedShape)
    {
        sendError("parameter-learn-invalid", "Malformed VST parameter Learn command");
        return;
    }

    if (!armed)
    {
        if (activeParameterLearn_ && activeParameterLearn_->learnId == learnId
            && activeParameterLearn_->chainId == chainId
            && activeParameterLearn_->instanceId == instanceId
            && activeParameterLearn_->pluginId == pluginId
            && activeParameterLearn_->generation == generation)
        {
            cancelActiveParameterLearn("cancelled");
        }
        else
        {
            // A stale cancellation never touches a newer operation, but it is
            // still acknowledged so the renderer cannot wait indefinitely.
            sendParameterLearnState(learnId, chainId, instanceId, pluginId,
                                    generation, false, "not-active");
        }
        return;
    }

    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr || !inst->isReady() || inst->pluginId() != pluginId
        || inst->generation() != generation
        || !isCurrentInstanceGeneration(chainId, instanceId, generation))
    {
        const auto reason = inst == nullptr ? code : juce::String("target-mismatch");
        sendParameterLearnState(learnId, chainId, instanceId, pluginId,
                                generation, false, reason);
        return;
    }

    cancelActiveParameterLearn("superseded");
    juce::String error;
    if (!inst->armParameterLearn(learnId, error))
    {
        sendParameterLearnState(learnId, chainId, instanceId, pluginId,
                                generation, false,
                                error.isNotEmpty() ? error : juce::String("arm-failed"));
        return;
    }
    activeParameterLearn_ = std::make_unique<ActiveParameterLearn>(
        ActiveParameterLearn { learnId, chainId, instanceId, pluginId, generation });
    sendParameterLearnState(learnId, chainId, instanceId, pluginId,
                            generation, true, "armed");
}

void Engine::cmdShutdown(const juce::var& msg)
{
    requestShutdown(true);
}

// ---- Engine 2 / PortAudio callback boundary ----

void Engine::audioEnginePrepared(double sr, int bs)
{
    transport_.setSampleRate(sr);
    // Called on the control thread before PortAudio starts. Allocation is
    // allowed here; the real-time callback only sees prepared storage.

    scratch_.setSize(2, bs);
    inputScratch_.setSize(2, bs);
    chainMidi_.ensureSize(kMidiBufferBytes);

    const int numChains = audioChainCount_.load(std::memory_order_acquire);
    for (int c = 0; c < numChains; ++c)
        audioChains_[static_cast<size_t>(c)]->prepareToPlay(sr, bs);
    sequencer_.prepare(sr,bs);
    audioOutputMeter_.prepare(sr);
    masterOutput_.prepare(sr);
    callbackDeadlineMilliseconds_ = 1000.0 * static_cast<double>(bs) / std::max(1.0, sr);
    // PortAudio/WASAPI shared serves several user blocks per host period, so
    // consecutive callbacks arrive back to back and are then followed by one
    // host-period-long pause. Measured against a single block deadline that
    // reported 43 % of callbacks as late on a stream PortAudio itself declared
    // free of underflows. The device's own buffered depth is the only
    // threshold at which a gap can actually starve the output;
    // paOutputUnderflow remains the authoritative starvation signal.
    callbackGapThresholdMilliseconds_ = std::max(
        callbackDeadlineMilliseconds_ * 1.5,
        1000.0 * audioEngine_.deviceTrace().outputLatencySeconds);
    previousCallbackStartMilliseconds_ = 0.0;
    callbackDurationMilliseconds_.store(0.0f, std::memory_order_relaxed);
    maximumCallbackDurationSinceSnapshot_.store(0.0f, std::memory_order_relaxed);
    maximumCallbackGapSinceSnapshot_.store(0.0f, std::memory_order_relaxed);
    deadlineMissesSinceSnapshot_.store(0, std::memory_order_relaxed);
    schedulingGapsSinceSnapshot_.store(0, std::memory_order_relaxed);

    currentSampleRate_ = sr;
    currentBlockSize_ = bs;
    currentOutputDevice_ = juce::String(audioEngine_.deviceTrace().deviceName);
    engineRunning_ = true;
    engineError_.clear();
    sendDeviceState();
    sendStatus();
}

void Engine::audioEngineStopped()
{
    const int numChains = audioChainCount_.load(std::memory_order_acquire);
    for (int c = 0; c < numChains; ++c)
        audioChains_[static_cast<size_t>(c)]->reset();
    audioOutputMeter_.reset();
    masterOutput_.reset();

    engineRunning_ = false;
    // Stopping the live endpoint never affects the private offline renderer.
    sendDeviceState();
    sendStatus();
}

void Engine::processEngine2Block(const float* const* inputChannelData,
                                 int numInputChannels,
                                 float* const* outputChannelData,
                                 int numOutputChannels,
                                 int numSamples) noexcept
{
    const double callbackStartedMilliseconds = juce::Time::getMillisecondCounterHiRes();
    if (previousCallbackStartMilliseconds_ > 0.0 && callbackGapThresholdMilliseconds_ > 0.0)
    {
        const float gap = static_cast<float>(
            callbackStartedMilliseconds - previousCallbackStartMilliseconds_);
        publishMaximum(maximumCallbackGapSinceSnapshot_, gap);
        if (gap > static_cast<float>(callbackGapThresholdMilliseconds_))
        {
            schedulingGapsSinceSnapshot_.fetch_add(1, std::memory_order_relaxed);
            totalSchedulingGaps_.fetch_add(1, std::memory_order_relaxed);
        }
    }
    previousCallbackStartMilliseconds_ = callbackStartedMilliseconds;
    Transport& blockTransport = transport_;
    pluginPlayHead_.select(transport_);
    blockTransport.beginBlock();
    for (int ch = 0; ch < numOutputChannels; ++ch)
        juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
    inputScratch_.clear(0,numSamples);for(int ch=0;ch<std::min(2,numInputChannels);++ch)if(inputChannelData[ch])inputScratch_.copyFrom(ch,0,inputChannelData[ch],numSamples);if(numInputChannels==1)inputScratch_.copyFrom(1,0,inputScratch_,0,0,numSamples);

    AudioExecutionPlan* plan=nullptr;
    MidiExecutionPlan* midiPlan=nullptr;
    do { midiPlan=activeMidiPlan_.load(std::memory_order_acquire); midiPlanHazard_.store(midiPlan,std::memory_order_release); } while(midiPlan!=activeMidiPlan_.load(std::memory_order_acquire));
    if(midiPanicPending_.exchange(false,std::memory_order_acq_rel)){
        // Mutable MidiExecutionPlan/Arpeggiator state is audio-thread-owned.
        // Hardware was already silenced by the message-thread request above.
        if(midiPlan)midiPlan->panicAll(nullptr);
    }
    const double midiStartMs=juce::Time::getMillisecondCounterHiRes()+std::max(1.0,1000.0*numSamples/std::max(1.0,currentSampleRate_));
    auto* hardwareMidi = &physicalMidiOutput_;
    sequencer_.processMidi(numSamples,blockTransport,midiPlan,hardwareMidi,midiStartMs);
    if(midiPlan)midiPlan->process(numSamples,blockTransport,hardwareMidi,midiStartMs,currentSampleRate_);
    audioNetworkReaders_.fetch_add(1, std::memory_order_acq_rel);
    do { plan=activeAudioPlan_.load(std::memory_order_acquire); audioPlanHazard_.store(plan,std::memory_order_release); }
    while(plan!=activeAudioPlan_.load(std::memory_order_acquire));
    if (plan) plan->process(outputChannelData, numOutputChannels, numSamples, blockTransport, chainMidi_, &inputScratch_);
    audioNetworkReaders_.fetch_sub(1, std::memory_order_release);
    // The click is another live Audio Output source. The export context below
    // has its own buffer and never receives it.
    auto renderMetronomeClick=[&](int offset,bool accent,bool preCount,int64_t beat,
                                  double ppq,int beatInBar,int64_t absoluteSample){
        const float volume=metronomeVolume_.load(std::memory_order_relaxed);
        const float phaseIncrement=metronomeClickPhaseIncrement(accent,preCount);
        const int length=std::min(96,numSamples-offset);
        for(int k=0;k<length;++k){const float env=1.0f-float(k)/length;const float click=std::sin(float(k)*phaseIncrement)*env*volume*(accent?1.0f:0.65f);for(int ch=0;ch<numOutputChannels;++ch)outputChannelData[ch][offset+k]+=click;}
        metronomeTicks_.push({0,absoluteSample,beat,ppq,beatInBar,accent,preCount});
    };
    const auto preCountGeneration=preCountGeneration_.load(std::memory_order_acquire);
    const bool preCounting=preCountActive_.load(std::memory_order_acquire);
    if(preCounting){
        const double qps=preCountQuarterNotesPerSample_.load(std::memory_order_relaxed);
        const int64_t start=preCountSamplePosition_.fetch_add(numSamples,std::memory_order_relaxed);
        const int64_t total=metronomePreCountSamples(qps,kPreCountBeats);
        const int usable=(int)std::max<int64_t>(0,std::min<int64_t>(numSamples,total-start));
        for(int i=0;i<usable;++i){
            const int64_t elapsed=start+i;int64_t beat=0;
            if(!metronomePreCountBeatAtSample(elapsed,qps,kPreCountBeats,beat))continue;
            if(lastPreCountBeat_.exchange(beat,std::memory_order_relaxed)==beat)continue;
            const int beatInBar=(int)beat;const bool accent=beatInBar==0;
            renderMetronomeClick(i,accent,true,beat,(double)elapsed*qps,beatInBar,
                                 transport_.samplePosition()+elapsed);
        }
        if(total>0&&start+numSamples>=total
            &&preCountGeneration==preCountGeneration_.load(std::memory_order_acquire)){
            bool expected=true;
            if(preCountActive_.compare_exchange_strong(expected,false,std::memory_order_acq_rel))
                preCountComplete_.store(true,std::memory_order_release);
        }
    }else if(metronomeEnabled_.load()&&blockTransport.processingPlaying()){
        const double qps=blockTransport.quarterNotesPerSample();
        const int64_t minimumDistance=std::max<int64_t>(1,(int64_t)std::llround(0.5/qps));
        for(int i=0;i<numSamples;++i){
            const double q=blockTransport.ppqAtSample(i);int64_t beat=0;
            if(!metronomeBeatAtSample(q,qps,beat))continue;
            const int64_t absoluteSample=blockTransport.samplePosition()+i;
            if(lastMetronomeTickSample_!=std::numeric_limits<int64_t>::min()
                && std::abs(absoluteSample-lastMetronomeTickSample_)<minimumDistance)continue;
            lastMetronomeTickSample_=absoluteSample;
            const int beatInBar=(int)((beat%4+4)%4);const bool accent=beatInBar==0;
            renderMetronomeClick(i,accent,false,beat,q,beatInBar,absoluteSample);
        }
    }
    // The network reaches the Master as a direct floating-point sum. Metering is
    // passive: no track-count compensation, ceiling, AGC, or gain envelope.
    const float* preMasterChannels[2]={numOutputChannels>0?outputChannelData[0]:nullptr,
                                      numOutputChannels>1?outputChannelData[1]:nullptr};
    audioOutputMeter_.observe(preMasterChannels,std::min(2,numOutputChannels),
                              numSamples,AudioSignalBoundary::input);
    masterOutput_.process(outputChannelData,numOutputChannels,numSamples);
    const float* postMasterChannels[2]={numOutputChannels>0?outputChannelData[0]:nullptr,
                                       numOutputChannels>1?outputChannelData[1]:nullptr};
    audioOutputMeter_.observe(postMasterChannels,std::min(2,numOutputChannels),
                              numSamples,AudioSignalBoundary::output);
    audioPlanHazard_.store(nullptr,std::memory_order_release);
    midiPlanHazard_.store(nullptr,std::memory_order_release);
    blockTransport.advance(numSamples);
    const float callbackDuration=static_cast<float>(
        juce::Time::getMillisecondCounterHiRes()-callbackStartedMilliseconds);
    callbackDurationMilliseconds_.store(callbackDuration,std::memory_order_release);
    publishMaximum(maximumCallbackDurationSinceSnapshot_,callbackDuration);
    publishMaximum(maximumCallbackDuration_,callbackDuration);
    if(callbackDeadlineMilliseconds_>0.0&&callbackDuration>callbackDeadlineMilliseconds_){deadlineMissesSinceSnapshot_.fetch_add(1,std::memory_order_relaxed);totalDeadlineMisses_.fetch_add(1,std::memory_order_relaxed);}
}

} // namespace mlh
