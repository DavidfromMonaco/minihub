#include "audio_graph.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <numbers>
#include <stdexcept>

namespace engine2 {

Transport::Transport(double sampleRate) noexcept : sampleRate_(sampleRate) {}
void Transport::setSampleRate(double sampleRate) noexcept {
    if (sampleRate > 0.0) sampleRate_.store(sampleRate, std::memory_order_release);
}

void Transport::play() noexcept { playing_.store(true, std::memory_order_release); }
void Transport::stop() noexcept { playing_.store(false, std::memory_order_release); }
void Transport::goToStart() noexcept { seek(0); }
void Transport::seek(std::int64_t sample) noexcept {
    samplePosition_.store(std::max<std::int64_t>(0, sample), std::memory_order_release);
}
void Transport::setTempo(double bpm) noexcept {
    tempo_.store(std::clamp(bpm, 20.0, 400.0), std::memory_order_release);
}
void Transport::setLoop(bool enabled, std::int64_t startSample, std::int64_t endSample) noexcept {
    const auto start = std::max<std::int64_t>(0, startSample);
    const auto end = std::max(start + 1, endSample);
    loopStart_.store(start, std::memory_order_release);
    loopEnd_.store(end, std::memory_order_release);
    loopActive_.store(enabled, std::memory_order_release);
}
TransportSnapshot Transport::snapshot() const noexcept {
    TransportSnapshot result;
    result.samplePosition = samplePosition_.load(std::memory_order_acquire);
    result.tempo = tempo_.load(std::memory_order_acquire);
    result.playing = playing_.load(std::memory_order_acquire);
    result.loopActive = loopActive_.load(std::memory_order_acquire);
    result.loopStart = loopStart_.load(std::memory_order_acquire);
    result.loopEnd = loopEnd_.load(std::memory_order_acquire);
    result.ppqPosition = static_cast<double>(result.samplePosition) * result.tempo /
                         (60.0 * sampleRate_.load(std::memory_order_acquire));
    return result;
}
void Transport::advance(std::uint32_t samples) noexcept {
    if (!playing_.load(std::memory_order_acquire)) return;
    auto next = samplePosition_.load(std::memory_order_relaxed) + samples;
    if (loopActive_.load(std::memory_order_acquire)) {
        const auto start = loopStart_.load(std::memory_order_acquire);
        const auto end = loopEnd_.load(std::memory_order_acquire);
        const auto length = end - start;
        if (length > 0 && next >= end) next = start + ((next - start) % length);
    }
    samplePosition_.store(next, std::memory_order_release);
}

DeterministicSynth::DeterministicSynth(double tuningOffset) noexcept
    : tuningOffset_(tuningOffset) {}
bool DeterministicSynth::prepare(double sampleRate, std::uint32_t, bool, std::string&) {
    sampleRate_ = sampleRate;
    reset();
    return sampleRate > 0.0;
}
bool DeterministicSynth::start(std::string&) { return true; }
void DeterministicSynth::stop() noexcept { velocity_ = 0.0F; }
void DeterministicSynth::reset() noexcept {
    phase_ = 0.0;
    note_ = 60;
    velocity_ = 0.0F;
}
bool DeterministicSynth::process(float* left, float* right, std::uint32_t frames,
                                 std::span<const MidiEvent> midi,
                                 const TransportSnapshot& transport) noexcept {
    std::size_t eventIndex = 0;
    for (std::uint32_t i = 0; i < frames; ++i) {
        while (eventIndex < midi.size() && midi[eventIndex].sampleOffset == i) {
            const auto& event = midi[eventIndex++];
            if (event.type == MidiType::noteOn && event.velocity > 0.0F) {
                note_ = event.note;
                velocity_ = event.velocity;
            } else if (event.note == note_) {
                velocity_ = 0.0F;
            }
        }
        if (!transport.playing || velocity_ == 0.0F) {
            left[i] = right[i] = 0.0F;
            continue;
        }
        const double semitones = static_cast<double>(note_) - 69.0 + tuningOffset_;
        const double frequency = 440.0 * std::pow(2.0, semitones / 12.0);
        const float sample = static_cast<float>(std::sin(phase_) * 0.18 * velocity_);
        left[i] = sample;
        right[i] = sample;
        phase_ += 2.0 * std::numbers::pi * frequency / sampleRate_;
        if (phase_ >= 2.0 * std::numbers::pi) phase_ -= 2.0 * std::numbers::pi;
    }
    return true;
}

DelayTestProcessor::DelayTestProcessor(std::uint32_t latencySamples)
    : latency_(latencySamples) {}
bool DelayTestProcessor::prepare(double, std::uint32_t, bool, std::string& error) {
    if (latency_ > kMaxCompensationSamples) {
        error = "artificial latency exceeds preallocated PDC capacity";
        return false;
    }
    leftDelay_.assign(std::max<std::uint32_t>(1, latency_), 0.0F);
    rightDelay_.assign(std::max<std::uint32_t>(1, latency_), 0.0F);
    cursor_ = 0;
    return true;
}
void DelayTestProcessor::reset() noexcept {
    std::fill(leftDelay_.begin(), leftDelay_.end(), 0.0F);
    std::fill(rightDelay_.begin(), rightDelay_.end(), 0.0F);
    cursor_ = 0;
}
bool DelayTestProcessor::process(float* left, float* right, std::uint32_t frames,
                                 std::span<const MidiEvent>,
                                 const TransportSnapshot& transport) noexcept {
    for (std::uint32_t i = 0; i < frames; ++i) {
        const float input = transport.playing && transport.samplePosition + i == 0 ? 0.25F : 0.0F;
        if (latency_ == 0) {
            left[i] = right[i] = input;
        } else {
            left[i] = leftDelay_[cursor_];
            right[i] = rightDelay_[cursor_];
            leftDelay_[cursor_] = rightDelay_[cursor_] = input;
            cursor_ = (cursor_ + 1) % latency_;
        }
    }
    return true;
}

struct AudioGraph::Track {
    std::unique_ptr<IProcessor> processor;
    float gain {1.0F};
    std::vector<ScheduledNote> sequence;
    std::vector<float> left;
    std::vector<float> right;
    std::vector<float> pdcLeft;
    std::vector<float> pdcRight;
    std::uint32_t pdcDelay {0};
    std::size_t pdcCursor {0};
    float lastPeak {0.0F};
};

AudioGraph::AudioGraph(double sampleRate, std::uint32_t maxBlockSize,
                       TrackConfig track1, TrackConfig track2, bool offline)
    : sampleRate_(sampleRate), maxBlockSize_(maxBlockSize), offline_(offline),
      track1_(std::make_unique<Track>()), track2_(std::make_unique<Track>()) {
    if (!track1.processor || !track2.processor || maxBlockSize == 0 ||
        maxBlockSize > kMaxBlockSize) {
        throw std::invalid_argument("invalid AudioGraph configuration");
    }
    track1_->processor = std::move(track1.processor);
    track1_->gain = track1.gain;
    track1_->sequence = std::move(track1.sequence);
    track2_->processor = std::move(track2.processor);
    track2_->gain = track2.gain;
    track2_->sequence = std::move(track2.sequence);
}
AudioGraph::~AudioGraph() { stop(); }

bool AudioGraph::prepare(std::string& error) {
    for (auto* track : {track1_.get(), track2_.get()}) {
        track->left.assign(maxBlockSize_, 0.0F);
        track->right.assign(maxBlockSize_, 0.0F);
        if (!track->processor->prepare(sampleRate_, maxBlockSize_, offline_, error)) return false;
    }
    maxLatency_ = std::max(track1_->processor->latencySamples(),
                           track2_->processor->latencySamples());
    if (maxLatency_ > kMaxCompensationSamples) {
        error = "plugin latency exceeds preallocated PDC capacity";
        return false;
    }
    for (auto* track : {track1_.get(), track2_.get()}) {
        track->pdcDelay = maxLatency_ - track->processor->latencySamples();
        track->pdcLeft.assign(std::max<std::uint32_t>(1, track->pdcDelay), 0.0F);
        track->pdcRight.assign(std::max<std::uint32_t>(1, track->pdcDelay), 0.0F);
        track->pdcCursor = 0;
    }
    prepared_ = true;
    return true;
}
bool AudioGraph::start(std::string& error) {
    if (!prepared_) { error = "graph is not prepared"; return false; }
    if (!track1_->processor->start(error)) return false;
    if (!track2_->processor->start(error)) {
        track1_->processor->stop();
        return false;
    }
    started_ = true;
    return true;
}
void AudioGraph::stop() noexcept {
    if (!started_) return;
    track2_->processor->stop();
    track1_->processor->stop();
    started_ = false;
}
void AudioGraph::reset() noexcept {
    for (auto* track : {track1_.get(), track2_.get()}) {
        track->processor->reset();
        std::fill(track->pdcLeft.begin(), track->pdcLeft.end(), 0.0F);
        std::fill(track->pdcRight.begin(), track->pdcRight.end(), 0.0F);
        track->pdcCursor = 0;
    }
    processedBlocks_ = 0;
}

void AudioGraph::gatherMidi(const Track& track, const TransportSnapshot& snapshot,
                            std::uint32_t frames,
                            std::array<MidiEvent, kMaxMidiEventsPerBlock>& events,
                            std::size_t& count) const noexcept {
    count = 0;
    if (!snapshot.playing) return;
    const auto begin = snapshot.samplePosition;
    const auto end = begin + frames;
    for (const auto& scheduled : track.sequence) {
        if (scheduled.samplePosition < begin || scheduled.samplePosition >= end) continue;
        if (count == events.size()) break;
        auto& event = events[count++];
        event.type = scheduled.type;
        event.channel = 0;
        event.note = scheduled.note;
        event.velocity = scheduled.velocity;
        event.sampleOffset = static_cast<std::uint32_t>(scheduled.samplePosition - begin);
    }
}

bool AudioGraph::processTrack(Track& track, const TransportSnapshot& snapshot,
                              std::uint32_t frames) noexcept {
    std::fill_n(track.left.data(), frames, 0.0F);
    std::fill_n(track.right.data(), frames, 0.0F);
    std::array<MidiEvent, kMaxMidiEventsPerBlock> midi {};
    std::size_t midiCount = 0;
    gatherMidi(track, snapshot, frames, midi, midiCount);
    if (!track.processor->process(track.left.data(), track.right.data(), frames,
                                  std::span<const MidiEvent>(midi.data(), midiCount), snapshot)) {
        return false;
    }
    float peak = 0.0F;
    for (std::uint32_t i = 0; i < frames; ++i) {
        const float left = track.left[i] * track.gain;
        const float right = track.right[i] * track.gain;
        if (track.pdcDelay == 0) {
            track.left[i] = left;
            track.right[i] = right;
        } else {
            track.left[i] = track.pdcLeft[track.pdcCursor];
            track.right[i] = track.pdcRight[track.pdcCursor];
            track.pdcLeft[track.pdcCursor] = left;
            track.pdcRight[track.pdcCursor] = right;
            track.pdcCursor = (track.pdcCursor + 1) % track.pdcDelay;
        }
        peak = std::max({peak, std::abs(track.left[i]), std::abs(track.right[i])});
    }
    track.lastPeak = peak;
    return true;
}

bool AudioGraph::processBlock(float* output, std::uint32_t frames, Transport& transport) noexcept {
    if (!output || !started_ || frames > maxBlockSize_) {
        if (output) std::fill_n(output, static_cast<std::size_t>(frames) * kChannels, 0.0F);
        return false;
    }
    std::uint32_t written = 0;
    while (written < frames) {
        const auto snapshot = transport.snapshot();
        auto segment = frames - written;
        // Split exactly at a loop boundary so MIDI offsets and VST process
        // context restart at loopStart within the same device callback.
        if (snapshot.playing && snapshot.loopActive &&
            snapshot.samplePosition < snapshot.loopEnd &&
            snapshot.samplePosition + segment > snapshot.loopEnd) {
            segment = static_cast<std::uint32_t>(snapshot.loopEnd - snapshot.samplePosition);
        }
        if (segment == 0 || !processTrack(*track1_, snapshot, segment) ||
            !processTrack(*track2_, snapshot, segment)) {
            std::fill_n(output, static_cast<std::size_t>(frames) * kChannels, 0.0F);
            return false;
        }
        // The master is deliberately only a linear sum: no limiter,
        // normalization, saturation, clipping, or gain hidden here.
        for (std::uint32_t i = 0; i < segment; ++i) {
            output[(written + i) * 2] = track1_->left[i] + track2_->left[i];
            output[(written + i) * 2 + 1] = track1_->right[i] + track2_->right[i];
        }
        transport.advance(segment);
        written += segment;
    }
    ++processedBlocks_;
    return true;
}

std::array<std::uint32_t, 2> AudioGraph::trackLatencies() const noexcept {
    return {track1_->processor->latencySamples(), track2_->processor->latencySamples()};
}
std::array<std::uint32_t, 2> AudioGraph::compensationDelays() const noexcept {
    return {track1_->pdcDelay, track2_->pdcDelay};
}
std::array<float, 2> AudioGraph::lastTrackPeaks() const noexcept {
    return {track1_->lastPeak, track2_->lastPeak};
}

std::vector<ScheduledNote> makeFixedSequence(std::uint32_t sampleRate, std::uint8_t rootNote) {
    const auto beat = static_cast<std::int64_t>(sampleRate / 2); // 120 BPM
    return {
        {0, MidiType::noteOn, rootNote, 0.8F},
        {beat, MidiType::noteOff, rootNote, 0.0F},
        {beat, MidiType::noteOn, static_cast<std::uint8_t>(rootNote + 7), 0.7F},
        {beat * 2, MidiType::noteOff, static_cast<std::uint8_t>(rootNote + 7), 0.0F},
        {beat * 2, MidiType::noteOn, static_cast<std::uint8_t>(rootNote + 12), 0.65F},
        {beat * 3, MidiType::noteOff, static_cast<std::uint8_t>(rootNote + 12), 0.0F},
    };
}

} // namespace engine2
