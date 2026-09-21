#pragma once

#include <juce_audio_formats/juce_audio_formats.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace mlh {

/**
 * An audio file, decoded whole, as an Audio Player node plays it.
 *
 * Immutable once a player holds it. The samples stay at the file's own rate:
 * the player converts on the fly, so a device that changes rate needs nothing
 * decoded again. Two channels always -- a mono file is copied to both, a file
 * with more keeps its first two.
 */
struct AudioPlayerAsset final {
    juce::String path;
    juce::String identity;       // path, size and modification time
    juce::String format;         // the reader's name: "WAV file", "Windows Media"...
    double sampleRate = 48000.0;
    int channels = 2;            // in the file
    juce::AudioBuffer<float> samples;
    std::vector<float> peaks;    // kPeakCount buckets, the louder channel's absolute peak

    [[nodiscard]] int64_t frames() const noexcept { return samples.getNumSamples(); }
    [[nodiscard]] double durationSeconds() const noexcept
    {
        return sampleRate > 0.0 ? static_cast<double>(frames()) / sampleRate : 0.0;
    }
};

namespace audio_player {

constexpr int kPeakCount = 512;
/** 2^26 stereo frames: 512 MB of samples, 23 minutes at 48 kHz. A longer file is
 *  refused by name rather than left to fail an allocation halfway. */
constexpr int64_t kMaxFrames = int64_t(1) << 26;

/** What a file is known by: a file saved again under the same name is another. */
juce::String fileIdentity(const juce::File&);

/**
 * Decode a whole file, for a worker thread. Null, with `error` in words a page
 * can show, when the file cannot be played. `cancel`, when given, is polled
 * between chunks so a shutdown does not wait for a long file.
 */
std::shared_ptr<const AudioPlayerAsset> decode(const juce::File&, juce::String& error,
                                               const std::atomic<bool>* cancel = nullptr);

/**
 * The windowed-sinc kernel the player resamples with. Exposed for the tests:
 * a table of one half of a symmetric kernel, `kTableResolution` points per
 * sample of distance, `kHalfWidth` samples wide.
 */
constexpr int kHalfWidth = 32;
constexpr int kTableResolution = 512;
const std::vector<float>& sincTable();

/**
 * One output frame of a stereo file (`frames` long) at the fractional frame
 * `position`. `stretch` >= 1 widens the kernel for a file read faster than the
 * output -- a higher rate than the device's -- so what the output cannot carry
 * is filtered out instead of folded back. Outside the file a sample reads as
 * silence, or as the other end of it when `wrap`, which is what keeps a loop
 * seamless.
 */
void interpolate(const float* left, const float* right, int64_t frames, double position,
                 double stretch, bool wrap, float& outLeft, float& outRight) noexcept;

} // namespace audio_player

/**
 * An Audio Player node's playback, owned by the engine and run by the audio
 * callback.
 *
 * THE CLOCK IT FOLLOWS
 * --------------------
 * A player has its own position and its own Play, Pause and Stop, and the
 * transport drives it as well, the way a synced file player does in other
 * hosts: when the transport starts, every player starts from where it is; when
 * the transport stops, every player pauses. A Stop somebody gives, on top of
 * that, returns each player to its start (`Command::stop`, sent by the engine).
 * Seeking the arrangement moves no player: a player's position is in its file,
 * not on the timeline. DECISIONS D-051.
 *
 * THREADS
 * -------
 * The message thread publishes a file (`setAsset`), the loop flag, and commands
 * through a fixed ring; the audio thread alone reads them, in `render`, and owns
 * the position, the state and the fades. A replaced file is kept in `retired_`
 * until `collectRetired` sees no render in progress: `render` raises
 * `inRender_` before it loads the pointer, so a render that could still hold the
 * old file is always seen.
 */
class AudioPlayer final {
public:
    enum class State : int { stopped = 0, playing = 1, paused = 2 };
    enum class Command : int { play = 1, pause = 2, stop = 3, seek = 4 };

    struct Status {
        State state = State::stopped;
        double positionSeconds = 0.0;
        uint64_t ended = 0; // times a play without loop reached the end of the file
    };

    explicit AudioPlayer(std::string id);

    const std::string& id() const noexcept { return id_; }

    // ---- message thread ----
    void setAsset(std::shared_ptr<const AudioPlayerAsset> asset);
    const std::shared_ptr<const AudioPlayerAsset>& asset() const noexcept { return owned_; }
    void setLooping(bool looping) noexcept { looping_.store(looping, std::memory_order_release); }
    bool looping() const noexcept { return looping_.load(std::memory_order_acquire); }
    /** False when the ring is full: a player the callback does not run fills it. */
    bool command(Command command, double seconds = 0.0) noexcept;
    bool hasRetired() const noexcept { return !retired_.empty(); }
    /** Free the files replaced since the last call, unless a render may hold one. */
    void collectRetired();
    Status status() const noexcept;
    /** The same file and loop, stopped at the start, and started by the first block
     *  its transport plays: an offline export plays every player from its start. */
    std::unique_ptr<AudioPlayer> cloneForExport() const;

    // ---- audio thread ----
    /** Write this block into `out` (cleared by the caller), at `level`. */
    void render(juce::AudioBuffer<float>& out, int numSamples, bool transportPlaying,
                double outputRate, float level) noexcept;

private:
    struct Queued { Command command = Command::play; double seconds = 0.0; };
    static constexpr uint32_t kQueueSize = 64;
    // A pause, a stop or a seek fades the sound out first, and a resume fades it
    // in: a waveform cut mid-cycle is a click. A start from the beginning does
    // not fade, or the file's first attack would be blunted.
    static constexpr double kFadeSeconds = 0.005;

    void apply(const Queued&, const AudioPlayerAsset*) noexcept;
    void start(const AudioPlayerAsset*) noexcept;
    void halt(State target, int64_t seekFrame) noexcept;
    void settle(const AudioPlayerAsset*) noexcept;
    void publish(const AudioPlayerAsset*) noexcept;

    const std::string id_;

    // Message thread.
    std::shared_ptr<const AudioPlayerAsset> owned_;
    std::vector<std::shared_ptr<const AudioPlayerAsset>> retired_;

    // Shared.
    std::atomic<const AudioPlayerAsset*> asset_ { nullptr };
    std::atomic<bool> inRender_ { false };
    std::atomic<bool> looping_ { false };
    std::array<Queued, kQueueSize> queue_ {};
    std::atomic<uint32_t> queueRead_ { 0 }, queueWrite_ { 0 };
    std::atomic<int> publishedState_ { 0 };
    std::atomic<double> publishedSeconds_ { 0.0 };
    std::atomic<uint64_t> ended_ { 0 };

    // Audio thread.
    const AudioPlayerAsset* current_ = nullptr;
    State state_ = State::stopped;
    double position_ = 0.0;       // in the file's frames
    bool primed_ = false;         // the transport has been seen once
    bool lastTransport_ = false;
    double fade_ = 1.0;           // 0..1, the gain of the fade in progress
    int fadeDirection_ = 0;       // +1 in, -1 out, 0 none
    State afterFade_ = State::playing;
    int64_t seekAfterFade_ = -1;
    float lastLevel_ = 1.0f;
    bool levelKnown_ = false;
};

} // namespace mlh
