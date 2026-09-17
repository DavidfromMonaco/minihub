#pragma once

// One Ring's scheduler: it walks the channels of the current scene on a beat
// clock and hands each command to a sink. Ported from One Ring 0.4's core
// (plans/active/one-ring-native.md); the class was `Engine` there, a name this
// engine already uses for itself. Its behaviour is the VST's but for what the
// author's first trial found: `beginCommand`, and a scene recall at rest or
// cut short by STOP.

#include "model.h"

#include <array>

namespace mlh::one_ring {

struct Event {
    const Action* action = nullptr;
    const CommandDescriptor* descriptor = nullptr;
    Value value;
    double beat = 0;
    std::size_t source = 0;
    bool release = false;
};

class EventSink {
public:
    virtual ~EventSink() = default;
    virtual bool send(const Event&) noexcept = 0;
    // The clock is about to play what falls on `beat`: what the sink keeps in
    // time with it -- the notes a capture takes -- is brought up to there first.
    virtual void reach(double) noexcept {}
};

struct ChannelState {
    bool enabled = true;
    bool active = false;
    int playhead = -1;
    std::uint64_t loop = 1;
    std::uint64_t execution = 0;
    std::uint64_t ordinal = 0;
    double origin = 0;
    double due = 0;
    bool held = false;
    Value heldValue;
};

// Plans and registry objects outlive their use here. Their owner publishes
// replacements at block boundaries and reclaims old data off the audio thread.
// About 250 KB of fixed storage: an owner allocates it once, never per block.
class Scheduler {
public:
    void bind(const Project&, const CommandRegistry&, EventSink&, bool registryOnly = false) noexcept;
    void play(double beat) noexcept;
    void stop(double beat) noexcept;
    void advance(double beginBeat, double endBeat) noexcept;
    void command(std::size_t channel, const std::string& command, double beat) noexcept;
    void scene(std::size_t index, double beat) noexcept;
    // Called before a command from outside the sequence: RUN, STOP, a button.
    // The guards against a sequence that restarts or recalls itself in a loop
    // count per tick, and a clock at rest never starts a new tick -- the VST
    // took a second scene pressed while stopped for such a loop, and refused
    // it. A press is its own tick; what it sets off is still guarded.
    void beginCommand(double beat) noexcept;
    void shiftTimeline(double delta) noexcept;
    void setBarLength(double beats) noexcept { if (beats > 0) barBeats_ = beats; }
    const std::array<ChannelState, channelCount>& states() const noexcept { return states_; }
    std::size_t currentScene() const noexcept { return scene_; }
    // The scene a Next bar recall waits to play, or -1.
    int pendingScene() const noexcept { return pendingSceneBeat_ >= 0 ? static_cast<int>(pendingScene_) : -1; }
    bool playing() const noexcept { return playing_; }
    std::uint64_t rejected() const noexcept { return rejected_; }
    std::uint64_t cycleGuards() const noexcept { return cycleGuards_; }
    // How many recalls have played: a recall of the scene already playing counts.
    std::uint64_t recalls() const noexcept { return recalls_; }

private:
    const Project* project_ = nullptr;
    const CommandRegistry* registry_ = nullptr;
    EventSink* sink_ = nullptr;
    std::size_t scene_ = 0;
    std::array<ChannelState, channelCount> states_{};
    std::array<bool, channelCount> startedThisTick_{};
    std::array<Event, 4096> events_{};
    std::size_t eventRead_ = 0, eventWrite_ = 0;
    bool playing_ = false, sceneChangedThisTick_ = false;
    bool dispatching_ = false;
    double tick_ = -1;
    double barBeats_ = 4;
    std::size_t pendingScene_ = 0;
    double pendingSceneBeat_ = -1;
    std::uint64_t rejected_ = 0, cycleGuards_ = 0, recalls_ = 0;

    const Channel& channel(std::size_t i) const noexcept;
    void beginTick(double) noexcept;
    void restart(std::size_t, double) noexcept;
    void release(std::size_t, double) noexcept;
    void enqueue(const Action&, const ValueSource&, std::size_t, double, bool release = false) noexcept;
    void dispatch() noexcept;
    void schedule(std::size_t) noexcept;
    void step(std::size_t, double, const ConditionContext&) noexcept;
    void applyScene(std::size_t, double) noexcept;
};

// The external registry plus One Ring's own targets: each channel's START,
// STOP, RESTART, RESET, TOGGLE, ENABLE and DISABLE, the scene recall, and the
// material's commands (`one-ring:memory`).
CommandRegistry withInternalCommands(const CommandRegistry&, const Project&);

extern const std::string memoryTarget;
extern const std::string writerTarget;
// `one-ring:voice:1` to `one-ring:voice:4`: the voice, from 0, or false.
bool voiceTarget(const std::string& target, std::size_t& voice) noexcept;

} // namespace mlh::one_ring
