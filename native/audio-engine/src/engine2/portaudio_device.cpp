#include "portaudio_device.h"

#include "audio_engine.h"

#include <pa_win_wasapi.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <limits>

namespace mlh::engine2 {

static_assert(kRealtimeOutputStagingFrames == kMaximumBlockSize,
              "PortAudio staging and Engine 2 maximum block size must match");

std::atomic<PortAudioDevice*> PortAudioDevice::owner_ {nullptr};
std::atomic<int> PortAudioDevice::activeStreams_ {0};

namespace {

struct PortAudioScope final {
    bool initialized = false;
    ~PortAudioScope() { if (initialized) Pa_Terminate(); }
};

bool sameName(const char* candidate, const std::string& requested)
{
    return candidate && requested == candidate;
}

template <typename Value>
void publishMaximum(std::atomic<Value>& destination, Value value) noexcept
{
    auto observed = destination.load(std::memory_order_relaxed);
    while (value > observed
           && !destination.compare_exchange_weak(observed, value,
                                                 std::memory_order_release,
                                                 std::memory_order_relaxed)) {}
}

} // namespace

PortAudioDevice::PortAudioDevice(AudioEngine& engine) noexcept : engine_(engine) {}
PortAudioDevice::~PortAudioDevice() { close(); }

std::vector<AudioDeviceDescription> PortAudioDevice::enumerate(std::string& error)
{
    PortAudioScope scope;
    const auto init = Pa_Initialize();
    if (init != paNoError)
    {
        error = std::string("Pa_Initialize: ") + Pa_GetErrorText(init);
        return {};
    }
    scope.initialized = true;
    const auto wasapi = Pa_HostApiTypeIdToHostApiIndex(paWASAPI);
    if (wasapi < 0)
    {
        error = "PortAudio WASAPI host API is unavailable";
        return {};
    }

    std::vector<AudioDeviceDescription> out;
    const auto count = Pa_GetDeviceCount();
    for (PaDeviceIndex index = 0; index < count; ++index)
    {
        const auto* info = Pa_GetDeviceInfo(index);
        if (!info || info->hostApi != wasapi)
            continue;
        AudioDeviceDescription item;
        item.index = index;
        item.name = info->name ? info->name : "unknown";
        item.backend = "WASAPI shared";
        item.isWasapi = true;
        item.hasInput = info->maxInputChannels > 0;
        item.hasOutput = info->maxOutputChannels > 0;
        item.defaultSampleRate = info->defaultSampleRate;
        item.defaultLowInputLatency = info->defaultLowInputLatency;
        item.defaultLowOutputLatency = info->defaultLowOutputLatency;
        out.push_back(std::move(item));
    }
    return out;
}

bool PortAudioDevice::open(const std::string& outputName, double preferredSampleRate,
                           std::uint32_t preferredFrames, bool enableInput,
                           std::string& error)
{
    if (stream_)
        return true;
    if (preferredFrames == 0 || preferredFrames > kMaximumBlockSize)
    {
        error = "Engine 2 buffer size must be between 1 and 4096 frames";
        return false;
    }

    PortAudioDevice* expected = nullptr;
    if (!owner_.compare_exchange_strong(expected, this, std::memory_order_acq_rel))
    {
        error = "Engine 2 audio-session invariant violated: another owner exists";
        return false;
    }
    ownsSession_ = true;
    const auto fail = [&](std::string message)
    {
        error = std::move(message);
        close();
        return false;
    };

    auto pa = Pa_Initialize();
    if (pa != paNoError)
        return fail(std::string("Pa_Initialize: ") + Pa_GetErrorText(pa));
    initialized_ = true;

    const auto wasapiIndex = Pa_HostApiTypeIdToHostApiIndex(paWASAPI);
    if (wasapiIndex < 0)
        return fail("PortAudio WASAPI host API is unavailable");
    const auto* host = Pa_GetHostApiInfo(wasapiIndex);
    if (!host || host->defaultOutputDevice == paNoDevice)
        return fail("WASAPI has no default output device");

    PaDeviceIndex outputIndex = host->defaultOutputDevice;
    if (!outputName.empty())
    {
        outputIndex = paNoDevice;
        const auto deviceCount = Pa_GetDeviceCount();
        for (PaDeviceIndex index = 0; index < deviceCount; ++index)
        {
            const auto* candidate = Pa_GetDeviceInfo(index);
            if (candidate && candidate->hostApi == wasapiIndex
                && candidate->maxOutputChannels >= 2
                && sameName(candidate->name, outputName))
            {
                outputIndex = index;
                break;
            }
        }
        if (outputIndex == paNoDevice)
            return fail("WASAPI output device not found: " + outputName);
    }

    const auto* outputInfo = Pa_GetDeviceInfo(outputIndex);
    if (!outputInfo || outputInfo->maxOutputChannels < 2)
        return fail("WASAPI output device is not stereo-capable");

    PaStreamParameters output {};
    output.device = outputIndex;
    output.channelCount = 2;
    // The hardware boundary is deliberately conventional and explicit:
    // paFloat32, stereo, interleaved LRLR. Engine 2 remains planar internally.
    output.sampleFormat = paFloat32;
    // PortAudio/WASAPI shared dimensions its host buffer as
    // frames + max(frames, suggestedLatency * sampleRate). Left at the device
    // default low latency, a 256-frame block at 48 kHz lands on
    // host == 2 * block, the exact ratio the WASAPI backend documents as
    // glitch-prone ("user frames equal to 1/2 of the host buffer frames").
    // Requesting at least two block periods forces host >= 3 * block and takes
    // the stream out of that ratio without pinning a fixed latency figure.
    const double negotiationRate = preferredSampleRate > 0.0
        ? preferredSampleRate : outputInfo->defaultSampleRate;
    const double blockSeconds = negotiationRate > 0.0
        ? static_cast<double>(preferredFrames) / negotiationRate : 0.0;
    output.suggestedLatency = std::max(outputInfo->defaultLowOutputLatency,
                                       2.0 * blockSeconds);
    PaWasapiStreamInfo outputWasapi {};
    outputWasapi.size = sizeof(PaWasapiStreamInfo);
    outputWasapi.hostApiType = paWASAPI;
    outputWasapi.version = 1;
    outputWasapi.flags = paWinWasapiThreadPriority;
    outputWasapi.threadPriority = eThreadPriorityProAudio;
    output.hostApiSpecificStreamInfo = &outputWasapi;

    PaStreamParameters input {};
    PaWasapiStreamInfo inputWasapi {};
    PaStreamParameters* inputPtr = nullptr;
    // Opened only on demand. See the contract on PortAudioDevice::open.
    const PaDeviceIndex inputIndex = enableInput ? host->defaultInputDevice : paNoDevice;
    const auto* inputInfo = inputIndex != paNoDevice ? Pa_GetDeviceInfo(inputIndex) : nullptr;
    if (inputInfo && inputInfo->maxInputChannels > 0)
    {
        input.device = inputIndex;
        input.channelCount = std::min(2, inputInfo->maxInputChannels);
        input.sampleFormat = paFloat32 | paNonInterleaved;
        input.suggestedLatency = inputInfo->defaultLowInputLatency;
        inputWasapi.size = sizeof(PaWasapiStreamInfo);
        inputWasapi.hostApiType = paWASAPI;
        inputWasapi.version = 1;
        inputWasapi.flags = paWinWasapiThreadPriority;
        inputWasapi.threadPriority = eThreadPriorityProAudio;
        input.hostApiSpecificStreamInfo = &inputWasapi;
        inputPtr = &input;
    }

    double rate = preferredSampleRate;
    pa = Pa_IsFormatSupported(inputPtr, &output, rate);
    if (pa != paFormatIsSupported && inputPtr)
    {
        inputPtr = nullptr;
        pa = Pa_IsFormatSupported(nullptr, &output, rate);
    }
    if (pa != paFormatIsSupported)
    {
        rate = outputInfo->defaultSampleRate;
        pa = Pa_IsFormatSupported(inputPtr, &output, rate);
        if (pa != paFormatIsSupported && inputPtr)
        {
            inputPtr = nullptr;
            pa = Pa_IsFormatSupported(nullptr, &output, rate);
        }
    }
    if (pa != paFormatIsSupported)
        return fail(std::string("WASAPI shared stereo format unsupported: ") + Pa_GetErrorText(pa));

    pa = Pa_OpenStream(&stream_, inputPtr, &output, rate, preferredFrames,
                       paNoFlag, &PortAudioDevice::callback, this);
    if (pa != paNoError)
        return fail(std::string("Pa_OpenStream: ") + Pa_GetErrorText(pa));

    trace_.deviceName = outputInfo->name ? outputInfo->name : "unknown";
    trace_.inputDeviceName = inputPtr && inputInfo && inputInfo->name ? inputInfo->name : "";
    trace_.requestedSampleRate = preferredSampleRate;
    trace_.requestedFrames = preferredFrames;
    trace_.inputActive = inputPtr != nullptr;
    trace_.inputChannels = inputPtr ? input.channelCount : 0;
    trace_.activeStreamsAtOpen = activeStreams_.load(std::memory_order_acquire);
    if (const auto* info = Pa_GetStreamInfo(stream_))
    {
        trace_.actualSampleRate = info->sampleRate;
        trace_.inputLatencySeconds = info->inputLatency;
        trace_.outputLatencySeconds = info->outputLatency;
    }
    else
    {
        trace_.actualSampleRate = rate;
    }

    std::cerr << "[engine2] device=\"" << trace_.deviceName
              << "\" backend=\"" << trace_.backend
              << "\" sampleRate=" << trace_.actualSampleRate
              << " bufferSize=" << trace_.requestedFrames
              << " outputFormat=paFloat32"
              << " outputChannels=2 outputLayout=interleaved"
              << " suggestedLatencyMs=" << (1000.0 * output.suggestedLatency)
              << " inputRequested=" << (enableInput ? 1 : 0)
              << " inputActive=" << (trace_.inputActive ? 1 : 0)
              << " inputDevice=\"" << trace_.inputDeviceName << "\""
              << " activeStreams=" << trace_.activeStreamsAtOpen << std::endl;
    return true;
}

bool PortAudioDevice::start(std::string& error)
{
    if (!stream_)
    {
        error = "PortAudio stream is not open";
        return false;
    }
    if (running_)
        return true;
    if (activeStreams_.load(std::memory_order_acquire) != 0)
    {
        error = "Engine 2 refuses to coexist with another active MiniHub stream";
        return false;
    }
    const auto result = Pa_StartStream(stream_);
    if (result != paNoError)
    {
        error = std::string("Pa_StartStream: ") + Pa_GetErrorText(result);
        return false;
    }
    activeStreams_.fetch_add(1, std::memory_order_acq_rel);
    running_ = true;
    std::cerr << "[engine2] stream-started activeStreams="
              << activeStreams_.load(std::memory_order_acquire) << std::endl;
    return true;
}

void PortAudioDevice::stop() noexcept
{
    if (!stream_ || !running_)
        return;
    Pa_StopStream(stream_);
    running_ = false;
    activeStreams_.fetch_sub(1, std::memory_order_acq_rel);
}

void PortAudioDevice::close() noexcept
{
    stop();
    if (stream_)
    {
        Pa_CloseStream(stream_);
        stream_ = nullptr;
    }
    trace_.activeStreamsAtClose = activeStreams_.load(std::memory_order_acquire);
    if (initialized_)
    {
        Pa_Terminate();
        initialized_ = false;
    }
    if (ownsSession_)
    {
        PortAudioDevice* expected = this;
        owner_.compare_exchange_strong(expected, nullptr, std::memory_order_acq_rel);
        ownsSession_ = false;
    }
}

int PortAudioDevice::callback(const void* input, void* output, unsigned long frames,
                              const PaStreamCallbackTimeInfo*, PaStreamCallbackFlags statusFlags,
                              void* userData) noexcept
{
    auto* self = static_cast<PortAudioDevice*>(userData);
    if (self == nullptr)
        return paAbort;

    const auto callbackStarted = std::chrono::steady_clock::now();
    const auto callbackSequenceId = self->callbacks_.fetch_add(1, std::memory_order_relaxed) + 1u;
    self->lastCallbackSequenceId_.store(callbackSequenceId, std::memory_order_release);
    self->lastCallbackFrames_.store(
        static_cast<std::uint32_t>(std::min<unsigned long>(
            frames, std::numeric_limits<std::uint32_t>::max())),
        std::memory_order_release);
    publishMaximum(self->maximumCallbackFrames_,
                   static_cast<std::uint32_t>(std::min<unsigned long>(
                       frames, std::numeric_limits<std::uint32_t>::max())));

    if ((statusFlags & paOutputUnderflow) != 0)
        self->outputUnderflows_.fetch_add(1, std::memory_order_relaxed);
    if ((statusFlags & paOutputOverflow) != 0)
        self->outputOverflows_.fetch_add(1, std::memory_order_relaxed);
    if ((statusFlags & paInputUnderflow) != 0)
        self->inputUnderflows_.fetch_add(1, std::memory_order_relaxed);
    if ((statusFlags & paInputOverflow) != 0)
        self->inputOverflows_.fetch_add(1, std::memory_order_relaxed);
    if ((statusFlags & paPrimingOutput) != 0)
        self->primingOutputs_.fetch_add(1, std::memory_order_relaxed);
    constexpr PaStreamCallbackFlags knownFlags = paOutputUnderflow | paOutputOverflow
                                                | paInputUnderflow | paInputOverflow
                                                | paPrimingOutput;
    if ((statusFlags & ~knownFlags) != 0)
        self->otherStatusFlags_.fetch_add(1, std::memory_order_relaxed);

    auto* const interleavedOutput = static_cast<float*>(output);
    // This happens before graph processing. Failure or partial graph output
    // therefore remains silence, never memory retained from a prior callback.
    if (!zeroPortAudioStereoOutput(interleavedOutput, frames)
        || frames > std::numeric_limits<std::uint32_t>::max())
        return paAbort;

    const auto* const inputChannels = static_cast<const float* const*>(input);
    OutputSampleStats sampleStats;
    std::uint32_t processed = 0;
    const auto callbackFrames = static_cast<std::uint32_t>(frames);
    while (processed < callbackFrames)
    {
        const auto segment = std::min(kRealtimeOutputStagingFrames,
                                      callbackFrames - processed);
        self->outputStaging_.clear(segment);
        const float* inputSegment[2] {nullptr, nullptr};
        for (int channel = 0; channel < std::min(self->trace_.inputChannels, 2); ++channel)
            if (inputChannels && inputChannels[channel])
                inputSegment[channel] = inputChannels[channel] + processed;
        float* masterChannels[2] {self->outputStaging_.left(), self->outputStaging_.right()};
        self->engine_.processRealtime(inputSegment, self->trace_.inputChannels,
                                      masterChannels, 2, segment,
                                      callbackSequenceId);
        auto* const outputSegment = interleavedOutput
                                    + static_cast<std::size_t>(processed) * 2u;
        sampleStats.add(interleaveMasterToPortAudio(
            self->outputStaging_.left(), self->outputStaging_.right(),
            outputSegment, segment));
        // Preallocated, non-blocking capture at the exact PortAudio write tap.
        self->outputCapture_.push(outputSegment, segment);
        processed += segment;
    }

    self->nanSamples_.fetch_add(sampleStats.nanSamples, std::memory_order_relaxed);
    self->positiveInfinitySamples_.fetch_add(sampleStats.positiveInfinitySamples,
                                             std::memory_order_relaxed);
    self->negativeInfinitySamples_.fetch_add(sampleStats.negativeInfinitySamples,
                                             std::memory_order_relaxed);
    self->lastOutputPeak_.store(sampleStats.peak, std::memory_order_release);
    publishMaximum(self->maximumOutputPeak_, sampleStats.peak);
    self->capturedFrames_.store(
        static_cast<std::uint64_t>(self->outputCapture_.capturedFrames()),
        std::memory_order_release);
    self->outputWrites_.fetch_add(1, std::memory_order_relaxed);
    self->lastOutputWriteSequenceId_.store(callbackSequenceId, std::memory_order_release);

    const auto elapsed = std::chrono::duration<float, std::milli>(
        std::chrono::steady_clock::now() - callbackStarted).count();
    self->lastCallbackMilliseconds_.store(elapsed, std::memory_order_release);
    publishMaximum(self->maximumCallbackMilliseconds_, elapsed);
    const auto deadline = static_cast<float>(1000.0 * static_cast<double>(frames)
                                             / std::max(1.0, self->trace_.actualSampleRate));
    if (elapsed > deadline)
        self->deadlineMisses_.fetch_add(1, std::memory_order_relaxed);
    return paContinue;
}

PortAudioCallbackStats PortAudioDevice::callbackStats() const noexcept
{
    PortAudioCallbackStats result;
    result.callbacks = callbacks_.load(std::memory_order_acquire);
    result.outputWrites = outputWrites_.load(std::memory_order_acquire);
    result.lastCallbackSequenceId = lastCallbackSequenceId_.load(std::memory_order_acquire);
    result.lastOutputWriteSequenceId = lastOutputWriteSequenceId_.load(std::memory_order_acquire);
    result.lastCallbackFrames = lastCallbackFrames_.load(std::memory_order_acquire);
    result.maximumCallbackFrames = maximumCallbackFrames_.load(std::memory_order_acquire);
    result.outputUnderflows = outputUnderflows_.load(std::memory_order_acquire);
    result.outputOverflows = outputOverflows_.load(std::memory_order_acquire);
    result.inputUnderflows = inputUnderflows_.load(std::memory_order_acquire);
    result.inputOverflows = inputOverflows_.load(std::memory_order_acquire);
    result.primingOutputs = primingOutputs_.load(std::memory_order_acquire);
    result.otherStatusFlags = otherStatusFlags_.load(std::memory_order_acquire);
    result.nanSamples = nanSamples_.load(std::memory_order_acquire);
    result.positiveInfinitySamples = positiveInfinitySamples_.load(std::memory_order_acquire);
    result.negativeInfinitySamples = negativeInfinitySamples_.load(std::memory_order_acquire);
    result.deadlineMisses = deadlineMisses_.load(std::memory_order_acquire);
    result.lastCallbackMilliseconds = lastCallbackMilliseconds_.load(std::memory_order_acquire);
    result.maximumCallbackMilliseconds = maximumCallbackMilliseconds_.load(std::memory_order_acquire);
    result.lastOutputPeak = lastOutputPeak_.load(std::memory_order_acquire);
    result.maximumOutputPeak = maximumOutputPeak_.load(std::memory_order_acquire);
    result.capturedFrames = capturedFrames_.load(std::memory_order_acquire);
    return result;
}

int PortAudioDevice::activeStreamCount() noexcept
{
    return activeStreams_.load(std::memory_order_acquire);
}

} // namespace mlh::engine2
