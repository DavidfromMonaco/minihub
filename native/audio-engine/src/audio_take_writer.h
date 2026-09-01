#pragma once

#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>
#include <memory>
#include <string>

namespace mlh {

/** Low-level non-blocking WAV capture used exclusively by armed Sequencer
 * audio tracks. It owns no transport or UI state. */
class AudioTakeWriter {
public:
    explicit AudioTakeWriter(std::string trackId);
    ~AudioTakeWriter();

    void prepare(double sampleRate, int blockSize);
    bool begin();
    void stop();
    void process(const juce::AudioBuffer<float>&, int numSamples) noexcept;

    double duration() const noexcept { return sampleRate_ > 0 ? double(frames_.load()) / sampleRate_ : 0; }
    bool hasTake() const noexcept { return frames_.load() > 0; }
    bool overrun() const noexcept { return overrun_.load(); }
    juce::File takeFile() const { return takeFile_; }

private:
    std::string trackId_;
    std::atomic<int64_t> frames_{0};
    std::atomic<bool> recording_{false}, overrun_{false};
    std::atomic<int> activeCallbacks_{0};
    double sampleRate_ = 48000;
    int blockSize_ = 512;
    juce::File takeFile_;
    juce::TimeSliceThread writerThread_{"MiniHub audio-track writer"};
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> threaded_;
};

} // namespace mlh
