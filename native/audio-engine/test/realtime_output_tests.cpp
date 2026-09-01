#include "engine2/realtime_output_buffer.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {

constexpr double kSampleRate = 48000.0;
constexpr std::uint32_t kTestFrames = 48000;
constexpr double kTwoPi = 6.283185307179586476925286766559;
int failures = 0;
int checks = 0;

void expect(bool condition, const std::string& message)
{
    ++checks;
    if (condition)
        return;
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
}

float dbToAmplitude(double db)
{
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

struct SimulationResult final {
    std::vector<float> interleaved;
    mlh::engine2::OutputSampleStats sampleStats;
    double maximumError = 0.0;
    double maximumCallbackMilliseconds = 0.0;
    std::uint64_t callbacks = 0;
};

SimulationResult simulate(const std::vector<std::uint32_t>& callbackPattern,
                          float amplitude)
{
    using namespace mlh::engine2;
    PlanarOutputStaging staging;
    StereoInterleavedCapture<kTestFrames> capture;
    SimulationResult result;
    result.interleaved.reserve(static_cast<std::size_t>(kTestFrames) * 2u);

    std::uint32_t rendered = 0;
    std::size_t patternIndex = 0;
    while (rendered < kTestFrames)
    {
        const auto requested = callbackPattern[patternIndex++ % callbackPattern.size()];
        const auto frames = std::min(requested, kTestFrames - rendered);
        constexpr float guard = 12345.25f;
        constexpr float stale = -9876.5f;
        std::vector<float> guarded(static_cast<std::size_t>(frames) * 2u + 4u, stale);
        guarded[0] = guarded[1] = guarded[guarded.size() - 2u] = guarded.back() = guard;
        auto* const portAudioOutput = guarded.data() + 2u;

        const auto started = std::chrono::steady_clock::now();
        expect(zeroPortAudioStereoOutput(portAudioOutput, frames),
               "stereo PortAudio destination accepts the exact callback size");
        expect(std::all_of(portAudioOutput, portAudioOutput + static_cast<std::size_t>(frames) * 2u,
                           [](float value) { return value == 0.0f; }),
               "every destination sample is zero before Master is copied");

        staging.clear(frames);
        for (std::uint32_t frame = 0; frame < frames; ++frame)
        {
            const auto absolute = static_cast<double>(rendered + frame);
            staging.left()[frame] = amplitude * static_cast<float>(
                std::sin(kTwoPi * 440.0 * absolute / kSampleRate));
            staging.right()[frame] = amplitude * static_cast<float>(
                std::sin(kTwoPi * 880.0 * absolute / kSampleRate));
        }
        const auto stats = interleaveMasterToPortAudio(
            staging.left(), staging.right(), portAudioOutput, frames);
        result.sampleStats.add(stats);
        capture.push(portAudioOutput, frames);

        for (std::uint32_t frame = 0; frame < frames; ++frame)
        {
            const auto absolute = static_cast<double>(rendered + frame);
            const float expectedLeft = amplitude * static_cast<float>(
                std::sin(kTwoPi * 440.0 * absolute / kSampleRate));
            const float expectedRight = amplitude * static_cast<float>(
                std::sin(kTwoPi * 880.0 * absolute / kSampleRate));
            result.maximumError = std::max(result.maximumError,
                static_cast<double>(std::abs(portAudioOutput[2u * frame] - expectedLeft)));
            result.maximumError = std::max(result.maximumError,
                static_cast<double>(std::abs(portAudioOutput[2u * frame + 1u] - expectedRight)));
        }
        expect(guarded[0] == guard && guarded[1] == guard
                   && guarded[guarded.size() - 2u] == guard && guarded.back() == guard,
               "interleaving preserves both before/after output sentinels");

        result.interleaved.insert(result.interleaved.end(), portAudioOutput,
                                  portAudioOutput + static_cast<std::size_t>(frames) * 2u);
        const auto elapsed = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - started).count();
        result.maximumCallbackMilliseconds = std::max(result.maximumCallbackMilliseconds,
                                                       elapsed);
        ++result.callbacks;
        rendered += frames;
    }

    expect(capture.copyChronological() == result.interleaved,
           "preallocated capture is sample-identical to the PortAudio write tap");
    return result;
}

double componentAmplitude(const std::vector<float>& interleaved, int channel,
                          double frequency)
{
    long double sine = 0.0;
    long double cosine = 0.0;
    const auto frames = interleaved.size() / 2u;
    for (std::size_t frame = 0; frame < frames; ++frame)
    {
        const double phase = kTwoPi * frequency * static_cast<double>(frame) / kSampleRate;
        const double sample = interleaved[2u * frame + static_cast<std::size_t>(channel)];
        sine += sample * std::sin(phase);
        cosine += sample * std::cos(phase);
    }
    return 2.0 * std::sqrt(static_cast<double>(sine * sine + cosine * cosine))
           / static_cast<double>(frames);
}

template <typename Value>
void writeLittleEndian(std::ofstream& stream, Value value)
{
    stream.write(reinterpret_cast<const char*>(&value), sizeof(value));
}

bool writeFloat32Wav(const std::filesystem::path& path,
                     const std::vector<float>& interleaved)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream)
        return false;
    const std::uint16_t format = 3; // WAVE_FORMAT_IEEE_FLOAT
    const std::uint16_t channels = 2;
    const std::uint32_t sampleRate = static_cast<std::uint32_t>(kSampleRate);
    const std::uint16_t bits = 32;
    const std::uint16_t blockAlign = channels * bits / 8u;
    const std::uint32_t bytesPerSecond = sampleRate * blockAlign;
    const auto dataBytes = static_cast<std::uint32_t>(interleaved.size() * sizeof(float));
    const std::uint32_t riffBytes = 36u + dataBytes;
    stream.write("RIFF", 4); writeLittleEndian(stream, riffBytes); stream.write("WAVE", 4);
    stream.write("fmt ", 4); writeLittleEndian(stream, std::uint32_t {16});
    writeLittleEndian(stream, format); writeLittleEndian(stream, channels);
    writeLittleEndian(stream, sampleRate); writeLittleEndian(stream, bytesPerSecond);
    writeLittleEndian(stream, blockAlign); writeLittleEndian(stream, bits);
    stream.write("data", 4); writeLittleEndian(stream, dataBytes);
    stream.write(reinterpret_cast<const char*>(interleaved.data()), dataBytes);
    return static_cast<bool>(stream);
}

void testNonFiniteDetection()
{
    using namespace mlh::engine2;
    const std::array<float, 4> left {
        std::numeric_limits<float>::quiet_NaN(),
        std::numeric_limits<float>::infinity(),
        -std::numeric_limits<float>::infinity(), 0.25f};
    const std::array<float, 4> right {0.0f, -0.25f, 0.5f, -0.5f};
    std::array<float, 8> output {};
    const auto stats = interleaveMasterToPortAudio(left.data(), right.data(),
                                                   output.data(), 4);
    expect(stats.nanSamples == 1 && stats.positiveInfinitySamples == 1
               && stats.negativeInfinitySamples == 1 && stats.nonFiniteSamples() == 3,
           "NaN, +Inf and -Inf are counted separately at the final copy");
    expect(std::isnan(output[0]) && std::isinf(output[2]) && output[2] > 0.0f
               && std::isinf(output[4]) && output[4] < 0.0f,
           "non-finite corruption is observed without a masking clamp");
}

void testStaleSampleErasure()
{
    using namespace mlh::engine2;
    PlanarOutputStaging staging;
    std::array<float, 256> output;
    output.fill(0.875f);
    expect(zeroPortAudioStereoOutput(output.data(), 128),
           "stale-output test can zero one exact callback");
    staging.clear(128);
    for (std::uint32_t frame = 0; frame < 17; ++frame)
    {
        staging.left()[frame] = 0.1f;
        staging.right()[frame] = -0.1f;
    }
    interleaveMasterToPortAudio(staging.left(), staging.right(), output.data(), 128);
    expect(std::all_of(output.begin() + 34, output.end(),
                       [](float value) { return value == 0.0f; }),
           "unwritten planar frames become zero, never previous-callback samples");
}

void testCaptureWrap()
{
    using namespace mlh::engine2;
    StereoInterleavedCapture<5> capture;
    std::array<float, 14> source {};
    for (std::size_t frame = 0; frame < 7; ++frame)
    {
        source[2u * frame] = static_cast<float>(frame);
        source[2u * frame + 1u] = -static_cast<float>(frame);
    }
    capture.push(source.data(), 3);
    capture.push(source.data() + 6, 4);
    const auto copied = capture.copyChronological();
    expect(copied.size() == 10u && copied[0] == 2.0f && copied[1] == -2.0f
               && copied[8] == 6.0f && copied[9] == -6.0f,
           "circular capture retains the newest exact interleaved frames in order");
}

} // namespace

int main(int argc, char** argv)
{
    using namespace mlh::engine2;
    expect(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559,
           "sample type is IEEE float32");
    testStaleSampleErasure();
    testNonFiniteDetection();
    testCaptureWrap();

    const std::array<std::uint32_t, 4> fixedSizes {128, 256, 512, 1024};
    std::vector<float> captureForArtifact;
    for (const auto size : fixedSizes)
    {
        const auto result = simulate({size}, dbToAmplitude(-18.0));
        const auto left440 = componentAmplitude(result.interleaved, 0, 440.0);
        const auto left880 = componentAmplitude(result.interleaved, 0, 880.0);
        const auto right440 = componentAmplitude(result.interleaved, 1, 440.0);
        const auto right880 = componentAmplitude(result.interleaved, 1, 880.0);
        expect(result.maximumError == 0.0 && result.sampleStats.nonFiniteSamples() == 0,
               "continuous -18 dBFS sine is copied sample-exactly and remains finite");
        expect(std::abs(left440 - dbToAmplitude(-18.0)) < 1.0e-6
                   && left880 < 1.0e-7 && right440 < 1.0e-7
                   && std::abs(right880 - dbToAmplitude(-18.0)) < 1.0e-6,
               "left contains only 440 Hz and right contains only 880 Hz");
        std::cout << "buffer=" << size << " callbacks=" << result.callbacks
                  << " maxCallbackMs=" << result.maximumCallbackMilliseconds
                  << " peak=" << result.sampleStats.peak
                  << " nonFinite=" << result.sampleStats.nonFiniteSamples()
                  << " maxError=" << result.maximumError << '\n';
        if (size == 256)
            captureForArtifact = result.interleaved;
    }

    const auto variable = simulate({63, 128, 257, 511, 1024, 193}, dbToAmplitude(-6.0));
    expect(variable.maximumError == 0.0 && variable.sampleStats.nonFiniteSamples() == 0,
           "actual callback frame counts, including non-preference sizes, remain exact");
    expect(std::abs(variable.sampleStats.peak - dbToAmplitude(-6.0)) < 1.0e-4,
           "-6 dBFS Master peak reaches the PortAudio copy unchanged");
    std::cout << "variable callbacks=" << variable.callbacks
              << " maxCallbackMs=" << variable.maximumCallbackMilliseconds
              << " peak=" << variable.sampleStats.peak
              << " nonFinite=" << variable.sampleStats.nonFiniteSamples()
              << " maxError=" << variable.maximumError << '\n';

    if (argc > 1)
    {
        const std::filesystem::path artifact = std::filesystem::u8path(argv[1]);
        expect(writeFloat32Wav(artifact, captureForArtifact),
               "exact PortAudio interleaved capture writes outside the callback");
        if (failures == 0)
            std::cout << "capture=" << artifact.u8string() << '\n';
    }

    if (failures == 0)
        std::cout << "realtime output buffer tests passed (" << checks << " checks)\n";
    return failures == 0 ? 0 : 1;
}
