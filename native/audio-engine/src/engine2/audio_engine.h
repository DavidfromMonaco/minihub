#pragma once

#include "../transport.h"
#include "portaudio_device.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace mlh::engine2 {

constexpr std::uint32_t kTargetBlockSize = 256;
constexpr std::uint32_t kMaximumBlockSize = 4096;

struct RealtimeStats final {
    std::uint64_t callbacks = 0;
    std::uint64_t processFailures = 0;
    std::uint64_t audioGraphProcessCalls = 0;
    std::uint64_t masterOutputProcessCalls = 0;
    std::uint64_t outputWrites = 0;
    std::uint32_t maximumCallbackFrames = 0;
    std::uint32_t lastCallbackFrames = 0;
    std::uint64_t callbackSequenceId = 0;
    std::uint64_t audioGraphSequenceId = 0;
    std::uint64_t masterOutputSequenceId = 0;
    std::uint64_t outputWriteSequenceId = 0;
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

/** Sole live audio authority used by MiniHub.
 *
 * Electron's native Engine object is now a control/IPC facade.  This class owns
 * both the one live Transport and the one PortAudioDevice, and is the only
 * object entered by the WASAPI callback.  The render function targets the
 * currently published immutable MiniHub graph; graph construction and plugin
 * lifecycle remain control-thread work.
 */
class AudioEngine final {
public:
    using PrepareCallback = std::function<void(double, int)>;
    using ProcessCallback = std::function<void(const float* const*, int,
                                               float* const*, int, int)>;
    using StopCallback = std::function<void()>;

    AudioEngine(PrepareCallback prepare, ProcessCallback process, StopCallback stopped);
    ~AudioEngine();

    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    bool openDefault(double sampleRate, std::uint32_t frames, bool enableInput,
                     std::string& error);
    bool selectDevice(const std::string& outputName, double sampleRate,
                      std::uint32_t frames, bool enableInput, std::string& error);
    void stop() noexcept;

    /** Whether the live stream currently carries the WASAPI capture endpoint.
     *  Reflects what was actually negotiated, not what was requested. */
    [[nodiscard]] bool inputActive() const noexcept { return device_.trace().inputActive; }

    [[nodiscard]] std::vector<AudioDeviceDescription> devices(std::string& error) const;
    [[nodiscard]] const DeviceTrace& deviceTrace() const noexcept { return device_.trace(); }
    [[nodiscard]] bool running() const noexcept { return device_.isRunning(); }
    [[nodiscard]] int activeStreamCount() const noexcept { return PortAudioDevice::activeStreamCount(); }
    [[nodiscard]] RealtimeStats realtimeStats() const noexcept;

    Transport& transport() noexcept { return transport_; }
    const Transport& transport() const noexcept { return transport_; }

    void configureDevice(double sampleRate, int maximumFrames) noexcept;
    void processRealtime(const float* const* input, int inputChannels,
                         float* const* output, int outputChannels,
                         std::uint32_t frames,
                         std::uint64_t callbackSequenceId) noexcept;

private:
    PrepareCallback prepare_;
    ProcessCallback process_;
    StopCallback stopped_;
    Transport transport_;
    PortAudioDevice device_;
    std::atomic<std::uint64_t> failures_ {0};
    std::atomic<std::uint64_t> audioGraphProcessCalls_ {0};
    std::atomic<std::uint64_t> masterOutputProcessCalls_ {0};
    std::atomic<std::uint64_t> lastAudioGraphSequenceId_ {0};
    std::atomic<std::uint64_t> lastMasterOutputSequenceId_ {0};
    std::atomic<std::uint32_t> maximumProcessFrames_ {kTargetBlockSize};
};

} // namespace mlh::engine2
