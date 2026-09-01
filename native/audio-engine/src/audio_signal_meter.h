#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <atomic>
#include <cstdint>

namespace mlh {

enum class AudioSignalBoundary { input, output };

/** Passive lock-free telemetry for a floating-point audio boundary.
 * This class never writes to the observed buffer. Peaks above 1.0 are
 * deliberately reported unchanged; there is no detector envelope, ceiling,
 * clamp, normalisation, or gain-reduction state.
 */
struct AudioSignalTelemetry {
    float inputPeak = 0.0f;
    float outputPeak = 0.0f;
    float maximumInputPeak = 0.0f;
    float maximumOutputPeak = 0.0f;
    float maximumObservedPeak = 0.0f;
    uint64_t nonFiniteSamples = 0;
    uint64_t totalNonFiniteSamples = 0;
};

class AudioSignalMeter {
public:
    void prepare(double) noexcept { reset(); }
    void reset() noexcept;
    void observe(const juce::AudioBuffer<float>& buffer, int numSamples,
                 AudioSignalBoundary boundary) noexcept;
    void observe(const float* const* channels, int channelCount, int numSamples,
                 AudioSignalBoundary boundary) noexcept;
    AudioSignalTelemetry takeTelemetrySnapshot() noexcept;

private:
    static void publishMaximum(std::atomic<float>& destination, float value) noexcept;
    void publishObservedPeak(AudioSignalBoundary boundary, float peak,
                             uint64_t nonFiniteSamples) noexcept;

    std::array<std::atomic<float>, 2> peakSinceSnapshot_ { 0.0f, 0.0f };
    std::array<std::atomic<float>, 2> maximumPeak_ { 0.0f, 0.0f };
    std::atomic<float> maximumObservedPeak_ { 0.0f };
    std::atomic<uint64_t> nonFiniteSinceSnapshot_ { 0 };
    std::atomic<uint64_t> totalNonFiniteSamples_ { 0 };
};

} // namespace mlh
