#include "audio_engine.h"

#include <algorithm>
#include <cstring>
#include <thread>

namespace engine2 {

AudioEngine::AudioEngine(double sampleRate)
    : sampleRate_(sampleRate), transport_(sampleRate) {}

AudioEngine::~AudioEngine() {
    active_.store(nullptr, std::memory_order_seq_cst);
    while (callbackReaders_.load(std::memory_order_seq_cst) != 0)
        std::this_thread::yield();
    ownedGraphs_.clear();
}

void AudioEngine::configureSampleRate(double sampleRate) noexcept {
    if (callbackReaders_.load(std::memory_order_acquire) != 0 || sampleRate <= 0.0) return;
    sampleRate_ = sampleRate;
    transport_.setSampleRate(sampleRate);
}

AudioGraph* AudioEngine::publishGraph(std::unique_ptr<AudioGraph> graph) {
    if (!graph) return nullptr;
    auto* raw = graph.get();
    ownedGraphs_.push_back(std::move(graph));
    active_.store(raw, std::memory_order_seq_cst);
    return raw;
}

void AudioEngine::reclaimRetiredGraphs() {
    if (callbackReaders_.load(std::memory_order_seq_cst) != 0) return;
    auto* keep = active_.load(std::memory_order_seq_cst);
    ownedGraphs_.erase(
        std::remove_if(ownedGraphs_.begin(), ownedGraphs_.end(),
                       [keep](const auto& graph) { return graph.get() != keep; }),
        ownedGraphs_.end());
}

AudioGraph* AudioEngine::activeGraph() const noexcept {
    return active_.load(std::memory_order_acquire);
}

void AudioEngine::processRealtime(float* output, std::uint32_t frames) noexcept {
    callbackReaders_.fetch_add(1, std::memory_order_seq_cst);
    auto* graph = active_.load(std::memory_order_seq_cst);
    callbacks_.fetch_add(1, std::memory_order_relaxed);
    auto observed = maxCallbackFrames_.load(std::memory_order_relaxed);
    while (observed < frames &&
           !maxCallbackFrames_.compare_exchange_weak(observed, frames,
                                                     std::memory_order_relaxed)) {}

    bool ok = graph != nullptr;
    std::uint32_t offset = 0;
    while (ok && offset < frames) {
        const auto count = std::min<std::uint32_t>(kMaxBlockSize, frames - offset);
        ok = graph->processBlock(output + static_cast<std::size_t>(offset) * 2,
                                 count, transport_);
        offset += count;
    }
    if (!ok) {
        std::fill_n(output, static_cast<std::size_t>(frames) * 2, 0.0F);
        failures_.fetch_add(1, std::memory_order_relaxed);
    }

    const auto target = captureTargetFrames_.load(std::memory_order_acquire);
    if (target != 0) {
        const auto written = capturedFrames_.load(std::memory_order_relaxed);
        if (written < target) {
            const auto copyFrames = std::min<std::uint64_t>(frames, target - written);
            std::memcpy(capture_.data() + written * 2, output,
                        static_cast<std::size_t>(copyFrames) * 2 * sizeof(float));
            capturedFrames_.store(written + copyFrames, std::memory_order_release);
        }
    }
    callbackReaders_.fetch_sub(1, std::memory_order_seq_cst);
}

void AudioEngine::enableCapture(std::uint64_t frames) {
    captureTargetFrames_.store(0, std::memory_order_release);
    capturedFrames_.store(0, std::memory_order_release);
    capture_.assign(static_cast<std::size_t>(frames) * 2, 0.0F);
    captureTargetFrames_.store(frames, std::memory_order_release);
}

std::vector<float> AudioEngine::takeCapture() {
    captureTargetFrames_.store(0, std::memory_order_release);
    const auto frames = capturedFrames_.load(std::memory_order_acquire);
    std::vector<float> result(capture_.begin(), capture_.begin() +
                              static_cast<std::ptrdiff_t>(frames * 2));
    capture_.clear();
    return result;
}

bool AudioEngine::captureComplete() const noexcept {
    const auto target = captureTargetFrames_.load(std::memory_order_acquire);
    return target != 0 && capturedFrames_.load(std::memory_order_acquire) >= target;
}

RealtimeStats AudioEngine::realtimeStats() const noexcept {
    return {callbacks_.load(std::memory_order_relaxed),
            failures_.load(std::memory_order_relaxed),
            maxCallbackFrames_.load(std::memory_order_relaxed),
            capturedFrames_.load(std::memory_order_relaxed)};
}

bool renderOffline(AudioGraph& graph, Transport& transport, std::uint64_t frames,
                   std::vector<float>& output, std::string& error) {
    output.assign(static_cast<std::size_t>(frames) * 2, 0.0F);
    std::uint64_t rendered = 0;
    while (rendered < frames) {
        const auto block = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(kTargetBlockSize, frames - rendered));
        if (!graph.processBlock(output.data() + rendered * 2, block, transport)) {
            error = "AudioGraph::processBlock failed at sample " + std::to_string(rendered);
            return false;
        }
        rendered += block;
    }
    return true;
}

} // namespace engine2
