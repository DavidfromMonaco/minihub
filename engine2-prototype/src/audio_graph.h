#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace engine2 {

constexpr std::uint32_t kChannels = 2;
constexpr std::uint32_t kDefaultSampleRate = 48000;
constexpr std::uint32_t kTargetBlockSize = 256;
constexpr std::uint32_t kMaxBlockSize = 4096;
constexpr std::size_t kMaxMidiEventsPerBlock = 256;
constexpr std::uint32_t kMaxCompensationSamples = 131072;

enum class MidiType : std::uint8_t { noteOn, noteOff };

struct MidiEvent {
    MidiType type {MidiType::noteOn};
    std::uint8_t channel {0};
    std::uint8_t note {60};
    float velocity {1.0F};
    std::uint32_t sampleOffset {0};
};

struct TransportSnapshot {
    std::int64_t samplePosition {0};
    double tempo {120.0};
    double ppqPosition {0.0};
    bool playing {false};
    bool loopActive {false};
    std::int64_t loopStart {0};
    std::int64_t loopEnd {0};
};

class Transport final {
public:
    explicit Transport(double sampleRate = kDefaultSampleRate) noexcept;
    void setSampleRate(double sampleRate) noexcept;
    void play() noexcept;
    void stop() noexcept;
    void goToStart() noexcept;
    void seek(std::int64_t sample) noexcept;
    void setTempo(double bpm) noexcept;
    void setLoop(bool enabled, std::int64_t startSample, std::int64_t endSample) noexcept;
    [[nodiscard]] TransportSnapshot snapshot() const noexcept;
    void advance(std::uint32_t samples) noexcept;

private:
    std::atomic<double> sampleRate_;
    std::atomic<std::int64_t> samplePosition_ {0};
    std::atomic<double> tempo_ {120.0};
    std::atomic<bool> playing_ {false};
    std::atomic<bool> loopActive_ {false};
    std::atomic<std::int64_t> loopStart_ {0};
    std::atomic<std::int64_t> loopEnd_ {0};
};

class IProcessor {
public:
    virtual ~IProcessor() = default;
    virtual bool prepare(double sampleRate, std::uint32_t maxBlockSize, bool offline,
                         std::string& error) = 0;
    virtual bool start(std::string& error) = 0;
    virtual void stop() noexcept = 0;
    virtual void reset() noexcept = 0;
    virtual bool process(float* left, float* right, std::uint32_t frames,
                         std::span<const MidiEvent> midi,
                         const TransportSnapshot& transport) noexcept = 0;
    [[nodiscard]] virtual std::uint32_t latencySamples() const noexcept = 0;
    [[nodiscard]] virtual const char* name() const noexcept = 0;
};

class DeterministicSynth final : public IProcessor {
public:
    explicit DeterministicSynth(double tuningOffset = 0.0) noexcept;
    bool prepare(double sampleRate, std::uint32_t, bool, std::string&) override;
    bool start(std::string&) override;
    void stop() noexcept override;
    void reset() noexcept override;
    bool process(float* left, float* right, std::uint32_t frames,
                 std::span<const MidiEvent> midi,
                 const TransportSnapshot& transport) noexcept override;
    [[nodiscard]] std::uint32_t latencySamples() const noexcept override { return 0; }
    [[nodiscard]] const char* name() const noexcept override { return "DeterministicSynth"; }

private:
    double sampleRate_ {kDefaultSampleRate};
    double phase_ {0.0};
    double tuningOffset_ {0.0};
    std::uint8_t note_ {60};
    float velocity_ {0.0F};
};

class DelayTestProcessor final : public IProcessor {
public:
    explicit DelayTestProcessor(std::uint32_t latencySamples);
    bool prepare(double, std::uint32_t maxBlockSize, bool, std::string& error) override;
    bool start(std::string&) override { return true; }
    void stop() noexcept override {}
    void reset() noexcept override;
    bool process(float* left, float* right, std::uint32_t frames,
                 std::span<const MidiEvent>, const TransportSnapshot&) noexcept override;
    [[nodiscard]] std::uint32_t latencySamples() const noexcept override { return latency_; }
    [[nodiscard]] const char* name() const noexcept override { return "DelayTestProcessor"; }

private:
    std::uint32_t latency_;
    std::vector<float> leftDelay_;
    std::vector<float> rightDelay_;
    std::size_t cursor_ {0};
};

struct ScheduledNote {
    std::int64_t samplePosition;
    MidiType type;
    std::uint8_t note;
    float velocity;
};

class AudioGraph final {
public:
    struct TrackConfig {
        std::unique_ptr<IProcessor> processor;
        float gain {1.0F};
        std::vector<ScheduledNote> sequence;
    };

    AudioGraph(double sampleRate, std::uint32_t maxBlockSize,
               TrackConfig track1, TrackConfig track2, bool offline);
    ~AudioGraph();
    AudioGraph(const AudioGraph&) = delete;
    AudioGraph& operator=(const AudioGraph&) = delete;

    bool prepare(std::string& error);
    bool start(std::string& error);
    void stop() noexcept;
    void reset() noexcept;
    bool processBlock(float* interleavedStereo, std::uint32_t frames,
                      Transport& transport) noexcept;
    [[nodiscard]] std::array<std::uint32_t, 2> trackLatencies() const noexcept;
    [[nodiscard]] std::array<std::uint32_t, 2> compensationDelays() const noexcept;
    [[nodiscard]] std::array<float, 2> lastTrackPeaks() const noexcept;
    [[nodiscard]] std::uint64_t processedBlocks() const noexcept { return processedBlocks_; }

private:
    struct Track;
    bool processTrack(Track& track, const TransportSnapshot& snapshot,
                      std::uint32_t frames) noexcept;
    void gatherMidi(const Track& track, const TransportSnapshot& snapshot,
                    std::uint32_t frames, std::array<MidiEvent, kMaxMidiEventsPerBlock>& events,
                    std::size_t& count) const noexcept;

    double sampleRate_;
    std::uint32_t maxBlockSize_;
    bool offline_;
    std::unique_ptr<Track> track1_;
    std::unique_ptr<Track> track2_;
    std::uint32_t maxLatency_ {0};
    std::uint64_t processedBlocks_ {0};
    bool prepared_ {false};
    bool started_ {false};
};

std::vector<ScheduledNote> makeFixedSequence(std::uint32_t sampleRate, std::uint8_t rootNote);

} // namespace engine2
