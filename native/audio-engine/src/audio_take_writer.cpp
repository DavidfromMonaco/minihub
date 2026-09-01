#include "audio_take_writer.h"

#include <algorithm>

namespace mlh {

AudioTakeWriter::AudioTakeWriter(std::string trackId) : trackId_(std::move(trackId))
{
    writerThread_.startThread();
}

AudioTakeWriter::~AudioTakeWriter()
{
    stop();
    writerThread_.stopThread(5000);
}

void AudioTakeWriter::prepare(double sampleRate, int blockSize)
{
    sampleRate_ = sampleRate > 0 ? sampleRate : 48000;
    blockSize_ = std::max(1, blockSize);
}

bool AudioTakeWriter::begin()
{
    stop();
    takeFile_ = juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getNonexistentChildFile("MiniHub-" + juce::String(trackId_) + "-take", ".wav");
    std::unique_ptr<juce::OutputStream> stream = takeFile_.createOutputStream();
    if (!stream) { overrun_ = true; return false; }
    juce::WavAudioFormat wav;
    auto raw = wav.createWriterFor(stream, juce::AudioFormatWriter::Options{}
        .withSampleRate(sampleRate_).withNumChannels(2).withBitsPerSample(32));
    if (!raw) { overrun_ = true; return false; }
    threaded_ = std::make_unique<juce::AudioFormatWriter::ThreadedWriter>(
        raw.release(), writerThread_, std::max(32768, blockSize_ * 64));
    frames_ = 0;
    overrun_ = false;
    recording_ = true;
    return true;
}

void AudioTakeWriter::stop()
{
    recording_ = false;
    while (activeCallbacks_.load(std::memory_order_acquire) > 0) juce::Thread::yield();
    threaded_.reset();
}

void AudioTakeWriter::process(const juce::AudioBuffer<float>& audio, int count) noexcept
{
    activeCallbacks_.fetch_add(1, std::memory_order_acq_rel);
    if (recording_.load(std::memory_order_relaxed) && threaded_ && count > 0) {
        const float* channels[2] = { audio.getReadPointer(0), audio.getReadPointer(1) };
        if (!threaded_->write(channels, count)) overrun_ = true;
        else frames_.fetch_add(count);
    }
    activeCallbacks_.fetch_sub(1, std::memory_order_release);
}

} // namespace mlh
