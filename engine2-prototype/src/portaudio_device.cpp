#include "portaudio_device.h"

#include "audio_engine.h"

#include "pa_win_wasapi.h"

#include <algorithm>

namespace engine2 {

std::atomic<PortAudioDevice*> PortAudioDevice::owner_ {nullptr};
std::atomic<int> PortAudioDevice::activeStreams_ {0};

PortAudioDevice::PortAudioDevice(AudioEngine& engine) noexcept : engine_(engine) {}
PortAudioDevice::~PortAudioDevice() { close(); }

bool PortAudioDevice::open(double preferredSampleRate, std::uint32_t preferredFrames,
                           std::string& error) {
    if (stream_) return true;
    PortAudioDevice* expected = nullptr;
    if (!owner_.compare_exchange_strong(expected, this, std::memory_order_acq_rel)) {
        error = "Engine 2 audio-session invariant violated: another owner exists";
        return false;
    }
    ownsSession_ = true;
    auto fail = [&](const std::string& message) {
        error = message;
        close();
        return false;
    };
    auto pa = Pa_Initialize();
    if (pa != paNoError) return fail(std::string("Pa_Initialize: ") + Pa_GetErrorText(pa));
    initialized_ = true;

    const auto wasapiIndex = Pa_HostApiTypeIdToHostApiIndex(paWASAPI);
    if (wasapiIndex < 0) return fail("PortAudio WASAPI host API is unavailable");
    const auto* host = Pa_GetHostApiInfo(wasapiIndex);
    if (!host || host->defaultOutputDevice == paNoDevice)
        return fail("WASAPI has no default output device");
    const auto deviceIndex = host->defaultOutputDevice;
    const auto* device = Pa_GetDeviceInfo(deviceIndex);
    if (!device || device->maxOutputChannels < 2)
        return fail("WASAPI default output is not stereo-capable");

    PaStreamParameters output {};
    output.device = deviceIndex;
    output.channelCount = 2;
    output.sampleFormat = paFloat32;
    output.suggestedLatency = device->defaultLowOutputLatency;
    // No paWinWasapiExclusive flag: this is explicitly WASAPI shared mode.
    PaWasapiStreamInfo wasapi {};
    wasapi.size = sizeof(PaWasapiStreamInfo);
    wasapi.hostApiType = paWASAPI;
    wasapi.version = 1;
    wasapi.flags = paWinWasapiThreadPriority;
    wasapi.threadPriority = eThreadPriorityProAudio;
    output.hostApiSpecificStreamInfo = &wasapi;

    double rate = preferredSampleRate;
    pa = Pa_IsFormatSupported(nullptr, &output, rate);
    if (pa != paFormatIsSupported) {
        rate = device->defaultSampleRate;
        pa = Pa_IsFormatSupported(nullptr, &output, rate);
    }
    if (pa != paFormatIsSupported)
        return fail(std::string("WASAPI stereo format unsupported: ") + Pa_GetErrorText(pa));

    pa = Pa_OpenStream(&stream_, nullptr, &output, rate, preferredFrames, paNoFlag,
                       &PortAudioDevice::callback, this);
    if (pa != paNoError)
        return fail(std::string("Pa_OpenStream: ") + Pa_GetErrorText(pa));

    trace_.deviceName = device->name ? device->name : "unknown";
    trace_.requestedSampleRate = preferredSampleRate;
    trace_.requestedFrames = preferredFrames;
    trace_.activeStreamsAtOpen = activeStreams_.load(std::memory_order_acquire);
    if (const auto* info = Pa_GetStreamInfo(stream_)) {
        trace_.actualSampleRate = info->sampleRate;
        trace_.outputLatencySeconds = info->outputLatency;
    } else {
        trace_.actualSampleRate = rate;
    }
    engine_.configureSampleRate(trace_.actualSampleRate);
    return true;
}

bool PortAudioDevice::start(std::string& error) {
    if (!stream_) { error = "PortAudio stream is not open"; return false; }
    if (running_) return true;
    if (activeStreams_.load(std::memory_order_acquire) != 0) {
        error = "Engine 2 refuses to coexist with another active MiniHub stream";
        return false;
    }
    const auto pa = Pa_StartStream(stream_);
    if (pa != paNoError) {
        error = std::string("Pa_StartStream: ") + Pa_GetErrorText(pa);
        return false;
    }
    activeStreams_.fetch_add(1, std::memory_order_acq_rel);
    running_ = true;
    return true;
}

void PortAudioDevice::stop() noexcept {
    if (!stream_ || !running_) return;
    Pa_StopStream(stream_);
    running_ = false;
    activeStreams_.fetch_sub(1, std::memory_order_acq_rel);
}

void PortAudioDevice::close() noexcept {
    stop();
    if (stream_) {
        Pa_CloseStream(stream_);
        stream_ = nullptr;
    }
    trace_.activeStreamsAtClose = activeStreams_.load(std::memory_order_acquire);
    if (initialized_) {
        Pa_Terminate();
        initialized_ = false;
    }
    if (ownsSession_) {
        PortAudioDevice* expected = this;
        owner_.compare_exchange_strong(expected, nullptr, std::memory_order_acq_rel);
        ownsSession_ = false;
    }
}

int PortAudioDevice::callback(const void*, void* output, unsigned long frames,
                              const PaStreamCallbackTimeInfo*, PaStreamCallbackFlags,
                              void* userData) noexcept {
    auto* self = static_cast<PortAudioDevice*>(userData);
    self->engine_.processRealtime(static_cast<float*>(output),
                                  static_cast<std::uint32_t>(frames));
    return paContinue;
}

int PortAudioDevice::activeStreamCount() noexcept {
    return activeStreams_.load(std::memory_order_acquire);
}

} // namespace engine2
