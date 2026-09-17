#include "scheduler.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <limits>

namespace mlh::one_ring {
namespace {
constexpr double epsilon = 1.0e-10;
const char* channelPrefix = "one-ring:channel:";
}

const std::string memoryTarget = "one-ring:memory";
const std::string writerTarget = "one-ring:writer";

namespace {
const char* voicePrefix = "one-ring:voice:";
const char* rootNames[] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
const char* scaleNames[] = {"Chromatic", "Major / Ionian", "Natural Minor / Aeolian", "Harmonic Minor", "Dorian",
                            "Phrygian", "Lydian", "Mixolydian", "Locrian", "Major Pentatonic", "Minor Pentatonic"};

CommandDescriptor whole(const char* id, int minimum, int maximum)
{
    CommandDescriptor command;
    command.id = command.label = id;
    command.type = ValueType::Integer;
    command.minimum = minimum;
    command.maximum = maximum;
    command.domain = ExecutionDomain::Audio;
    return command;
}

CommandDescriptor named(const char* id, const char* const* labels, int count)
{
    CommandDescriptor command;
    command.id = command.label = id;
    command.type = ValueType::Enumeration;
    command.domain = ExecutionDomain::Audio;
    for (int i = 0; i < count; ++i) command.choices.push_back({EnumValue{i}, labels[i]});
    return command;
}
} // namespace

bool voiceTarget(const std::string& target, std::size_t& voice) noexcept
{
    if (target.size() != 16 || target.compare(0, 15, voicePrefix) != 0) return false;
    const char digit = target[15];
    if (digit < '1' || digit > '0' + static_cast<char>(voiceCount)) return false;
    voice = static_cast<std::size_t>(digit - '1');
    return true;
}

CommandRegistry withInternalCommands(const CommandRegistry& external, const Project& project)
{
    CommandRegistry registry = external;
    for (std::size_t i = 0; i < channelCount; ++i) {
        ModuleDescriptor module;
        module.id = std::string(channelPrefix) + std::to_string(i + 1);
        module.label = "One Ring Channel / CH" + std::to_string(i + 1);
        for (const auto* name : {"START", "STOP", "RESTART", "RESET", "TOGGLE", "ENABLE", "DISABLE"}) {
            CommandDescriptor command;
            command.id = command.label = name;
            command.domain = ExecutionDomain::Audio;
            module.commands.push_back(command);
        }
        module.commands[0].releaseCommand = "STOP";
        registry.registerModule(std::move(module));
    }
    CommandDescriptor recall;
    recall.id = recall.label = "RECALL";
    recall.type = ValueType::Enumeration;
    recall.domain = ExecutionDomain::Audio;
    for (std::size_t i = 0; i < project.scenes.size(); ++i)
        recall.choices.push_back({EnumValue{static_cast<std::int32_t>(i)}, project.scenes[i].name});
    registry.registerModule({"one-ring:scenes", "One Ring Scenes", {recall}});
    ModuleDescriptor memory;
    memory.id = memoryTarget;
    memory.label = "One Ring Memory";
    for (const auto* name : {"CAPTURE_REPLACE", "CAPTURE_ADD", "CAPTURE_END", "CLEAR", "FREEZE", "UNFREEZE", "REVERT"}) {
        CommandDescriptor command;
        command.id = command.label = name;
        command.domain = ExecutionDomain::Audio;
        memory.commands.push_back(command);
    }
    // A Legato channel holds a capture open while its steps play.
    memory.commands[0].releaseCommand = "CAPTURE_END";
    memory.commands[1].releaseCommand = "CAPTURE_END";
    registry.registerModule(std::move(memory));
    for (std::size_t v = 0; v < voiceCount; ++v) {
        ModuleDescriptor voice;
        voice.id = std::string(voicePrefix) + std::to_string(v + 1);
        voice.label = "One Ring Voice " + std::to_string(v + 1);
        voice.commands.push_back(whole("PLAY", -1, 63));
        auto note = whole("NOTE", 0, 255);
        // A Legato channel ties a note over the steps that repeat its value.
        note.releaseCommand = "NOTE_OFF";
        voice.commands.push_back(note);
        CommandDescriptor off;
        off.id = off.label = "NOTE_OFF";
        off.domain = ExecutionDomain::Audio;
        voice.commands.push_back(off);
        voice.commands.push_back(whole("TRANSPOSE", -48, 48));
        voice.commands.push_back(whole("OCTAVE", -3, 3));
        voice.commands.push_back(named("ROOT", rootNames, 12));
        voice.commands.push_back(named("SCALE", scaleNames, 11));
        voice.commands.push_back(whole("VELOCITY", 0, 200));
        voice.commands.push_back(whole("GATE", 5, 400));
        voice.commands.push_back(whole("DENSITY", 0, 100));
        registry.registerModule(std::move(voice));
    }
    ModuleDescriptor writer;
    writer.id = writerTarget;
    writer.label = "One Ring Writer";
    for (const auto* name : {"WRITE", "FEEDBACK_ON", "FEEDBACK_OFF"}) {
        CommandDescriptor command;
        command.id = command.label = name;
        command.domain = ExecutionDomain::Audio;
        writer.commands.push_back(command);
    }
    registry.registerModule(std::move(writer));
    return registry;
}

const Channel& Scheduler::channel(std::size_t i) const noexcept
{
    return project_->scenes[scene_].channels[i];
}

void Scheduler::bind(const Project& project, const CommandRegistry& registry, EventSink& sink, bool registryOnly) noexcept
{
    if (project.scenes.empty()) return;
    if (registryOnly && project_ && registry_) {
        // Discovery must not reset playback or release an unchanged legato.
        // The host releases actions whose route/target has disappeared.
        for (std::size_t i = 0; i < channelCount; ++i) {
            if (!states_[i].held) continue;
            const auto& action = channel(i).target;
            const auto* before = registry_->find(action.target, action.command);
            const auto* after = registry.find(action.target, action.command);
            if (!before || !after || before->releaseCommand != after->releaseCommand
                || before->releaseValue != after->releaseValue
                || validate(*after, states_[i].heldValue) != Validation::Ok)
                states_[i].held = false;
        }
        project_ = &project;
        registry_ = &registry;
        sink_ = &sink;
        return;
    }
    if (project_ && sink_) {
        for (std::size_t i = 0; i < channelCount; ++i) release(i, std::max(0.0, tick_));
        dispatch();
    }
    project_ = &project;
    registry_ = &registry;
    sink_ = &sink;
    scene_ = std::min(project.selectedScene, project.scenes.size() - 1);
    for (std::size_t i = 0; i < channelCount; ++i) {
        states_[i].enabled = channel(i).enabled;
        if (!states_[i].enabled) states_[i].active = false;
        if (states_[i].active) schedule(i);
    }
}

void Scheduler::beginTick(double beat) noexcept
{
    if (std::abs(beat - tick_) <= epsilon) return;
    tick_ = beat;
    startedThisTick_.fill(false);
    sceneChangedThisTick_ = false;
    eventRead_ = eventWrite_ = 0;
}

void Scheduler::beginCommand(double beat) noexcept
{
    beginTick(beat);
    startedThisTick_.fill(false);
    sceneChangedThisTick_ = false;
}

void Scheduler::play(double beat) noexcept
{
    if (!project_ || playing_) return;
    beginTick(beat);
    playing_ = true;
    for (std::size_t i = 0; i < channelCount; ++i) {
        states_[i].enabled = channel(i).enabled;
        if (states_[i].enabled) restart(i, beat);
    }
}

void Scheduler::stop(double beat) noexcept
{
    if (!project_) return;
    beginTick(beat);
    for (std::size_t i = 0; i < channelCount; ++i) {
        release(i, beat);
        states_[i].active = false;
        states_[i].playhead = -1;
        states_[i].ordinal = 0;
        states_[i].loop = 1;
    }
    playing_ = false;
    // A recall still waiting for its bar is not lost to STOP: the scene asked
    // for is the one shown, and the one the next RUN starts in.
    if (pendingSceneBeat_ >= 0) {
        pendingSceneBeat_ = -1;
        applyScene(pendingScene_, beat);
    }
    dispatch();
}

void Scheduler::restart(std::size_t i, double beat) noexcept
{
    if (startedThisTick_[i]) { ++cycleGuards_; return; }
    startedThisTick_[i] = true;
    release(i, beat);
    auto& state = states_[i];
    state.active = state.enabled;
    state.playhead = -1;
    state.ordinal = 0;
    state.loop = 1;
    ++state.execution;
    state.origin = beat;
    schedule(i);
}

void Scheduler::command(std::size_t i, const std::string& name, double beat) noexcept
{
    if (!project_ || i >= channelCount) { ++rejected_; return; }
    beginTick(beat);
    auto& state = states_[i];
    if (name == "ENABLE") state.enabled = true;
    else if (name == "DISABLE" || name == "STOP" || (name == "TOGGLE" && state.active)) {
        release(i, beat);
        state.active = false;
        state.playhead = -1;
        state.ordinal = 0;
        state.loop = 1;
        if (name == "DISABLE") state.enabled = false;
    } else if (name == "RESTART" || name == "RESET" || name == "START" || name == "TOGGLE") {
        if (name == "START" && state.active) return;
        const bool active = state.active;
        restart(i, beat);
        if (name == "RESET") state.active = active;
        if (state.active) playing_ = true;
    } else ++rejected_;
    dispatch();
}

void Scheduler::schedule(std::size_t i) noexcept
{
    auto& state = states_[i];
    const auto& config = channel(i);
    const double duration = config.resolution.beats();
    const auto stepIndex = state.ordinal % config.length;
    double shift = 0;
    if (stepIndex != 0) {
        Random random({project_->seed, state.execution, state.ordinal / config.length,
            static_cast<std::uint32_t>(i), static_cast<std::uint32_t>(stepIndex)}, RandomStream::Humanize);
        shift = std::min(0.95, ((state.ordinal & 1) ? config.swing * 0.5 : 0)
                               + config.humanize * random.unit());
    }
    // Jitter moves an onset inside its own cell. Loop boundaries stay on the
    // unmodified grid, preventing a random walk away from the host tempo.
    // Negative phase wraps within one cycle: -1 starts one cell before the
    // next unshifted cycle. Never compress several past onsets into one tick.
    double offset = config.offsetSteps;
    if (offset < 0) { offset = std::fmod(offset, static_cast<double>(config.length)); if (offset < 0) offset += config.length; }
    state.due = state.origin + (static_cast<double>(state.ordinal) + offset + shift) * duration;
}

void Scheduler::enqueue(const Action& action, const ValueSource& source, std::size_t i,
                        double beat, bool isRelease) noexcept
{
    if (action.target.empty() && action.command.empty()) return;
    const auto* descriptor = registry_->find(action.target, action.command);
    if (!descriptor || validate(*descriptor, source) != Validation::Ok) { ++rejected_; return; }
    if (eventWrite_ == events_.size()) { ++cycleGuards_; return; }
    auto& state = states_[i];
    Random random({project_->seed, state.execution, state.loop, static_cast<std::uint32_t>(i),
        static_cast<std::uint32_t>(std::max(0, state.playhead))}, RandomStream::Value);
    events_[eventWrite_++] = {&action, descriptor, sample(source, random), beat, i, isRelease};
}

void Scheduler::release(std::size_t i, double beat) noexcept
{
    auto& state = states_[i];
    if (!state.held) return;
    state.held = false;
    const auto& action = channel(i).target;
    const auto* descriptor = registry_->find(action.target, action.command);
    if (descriptor && descriptor->releaseCommand && eventWrite_ < events_.size())
        events_[eventWrite_++] = {&action, descriptor, descriptor->releaseValue, beat, i, true};
    else ++rejected_;
}

void Scheduler::dispatch() noexcept
{
    if (dispatching_) return;
    dispatching_ = true;
    while (eventRead_ < eventWrite_) {
        const auto event = events_[eventRead_++];
        const auto& target = event.action->target;
        const auto& name = event.release ? *event.descriptor->releaseCommand : event.action->command;
        if (target.compare(0, 17, channelPrefix) == 0) {
            unsigned int i = 0;
            const auto parsed = std::from_chars(target.data() + 17, target.data() + target.size(), i);
            if (parsed.ec == std::errc{} && parsed.ptr == target.data() + target.size() && i >= 1 && i <= channelCount)
                command(i - 1, name, event.beat);
            else ++rejected_;
        } else if (target == "one-ring:scenes" && name == "RECALL") {
            if (const auto* index = std::get_if<EnumValue>(&event.value))
                scene(static_cast<std::size_t>(index->id), event.beat);
            else ++rejected_;
        } else if (!sink_->send(event)) ++rejected_;
    }
    dispatching_ = false;
}

void Scheduler::step(std::size_t i, double beat, const ConditionContext& snapshot) noexcept
{
    auto& state = states_[i];
    const auto& config = channel(i);
    if (state.ordinal > 0 && state.ordinal % config.length == 0) {
        const auto completed = state.ordinal / config.length;
        if (config.repeats && completed >= config.repeats) {
            release(i, beat);
            state.active = false;
            state.playhead = -1;
            for (const auto& action : config.follow) enqueue(action, action.value, i, beat);
            state.ordinal = 0;
            state.loop = 1;
            return;
        }
    }
    state.loop = state.ordinal / config.length + 1;
    state.playhead = static_cast<int>(state.ordinal % config.length);
    const auto& current = config.steps[static_cast<std::size_t>(state.playhead)];
    auto conditions = snapshot;
    conditions.loop = state.loop;
    conditions.repeats = config.repeats;
    Random probability({project_->seed, state.execution, state.loop, static_cast<std::uint32_t>(i),
        static_cast<std::uint32_t>(state.playhead)}, RandomStream::Probability);
    const bool fire = current.enabled && evaluate(current.conditions, conditions)
                      && probability.probability(current.probability);
    if (!fire) release(i, beat);
    else if (config.mode == StepMode::Trigger) enqueue(config.target, current.value, i, beat);
    else {
        Random values({project_->seed, state.execution, state.loop, static_cast<std::uint32_t>(i),
            static_cast<std::uint32_t>(state.playhead)}, RandomStream::Value);
        const auto value = sample(current.value, values);
        if (!state.held || value != state.heldValue) {
            const auto* descriptor = registry_->find(config.target.target, config.target.command);
            if (descriptor && descriptor->releaseCommand && validate(*descriptor, current.value) == Validation::Ok) {
                release(i, beat);
                enqueue(config.target, current.value, i, beat);
                state.held = true;
                state.heldValue = value;
            } else ++rejected_;
        }
    }
    ++state.ordinal;
    schedule(i);
}

void Scheduler::scene(std::size_t index, double beat) noexcept
{
    if (!project_ || index >= project_->scenes.size()) { ++rejected_; return; }
    beginTick(beat);
    // Next bar means a bar of a sequence that plays. At rest there is no bar
    // to wait for, and a recall left pending would fire wherever RUN starts.
    if (project_->sceneTiming == SceneTiming::NextBar && playing_) {
        pendingScene_ = index;
        pendingSceneBeat_ = std::ceil((beat + epsilon) / barBeats_) * barBeats_;
    } else applyScene(index, beat);
    dispatch();
}

void Scheduler::applyScene(std::size_t index, double beat) noexcept
{
    if (sceneChangedThisTick_) { ++cycleGuards_; return; }
    sceneChangedThisTick_ = true;
    ++recalls_;
    std::array<double, channelCount> remaining{};
    for (std::size_t i = 0; i < channelCount; ++i) {
        remaining[i] = std::max(0.0, states_[i].due - beat) / channel(i).resolution.beats();
        release(i, beat);
    }
    // Release events reference the old immutable scene until dispatch ends.
    scene_ = index;
    for (std::size_t i = 0; i < channelCount; ++i) {
        auto& state = states_[i];
        state.enabled = channel(i).enabled;
        if (project_->scenePosition == ScenePosition::Restart) {
            state.active = playing_ && state.enabled;
            state.ordinal = 0;
            state.loop = 1;
            state.playhead = -1;
            state.origin = beat;
            ++state.execution;
        } else {
            state.active = state.active && state.enabled;
            state.playhead = state.playhead < 0 ? -1 : state.playhead % static_cast<int>(channel(i).length);
        }
        schedule(i);
        if (project_->scenePosition == ScenePosition::Preserve) {
            const double desired = beat + remaining[i] * channel(i).resolution.beats();
            state.origin += desired - state.due;
            state.due = desired;
        }
    }
}

void Scheduler::shiftTimeline(double delta) noexcept
{
    if (!std::isfinite(delta)) return;
    for (auto& state : states_) { state.origin += delta; state.due += delta; }
    tick_ += delta;
    if (pendingSceneBeat_ >= 0) pendingSceneBeat_ += delta;
}

void Scheduler::advance(double beginBeat, double endBeat) noexcept
{
    if (!project_ || !playing_ || !std::isfinite(beginBeat) || !std::isfinite(endBeat) || endBeat < beginBeat) return;
    // The bound covers malicious resolutions and large time discontinuities;
    // normal audio blocks need at most a handful of iterations.
    for (std::size_t iteration = 0; iteration < 8192; ++iteration) {
        double next = std::numeric_limits<double>::infinity();
        for (const auto& state : states_) if (state.active) next = std::min(next, state.due);
        if (pendingSceneBeat_ >= 0) next = std::min(next, pendingSceneBeat_);
        if (next >= endBeat - epsilon) return;
        next = std::max(next, beginBeat);
        sink_->reach(next);
        beginTick(next);
        if (pendingSceneBeat_ >= 0 && pendingSceneBeat_ <= next + epsilon) {
            const auto index = pendingScene_;
            pendingSceneBeat_ = -1;
            applyScene(index, next);
        }
        ConditionContext snapshot;
        for (std::size_t i = 0; i < channelCount; ++i) snapshot.active[i] = states_[i].active;
        for (std::size_t i = 0; i < channelCount; ++i)
            if (states_[i].active && states_[i].due <= next + epsilon) step(i, next, snapshot);
        dispatch();
    }
    ++cycleGuards_;
    stop(endBeat);
}

} // namespace mlh::one_ring
