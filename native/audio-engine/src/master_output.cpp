#include "master_output.h"

#include <algorithm>
#include <cmath>

namespace mlh {

void MasterOutput::prepare(double sampleRate) noexcept
{
    const double safeRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    const float target = juce::Decibels::decibelsToGain(gainDb());
    smoothedGain_.reset(safeRate, gainSmoothingSeconds);
    smoothedGain_.setCurrentAndTargetValue(target);
    reset();
}

void MasterOutput::reset() noexcept
{
    for (auto& peak : peakSinceSnapshot_) peak.store(0.0f, std::memory_order_relaxed);
    preGainPeakSinceSnapshot_.store(0.0f, std::memory_order_relaxed);
    maximumPeak_.store(0.0f, std::memory_order_relaxed);
    overRangeSinceSnapshot_.store(0, std::memory_order_relaxed);
    totalOverRangeSamples_.store(0, std::memory_order_relaxed);
    nonFiniteSinceSnapshot_.store(0, std::memory_order_relaxed);
    totalNonFiniteSamples_.store(0, std::memory_order_relaxed);
}

void MasterOutput::setGainDb(float gainDb) noexcept
{
    if (std::isfinite(gainDb))
        gainDb_.store(std::clamp(gainDb, -60.0f, 12.0f), std::memory_order_release);
}

void MasterOutput::publishMaximum(std::atomic<float>& destination, float value) noexcept
{
    float observed = destination.load(std::memory_order_relaxed);
    while (value > observed
           && !destination.compare_exchange_weak(observed, value,
                                                 std::memory_order_release,
                                                 std::memory_order_relaxed)) {}
}

void MasterOutput::process(float* const* channels, int channelCount, int numSamples) noexcept
{
    if (channels == nullptr || channelCount <= 0 || numSamples <= 0)
        return;

    const int processedChannels = std::min(2, channelCount);
    smoothedGain_.setTargetValue(juce::Decibels::decibelsToGain(gainDb()));
    float blockPreGainPeak = 0.0f;
    std::array<float, 2> blockPeaks { 0.0f, 0.0f };
    uint64_t blockOverRange = 0;
    uint64_t blockNonFinite = 0;

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float masterGain = smoothedGain_.getNextValue();
        for (int channel = 0; channel < processedChannels; ++channel)
        {
            const float raw = channels[channel] != nullptr ? channels[channel][sample] : 0.0f;
            if (!std::isfinite(raw)) ++blockNonFinite;
            const float finiteInput = std::isfinite(raw) ? raw : 0.0f;
            blockPreGainPeak = std::max(blockPreGainPeak, std::abs(finiteInput));
            const float output = finiteInput * masterGain;
            channels[channel][sample] = std::isfinite(output) ? output : 0.0f;
            if (!std::isfinite(output)) ++blockNonFinite;
            const float magnitude = std::abs(channels[channel][sample]);
            blockPeaks[static_cast<size_t>(channel)] = std::max(
                blockPeaks[static_cast<size_t>(channel)], magnitude);
            if (magnitude >= 1.0f) ++blockOverRange;
        }
        for (int channel = processedChannels; channel < channelCount; ++channel)
            if (channels[channel] != nullptr) channels[channel][sample] = 0.0f;
    }

    publishMaximum(peakSinceSnapshot_[0], blockPeaks[0]);
    publishMaximum(peakSinceSnapshot_[1], processedChannels > 1
        ? blockPeaks[1] : blockPeaks[0]);
    publishMaximum(preGainPeakSinceSnapshot_, blockPreGainPeak);
    publishMaximum(maximumPeak_, std::max(blockPeaks[0], blockPeaks[1]));
    if (blockOverRange > 0)
    {
        clipLatched_.store(true, std::memory_order_release);
        overRangeSinceSnapshot_.fetch_add(blockOverRange, std::memory_order_relaxed);
        totalOverRangeSamples_.fetch_add(blockOverRange, std::memory_order_relaxed);
    }
    if (blockNonFinite > 0)
    {
        nonFiniteSinceSnapshot_.fetch_add(blockNonFinite, std::memory_order_relaxed);
        totalNonFiniteSamples_.fetch_add(blockNonFinite, std::memory_order_relaxed);
    }
}

MasterMeterSnapshot MasterOutput::takeMeterSnapshot() noexcept
{
    MasterMeterSnapshot result;
    result.peakLeft = peakSinceSnapshot_[0].exchange(0.0f, std::memory_order_acq_rel);
    result.peakRight = peakSinceSnapshot_[1].exchange(0.0f, std::memory_order_acq_rel);
    result.preGainPeak = preGainPeakSinceSnapshot_.exchange(0.0f, std::memory_order_acq_rel);
    result.maximumPeak = maximumPeak_.load(std::memory_order_acquire);
    result.overRangeSamples = overRangeSinceSnapshot_.exchange(0, std::memory_order_acq_rel);
    result.totalOverRangeSamples = totalOverRangeSamples_.load(std::memory_order_acquire);
    result.nonFiniteSamples = nonFiniteSinceSnapshot_.exchange(0, std::memory_order_acq_rel);
    result.totalNonFiniteSamples = totalNonFiniteSamples_.load(std::memory_order_acquire);
    result.clipLatched = clipLatched_.load(std::memory_order_acquire);
    return result;
}

AudioBlockStatistics measureAudioBlock(const juce::AudioBuffer<float>& buffer,
                                       int numSamples) noexcept
{
    AudioBlockStatistics result;
    const int count = std::clamp(numSamples, 0, buffer.getNumSamples());
    long double sumSquares = 0.0;
    uint64_t measuredSamples = 0;
    for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        for (int sample = 0; sample < count; ++sample)
        {
            const float value = buffer.getSample(channel, sample);
            if (!std::isfinite(value)) { result.finite = false; continue; }
            const float magnitude = std::abs(value);
            result.absolutePeak = std::max(result.absolutePeak, magnitude);
            if (magnitude > 1.0f) ++result.overRangeSamples;
            sumSquares += static_cast<long double>(value) * value;
            ++measuredSamples;
        }
    result.rms = measuredSamples > 0
        ? std::sqrt(static_cast<double>(sumSquares / measuredSamples)) : 0.0;
    return result;
}

} // namespace mlh
