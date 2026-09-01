#pragma once

#include "chain.h"
#include "audio_take_writer.h"
#include "transport.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace mlh {

class MidiExecutionPlan;
class MidiOutputSink;

/** Native, sample-clocked arrangement engine. The renderer publishes immutable
 * project snapshots; the audio callback only reads a precompiled plan. */
class SequencerEngine {
public:
    struct ExportOptions {
        juce::String format { "wav" };
        int wavBits = 24;
        int mp3BitrateKbps = 320;
        /** Index returned by OggVorbisAudioFormat::getQualityOptions().
         *  A negative value selects the highest available quality. */
        int oggQualityIndex = -1;
    };

    SequencerEngine();
    ~SequencerEngine();

    bool sync(const juce::var& project,
              const std::function<Chain*(const std::string&)>& chainLookup,
              double engineSampleRate, int maxBlockSize,
              juce::Array<juce::var>& audioInfo, std::string& error);
    /** Publish an empty immutable plan, silencing any arrangement that was
     *  active before a failed sync or project handoff. */
    void clearPlan();

    void prepare(double sampleRate, int blockSize);
    void processMidi(int numSamples, Transport&, MidiExecutionPlan* = nullptr,
                     MidiOutputSink* = nullptr, double callbackStartMs = 0) noexcept;
    void renderAudio(juce::AudioBuffer<float>& destination, int numSamples, Transport&) noexcept;
    void renderAudioForOutput(juce::AudioBuffer<float>& destination, int numSamples,
                              Transport&, const std::string& outputId) noexcept;
    void captureSource(const std::string& sourceId, const juce::AudioBuffer<float>&,
                       int numSamples, Transport&) noexcept;

    void beginRecording(Transport&);
    juce::Array<juce::var> finishRecording(Transport&);
    void recordMidiInput(const std::string& sourceId, const juce::MidiMessage&,
                         double offsetMs, Transport&);
    bool recording() const noexcept { return recording_.load(); }
    void panic() noexcept;
    void panicExport() noexcept;
    bool consumeExportCleanupRequest() noexcept
    {
        return exportCleanupPending_.exchange(false, std::memory_order_acq_rel);
    }

    bool prepareExportPlan(const std::function<Chain*(const std::string&)>& chainLookup,
                           std::string& error);
    bool startExport(const juce::File&, double startPpq, double endPpq,
                     double tailSeconds, const Transport& liveTransport,
                     const ExportOptions&, juce::String& error);
    /** Backward-compatible WAV entry point used by older native callers. */
    bool startExport(const juce::File& file, int bits, double startPpq,
                     double endPpq, double tailSeconds,
                     const Transport& liveTransport, juce::String& error)
    {
        ExportOptions options; options.wavBits = bits;
        return startExport(file, startPpq, endPpq, tailSeconds,
                           liveTransport, options, error);
    }
    /** Atomically asks the offline worker to stop; never waits on a writer,
     *  plug-in, or render-plan hazard on the message thread. */
    bool requestCancelExport(bool publishTerminalEvent = true) noexcept;
    bool finalizeRequestedCancel() noexcept;
    /** Final destruction step. Called by the offline worker (or by native
     *  single-threaded tests after rendering has stopped). */
    bool cancelExport(bool publishTerminalEvent = false);
    void processMaster(float* const* channels, int channelCount, int numSamples,
                       Transport&) noexcept;
    juce::Array<juce::var> serviceEvents();
    bool exporting() const noexcept { return exportActive_.load(); }
    bool exportTransactionActive() const noexcept { return exportTransactionActive_.load(); }
    int64_t exportFrames() const noexcept { return exportFrames_.load(std::memory_order_acquire); }
    int64_t exportTargetFrames() const noexcept { return exportTargetFrames_.load(std::memory_order_acquire); }
    juce::String exportFormat() const { return exportFormat_; }
    juce::String exportFilePath() const { return exportFile_.getFullPathName(); }
    Transport& exportTransport() noexcept { return offlineExportTransport_; }
    double exportSourceEndPpq() const noexcept { return exportEndPpq_.load(); }
    static juce::File bundledLameExecutable();
    static juce::StringArray oggQualityOptions();
    juce::var exportSnapshotTrace() const;

private:
    struct MidiEvent {
        double startPpq = 0, endPpq = 0;
        uint8_t pitch = 60, velocity = 100, channel = 1;
    };
    struct AudioAsset {
        double sampleRate = 48000, durationSeconds = 0;
        juce::AudioBuffer<float> samples;
        std::vector<float> peaks;
    };
    struct AudioClip {
        std::string id;
        double startPpq = 0, lengthPpq = 4;
        double trimStartSeconds = 0, trimEndSeconds = 0;
        float gain = 1;
        std::shared_ptr<const AudioAsset> asset;
    };
    struct ClipTrace {
        std::string id, type;
        double startPpq = 0, lengthPpq = 0;
        bool available = true;
    };
    struct Track {
        enum class MidiOutputKind { chain, processor, physical };
        std::string id, type, inputId, outputId;
        bool armed = false, muted = false;
        float volume = 1;
        MidiOutputKind midiOutputKind = MidiOutputKind::chain;
        Chain* destination = nullptr;
        AudioTakeWriter* takeWriter = nullptr; // append-only owner in takeWriters_
        juce::MidiBuffer midiScratch; // pre-sized outside the audio callback
        std::vector<MidiEvent> midi;
        std::vector<AudioClip> audio;
        std::vector<ClipTrace> clips;
    };
    struct Plan { uint64_t generation = 0; std::vector<Track> tracks; };

    struct RecordedMidiEvent {
        double startPpq = 0, durationPpq = 0;
        int pitch = 60, velocity = 100, channel = 1;
    };
    struct ActiveNote { double startPpq = 0; int velocity = 100; };
    struct MidiTake {
        std::string trackId, sourceId;
        double startPpq = 0, lastPpq = 0, loopOffset = 0;
        std::map<int, std::vector<ActiveNote>> active;
        std::vector<RecordedMidiEvent> events;
    };
    struct AudioTake { std::string trackId; AudioTakeWriter* writer=nullptr; double startPpq=0, bpm=120; };

    Plan* acquirePlan(bool exportContext) noexcept;
    void releasePlan() noexcept;
    static int eventOffset(double target, double blockStart, double qps, int count,
                           const Transport&) noexcept;
    double recordedPpq(MidiTake&, Transport&) const noexcept;
    void closeMidiNotes(MidiTake&, double endPpq);

    juce::AudioFormatManager formats_;
    double sampleRate_ = 48000;
    int blockSize_ = 512;
    std::map<std::string, std::unique_ptr<AudioTakeWriter>> takeWriters_; // append-only
    std::map<std::string, std::shared_ptr<AudioAsset>> audioAssets_;
    std::vector<std::unique_ptr<Plan>> plans_;
    uint64_t nextPlanGeneration_ = 0; // message thread only
    std::atomic<Plan*> activePlan_{nullptr}, planHazard_{nullptr};
    // Captured before exportActive_ opens. It remains owned even if the editor
    // publishes a newer arrangement while the current master is rendering.
    std::atomic<Plan*> exportPlan_{nullptr};
    std::unique_ptr<Plan> preparedExportPlan_;
    std::atomic<bool> needsChase_{true}, needsExportChase_{true}, recording_{false};
    std::vector<MidiTake> midiTakes_;      // message thread only
    std::vector<AudioTake> audioTakes_;    // message thread only

    // Offline rendering owns a CPU-driven worker in Engine. The writer is
    // intentionally synchronous on that non-realtime worker: a ThreadedWriter
    // queue can be outrun by a fast bounce and was only necessary while export
    // incorrectly ran inside the hardware callback.
    std::unique_ptr<juce::AudioFormatWriter> exportWriter_;
    std::atomic<bool> exportActive_{false}, exportTransactionActive_{false},
                      exportFinishPending_{false}, exportCancelledPending_{false},
                      exportSourceStopSent_{false}, exportCleanupPending_{false},
                      exportCancelRequested_{false}, exportCancelPublishTerminal_{true};
    std::atomic<int> exportCallbacks_{0};
    std::atomic<int64_t> exportFrames_{0}, exportTargetFrames_{0};
    std::atomic<double> exportEndPpq_{0};
    juce::File exportFile_;
    juce::String exportError_, exportFormat_ { "wav" };
    Transport offlineExportTransport_;
};

} // namespace mlh
