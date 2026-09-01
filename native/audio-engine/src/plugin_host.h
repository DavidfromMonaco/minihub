#pragma once

#include "audio_signal_meter.h"
#include "gesture_learn_state.h"
#include "vst3_scanner.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <set>

namespace mlh {

class DirectVst3Plugin;

juce::String pluginEditorWindowTitle(const juce::String& pluginName);
juce::String pluginEditorUntouchedText();
juce::String pluginEditorLearnArmedText();

struct PluginProcessingTelemetry {
    float lastMilliseconds = 0.0f;
    float maximumRecentMilliseconds = 0.0f;
    float maximumMilliseconds = 0.0f;
    uint64_t processCalls = 0;
};

/** A live Steinberg-SDK VST3 instance.
 *
 * JUCE types remain at this class boundary only because the existing MiniHub
 * graph/sequencer and JSON protocol use AudioBuffer, MidiBuffer and var.  The
 * module discovery, component/controller lifecycle, bus negotiation, process
 * call, parameter queues, state and IPlugView are all hosted directly through
 * the official VST3 SDK by DirectVst3Plugin.
 */
class PluginInstance final : private juce::Timer {
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

    PluginInstance();
    ~PluginInstance() override;

    PluginInstance(const PluginInstance&) = delete;
    PluginInstance& operator=(const PluginInstance&) = delete;

    bool create(const PluginRecord& record, double sampleRate, int blockSize,
                juce::String& error);
    void prepareToPlay(double sampleRate, int blockSize, bool offline = false);
    void setPlayHead(juce::AudioPlayHead* playHead) { assignedPlayHead_ = playHead; }
    juce::AudioPlayHead* assignedPlayHeadForTesting() const { return assignedPlayHead_; }
    void reset();
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) noexcept;

    AudioSignalTelemetry takeSignalTelemetry() noexcept
    {
        return signalMeter_.takeTelemetrySnapshot();
    }
    PluginProcessingTelemetry takeProcessingTelemetry() noexcept;
    int totalInputChannelsForTesting() const;
    int totalOutputChannelsForTesting() const;
    int enabledOutputBusesForTesting() const;
    int latencySamples() const noexcept;

    const juce::String& instanceId() const { return instanceId_; }
    const juce::String& pluginId() const { return pluginId_; }
    const juce::String& name() const { return name_; }
    const juce::String& role() const { return role_; }
    bool isInstrument() const { return isInstrument_; }
    bool isReady() const { return isReady_.load(std::memory_order_acquire); }
    const juce::String& error() const { return error_; }
    bool bypassed() const { return bypassed_.load(std::memory_order_relaxed); }
    void setBypassed(bool value) { bypassed_.store(value, std::memory_order_relaxed); }

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

    bool armParameterLearn(const juce::String& learnId, juce::String& error);
    void cancelParameterLearn(const juce::String& reason);
    bool learnArmed() const { return learnState_.isArmed(); }
    const juce::String& activeLearnId() const { return activeLearnId_; }

    bool openEditor(juce::String& message);
    void closeEditor();
    bool editorVisible() const;
    void foregroundEditorIfAllowed();
    int editorWidth() const;
    int editorHeight() const;

    juce::var getState() const;
    bool setState(const juce::var& state, juce::String& error);
    bool takeStateSnapshotIfDue(juce::var& state, bool force = false);
    juce::var getParameters() const;
    bool setParameterNormalized(const juce::String& parameterId,
                                float normalizedValue,
                                juce::String& error);
    bool shouldReportParameterSetFailure(const juce::String& parameterId)
    {
        return failedParameterIds_.insert(parameterId).second;
    }

private:
    friend class DirectVst3Plugin;
    void timerCallback() override;
    void directParameterGesture(int parameterIndex, bool starting) noexcept;
    void directParameterValue(int parameterIndex, float normalizedValue) noexcept;
    void directNonParameterStateChanged() noexcept;
    void directEditorClosed();

    bool beginRealtimeRead() noexcept;
    void endRealtimeRead() noexcept;
    void beginControlMutation() const noexcept;
    void endControlMutation() const noexcept;

    std::unique_ptr<DirectVst3Plugin> plugin_;
    juce::String chainId_;
    juce::String instanceId_;
    juce::String pluginId_;
    juce::String name_;
    juce::String role_;
    bool isInstrument_ = false;
    std::atomic<bool> isReady_ {false};
    std::atomic<bool> bypassed_ {false};
    juce::String error_;
    juce::int64 generation_ = 0;
    ParameterTouchedCallback parameterTouchedCallback_;
    ParameterLearnEndedCallback parameterLearnEndedCallback_;
    EditorClosedCallback editorClosedCallback_;

    GestureLearnState learnState_;
    juce::String activeLearnId_;
    std::set<juce::String> failedParameterIds_;
    std::atomic<uint64_t> stateRevision_ {0};
    juce::AudioPlayHead* assignedPlayHead_ = nullptr;
    uint64_t observedStateRevision_ = 0;
    uint64_t capturedStateRevision_ = 0;
    int stableStateTicks_ = 0;
    AudioSignalMeter signalMeter_;
    std::atomic<float> lastProcessingMilliseconds_ {0.0f};
    std::atomic<float> maximumRecentProcessingMilliseconds_ {0.0f};
    std::atomic<float> maximumProcessingMilliseconds_ {0.0f};
    std::atomic<uint64_t> processingCalls_ {0};

    // State/prepare/reset are control-thread operations. They set this gate and
    // wait for the current reader to leave; the audio callback only performs
    // atomics and drops the block when a mutation is active.
    mutable std::atomic<bool> controlMutation_ {false};
    mutable std::atomic<std::uint32_t> realtimeReaders_ {0};
};

} // namespace mlh
