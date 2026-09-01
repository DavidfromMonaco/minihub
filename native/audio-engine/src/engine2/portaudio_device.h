#pragma once

#include "realtime_output_buffer.h"

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include <portaudio.h>

namespace mlh::engine2 {

class AudioEngine;

struct AudioDeviceDescription final {
    int index = paNoDevice;
    std::string name;
    std::string backend;
    bool isWasapi = false;
    bool hasInput = false;
    bool hasOutput = false;
    double defaultSampleRate = 0.0;
    double defaultLowInputLatency = 0.0;
    double defaultLowOutputLatency = 0.0;
};

struct DeviceTrace final {
    std::string deviceName;
    std::string inputDeviceName;
    std::string backend {"WASAPI shared"};
    double requestedSampleRate = 0.0;
    double actualSampleRate = 0.0;
    std::uint32_t requestedFrames = 0;
    double inputLatencySeconds = 0.0;
    double outputLatencySeconds = 0.0;
    bool inputActive = false;
    int inputChannels = 0;
    int activeStreamsAtOpen = 0;
    int activeStreamsAtClose = 0;
    int outputChannels = 2;
    std::uint32_t outputSampleBytes = sizeof(float);
    bool outputFloat32 = true;
    bool outputInterleaved = true;
};

struct PortAudioCallbackStats final {
    std::uint64_t callbacks = 0;
    std::uint64_t outputWrites = 0;
    std::uint64_t lastCallbackSequenceId = 0;
    std::uint64_t lastOutputWriteSequenceId = 0;
    std::uint32_t lastCallbackFrames = 0;
    std::uint32_t maximumCallbackFrames = 0;
    std::uint64_t outputUnderflows = 0;
    std::uint64_t outputOverflows = 0;
    std::uint64_t inputUnderflows = 0;
    std::uint64_t inputOverflows = 0;
    std::uint64_t primingOutputs = 0;
    std::uint64_t otherStatusFlags = 0;
    std::uint64_t nanSamples = 0;
    std::uint64_t positiveInfinitySamples = 0;
    std::uint64_t negativeInfinitySamples = 0;
    std::uint64_t deadlineMisses = 0;
    float lastCallbackMilliseconds = 0.0f;
    float maximumCallbackMilliseconds = 0.0f;
    float lastOutputPeak = 0.0f;
    float maximumOutputPeak = 0.0f;
    std::uint64_t capturedFrames = 0;
};

/** The process-wide PortAudio/WASAPI endpoint.
 *
 * The static owner gate is acquired before Pa_Initialize(), so MiniHub cannot
 * accidentally create a second host-owned stream.  The stream is always
 * shared-mode WASAPI. The output contract is explicitly paFloat32 stereo
 * interleaved; Engine 2's planar Master L/R is staged in preallocated storage
 * and copied exactly once into the PortAudio destination.
 */
class PortAudioDevice final {
public:
    explicit PortAudioDevice(AudioEngine& engine) noexcept;
    ~PortAudioDevice();

    PortAudioDevice(const PortAudioDevice&) = delete;
    PortAudioDevice& operator=(const PortAudioDevice&) = delete;

    static std::vector<AudioDeviceDescription> enumerate(std::string& error);
    /** `enableInput` opens the WASAPI default capture endpoint in the same
     *  duplex stream. It must stay false unless the live graph actually owns an
     *  `audio-input` node: the capture default is frequently a USB codec while
     *  the render endpoint is the onboard one, and aggregating two independent
     *  word clocks into one stream drifts and drops samples periodically. */
    bool open(const std::string& outputName, double preferredSampleRate,
              std::uint32_t preferredFrames, bool enableInput, std::string& error);
    bool start(std::string& error);
    void stop() noexcept;
    void close() noexcept;

    [[nodiscard]] bool isOpen() const noexcept { return stream_ != nullptr; }
    [[nodiscard]] bool isRunning() const noexcept { return running_; }
    [[nodiscard]] const DeviceTrace& trace() const noexcept { return trace_; }
    [[nodiscard]] PortAudioCallbackStats callbackStats() const noexcept;
    [[nodiscard]] static int activeStreamCount() noexcept;

private:
    static int callback(const void* input, void* output, unsigned long frames,
                        const PaStreamCallbackTimeInfo*, PaStreamCallbackFlags,
                        void* userData) noexcept;

    AudioEngine& engine_;
    PaStream* stream_ = nullptr;
    bool initialized_ = false;
    bool ownsSession_ = false;
    bool running_ = false;
    DeviceTrace trace_;
    PlanarOutputStaging outputStaging_;
    StereoInterleavedCapture<kRealtimeOutputCaptureFrames> outputCapture_;

    std::atomic<std::uint64_t> callbacks_ {0};
    std::atomic<std::uint64_t> outputWrites_ {0};
    std::atomic<std::uint64_t> lastCallbackSequenceId_ {0};
    std::atomic<std::uint64_t> lastOutputWriteSequenceId_ {0};
    std::atomic<std::uint32_t> lastCallbackFrames_ {0};
    std::atomic<std::uint32_t> maximumCallbackFrames_ {0};
    std::atomic<std::uint64_t> outputUnderflows_ {0};
    std::atomic<std::uint64_t> outputOverflows_ {0};
    std::atomic<std::uint64_t> inputUnderflows_ {0};
    std::atomic<std::uint64_t> inputOverflows_ {0};
    std::atomic<std::uint64_t> primingOutputs_ {0};
    std::atomic<std::uint64_t> otherStatusFlags_ {0};
    std::atomic<std::uint64_t> nanSamples_ {0};
    std::atomic<std::uint64_t> positiveInfinitySamples_ {0};
    std::atomic<std::uint64_t> negativeInfinitySamples_ {0};
    std::atomic<std::uint64_t> deadlineMisses_ {0};
    std::atomic<float> lastCallbackMilliseconds_ {0.0f};
    std::atomic<float> maximumCallbackMilliseconds_ {0.0f};
    std::atomic<float> lastOutputPeak_ {0.0f};
    std::atomic<float> maximumOutputPeak_ {0.0f};
    std::atomic<std::uint64_t> capturedFrames_ {0};

    static std::atomic<PortAudioDevice*> owner_;
    static std::atomic<int> activeStreams_;
};

} // namespace mlh::engine2
