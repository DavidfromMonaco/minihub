#include "audio_player.h"

#include <algorithm>
#include <cmath>
#include <new>

namespace mlh {

namespace audio_player {

namespace {

double besselI0(double x) noexcept
{
    double sum = 1.0, term = 1.0;
    const double half = x * 0.5;
    for (int k = 1; k < 64; ++k)
    {
        term *= (half / k) * (half / k);
        sum += term;
        if (term < sum * 1.0e-14)
            break;
    }
    return sum;
}

} // namespace

juce::String fileIdentity(const juce::File& file)
{
    return file.getFullPathName() + "|" + juce::String(file.getSize()) + "|"
         + juce::String(file.getLastModificationTime().toMilliseconds());
}

std::shared_ptr<const AudioPlayerAsset> decode(const juce::File& file, juce::String& error,
                                               const std::atomic<bool>* cancel)
{
    error.clear();
    if (!file.existsAsFile())
    {
        error = "The file is missing: " + file.getFullPathName();
        return {};
    }
    // A manager per decode: two files can load at once, on two workers.
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
    if (reader == nullptr)
    {
        error = "MiniHub cannot read this file as audio: " + file.getFileName();
        return {};
    }
    const int64_t length = reader->lengthInSamples;
    if (!(reader->sampleRate > 0.0) || reader->numChannels < 1 || length <= 0)
    {
        error = "The file holds no audio: " + file.getFileName();
        return {};
    }
    if (length > kMaxFrames)
    {
        const int minutes = static_cast<int>(std::floor(static_cast<double>(kMaxFrames) / reader->sampleRate / 60.0));
        error = "The file is too long to load: MiniHub plays up to " + juce::String(minutes)
              + " minutes at its sample rate.";
        return {};
    }

    auto asset = std::make_shared<AudioPlayerAsset>();
    asset->path = file.getFullPathName();
    asset->identity = fileIdentity(file);
    asset->format = reader->getFormatName();
    asset->sampleRate = reader->sampleRate;
    asset->channels = static_cast<int>(reader->numChannels);
    try
    {
        asset->samples.setSize(2, static_cast<int>(length), false, true, false);
    }
    catch (const std::bad_alloc&)
    {
        error = "There is not enough memory to load this file: " + file.getFileName();
        return {};
    }
    // In chunks, so a shutdown need not wait for the end of a long file. A mono
    // file is copied to both channels by the reader itself.
    constexpr int kChunk = 1 << 16;
    for (int64_t start = 0; start < length; start += kChunk)
    {
        if (cancel != nullptr && cancel->load(std::memory_order_acquire))
        {
            error = "Loading was cancelled";
            return {};
        }
        const int count = static_cast<int>(std::min<int64_t>(kChunk, length - start));
        reader->read(&asset->samples, static_cast<int>(start), count, start, true, true);
    }

    asset->peaks.resize(static_cast<size_t>(kPeakCount), 0.0f);
    for (int bucket = 0; bucket < kPeakCount; ++bucket)
    {
        const auto begin = static_cast<int>(static_cast<int64_t>(bucket) * length / kPeakCount);
        const auto end = static_cast<int>(static_cast<int64_t>(bucket + 1) * length / kPeakCount);
        const int count = std::max(1, end - begin);
        const int first = std::min(begin, static_cast<int>(length) - 1);
        const int span = std::min(count, static_cast<int>(length) - first);
        float peak = 0.0f;
        for (int channel = 0; channel < 2; ++channel)
            peak = std::max(peak, asset->samples.getMagnitude(channel, first, span));
        asset->peaks[static_cast<size_t>(bucket)] = peak;
    }
    return asset;
}

const std::vector<float>& sincTable()
{
    // A Kaiser-windowed sinc, cut at 92 % of the slower side's Nyquist: flat to
    // about 18.5 kHz from a 44.1 kHz file, and what lies above folded back some
    // 80 dB down. The table holds one half of the symmetric kernel.
    static const std::vector<float> table = []
    {
        constexpr double cutoff = 0.92;
        constexpr double beta = 8.0;
        const double pi = juce::MathConstants<double>::pi;
        const double normal = besselI0(beta);
        std::vector<float> values(static_cast<size_t>(kHalfWidth * kTableResolution + 2), 0.0f);
        for (size_t j = 0; j < values.size(); ++j)
        {
            const double x = static_cast<double>(j) / kTableResolution;
            if (x >= kHalfWidth)
                continue;
            const double t = cutoff * x;
            const double sinc = t == 0.0 ? 1.0 : std::sin(pi * t) / (pi * t);
            const double r = x / kHalfWidth;
            const double window = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - r * r))) / normal;
            values[j] = static_cast<float>(cutoff * sinc * window);
        }
        return values;
    }();
    return table;
}

void interpolate(const float* left, const float* right, int64_t frames, double position,
                 double stretch, bool wrap, float& outLeft, float& outRight) noexcept
{
    outLeft = outRight = 0.0f;
    if (frames <= 0 || left == nullptr || right == nullptr || !std::isfinite(position))
        return;
    const auto& table = sincTable();
    // Past four times the output's rate the kernel stops widening: the CPU a
    // block costs stays bounded whatever the file.
    stretch = std::clamp(stretch, 1.0, 4.0);
    const double base = std::floor(position);
    const double fraction = position - base;
    const auto centre = static_cast<int64_t>(base);
    const int reach = static_cast<int>(std::ceil(kHalfWidth * stretch));
    const double scale = kTableResolution / stretch;
    const int last = kHalfWidth * kTableResolution;
    double sumLeft = 0.0, sumRight = 0.0, weights = 0.0;
    for (int k = 1 - reach; k <= reach; ++k)
    {
        const double index = std::abs(static_cast<double>(k) - fraction) * scale;
        const int i = static_cast<int>(index);
        if (i >= last)
            continue;
        const double weight = table[static_cast<size_t>(i)]
            + (table[static_cast<size_t>(i) + 1] - table[static_cast<size_t>(i)]) * (index - i);
        int64_t frame = centre + k;
        if (frame < 0 || frame >= frames)
        {
            if (!wrap)
            {
                weights += weight;
                continue;
            }
            frame %= frames;
            if (frame < 0)
                frame += frames;
        }
        sumLeft += weight * left[frame];
        sumRight += weight * right[frame];
        weights += weight;
    }
    if (weights == 0.0)
        return;
    outLeft = static_cast<float>(sumLeft / weights);
    outRight = static_cast<float>(sumRight / weights);
}

} // namespace audio_player

AudioPlayer::AudioPlayer(std::string id) : id_(std::move(id))
{
    // Built here, on the message thread, and never in the callback.
    (void) audio_player::sincTable();
}

void AudioPlayer::setAsset(std::shared_ptr<const AudioPlayerAsset> asset)
{
    if (asset == owned_)
        return;
    asset_.store(asset.get(), std::memory_order_seq_cst);
    if (owned_ != nullptr)
        retired_.push_back(std::move(owned_));
    owned_ = std::move(asset);
}

bool AudioPlayer::command(Command command, double seconds) noexcept
{
    const auto write = queueWrite_.load(std::memory_order_relaxed);
    const auto next = (write + 1u) % kQueueSize;
    if (next == queueRead_.load(std::memory_order_acquire))
        return false;
    queue_[write] = { command, std::isfinite(seconds) ? std::max(0.0, seconds) : 0.0 };
    queueWrite_.store(next, std::memory_order_release);
    return true;
}

void AudioPlayer::collectRetired()
{
    if (retired_.empty())
        return;
    // A render raises inRender_ before it loads asset_: seen lowered after the
    // swap, every render still to come reads the file that replaced these.
    if (inRender_.load(std::memory_order_seq_cst))
        return;
    retired_.clear();
}

AudioPlayer::Status AudioPlayer::status() const noexcept
{
    Status status;
    status.state = static_cast<State>(publishedState_.load(std::memory_order_acquire));
    status.positionSeconds = publishedSeconds_.load(std::memory_order_acquire);
    status.ended = ended_.load(std::memory_order_acquire);
    return status;
}

std::unique_ptr<AudioPlayer> AudioPlayer::cloneForExport() const
{
    auto clone = std::make_unique<AudioPlayer>(id_);
    clone->owned_ = owned_;
    clone->asset_.store(owned_.get(), std::memory_order_seq_cst);
    clone->current_ = owned_.get();
    clone->looping_.store(looping(), std::memory_order_release);
    // An export prints what Play plays.
    clone->followsTransport_.store(followsTransport(), std::memory_order_release);
    // Seen stopped, so the export's first playing block is a start.
    clone->primed_ = true;
    clone->lastTransport_ = false;
    return clone;
}

void AudioPlayer::start(const AudioPlayerAsset* asset) noexcept
{
    if (asset == nullptr)
        return;
    if (state_ == State::playing)
    {
        // A fade towards a pause or a stop is taken back; one towards a seek
        // runs out, and the seek resumes playing.
        afterFade_ = State::playing;
        if (fadeDirection_ < 0 && seekAfterFade_ < 0)
            fadeDirection_ = 1;
        return;
    }
    if (position_ < 0.0 || position_ >= static_cast<double>(asset->frames()))
        position_ = 0.0;
    state_ = State::playing;
    seekAfterFade_ = -1;
    // From the beginning, the file starts as it was written: a fade there would
    // blunt the attack of its first note. Resumed, it fades in.
    if (position_ > 0.0)
    {
        fade_ = 0.0;
        fadeDirection_ = 1;
    }
    else
    {
        fade_ = 1.0;
        fadeDirection_ = 0;
    }
}

void AudioPlayer::halt(State target, int64_t seekFrame) noexcept
{
    afterFade_ = target;
    if (target == State::stopped)
        seekAfterFade_ = -1;
    else if (seekFrame >= 0)
        seekAfterFade_ = seekFrame;
    fadeDirection_ = -1;
}

void AudioPlayer::settle(const AudioPlayerAsset* asset) noexcept
{
    if (seekAfterFade_ >= 0)
    {
        position_ = static_cast<double>(seekAfterFade_);
        seekAfterFade_ = -1;
    }
    state_ = afterFade_;
    afterFade_ = State::playing;
    if (state_ == State::stopped)
        position_ = 0.0;
    fade_ = 1.0;
    fadeDirection_ = 0;
    if (state_ == State::playing && asset != nullptr && position_ > 0.0)
    {
        fade_ = 0.0;
        fadeDirection_ = 1;
    }
}

void AudioPlayer::apply(const Queued& queued, const AudioPlayerAsset* asset) noexcept
{
    switch (queued.command)
    {
        case Command::play:
            start(asset);
            break;
        case Command::pause:
            if (state_ == State::playing)
                halt(State::paused, -1);
            break;
        case Command::stop:
            if (state_ == State::playing)
                halt(State::stopped, -1);
            else
            {
                state_ = State::stopped;
                position_ = 0.0;
                fade_ = 1.0;
                fadeDirection_ = 0;
                seekAfterFade_ = -1;
            }
            break;
        case Command::seek:
        {
            if (asset == nullptr)
                break;
            const auto frame = std::clamp<int64_t>(
                static_cast<int64_t>(std::llround(queued.seconds * asset->sampleRate)),
                0, std::max<int64_t>(0, asset->frames() - 1));
            if (state_ == State::playing && fadeDirection_ < 0 && afterFade_ != State::playing)
            {
                // On its way to a pause or a stop: it arrives there, at this place.
                seekAfterFade_ = frame;
                if (afterFade_ == State::stopped && frame > 0)
                    afterFade_ = State::paused;
            }
            else if (state_ == State::playing)
                halt(State::playing, frame);
            else
            {
                position_ = static_cast<double>(frame);
                // A place chosen while stopped is where Play will start.
                state_ = frame > 0 ? State::paused : state_;
            }
            break;
        }
    }
}

void AudioPlayer::publish(const AudioPlayerAsset* asset) noexcept
{
    publishedState_.store(static_cast<int>(state_), std::memory_order_release);
    publishedSeconds_.store(asset != nullptr && asset->sampleRate > 0.0 ? position_ / asset->sampleRate : 0.0,
                            std::memory_order_release);
}

void AudioPlayer::render(juce::AudioBuffer<float>& out, int numSamples, bool transportPlaying,
                         double outputRate, float level) noexcept
{
    inRender_.store(true, std::memory_order_seq_cst);
    const auto* asset = asset_.load(std::memory_order_seq_cst);
    if (asset != current_)
    {
        // Another file, or none: it waits at its beginning.
        current_ = asset;
        state_ = State::stopped;
        position_ = 0.0;
        fade_ = 1.0;
        fadeDirection_ = 0;
        seekAfterFade_ = -1;
    }
    for (auto read = queueRead_.load(std::memory_order_relaxed);
         read != queueWrite_.load(std::memory_order_acquire);
         read = (read + 1u) % kQueueSize)
    {
        apply(queue_[read], asset);
        queueRead_.store((read + 1u) % kQueueSize, std::memory_order_release);
    }
    if (!primed_)
    {
        // The transport as it stood when this player appeared is no edge: a
        // file loaded while the arrangement plays waits for a Play.
        primed_ = true;
        lastTransport_ = transportPlaying;
    }
    else if (transportPlaying != lastTransport_)
    {
        lastTransport_ = transportPlaying;
        // Edges are still tracked while the player does not follow them, so
        // following again never finds a stale one waiting.
        if (followsTransport_.load(std::memory_order_acquire))
        {
            if (transportPlaying)
                start(asset);
            // Already on its way to a stop -- a Stop somebody gave arrives with
            // the transport's own stop -- it keeps going there.
            else if (state_ == State::playing && !(fadeDirection_ < 0 && afterFade_ != State::playing))
                halt(State::paused, -1);
        }
    }

    const int channels = out.getNumChannels();
    if (asset != nullptr && numSamples > 0 && outputRate > 0.0 && channels > 0 && state_ == State::playing)
    {
        const int64_t frames = asset->frames();
        const double step = asset->sampleRate / outputRate;
        // The same rate as the device: the samples as they are, bit for bit.
        const bool direct = std::abs(step - 1.0) < 1.0e-12;
        const double stretch = std::max(1.0, step);
        const double fadeStep = 1.0 / std::max(1.0, kFadeSeconds * outputRate);
        const bool wrap = looping_.load(std::memory_order_acquire);
        const float* left = asset->samples.getReadPointer(0);
        const float* right = asset->samples.getReadPointer(1);
        float* outLeft = out.getWritePointer(0);
        float* outRight = channels > 1 ? out.getWritePointer(1) : nullptr;
        if (direct)
            position_ = std::round(position_);
        for (int i = 0; i < numSamples && state_ == State::playing; ++i)
        {
            float l = 0.0f, r = 0.0f;
            if (direct)
            {
                const auto frame = static_cast<int64_t>(position_);
                if (frame >= 0 && frame < frames)
                {
                    l = left[frame];
                    r = right[frame];
                }
            }
            else
                audio_player::interpolate(left, right, frames, position_, stretch, wrap, l, r);
            float gain = 1.0f;
            if (fadeDirection_ != 0)
            {
                gain = static_cast<float>(fade_);
                fade_ += fadeDirection_ * fadeStep;
                if (fadeDirection_ > 0 && fade_ >= 1.0)
                {
                    fade_ = 1.0;
                    fadeDirection_ = 0;
                }
            }
            outLeft[i] += l * gain;
            if (outRight != nullptr)
                outRight[i] += r * gain;
            if (fadeDirection_ < 0 && fade_ <= 0.0)
            {
                // Silent now: the pause, the stop or the seek happens here.
                settle(asset);
                continue;
            }
            position_ += step;
            if (position_ >= static_cast<double>(frames))
            {
                if (wrap)
                    position_ = std::fmod(position_, static_cast<double>(frames));
                else
                {
                    state_ = State::stopped;
                    position_ = 0.0;
                    fade_ = 1.0;
                    fadeDirection_ = 0;
                    ended_.fetch_add(1, std::memory_order_acq_rel);
                }
            }
        }
    }

    if (!levelKnown_)
    {
        lastLevel_ = level;
        levelKnown_ = true;
    }
    // A level moved during the block glides to its new value across it.
    if (numSamples > 0 && (lastLevel_ != level || level != 1.0f))
        out.applyGainRamp(0, numSamples, lastLevel_, level);
    lastLevel_ = level;

    publish(asset);
    inRender_.store(false, std::memory_order_release);
}

} // namespace mlh
