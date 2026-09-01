#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include "portaudio.h"

namespace engine2 {

class AudioEngine;

struct DeviceTrace {
    std::string deviceName;
    double requestedSampleRate {0.0};
    double actualSampleRate {0.0};
    std::uint32_t requestedFrames {0};
    double outputLatencySeconds {0.0};
    int activeStreamsAtOpen {0};
    int activeStreamsAtClose {0};
};

class PortAudioDevice final {
public:
    explicit PortAudioDevice(AudioEngine& engine) noexcept;
    ~PortAudioDevice();
    PortAudioDevice(const PortAudioDevice&) = delete;
    PortAudioDevice& operator=(const PortAudioDevice&) = delete;

    bool open(double preferredSampleRate, std::uint32_t preferredFrames, std::string& error);
    bool start(std::string& error);
    void stop() noexcept;
    void close() noexcept;
    [[nodiscard]] bool isOpen() const noexcept { return stream_ != nullptr; }
    [[nodiscard]] bool isRunning() const noexcept { return running_; }
    [[nodiscard]] const DeviceTrace& trace() const noexcept { return trace_; }
    [[nodiscard]] static int activeStreamCount() noexcept;

private:
    static int callback(const void*, void* output, unsigned long frames,
                        const PaStreamCallbackTimeInfo*, PaStreamCallbackFlags, void* userData) noexcept;

    AudioEngine& engine_;
    PaStream* stream_ {nullptr};
    bool initialized_ {false};
    bool ownsSession_ {false};
    bool running_ {false};
    DeviceTrace trace_;
    static std::atomic<PortAudioDevice*> owner_;
    static std::atomic<int> activeStreams_;
};

} // namespace engine2

