#include "audio_engine.h"

#include <algorithm>

namespace mlh::engine2 {

AudioEngine::AudioEngine(PrepareCallback prepare, ProcessCallback process,
                         StopCallback stopped)
    : prepare_(std::move(prepare)), process_(std::move(process)),
      stopped_(std::move(stopped)), device_(*this)
{
}

AudioEngine::~AudioEngine()
{
    stop();
}

bool AudioEngine::openDefault(double sampleRate, std::uint32_t frames, std::string& error)
{
    return selectDevice({}, sampleRate, frames, error);
}

bool AudioEngine::selectDevice(const std::string& outputName, double sampleRate,
                               std::uint32_t frames, std::string& error)
{
    stop();
    if (!device_.open(outputName, sampleRate, frames, error))
        return false;
    const auto& trace = device_.trace();
    configureDevice(trace.actualSampleRate, static_cast<int>(frames));
    if (prepare_)
        prepare_(trace.actualSampleRate, static_cast<int>(frames));
    if (!device_.start(error))
    {
        device_.close();
        return false;
    }
    return true;
}

void AudioEngine::stop() noexcept
{
    const bool wasOpen = device_.isOpen();
    device_.close();
    if (wasOpen && stopped_)
        stopped_();
}

std::vector<AudioDeviceDescription> AudioEngine::devices(std::string& error) const
{
    return PortAudioDevice::enumerate(error);
}

RealtimeStats AudioEngine::realtimeStats() const noexcept
{
    const auto portAudio = device_.callbackStats();
    RealtimeStats result;
    result.callbacks = portAudio.callbacks;
    result.processFailures = failures_.load(std::memory_order_acquire);
    result.audioGraphProcessCalls = audioGraphProcessCalls_.load(std::memory_order_acquire);
    result.masterOutputProcessCalls = masterOutputProcessCalls_.load(std::memory_order_acquire);
    result.outputWrites = portAudio.outputWrites;
    result.maximumCallbackFrames = portAudio.maximumCallbackFrames;
    result.lastCallbackFrames = portAudio.lastCallbackFrames;
    result.callbackSequenceId = portAudio.lastCallbackSequenceId;
    result.audioGraphSequenceId = lastAudioGraphSequenceId_.load(std::memory_order_acquire);
    result.masterOutputSequenceId = lastMasterOutputSequenceId_.load(std::memory_order_acquire);
    result.outputWriteSequenceId = portAudio.lastOutputWriteSequenceId;
    result.outputUnderflows = portAudio.outputUnderflows;
    result.outputOverflows = portAudio.outputOverflows;
    result.inputUnderflows = portAudio.inputUnderflows;
    result.inputOverflows = portAudio.inputOverflows;
    result.primingOutputs = portAudio.primingOutputs;
    result.otherStatusFlags = portAudio.otherStatusFlags;
    result.nanSamples = portAudio.nanSamples;
    result.positiveInfinitySamples = portAudio.positiveInfinitySamples;
    result.negativeInfinitySamples = portAudio.negativeInfinitySamples;
    result.deadlineMisses = portAudio.deadlineMisses;
    result.lastCallbackMilliseconds = portAudio.lastCallbackMilliseconds;
    result.maximumCallbackMilliseconds = portAudio.maximumCallbackMilliseconds;
    result.lastOutputPeak = portAudio.lastOutputPeak;
    result.maximumOutputPeak = portAudio.maximumOutputPeak;
    result.capturedFrames = portAudio.capturedFrames;
    return result;
}

void AudioEngine::configureDevice(double sampleRate, int maximumFrames) noexcept
{
    transport_.setSampleRate(sampleRate);
    maximumProcessFrames_.store(
        static_cast<std::uint32_t>(std::clamp(maximumFrames, 1,
                                              static_cast<int>(kMaximumBlockSize))),
        std::memory_order_release);
}

void AudioEngine::processRealtime(const float* const* input, int inputChannels,
                                  float* const* output, int outputChannels,
                                  std::uint32_t frames,
                                  std::uint64_t callbackSequenceId) noexcept
{
    if (!process_ || !output || outputChannels < 1)
    {
        failures_.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    // PortAudio owns callback framing. If a backend supplies more frames than
    // the configured DSP capacity, process contiguous prepared-size segments;
    // every sample in the actual callback is still consumed exactly once.
    const auto maximumProcessFrames = maximumProcessFrames_.load(std::memory_order_acquire);
    std::uint32_t processed = 0;
    while (processed < frames)
    {
        const auto segment = std::min(maximumProcessFrames, frames - processed);
        const float* inputSegment[2] {nullptr, nullptr};
        float* outputSegment[2] {nullptr, nullptr};
        for (int channel = 0; channel < std::min(inputChannels, 2); ++channel)
            if (input && input[channel]) inputSegment[channel] = input[channel] + processed;
        for (int channel = 0; channel < std::min(outputChannels, 2); ++channel)
            if (output[channel]) outputSegment[channel] = output[channel] + processed;
        audioGraphProcessCalls_.fetch_add(1, std::memory_order_relaxed);
        lastAudioGraphSequenceId_.store(callbackSequenceId, std::memory_order_release);
        process_(inputSegment, std::min(inputChannels, 2), outputSegment,
                 std::min(outputChannels, 2), static_cast<int>(segment));
        masterOutputProcessCalls_.fetch_add(1, std::memory_order_relaxed);
        lastMasterOutputSequenceId_.store(callbackSequenceId, std::memory_order_release);
        processed += segment;
    }
}

} // namespace mlh::engine2
