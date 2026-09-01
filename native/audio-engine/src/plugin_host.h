#pragma once

#include "vst3_scanner.h"
#include "gesture_learn_state.h"
#include "audio_signal_meter.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <memory>
#include <atomic>
#include <functional>
#include <map>
#include <set>

namespace mlh {

class MiniHubPluginHostComponent;

/** Text used by the native JUCE editor chrome. These helpers are public so
 * the native regression suite exercises the exact production conversion. */
juce::String pluginEditorWindowTitle(const juce::String& pluginName);
juce::String pluginEditorUntouchedText();
juce::String pluginEditorLearnArmedText();

struct PluginProcessingTelemetry {
    float lastMilliseconds = 0.0f;
    float maximumRecentMilliseconds = 0.0f;
    float maximumMilliseconds = 0.0f;
    uint64_t processCalls = 0;
};

/**
 * A single live VST3 plugin instance inside a serial chain.
 *
 * Owns the real-time plugin instance, its native editor window, and its
 * serialized state. Only stable, reconstructable data (instanceId, pluginId,
 * name, role, bypass, serialized state) is ever exposed to the outside world —
 * native pointers/handles never leave the engine.
 */
class PluginInstance : private juce::AudioProcessorParameter::Listener,
                       private juce::AudioProcessorListener,
                       private juce::Timer {
public:
    struct TouchedParameter {
        juce::String parameterId;
        juce::String name;
        juce::String learnId;
        float normalizedValue = 0.0f;
        bool gestureAware = true;
        bool capturedByLearn = false;
    };
    using ParameterTouchedCallback = std::function<void(PluginInstance&, const TouchedParameter&)>;
    using ParameterLearnEndedCallback =
        std::function<void(PluginInstance&, const juce::String&, const juce::String&)>;
    using EditorClosedCallback = std::function<void(PluginInstance&)>;

    PluginInstance() = default;
    ~PluginInstance();

    PluginInstance(const PluginInstance&) = delete;
    PluginInstance& operator=(const PluginInstance&) = delete;

    /** Create the plugin from a registry record. Must run OFF the message thread
     *  (VST3 instantiation can require an unblocked message thread). */
    bool create(const PluginRecord& record, double sampleRate, int blockSize,
                juce::String& error);

    void prepareToPlay(double sampleRate, int blockSize);
    void setPlayHead(juce::AudioPlayHead* playHead);
    juce::AudioPlayHead* assignedPlayHeadForTesting() const { return assignedPlayHead_; }
    void reset();

    /** Process one block. Called from the real-time audio callback only. */
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    AudioSignalTelemetry takeSignalTelemetry() noexcept { return signalMeter_.takeTelemetrySnapshot(); }
    PluginProcessingTelemetry takeProcessingTelemetry() noexcept;

    int totalInputChannelsForTesting() const
    {
        return plugin_ != nullptr ? plugin_->getTotalNumInputChannels() : 0;
    }
    int totalOutputChannelsForTesting() const
    {
        return plugin_ != nullptr ? plugin_->getTotalNumOutputChannels() : 0;
    }
    int enabledOutputBusesForTesting() const;

    const juce::String& instanceId() const { return instanceId_; }
    const juce::String& pluginId() const { return pluginId_; }
    const juce::String& name() const { return name_; }
    const juce::String& role() const { return role_; }
    bool isInstrument() const { return isInstrument_; }
    bool isReady() const { return isReady_; }
    const juce::String& error() const { return error_; }

    bool bypassed() const { return bypassed_; }
    void setBypassed(bool b) { bypassed_ = b; }

    void setInstanceId(const juce::String& id) { instanceId_ = id; }
    void setRuntimeIdentity(const juce::String& chainId,
                            const juce::String& instanceId,
                            juce::int64 generation);
    const juce::String& chainId() const { return chainId_; }
    juce::int64 generation() const { return generation_; }
    void setParameterTouchedCallback(ParameterTouchedCallback callback)
    {
        parameterTouchedCallback_ = std::move(callback);
    }
    void setParameterLearnEndedCallback(ParameterLearnEndedCallback callback)
    {
        parameterLearnEndedCallback_ = std::move(callback);
    }
    void setEditorClosedCallback(EditorClosedCallback callback)
    {
        editorClosedCallback_ = std::move(callback);
    }
    /** Arm the one externally-owned Learn operation for this visible editor. */
    bool armParameterLearn(const juce::String& learnId, juce::String& error);
    /** End the current operation, if any, and synchronously notify the engine. */
    void cancelParameterLearn(const juce::String& reason);
    bool learnArmed() const { return learnState_.isArmed(); }
    const juce::String& activeLearnId() const { return activeLearnId_; }

    // ---- Native editor window (owned by the engine, never embedded in Electron) ----

    /** Open (or re-show) the plugin's own native editor in a top-level window.
     *  MUST be called on the JUCE message thread. Returns false and fills
     *  `message` when the plugin exposes no editor or the editor cannot be
     *  created. */
    bool openEditor(juce::String& message);

    /** Hide the editor window. The plugin instance stays loaded and keeps
     *  processing audio. */
    void closeEditor();

    /** True while the editor window exists AND is actually on screen. This is
     *  what `editorStatus` reports — never a bare "the command succeeded". */
    bool editorVisible() const;
    void foregroundEditorIfAllowed();

    /** Size of the editor window currently on screen (0 when there is none). */
    int editorWidth() const;
    int editorHeight() const;

    // Serialized plugin state (base64). Safe to persist/restore.
    juce::var getState() const;
    bool setState(const juce::var& state, juce::String& error);
    bool takeStateSnapshotIfDue(juce::var& state, bool force = false);

    /**
     * Enumerate the plugin's parameters as a JSON array of records.
     *
     * MUST be called on the JUCE message thread (VST3 parameter metadata is
     * read from the edit controller, which requires the message thread).
     * Demand-driven: this is only invoked when Electron explicitly asks for
     * the list; it never runs on the audio callback and never streams values.
     *
     * Each record carries the plugin-provided stable parameter ID (the VST3
     * ParamID) when available, plus inexpensive descriptive metadata. Display
     * text is deliberately not queried here because that calls into the VST3
     * edit controller once per parameter; it can be fetched lazily later.
     */
    juce::var getParameters() const;

    /**
     * Set a normalized parameter through JUCE's hosted-parameter API.
     * Message-thread only. Resolves the stable VST3 ParamID to a live index
     * inside this instance; no pointer or index crosses the IPC boundary.
     */
    bool setParameterNormalized(const juce::String& parameterId,
                                float normalizedValue,
                                juce::String& error);
    /** True only for the first repeated failure of this ParamID in this live instance. */
    bool shouldReportParameterSetFailure(const juce::String& parameterId)
    {
        return failedParameterIds_.insert(parameterId).second;
    }

private:
    void showEditorWindow();
    void attachParameterListeners();
    void detachParameterListeners();
    void parameterValueChanged(int parameterIndex, float newValue) override;
    void parameterGestureChanged(int parameterIndex, bool gestureIsStarting) override;
    void audioProcessorParameterChanged(juce::AudioProcessor*, int, float) override;
    void audioProcessorChanged(juce::AudioProcessor*, const juce::AudioProcessorListener::ChangeDetails&) override;
    void timerCallback() override;

    std::unique_ptr<juce::AudioPluginInstance> plugin_;
    // The window owns the editor component (JUCE reference-host pattern), so
    // there is exactly one owner and no destruction-order hazard.
    std::unique_ptr<juce::DocumentWindow> editorWindow_;
    MiniHubPluginHostComponent* hostComponent_ = nullptr; // owned by editorWindow_

    juce::String chainId_;
    juce::String instanceId_;
    juce::String pluginId_;
    juce::String name_;
    juce::String role_;
    bool isInstrument_ = false;
    bool isReady_ = false;
    bool bypassed_ = false;
    juce::String error_;
    juce::int64 generation_ = 0;
    ParameterTouchedCallback parameterTouchedCallback_;
    ParameterLearnEndedCallback parameterLearnEndedCallback_;
    EditorClosedCallback editorClosedCallback_;
    bool parameterListenersAttached_ = false;

    GestureLearnState learnState_;
    juce::String activeLearnId_;
    std::map<juce::String, int> stableParameterIndices_;
    bool parameterIndexBuilt_ = false;
    std::set<juce::String> failedParameterIds_;
    std::atomic<uint64_t> stateRevision_ { 0 };
    juce::AudioPlayHead* assignedPlayHead_ = nullptr;
    uint64_t observedStateRevision_ = 0;
    uint64_t capturedStateRevision_ = 0;
    int stableStateTicks_ = 0;
    AudioSignalMeter signalMeter_;
    std::atomic<float> lastProcessingMilliseconds_ { 0.0f };
    std::atomic<float> maximumRecentProcessingMilliseconds_ { 0.0f };
    std::atomic<float> maximumProcessingMilliseconds_ { 0.0f };
    std::atomic<uint64_t> processingCalls_ { 0 };
};

} // namespace mlh
