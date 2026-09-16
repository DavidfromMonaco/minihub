#pragma once

// One Ring's scheduler: it walks the channels of the current scene on a beat
// clock and hands each command to a sink. Ported from One Ring 0.4's core with
// its behaviour unchanged (plans/active/one-ring-native.md); the class was
// `Engine` there, a name this engine already uses for itself.

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
    void shiftTimeline(double delta) noexcept;
    void setBarLength(double beats) noexcept { if (beats > 0) barBeats_ = beats; }
    const std::array<ChannelState, channelCount>& states() const noexcept { return states_; }
    std::size_t currentScene() const noexcept { return scene_; }
    bool playing() const noexcept { return playing_; }
    std::uint64_t rejected() const noexcept { return rejected_; }
    std::uint64_t cycleGuards() const noexcept { return cycleGuards_; }

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
    std::uint64_t rejected_ = 0, cycleGuards_ = 0;

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
// STOP, RESTART, RESET, TOGGLE, ENABLE and DISABLE, and the scene recall.
CommandRegistry withInternalCommands(const CommandRegistry&, const Project&);

} // namespace mlh::one_ring
