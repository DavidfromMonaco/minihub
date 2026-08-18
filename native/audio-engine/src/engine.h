#pragma once

#include "chain.h"
#include "ipc.h"
#include "vst3_scanner.h"

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <map>
#include <memory>

namespace mlh {

/**
 * The native audio engine core.
 *
 * Owns the audio device (WASAPI shared low latency via JUCE AudioDeviceManager),
 * the VST3 registry, and the set of serial plugin chains. Runs on the JUCE
 * message thread; the real-time audio callback lives in this class and only
 * touches lock-free structures.
 */
class Engine : public juce::AudioIODeviceCallback {
public:
    explicit Engine(Ipc& ipc);
    ~Engine() override;

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    /** Handle an incoming IPC command (called on the message thread). */
    void handleCommand(const juce::var& msg);

    /** Send the current engine status event. */
    void sendStatus();

private:
    // ---- AudioIODeviceCallback (real-time) ----
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                         int numInputChannels,
                                         float* const* outputChannelData,
                                         int numOutputChannels,
                                         int numSamples,
                                         const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceStopped() override;

    // ---- command handlers ----
    void cmdHello(const juce::var& msg);
    void cmdListDevices(const juce::var& msg);
    void cmdSelectDevice(const juce::var& msg);
    void cmdGetDeviceState(const juce::var& msg);
    void cmdScanVst3(const juce::var& msg);
    void cmdListPlugins(const juce::var& msg);
    void cmdCreateInstance(const juce::var& msg);
    void cmdRemoveInstance(const juce::var& msg);
    void cmdReorderChain(const juce::var& msg);
    void cmdSetBypass(const juce::var& msg);
    void cmdMidi(const juce::var& msg);
    void cmdSetChainMidiEnabled(const juce::var& msg);
    void cmdSetChainOutputEnabled(const juce::var& msg);
    void cmdOpenEditor(const juce::var& msg);
    void cmdCloseEditor(const juce::var& msg);
    void cmdGetState(const juce::var& msg);
    void cmdSetState(const juce::var& msg);
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
    void sendPlugins();
    /** Stop the audio callback and close the device. Must run before any chain
     *  or plugin is destroyed. */
    void stopAudio();
    void sendError(const juce::String& code, const juce::String& message);
    void sendChainChanged(const juce::String& chainId);
    void sendDeviceState();
    void sendInstanceStatus(const juce::String& chainId, PluginInstance* inst);

    static constexpr int kMaxChains = 32;

    Ipc& ipc_;
    juce::AudioDeviceManager deviceManager_;
    juce::AudioBuffer<float> scratch_; // stereo scratch for chain processing
    juce::MidiBuffer chainMidi_;       // reused per block, never allocated in the callback
    Vst3Scanner scanner_;

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
    bool scanning_ = false;

    bool engineRunning_ = false;
    juce::String engineError_;
    double currentSampleRate_ = 48000.0;
    int currentBlockSize_ = 512;
    juce::String currentOutputDevice_;
};

} // namespace mlh
