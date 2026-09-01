#pragma once

#include "audio_graph.h"

#include <atomic>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace engine2 {

struct RealtimeStats {
    std::uint64_t callbacks {0};
    std::uint64_t processFailures {0};
    std::uint32_t maximumCallbackFrames {0};
    std::uint64_t capturedFrames {0};
};

class AudioEngine final {
public:
    explicit AudioEngine(double sampleRate = kDefaultSampleRate);
    ~AudioEngine();
    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    // Graph construction/prepare happens on the control thread. Publication is
    // one atomic pointer exchange. Retired graphs are reclaimed only when no
    // callback is inside processRealtime().
    AudioGraph* publishGraph(std::unique_ptr<AudioGraph> graph);
    void reclaimRetiredGraphs();
    [[nodiscard]] AudioGraph* activeGraph() const noexcept;
    Transport& transport() noexcept { return transport_; }
    void configureSampleRate(double sampleRate) noexcept;
    [[nodiscard]] double sampleRate() const noexcept { return sampleRate_; }
    void processRealtime(float* interleavedStereo, std::uint32_t frames) noexcept;

    void enableCapture(std::uint64_t frames);
    [[nodiscard]] std::vector<float> takeCapture();
    [[nodiscard]] bool captureComplete() const noexcept;
    [[nodiscard]] RealtimeStats realtimeStats() const noexcept;

private:
    double sampleRate_;
    Transport transport_;
    std::atomic<AudioGraph*> active_ {nullptr};
    std::vector<std::unique_ptr<AudioGraph>> ownedGraphs_;
    std::atomic<std::uint32_t> callbackReaders_ {0};
    std::atomic<std::uint64_t> callbacks_ {0};
    std::atomic<std::uint64_t> failures_ {0};
    std::atomic<std::uint32_t> maxCallbackFrames_ {0};
    std::vector<float> capture_;
    std::atomic<std::uint64_t> captureTargetFrames_ {0};
    std::atomic<std::uint64_t> capturedFrames_ {0};
};

bool renderOffline(AudioGraph& graph, Transport& transport, std::uint64_t frames,
                   std::vector<float>& output, std::string& error);

} // namespace engine2
