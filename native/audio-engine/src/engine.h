#pragma once

#include "chain.h"
#include "ipc.h"
#include "vst3_scanner.h"
#include "transport.h"
#include "audio_graph.h"
#include "midi_graph.h"
#include "midi_output.h"
#include "master_output.h"
#include "sequencer.h"
#include "engine2/audio_engine.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <thread>
#include <vector>

namespace mlh {

struct EngineRuntimeIdentity {
    juce::int64 processId = 0;
    juce::int64 parentProcessId = 0;
    juce::String role { "live" };
    juce::String createdAt;
    juce::String arguments;
};

/**
 * The native audio engine core.
 *
 * Owns Engine 2 (one PortAudio/WASAPI shared stream), the VST3 registry, and
 * the serial plugin chains. The control facade runs on the JUCE message thread;
 * Engine 2's real-time callback touches lock-free/preallocated structures only.
 */
class Engine : private juce::Timer {
public:
    explicit Engine(Ipc& ipc, EngineRuntimeIdentity identity = {});
    ~Engine() override;

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    /** Handle an incoming IPC command (called on the message thread). */
    void handleCommand(const juce::var& msg);

    /** Send the current engine status event. */
    void sendStatus();

    /** Begin an orderly asynchronous shutdown. The message loop remains alive
     *  until every owned worker has finished and been joined. */
    void requestShutdown(bool sendAck = true);

private:
    // ---- Engine 2 / PortAudio boundary ----
    void audioEnginePrepared(double sampleRate, int blockSize);
    void processEngine2Block(const float* const* inputChannelData,
                             int numInputChannels,
                             float* const* outputChannelData,
                             int numOutputChannels,
                             int numSamples) noexcept;
    void audioEngineStopped();
    void timerCallback() override;

    // ---- command handlers ----
    void cmdHello(const juce::var& msg);
    void cmdListDevices(const juce::var& msg);
    void cmdSelectDevice(const juce::var& msg);
    void cmdSelectMidiOutput(const juce::var& msg);
    void cmdGetDeviceState(const juce::var& msg);
    void cmdScanVst3(const juce::var& msg);
    void cmdListPlugins(const juce::var& msg);
    void cmdCreateInstance(const juce::var& msg);
    void cmdRemoveInstance(const juce::var& msg);
    void cmdReorderChain(const juce::var& msg);
    void cmdSetBypass(const juce::var& msg);
    void cmdMidi(const juce::var& msg);
    void cmdMidiNode(const juce::var& msg);
    void cmdSetChainMidiEnabled(const juce::var& msg);
    void cmdSetChainOutputEnabled(const juce::var& msg);
    void cmdOpenEditor(const juce::var& msg);
    void cmdCloseEditor(const juce::var& msg);
    void cmdGetState(const juce::var& msg);
    void cmdSetState(const juce::var& msg);
    void cmdGetVstParameters(const juce::var& msg);
    void cmdSetVstParameter(const juce::var& msg);
    void cmdSetVstParameterLearn(const juce::var& msg);
    void cmdSetTransport(const juce::var& msg);
    void cmdGetTransport(const juce::var& msg);
    void cmdForegroundEditors(const juce::var& msg);
    void cmdSyncAudioGraph(const juce::var& msg);
    void cmdSyncMidiGraph(const juce::var& msg);
    void cmdCapturePluginStates(const juce::var& msg);
    void cmdSetMetronome(const juce::var& msg);
    void cmdSetMasterOutput(const juce::var& msg);
    void cmdResetMasterClip(const juce::var& msg);
    void cmdSyncSequencer(const juce::var& msg);
    void cmdSetSequencerTrackControl(const juce::var& msg);
    void cmdSequencerMidiInput(const juce::var& msg);
    void cmdSequencerRecord(const juce::var& msg);
    void cmdSequencerExport(const juce::var& msg);
    void cmdSequencerCancelExport(const juce::var& msg);
    void cmdSequencerQuiesce(const juce::var& msg);
    void cmdSequencerPanic(const juce::var& msg);
    void cmdShutdown(const juce::var& msg);

    Chain* getOrCreateChain(const juce::String& chainId);
    Chain* getChain(const juce::String& chainId);

    /** Resolve `chainId` from a command, reporting `chain-not-found`. */
    Chain* requireChain(const juce::String& chainId);
    /** Resolve `chainId`+`instanceId`, filling `code`/`message` on failure so
     *  the caller can report it in whatever shape its response needs. */
    PluginInstance* lookupInstance(const juce::String& chainId,
                                   const juce::String& instanceId,
                                   juce::String& code,
                                   juce::String& message);
    /** Resolve `chainId`+`instanceId`, reporting the failure as an error event. */
    PluginInstance* requireInstance(const juce::String& chainId,
                                    const juce::String& instanceId);
    juce::String instanceKey(const juce::String& chainId,
                             const juce::String& instanceId) const;
    bool isCurrentInstanceGeneration(const juce::String& chainId,
                                     const juce::String& instanceId,
                                     juce::int64 generation) const;
    void finishPendingPluginLoad(const juce::String& chainId,
                                 const juce::String& instanceId,
                                 juce::int64 generation);
    void sendPlugins();
    /** Stop the audio callback and close the device. Must run before any chain
     *  or plugin is destroyed. */
    void stopAudio();

    /** Open the system's default WASAPI shared output so the engine is audible before the
     *  user has ever visited the Audio Output panel. */
    void openDefaultOutput();
    void sendError(const juce::String& code, const juce::String& message);
    void sendChainChanged(const juce::String& chainId);
    void sendDeviceState();
    void sendMidiOutputState();
    void panicAllMidi();
    void clearAudioGraph();
    void publishAudioPlan(std::unique_ptr<AudioExecutionPlan> plan);
    void republishActiveAudioGraph();
    void clearMidiGraph();
    void sendInstanceStatus(const juce::String& chainId, PluginInstance* inst);
    void sendParameterTouched(PluginInstance& inst,
                              const PluginInstance::TouchedParameter& touched);
    void capturePluginStates(bool force);
    void sendEditorStatus(PluginInstance& inst, bool open,
                          const juce::String& message = {});
    void sendParameterLearnState(const juce::String& learnId,
                                 const juce::String& chainId,
                                 const juce::String& instanceId,
                                 const juce::String& pluginId,
                                 juce::int64 generation,
                                 bool armed,
                                 const juce::String& reason);
    void cancelActiveParameterLearn(const juce::String& reason);
    void parameterLearnEnded(PluginInstance& inst,
                             const juce::String& learnId,
                             const juce::String& reason);
    void flushDeferredExportCommands();
    void clearExportContext();
    bool tryClearExportContext() noexcept;
    /** CPU-driven bounce loop. It owns only cloned processors and private PCM;
     *  it never runs on or waits for the hardware audio callback. */
    void renderOfflineExport(uint64_t generation) noexcept;
    bool exportTransactionActive() const noexcept
    {
        return exportPreparing_.load(std::memory_order_acquire)
            || sequencer_.exportTransactionActive();
    }
    void launchWorker(std::function<void()> work);
    /** Post one worker-owned result back to the message thread. Shutdown waits
     *  for these callbacks as well as the worker threads, so a completed load
     *  cannot strand a raw PluginInstance in a callback behind app quit. */
    void postWorkerResult(std::function<void()> result);
    void workerFinished();
    void reapFinishedWorkers();
    void finishShutdown();

    static constexpr int kMaxChains = 32;

    Ipc& ipc_;
    const EngineRuntimeIdentity runtimeIdentity_;
    // Exactly one live owner: AudioEngine -> PortAudioDevice -> WASAPI stream.
    engine2::AudioEngine audioEngine_;
    // Compatibility alias for the existing control/sequencer code. Ownership
    // remains exclusively in Engine 2.
    Transport& transport_;
    juce::AudioBuffer<float> scratch_; // stereo scratch for chain processing
    juce::AudioBuffer<float> inputScratch_; // physical input tap for armed audio tracks
    juce::MidiBuffer chainMidi_;       // reused per block, never allocated in the callback
    Vst3Scanner scanner_;
    TransportPlayHeadRouter pluginPlayHead_;
    SequencerEngine sequencer_;
    AudioSignalMeter audioOutputMeter_;
    MasterOutput masterOutput_;
    PhysicalMidiOutput physicalMidiOutput_;
    // Published plans are immutable and retained until shutdown. The callback
    // loads one raw pointer atomically; publication cannot reclaim a plan that
    // an in-flight callback still uses.
    std::vector<std::unique_ptr<AudioExecutionPlan>> audioPlans_;
    std::atomic<AudioExecutionPlan*> activeAudioPlan_ { nullptr };
    std::atomic<AudioExecutionPlan*> audioPlanHazard_ { nullptr };
    std::atomic<std::uint32_t> audioGraphReaders_ { 0 };
    std::vector<std::unique_ptr<MidiExecutionPlan>> midiPlans_;
    std::atomic<MidiExecutionPlan*> activeMidiPlan_ { nullptr };
    std::atomic<MidiExecutionPlan*> midiPlanHazard_ { nullptr };
    // Message-thread commands request panic through this gate. Mutable MIDI
    // plan/Arpeggiator state is consumed exclusively by the audio callback.
    std::atomic<bool> midiPanicPending_ { false };
    int timingDiagnosticTicks_ = 0;
    // Commands in this list describe the state *after* the current bounce.
    // Keeping them off the live native graph makes one master export consume
    // one immutable routing/state snapshot from its first block to its last.
    std::vector<juce::var> deferredExportCommands_;
    bool replayingDeferredExportCommands_ = false;

    struct ExportPluginSnapshot {
        juce::String chainId, instanceId, pluginId;
        int index = 0;
        juce::int64 generation = 0;
        PluginRecord record;
        bool recordResolved = false;
        bool bypassed = false;
        juce::var state;
    };
    struct ExportContext {
        std::map<juce::String, std::unique_ptr<Chain>> chains;
        std::unique_ptr<AudioExecutionPlan> audioPlan;
        std::unique_ptr<MidiExecutionPlan> midiPlan;
        juce::AudioBuffer<float> audio;
        juce::MidiBuffer midiScratch;
        MasterOutput master;
        double sampleRate = 48000.0;
    };
    std::unique_ptr<ExportContext> exportContext_;
    std::atomic<ExportContext*> activeExportContext_ { nullptr };
    std::atomic<ExportContext*> exportContextHazard_ { nullptr };
    AudioGraphSpec activeAudioSpec_;
    MidiGraphSpec activeMidiSpec_;
    std::atomic<bool> exportPreparing_ { false };
    std::atomic<uint64_t> exportGeneration_ { 0 };
    std::shared_ptr<std::atomic<bool>> exportCancel_;
    juce::File preparingExportFile_;
    juce::String preparingExportFormat_ { "wav" };
    int64_t lastPublishedExportFrames_ = -1;
    double exportProgressStartedAtMs_ = 0.0;
    double exportLastAdvancedAtMs_ = 0.0;
    double exportTransactionStartedAtMs_ = 0.0;
    double exportSampleRate_ = 48000.0;

    // Chain ownership lives on the message thread. The audio callback reads a
    // separate append-only array instead of iterating the std::map, which the
    // message thread can rehash at any time (that was a real data race).
    // Chains are only ever appended; they are removed exclusively at shutdown,
    // after the audio callback has been detached.
    std::map<juce::String, std::unique_ptr<Chain>> chains_;
    std::array<Chain*, kMaxChains> audioChains_{};
    std::atomic<int> audioChainCount_{0};

    // Guards against a scan result / plugin creation landing on the message
    // thread after the Engine has been destroyed.
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
    struct WorkerSlot {
        std::shared_ptr<std::atomic<bool>> done;
        std::thread thread;
    };
    std::vector<std::unique_ptr<WorkerSlot>> workers_;
    std::atomic<bool> cancelWorkers_ { false };
    std::atomic<int> pendingWorkerCallbacks_ { 0 };
    bool shutdownRequested_ = false;
    bool shutdownAckRequested_ = false;
    bool shutdownFinished_ = false;
    bool scanning_ = false;
    std::map<juce::String, juce::int64> instanceGenerations_;
    // An export cannot capture a deterministic initial processor graph while
    // an asynchronous VST creation can still install itself. Values are the
    // generation so a stale worker cannot clear a replacement load.
    std::map<juce::String, juce::int64> pendingPluginLoads_;
    juce::int64 nextInstanceGeneration_ = 0;
    struct ActiveParameterLearn {
        juce::String learnId;
        juce::String chainId;
        juce::String instanceId;
        juce::String pluginId;
        juce::int64 generation = 0;
    };
    std::unique_ptr<ActiveParameterLearn> activeParameterLearn_;

    bool engineRunning_ = false;
    juce::String engineError_;
    double currentSampleRate_ = 48000.0;
    int currentBlockSize_ = 512;
    juce::String currentOutputDevice_;
    std::atomic<bool> metronomeEnabled_{false};
    std::atomic<float> metronomeVolume_{0.35f};
    MetronomeTickQueue metronomeTicks_;
    static constexpr int kPreCountBeats = 4;
    std::atomic<bool> preCountActive_{false};
    std::atomic<bool> preCountComplete_{false};
    std::atomic<uint64_t> preCountGeneration_{0};
    std::atomic<int64_t> preCountSamplePosition_{0};
    std::atomic<int64_t> lastPreCountBeat_{-1};
    std::atomic<double> preCountQuarterNotesPerSample_{0.0};
    int64_t lastMetronomeTickSample_ = std::numeric_limits<int64_t>::min();
    int uiTelemetryDivider_ = 0;
    double callbackDeadlineMilliseconds_ = 0.0;
    double previousCallbackStartMilliseconds_ = 0.0;
    std::atomic<float> callbackDurationMilliseconds_ { 0.0f };
    std::atomic<float> maximumCallbackDurationSinceSnapshot_ { 0.0f };
    std::atomic<float> maximumCallbackDuration_ { 0.0f };
    std::atomic<float> maximumCallbackGapSinceSnapshot_ { 0.0f };
    std::atomic<uint64_t> deadlineMissesSinceSnapshot_ { 0 };
    std::atomic<uint64_t> totalDeadlineMisses_ { 0 };
    std::atomic<uint64_t> schedulingGapsSinceSnapshot_ { 0 };
    std::atomic<uint64_t> totalSchedulingGaps_ { 0 };
};

} // namespace mlh
