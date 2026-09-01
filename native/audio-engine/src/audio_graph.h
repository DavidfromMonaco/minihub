#pragma once
#include "chain.h"
#include "audio_signal_meter.h"
#include "transport.h"
#include <juce_audio_basics/juce_audio_basics.h>
#include <array>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace mlh {

class SequencerEngine;

enum class AudioNodeKind { input, vst, mixer, morpher, sequencer, output, diagnosticSine };

struct AudioGraphInput {
    std::string portId;
    std::string sourceNodeId;
    std::string sourcePortId;
    float level = 1.0f;
    bool muted = false;
};

struct AudioGraphNodeSpec {
    std::string id;
    AudioNodeKind kind = AudioNodeKind::vst;
    std::vector<AudioGraphInput> inputs;
    float masterLevel = 1.0f;
    int stepCount = 4;
    std::array<float, 32> steps {};
    /** Native-test-only deterministic source. It is deliberately absent from
     *  the IPC graph parser, so a project can never persist or instantiate it. */
    double diagnosticCyclesPerSample = 0.0;
    float diagnosticAmplitude = 0.0f;
    int64_t diagnosticStartSample = 0;
    int64_t diagnosticEndSample = std::numeric_limits<int64_t>::max();
    int diagnosticLatencySamples = 0;
};

struct AudioGraphSpec { std::vector<AudioGraphNodeSpec> nodes; };

class AudioExecutionPlan {
public:
    struct SourceDelay {
        int samples = 0;
        size_t cursor = 0;
        std::vector<float> left;
        std::vector<float> right;
        juce::AudioBuffer<float> output;

        void prepare(int delaySamples, int maxBlockSize);
        const juce::AudioBuffer<float>& process(const juce::AudioBuffer<float>& input,
                                                int numSamples) noexcept;
    };

    struct Node {
        std::string id;
        AudioNodeKind kind = AudioNodeKind::vst;
        Chain* chain = nullptr; // chains are append-only and outlive every plan
        SequencerEngine* sequencer = nullptr;
        std::vector<int> sources;
        std::vector<float> levels;
        std::vector<bool> mutes;
        std::vector<SourceDelay> sourceDelays;
        std::vector<const juce::AudioBuffer<float>*> processedSources;
        int latencySamples = 0;
        float masterLevel = 1.0f;
        int stepCount = 4;
        std::array<float, 32> steps {};
        juce::AudioBuffer<float> output;
        juce::AudioBuffer<float> sequencerInput;
        std::unique_ptr<AudioSignalMeter> signalMeter;
        double diagnosticCyclesPerSample = 0.0;
        float diagnosticAmplitude = 0.0f;
        int64_t diagnosticStartSample = 0;
        int64_t diagnosticEndSample = std::numeric_limits<int64_t>::max();
        int64_t diagnosticRenderedSamples = 0;
    };

    static std::unique_ptr<AudioExecutionPlan> compile(
        const AudioGraphSpec&, const std::function<Chain*(const std::string&)>&,
        SequencerEngine*, int maxBlockSize, std::string& error,
        bool pdcEnabled = true);

    void process(float* const* hardwareOutputs, int hardwareChannels,
                 int numSamples, Transport& transport, juce::MidiBuffer& midiScratch,
                 const juce::AudioBuffer<float>* hardwareInput = nullptr) noexcept;
    const std::vector<Node>& nodes() const noexcept { return nodes_; }

    static float morpherPosition(const Node&, double ppq, int numerator=4, int denominator=4) noexcept;
    static float mixScalar(const float* values,const float* levels,const bool* mutes,int count,float master) noexcept;
    static std::pair<float,float> equalPowerGains(float fraction) noexcept;
private:
    std::vector<Node> nodes_; // compiled topological order; immutable after publication
    int maxBlockSize_ = 0;
    SequencerEngine* sequencer_ = nullptr;
};

} // namespace mlh
