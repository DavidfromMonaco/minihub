#pragma once
#include "chain.h"
#include "audio_signal_meter.h"
#include "transport.h"
#include <juce_audio_basics/juce_audio_basics.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <limits>
#include <string>
#include <vector>

namespace mlh {

class SequencerEngine;

enum class AudioNodeKind { input, vst, mixer, morpher, sequencer, output, diagnosticSine };

struct AudioNetworkInput {
    std::string portId;
    std::string sourceNodeId;
    std::string sourcePortId;
    float level = 1.0f;
    bool muted = false;
};

struct AudioNetworkNodeSpec {
    std::string id;
    AudioNodeKind kind = AudioNodeKind::vst;
    std::vector<AudioNetworkInput> inputs;
    float masterLevel = 1.0f;
    int stepCount = 4;
    std::array<float, 32> steps {};
    /** Native-test-only deterministic source. It is deliberately absent from
     *  the IPC network parser, so a project can never persist or instantiate it. */
    double diagnosticCyclesPerSample = 0.0;
    float diagnosticAmplitude = 0.0f;
    int64_t diagnosticStartSample = 0;
    int64_t diagnosticEndSample = std::numeric_limits<int64_t>::max();
    int diagnosticLatencySamples = 0;
};

struct AudioNetworkSpec { std::vector<AudioNetworkNodeSpec> nodes; };

/** The mutable half of a compiled node.
 *
 *  Input levels, mutes, the master level and the Morpher steps are the only
 *  things a user changes continuously, and none of them alters the shape of the
 *  network. Holding them here - behind atomics, in their own allocation - lets the
 *  control thread update an already published plan in place instead of
 *  recompiling it. Recompiling rebuilt every SourceDelay, so a single fader drag
 *  used to zero the PDC delay lines mid-stream, repeatedly.
 *
 *  The audio thread only ever loads. Relaxed ordering is sufficient: each value
 *  stands on its own, none of them guards other memory, and the block boundary
 *  is already the natural update granularity.
 */
struct NodeValues final {
    // Both limits are also enforced by the IPC parser and by compile().
    static constexpr size_t kMaxInputs = 64;
    static constexpr size_t kMaxSteps = 32;

    std::atomic<float> masterLevel {1.0f};
    std::array<std::atomic<float>, kMaxSteps> steps {};
    std::array<std::atomic<float>, kMaxInputs> levels {};
    std::array<std::atomic<bool>, kMaxInputs> mutes {};
};

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
        std::vector<SourceDelay> sourceDelays;
        std::vector<const juce::AudioBuffer<float>*> processedSources;
        int latencySamples = 0;
        // Structural: changing it recompiles, unlike the step values themselves.
        int stepCount = 4;
        // Never null, so a Node built directly (tests, diagnostics) reads back
        // exactly like a compiled one.
        std::unique_ptr<NodeValues> values = std::make_unique<NodeValues>();

        // ---- audio-thread reads ----
        [[nodiscard]] float level(size_t input) const noexcept
        {
            return input < NodeValues::kMaxInputs
                ? values->levels[input].load(std::memory_order_relaxed) : 0.0f;
        }
        [[nodiscard]] bool muted(size_t input) const noexcept
        {
            return input < NodeValues::kMaxInputs
                && values->mutes[input].load(std::memory_order_relaxed);
        }
        [[nodiscard]] float masterLevel() const noexcept
        {
            return values->masterLevel.load(std::memory_order_relaxed);
        }
        [[nodiscard]] float step(size_t index) const noexcept
        {
            return index < NodeValues::kMaxSteps
                ? values->steps[index].load(std::memory_order_relaxed) : 0.0f;
        }

        // ---- control-thread writes, safe against a live audio thread ----
        // The clamps live here so compile() and an in-place update cannot drift.
        void setLevel(size_t input, float value) noexcept
        {
            if (input < NodeValues::kMaxInputs)
                values->levels[input].store(std::clamp(value, 0.0f, 2.0f),
                                            std::memory_order_relaxed);
        }
        void setMuted(size_t input, bool value) noexcept
        {
            if (input < NodeValues::kMaxInputs)
                values->mutes[input].store(value, std::memory_order_relaxed);
        }
        void setMasterLevel(float value) noexcept
        {
            values->masterLevel.store(std::clamp(value, 0.0f, 2.0f),
                                      std::memory_order_relaxed);
        }
        void setStep(size_t index, float value) noexcept
        {
            if (index < NodeValues::kMaxSteps)
                values->steps[index].store(std::clamp(value, 0.0f, 1.0f),
                                           std::memory_order_relaxed);
        }

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
        const AudioNetworkSpec&, const std::function<Chain*(const std::string&)>&,
        SequencerEngine*, int maxBlockSize, std::string& error,
        bool pdcEnabled = true);

    void process(float* const* hardwareOutputs, int hardwareChannels,
                 int numSamples, Transport& transport, juce::MidiBuffer& midiScratch,
                 const juce::AudioBuffer<float>* hardwareInput = nullptr) noexcept;
    const std::vector<Node>& nodes() const noexcept { return nodes_; }

    /** Control-thread lookup for a values-only update of a LIVE plan.
     *
     *  The audio thread keeps reading the plan throughout: only the atomics in
     *  NodeValues are written, nothing is reallocated, reordered or freed.
     *  Returns nullptr when the id is unknown, which tells the caller its view
     *  of the topology is stale and a full resync is required. */
    [[nodiscard]] Node* findNode(const std::string& id) noexcept;

    static float morpherPosition(const Node&, double ppq, int numerator=4, int denominator=4) noexcept;
    static float mixScalar(const float* values,const float* levels,const bool* mutes,int count,float master) noexcept;
    static std::pair<float,float> equalPowerGains(float fraction) noexcept;
private:
    std::vector<Node> nodes_; // compiled topological order; immutable after publication
    int maxBlockSize_ = 0;
    SequencerEngine* sequencer_ = nullptr;
    uint64_t blockIdentity_ = 0; // immutable per-plan prefix, assigned off the audio thread
    uint64_t blockCounter_ = 0; // audio-thread owned callback identity
};

} // namespace mlh
