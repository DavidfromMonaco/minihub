#pragma once

// One native One Ring: what the VST's Processor did around the scheduler, with
// the engine's live Transport where the VST had a host playhead.
//
// Three threads meet here. The message thread publishes sequences and targets,
// queues RUN, STOP, channel and scene commands, and drains the commands the
// scheduler produced. The audio callback owns the scheduler: it swaps in the
// newest plan at a block boundary, runs the clock and advances. Nothing the
// callback touches locks or allocates.

#include "scheduler.h"
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
    bool playing = false;
    double beat = 0;
    double bpm = 0;
    std::uint64_t rejected = 0;
    std::uint64_t guarded = 0;
};

class Runtime final : private EventSink {
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
    std::size_t takeEvents(Packet* out, std::size_t capacity) noexcept;
    Status status() noexcept { return status_.read(); }
    bool hasProject() const noexcept { return pending_.load(std::memory_order_acquire) != nullptr; }

    // Audio thread: one block of `numSamples` at the transport's position.
    void process(const Transport&, int numSamples, double sampleRate) noexcept;

private:
    struct Plan {
        Project project;
        CommandRegistry registry;
        std::uint64_t revision = 0;
        std::uint64_t projectVersion = 0;
    };
    enum class CommandKind : std::uint8_t { Channel, Scene };
    struct Command {
        CommandKind kind = CommandKind::Channel;
        std::uint8_t name = 0;
        std::uint16_t index = 0;
    };

    bool publish(Project, bool registryOnly, std::string& error);
    void reclaim() noexcept;
    bool send(const Event&) noexcept override;

    // Message thread only.
    std::vector<std::unique_ptr<Plan>> plans_;
    CommandRegistry external_;
    std::uint64_t registryRevision_ = 0;
    std::uint64_t projectVersion_ = 0;

    std::atomic<Plan*> pending_{nullptr};
    std::atomic<Plan*> active_{nullptr};
    // The callback raises this before loading `pending_`: a plan is reclaimed
    // only in an interval with provably no reader, as the audio plans are.
    std::atomic<unsigned> readers_{0};
    std::atomic<int> playRequest_{-1};
    std::atomic<std::size_t> liveScene_{0};

    Queue<Command, 256> input_;
    Queue<Packet, 2048> output_;
    Latest<Status> status_;

    // Audio thread only.
    std::unique_ptr<Scheduler> scheduler_;
    double beat_ = 0;
    bool previousHostPlaying_ = false;
    std::uint64_t sequence_ = 0;
    std::uint64_t dropped_ = 0;
};

} // namespace mlh::one_ring
