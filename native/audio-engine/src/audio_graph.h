#pragma once
#include "chain.h"
#include "audio_signal_meter.h"
#include "transport.h"
#include <juce_audio_basics/juce_audio_basics.h>
#include <array>
#include <string>
#include <vector>

namespace mlh {

class SequencerEngine;

enum class AudioNodeKind { input, vst, mixer, morpher, sequencer, output };

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
};

struct AudioGraphSpec { std::vector<AudioGraphNodeSpec> nodes; };

class AudioExecutionPlan {
public:
    struct Node {
        std::string id;
        AudioNodeKind kind = AudioNodeKind::vst;
        Chain* chain = nullptr; // chains are append-only and outlive every plan
        SequencerEngine* sequencer = nullptr;
        std::vector<int> sources;
        std::vector<float> levels;
        std::vector<bool> mutes;
        float masterLevel = 1.0f;
        int stepCount = 4;
        std::array<float, 32> steps {};
        juce::AudioBuffer<float> output;
        juce::AudioBuffer<float> sequencerInput;
        std::unique_ptr<AudioSignalMeter> signalMeter;
    };

    static std::unique_ptr<AudioExecutionPlan> compile(
        const AudioGraphSpec&, const std::function<Chain*(const std::string&)>&,
        SequencerEngine*, int maxBlockSize, std::string& error);

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
