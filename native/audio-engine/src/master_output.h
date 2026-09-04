#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <atomic>
#include <cstdint>

namespace mlh {

/** Values transferred from the audio thread to the message thread. Peaks and
 *  recent reduction cover every block since the previous snapshot. */
struct MasterMeterSnapshot {
    float peakLeft = 0.0f;
    float peakRight = 0.0f;
    float preGainPeak = 0.0f;
    float maximumPeak = 0.0f;
    uint64_t overRangeSamples = 0;
    uint64_t totalOverRangeSamples = 0;
    uint64_t nonFiniteSamples = 0;
    uint64_t totalNonFiniteSamples = 0;
    bool clipLatched = false;
};

/** Master Gain + post-gain meter shared by hardware monitoring and master
 *  export. There is no automatic gain reduction anywhere in this stage or at
 *  upstream network boundaries. This stage owns no callback-time storage. */
class MasterOutput {
public:
    static constexpr double gainSmoothingSeconds = 0.020;

    void prepare(double sampleRate) noexcept;
    void reset() noexcept;

    void setGainDb(float gainDb) noexcept;
    float gainDb() const noexcept { return gainDb_.load(std::memory_order_relaxed); }

    void process(float* const* channels, int channelCount, int numSamples) noexcept;
    MasterMeterSnapshot takeMeterSnapshot() noexcept;
    void resetClip() noexcept { clipLatched_.store(false, std::memory_order_release); }

private:
    static void publishMaximum(std::atomic<float>& destination, float value) noexcept;

    std::atomic<float> gainDb_ { 0.0f };
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> smoothedGain_ { 1.0f };

    std::array<std::atomic<float>, 2> peakSinceSnapshot_ { 0.0f, 0.0f };
    std::atomic<float> preGainPeakSinceSnapshot_ { 0.0f };
    std::atomic<float> maximumPeak_ { 0.0f };
    std::atomic<uint64_t> overRangeSinceSnapshot_ { 0 };
    std::atomic<uint64_t> totalOverRangeSamples_ { 0 };
    std::atomic<uint64_t> nonFiniteSinceSnapshot_ { 0 };
    std::atomic<uint64_t> totalNonFiniteSamples_ { 0 };
    std::atomic<bool> clipLatched_ { false };
};

struct AudioBlockStatistics {
    float absolutePeak = 0.0f;
    double rms = 0.0;
    uint64_t overRangeSamples = 0;
    bool finite = true;
};

/** Deterministic diagnostics helper used off the real-time path by tests and
 *  clipping investigations. */
AudioBlockStatistics measureAudioBlock(const juce::AudioBuffer<float>& buffer,
                                       int numSamples) noexcept;

} // namespace mlh
