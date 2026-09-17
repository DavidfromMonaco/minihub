#pragma once

// One native One Ring: what the VST's Processor did around the scheduler, with
// the engine's live Transport where the VST had a host playhead -- and, part
// two, the notes it captures on its MIDI IN, keeps as its material and plays,
// through its voices, from its MIDI OUT.
//
// Three threads meet here. The message thread publishes sequences, targets and
// material, queues RUN, STOP, channel, scene and memory commands and live notes,
// and drains the commands the scheduler produced and the material the callback
// changed. The audio callback owns the scheduler and the material: it swaps in
// the newest plan at a block boundary, runs the clock, advances, and captures.
// Nothing the callback touches locks or allocates.

#include "capture.h"
#include "scheduler.h"
#include "voices.h"
#include "../midi_network.h"
#include "../transport.h"

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace mlh::one_ring {

// Single producer, single consumer, fixed capacity. A full queue refuses the
// item; the producer counts it.
template <class T, std::size_t Capacity>
class Queue {
public:
    bool push(const T& item) noexcept
    {
        const auto write = write_.load(std::memory_order_relaxed);
        const auto next = (write + 1) % Capacity;
        if (next == read_.load(std::memory_order_acquire)) return false;
        items_[write] = item;
        write_.store(next, std::memory_order_release);
        return true;
    }
    bool pop(T& item) noexcept
    {
        const auto read = read_.load(std::memory_order_relaxed);
        if (read == write_.load(std::memory_order_acquire)) return false;
        item = items_[read];
        read_.store((read + 1) % Capacity, std::memory_order_release);
        return true;
    }

private:
    std::array<T, Capacity> items_{};
    std::atomic<std::size_t> read_{0}, write_{0};
};

// The newest value one thread writes and another reads, with no lock and no
// queue. A queue nobody drains fills up and then keeps its OLDEST entries: the
// VST's first status, read after a quiet minute, answered "stopped, beat 0"
// about a sequence that was running. Three slots, one index exchanged.
template <class T>
class Latest {
public:
    void write(const T& value) noexcept
    {
        slots_[write_] = value;
        write_ = middle_.exchange(write_ | fresh, std::memory_order_acq_rel) & ~fresh;
    }
    const T& read() noexcept
    {
        if (middle_.load(std::memory_order_acquire) & fresh)
            read_ = middle_.exchange(read_, std::memory_order_acq_rel) & ~fresh;
        return slots_[read_];
    }
    // The value written since the last take, or null when there is none.
    const T* take() noexcept
    {
        if (!(middle_.load(std::memory_order_acquire) & fresh)) return nullptr;
        read_ = middle_.exchange(read_, std::memory_order_acq_rel) & ~fresh;
        return &slots_[read_];
    }

private:
    static constexpr unsigned fresh = 4;
    std::array<T, 3> slots_{};
    unsigned write_ = 0, read_ = 2;
    std::atomic<unsigned> middle_{1};
};

// One command for a cabled module, in the shape the VST's packets had. The
// timer turns it into a `controlEvents` entry; CommandBus checks it again.
struct Packet {
    std::uint64_t sequence = 0;
    std::uint64_t registryRevision = 0;
    double beat = 0;
    double number = 0;
    // 0 no value, 1 boolean, 2 integer, 3 float, 4 choice id -- Value's index.
    std::uint32_t valueType = 0;
    char target[256]{};
    char command[128]{};
};

struct Status {
    std::array<int, channelCount> playhead{};
    std::array<bool, channelCount> active{};
    std::size_t scene = 0;
    // A Next bar recall not played yet, or -1.
    int pendingScene = -1;
    bool playing = false;
    double beat = 0;
    double bpm = 0;
    std::uint64_t rejected = 0;
    std::uint64_t guarded = 0;
    // Part two.
    CaptureState capture = CaptureState::Off;
    std::uint32_t captured = 0;
    // Notes a capture could not keep, and changes frozen material refused.
    std::uint64_t captureRefused = 0;
    std::uint32_t originNotes = 0;
    std::uint32_t currentNotes = 0;
    bool hasCurrent = false;
    bool frozen = false;
    std::uint32_t materialGeneration = 0;
    std::uint64_t materialRevision = 0;
    std::array<std::uint32_t, voiceCount> sounding{};
    // Notes the voices could not play: a voice full, too many waiting.
    std::uint64_t notesRefused = 0;
    // What the voices play by, live: the scene's rules and the commands since.
    std::array<VoiceRules, voiceCount> voices{};
};

// Where a node's notes go: plugin chains, arpeggiators by id, the hardware output.
struct OutputTargets {
    std::vector<Chain*> chains;
    std::vector<std::string> processors;
    bool hardware = false;
};

// What the callback made of the material, numbered.
struct MaterialReport {
    std::uint64_t revision = 0;
    Material material;
};

enum class MemoryCommand : std::uint8_t { CaptureReplace, CaptureAdd, CaptureEnd, Clear, Freeze, Unfreeze, Revert };
bool memoryCommandNamed(const std::string& name, MemoryCommand& command) noexcept;

class Runtime final : private EventSink, private CaptureSink, private NoteSink {
public:
    Runtime();
    ~Runtime() override;
    Runtime(const Runtime&) = delete;
    Runtime& operator=(const Runtime&) = delete;

    // Message thread.

    // A new sequence. Only what the sequence is made of is checked here: a
    // value a cabled target would refuse stays authored, and the scheduler
    // counts it as refused when its cell plays -- the VST refused a whole saved
    // sequence over one such cell. An edit keeps the scene that is playing; a
    // restore (a project opened, the engine restarted) takes the saved one.
    bool setProject(Project, bool restore, std::string& error);
    // What the node's CTRL OUT reaches. Playback and held Legato are kept.
    bool setTargets(CommandRegistry external, std::uint64_t revision, std::string& error);
    void run() noexcept { playRequest_.store(1, std::memory_order_release); }
    void stop() noexcept { playRequest_.store(0, std::memory_order_release); }
    bool channelCommand(std::size_t channel, const std::string& command) noexcept;
    bool recallScene(std::size_t scene) noexcept;
    // A capture asked from outside the sequence waits for the next bar of what
    // plays; with nothing playing it starts at once.
    bool memoryCommand(MemoryCommand) noexcept;
    // The material the node's content holds: a project opened, a clip loaded,
    // an edit undone. It replaces what the callback has; nothing is reported.
    void setMaterial(const Material&) noexcept;
    // A note from a controller cabled to MIDI IN, taken at the next block.
    bool pushLiveInput(const unsigned char* bytes, int size) noexcept;
    // Where MIDI OUT is cabled. The notes sounding on the old ones end there first.
    void setOutputs(OutputTargets);
    // The instruments were silenced (a Stop, a new wiring): what sounds is forgotten.
    void panic() noexcept { panicRequest_.store(true, std::memory_order_release); }
    // A seek: every sounding note gets its Note Off and rings out.
    void releaseNotes() noexcept { releaseRequest_.store(true, std::memory_order_release); }
    // The node is going: its notes end, then it plays nothing more. `retired`
    // says when the callback has done it.
    void retire() noexcept { retireRequest_.store(true, std::memory_order_release); }
    bool retired() const noexcept { return retired_.load(std::memory_order_acquire); }
    std::size_t takeEvents(Packet* out, std::size_t capacity) noexcept;
    Status status() noexcept { return status_.read(); }
    // The material as the callback last changed it, when it did since the last call.
    const MaterialReport* takeMaterialReport() noexcept { return materialOut_.take(); }
    bool hasProject() const noexcept { return pending_.load(std::memory_order_acquire) != nullptr; }

    // Audio thread.

    // What the Sequencer sends this block, before process().
    void pushInput(const juce::MidiBuffer&) noexcept;
    // One block of `numSamples` at the transport's position. The notes go to
    // the outputs' chains, to `arpeggiators` and to `hardware`.
    void process(const Transport&, int numSamples, double sampleRate,
                 MidiExecutionPlan* arpeggiators = nullptr, MidiOutputSink* hardware = nullptr,
                 double callbackStartMs = 0) noexcept;

private:
    struct Plan {
        Project project;
        CommandRegistry registry;
        std::uint64_t revision = 0;
        std::uint64_t projectVersion = 0;
    };
    enum class CommandKind : std::uint8_t { Channel, Scene, Memory };
    struct Command {
        CommandKind kind = CommandKind::Channel;
        std::uint8_t name = 0;
        std::uint16_t index = 0;
    };
    struct LiveNote {
        unsigned char bytes[3]{};
        int size = 0;
    };

    bool publish(Project, bool registryOnly, std::string& error);
    void reclaim() noexcept;
    bool send(const Event&) noexcept override;
    void reach(double beat) noexcept override;
    void captured(const NoteList&, CaptureMode) noexcept override;
    void noteOn(int offset, int channel, int pitch, int velocity) noexcept override;
    void noteOff(int offset, int channel, int pitch) noexcept override;
    bool voice(std::size_t voice, const Event&) noexcept;
    void syncRules(bool force) noexcept;
    void materialChanged() noexcept;
    void flush(const OutputTargets*, bool blockEpochs) noexcept;
    void memory(MemoryCommand, int offset, bool fromOutside) noexcept;
    void drainTo(int offset) noexcept;
    int offsetOf(double beat) const noexcept;
    double nextBarWait() const noexcept;
    void report() noexcept;

    // Message thread only.
    std::vector<std::unique_ptr<Plan>> plans_;
    std::vector<std::unique_ptr<OutputTargets>> outputPlans_;
    CommandRegistry external_;
    std::uint64_t registryRevision_ = 0;
    std::uint64_t projectVersion_ = 0;

    std::atomic<Plan*> pending_{nullptr};
    std::atomic<Plan*> active_{nullptr};
    std::atomic<OutputTargets*> outputs_{nullptr};
    std::atomic<OutputTargets*> activeOutputs_{nullptr};
    std::atomic<bool> panicRequest_{false}, releaseRequest_{false}, retireRequest_{false}, retired_{false};
    // The callback raises this before loading `pending_`: a plan is reclaimed
    // only in an interval with provably no reader, as the audio plans are.
    std::atomic<unsigned> readers_{0};
    std::atomic<int> playRequest_{-1};
    std::atomic<std::size_t> liveScene_{0};

    Queue<Command, 256> input_;
    Queue<Packet, 2048> output_;
    Queue<LiveNote, 512> liveNotes_;
    Latest<Status> status_;
    Latest<Material> materialIn_;
    Latest<MaterialReport> materialOut_;

    // Audio thread only.
    std::unique_ptr<Scheduler> scheduler_;
    double beat_ = 0;
    bool previousHostPlaying_ = false;
    std::uint64_t sequence_ = 0;
    std::uint64_t dropped_ = 0;
    Material material_;
    MaterialReport outgoing_;
    std::uint64_t materialRevision_ = 0;
    std::uint64_t materialRefused_ = 0;
    Capture capture_{*this};
    Voices voices_;
    juce::MidiBuffer out_;
    std::array<std::uint32_t, 64> epochs_{};
    MidiExecutionPlan* arpeggiators_ = nullptr;
    MidiOutputSink* hardware_ = nullptr;
    double callbackStartMs_ = 0;
    double sampleRate_ = 48000;
    std::size_t rulesScene_ = 0;
    std::uint64_t rulesRecalls_ = 0;
    std::uint64_t rulesVersion_ = 0;
    bool rulesKnown_ = false;
    juce::MidiBuffer scheduledInput_;
    juce::MidiBufferIterator inputAt_{}, inputEnd_{};
    std::array<LiveNote, 512> liveBlock_{};
    std::size_t liveCount_ = 0, liveRead_ = 0;
    // The block being processed.
    double blockBegin_ = 0;
    double blockBeatsPerSample_ = 0;
    int blockSamples_ = 0;
    double hostBeat_ = 0;
    bool hostPlaying_ = false;
};

} // namespace mlh::one_ring
