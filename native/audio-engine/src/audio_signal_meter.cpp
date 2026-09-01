#include "audio_signal_meter.h"

#include <algorithm>
#include <cmath>

namespace mlh {

void AudioSignalMeter::reset() noexcept
{
    for (auto& peak : peakSinceSnapshot_) peak.store(0.0f, std::memory_order_relaxed);
    for (auto& peak : maximumPeak_) peak.store(0.0f, std::memory_order_relaxed);
    maximumObservedPeak_.store(0.0f, std::memory_order_relaxed);
    nonFiniteSinceSnapshot_.store(0, std::memory_order_relaxed);
    totalNonFiniteSamples_.store(0, std::memory_order_relaxed);
}

void AudioSignalMeter::publishMaximum(std::atomic<float>& destination, float value) noexcept
{
    float observed = destination.load(std::memory_order_relaxed);
    while (value > observed
           && !destination.compare_exchange_weak(observed, value,
                                                 std::memory_order_release,
                                                 std::memory_order_relaxed)) {}
}

void AudioSignalMeter::publishObservedPeak(AudioSignalBoundary boundary, float peak,
                                           uint64_t nonFiniteSamples) noexcept
{
    const size_t index = boundary == AudioSignalBoundary::input ? 0u : 1u;
    publishMaximum(peakSinceSnapshot_[index], peak);
    publishMaximum(maximumPeak_[index], peak);
    publishMaximum(maximumObservedPeak_, peak);
    if (nonFiniteSamples > 0)
    {
        nonFiniteSinceSnapshot_.fetch_add(nonFiniteSamples, std::memory_order_relaxed);
        totalNonFiniteSamples_.fetch_add(nonFiniteSamples, std::memory_order_relaxed);
    }
}

void AudioSignalMeter::observe(const juce::AudioBuffer<float>& buffer, int numSamples,
                               AudioSignalBoundary boundary) noexcept
{
    const int count = std::clamp(numSamples, 0, buffer.getNumSamples());
    std::array<const float*, 2> channels { nullptr, nullptr };
    const int channelCount = std::min(2, buffer.getNumChannels());
    for (int channel = 0; channel < channelCount; ++channel)
        channels[static_cast<size_t>(channel)] = buffer.getReadPointer(channel);
    observe(channels.data(), channelCount, count, boundary);
}

void AudioSignalMeter::observe(const float* const* channels, int channelCount,
                               int numSamples, AudioSignalBoundary boundary) noexcept
{
    if (channels == nullptr || channelCount <= 0 || numSamples <= 0)
        return;
    float peak = 0.0f;
    uint64_t nonFinite = 0;
    for (int channel = 0; channel < std::min(2, channelCount); ++channel)
        if (channels[channel] != nullptr)
            for (int sample = 0; sample < numSamples; ++sample)
            {
                const float value = channels[channel][sample];
                if (!std::isfinite(value)) { ++nonFinite; continue; }
                peak = std::max(peak, std::abs(value));
            }
    publishObservedPeak(boundary, peak, nonFinite);
}

AudioSignalTelemetry AudioSignalMeter::takeTelemetrySnapshot() noexcept
{
    AudioSignalTelemetry result;
    result.inputPeak = peakSinceSnapshot_[0].exchange(0.0f, std::memory_order_acq_rel);
    result.outputPeak = peakSinceSnapshot_[1].exchange(0.0f, std::memory_order_acq_rel);
    result.maximumInputPeak = maximumPeak_[0].load(std::memory_order_acquire);
    result.maximumOutputPeak = maximumPeak_[1].load(std::memory_order_acquire);
    result.maximumObservedPeak = maximumObservedPeak_.load(std::memory_order_acquire);
    result.nonFiniteSamples = nonFiniteSinceSnapshot_.exchange(0, std::memory_order_acq_rel);
    result.totalNonFiniteSamples = totalNonFiniteSamples_.load(std::memory_order_acquire);
    return result;
}

} // namespace mlh
