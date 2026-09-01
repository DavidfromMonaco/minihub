#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <type_traits>
#include <vector>

namespace mlh::engine2 {

constexpr std::size_t kPortAudioOutputChannels = 2;
constexpr std::uint32_t kRealtimeOutputStagingFrames = 4096;
constexpr std::size_t kRealtimeOutputCaptureFrames = 48000;

static_assert(sizeof(float) == 4, "PortAudio paFloat32 requires 32-bit float samples");
static_assert(std::numeric_limits<float>::is_iec559,
              "PortAudio paFloat32 requires IEEE-754 float samples");

struct OutputSampleStats final {
    std::uint64_t nanSamples = 0;
    std::uint64_t positiveInfinitySamples = 0;
    std::uint64_t negativeInfinitySamples = 0;
    float peak = 0.0f;

    [[nodiscard]] std::uint64_t nonFiniteSamples() const noexcept
    {
        return nanSamples + positiveInfinitySamples + negativeInfinitySamples;
    }

    void add(const OutputSampleStats& other) noexcept
    {
        nanSamples += other.nanSamples;
        positiveInfinitySamples += other.positiveInfinitySamples;
        negativeInfinitySamples += other.negativeInfinitySamples;
        peak = std::max(peak, other.peak);
    }
};

/** Preallocated planar staging owned by the one PortAudio endpoint. */
class PlanarOutputStaging final {
public:
    void clear(std::uint32_t frames) noexcept
    {
        const auto bounded = std::min<std::uint32_t>(frames, kRealtimeOutputStagingFrames);
        std::memset(left_.data(), 0, static_cast<std::size_t>(bounded) * sizeof(float));
        std::memset(right_.data(), 0, static_cast<std::size_t>(bounded) * sizeof(float));
    }

    [[nodiscard]] float* left() noexcept { return left_.data(); }
    [[nodiscard]] float* right() noexcept { return right_.data(); }
    [[nodiscard]] const float* left() const noexcept { return left_.data(); }
    [[nodiscard]] const float* right() const noexcept { return right_.data(); }

private:
    std::array<float, kRealtimeOutputStagingFrames> left_ {};
    std::array<float, kRealtimeOutputStagingFrames> right_ {};
};

/** Zero exactly the paFloat32 stereo interleaved destination for this callback. */
inline bool zeroPortAudioStereoOutput(float* output, std::uint64_t frames) noexcept
{
    if (output == nullptr
        || frames > std::numeric_limits<std::size_t>::max()
                        / (kPortAudioOutputChannels * sizeof(float)))
        return false;
    std::memset(output, 0,
                static_cast<std::size_t>(frames) * kPortAudioOutputChannels * sizeof(float));
    return true;
}

/**
 * The only Master -> PortAudio conversion. No gain, clamp or type conversion is
 * performed: planar IEEE float32 L/R is copied to paFloat32 stereo interleaved.
 */
inline OutputSampleStats interleaveMasterToPortAudio(const float* masterLeft,
                                                      const float* masterRight,
                                                      float* output,
                                                      std::uint32_t frames) noexcept
{
    OutputSampleStats stats;
    if (masterLeft == nullptr || masterRight == nullptr || output == nullptr)
        return stats;

    const auto observe = [&stats](float sample) noexcept
    {
        if (std::isnan(sample))
            ++stats.nanSamples;
        else if (std::isinf(sample))
            sample > 0.0f ? ++stats.positiveInfinitySamples
                          : ++stats.negativeInfinitySamples;
        else
            stats.peak = std::max(stats.peak, std::abs(sample));
    };

    for (std::uint32_t frame = 0; frame < frames; ++frame)
    {
        const float left = masterLeft[frame];
        const float right = masterRight[frame];
        observe(left);
        observe(right);
        output[2u * frame] = left;
        output[2u * frame + 1u] = right;
    }
    return stats;
}

/** Callback-safe rolling capture of the exact interleaved samples sent to PA. */
template <std::size_t CapacityFrames>
class StereoInterleavedCapture final {
public:
    void push(const float* interleaved, std::uint64_t frames) noexcept
    {
        if (interleaved == nullptr)
            return;
        for (std::uint64_t frame = 0; frame < frames; ++frame)
        {
            const auto destination = writeFrame_ * kPortAudioOutputChannels;
            samples_[destination] = interleaved[2u * frame];
            samples_[destination + 1u] = interleaved[2u * frame + 1u];
            writeFrame_ = (writeFrame_ + 1u) % CapacityFrames;
            capturedFrames_ = std::min<std::size_t>(capturedFrames_ + 1u, CapacityFrames);
        }
    }

    /** Call only after the producer callback is stopped. */
    [[nodiscard]] std::vector<float> copyChronological() const
    {
        std::vector<float> result(capturedFrames_ * kPortAudioOutputChannels);
        const auto first = capturedFrames_ == CapacityFrames ? writeFrame_ : 0u;
        for (std::size_t frame = 0; frame < capturedFrames_; ++frame)
        {
            const auto sourceFrame = (first + frame) % CapacityFrames;
            result[2u * frame] = samples_[2u * sourceFrame];
            result[2u * frame + 1u] = samples_[2u * sourceFrame + 1u];
        }
        return result;
    }

    [[nodiscard]] std::size_t capturedFrames() const noexcept { return capturedFrames_; }

private:
    std::array<float, CapacityFrames * kPortAudioOutputChannels> samples_ {};
    std::size_t writeFrame_ = 0;
    std::size_t capturedFrames_ = 0;
};

} // namespace mlh::engine2
