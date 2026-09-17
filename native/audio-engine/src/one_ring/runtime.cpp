#include "runtime.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace mlh::one_ring {
namespace {

// Built before any callback runs: the scheduler takes a command's name by
// reference, and a std::string made in the callback would allocate.
const std::array<std::string, 7> channelCommands{
    "START", "STOP", "RESTART", "RESET", "TOGGLE", "ENABLE", "DISABLE"};
const std::array<std::string, 7> memoryCommands{
    "CAPTURE_REPLACE", "CAPTURE_ADD", "CAPTURE_END", "CLEAR", "FREEZE", "UNFREEZE", "REVERT"};

template <std::size_t N>
void copyText(char (&out)[N], const std::string& text) noexcept
{
    const auto size = std::min(N - 1, text.size());
    std::memcpy(out, text.data(), size);
    out[size] = 0;
}

} // namespace

bool memoryCommandNamed(const std::string& name, MemoryCommand& command) noexcept
{
    const auto found = std::find(memoryCommands.begin(), memoryCommands.end(), name);
    if (found == memoryCommands.end()) return false;
    command = static_cast<MemoryCommand>(found - memoryCommands.begin());
    return true;
}

Runtime::Runtime() : scheduler_(std::make_unique<Scheduler>())
{
    // The Sequencer's block for this node, at its sample offsets: sized once.
    scheduledInput_.ensureSize(8192);
}

Runtime::~Runtime() = default;

bool Runtime::setProject(Project project, bool restore, std::string& error)
{
    // An edit keeps the scene that is playing: a cell changed while scene C
    // plays must not send the sequence back to the scene the file opened in.
    // A restore is the file speaking, and its scene is the one to take.
    if (!restore && pending_.load(std::memory_order_acquire) != nullptr)
        project.selectedScene = liveScene_.load(std::memory_order_acquire);
    const auto scene = project.selectedScene;
    if (!publish(std::move(project), false, error)) return false;
    liveScene_.store(scene, std::memory_order_release);
    return true;
}

bool Runtime::setTargets(CommandRegistry external, std::uint64_t revision, std::string& error)
{
    const auto* current = pending_.load(std::memory_order_acquire);
    if (current == nullptr) {
        error = "no sequence to aim";
        return false;
    }
    auto previous = std::move(external_);
    const auto previousRevision = registryRevision_;
    external_ = std::move(external);
    registryRevision_ = revision;
    auto project = current->project;
    project.selectedScene = liveScene_.load(std::memory_order_acquire);
    if (publish(std::move(project), true, error)) return true;
    external_ = std::move(previous);
    registryRevision_ = previousRevision;
    return false;
}

bool Runtime::publish(Project project, bool registryOnly, std::string& error)
{
    auto plan = std::make_unique<Plan>();
    plan->project = std::move(project);
    plan->revision = registryRevision_;
    try {
        plan->registry = withInternalCommands(external_, plan->project);
        if (!registryOnly) {
            // One Ring's own targets only: see setProject in the header.
            const auto errors = validate(plan->project, withInternalCommands(CommandRegistry{}, plan->project));
            if (!errors.empty()) {
                error = errors.front();
                return false;
            }
        }
    } catch (const std::exception& failure) {
        error = failure.what();
        return false;
    }
    plan->projectVersion = registryOnly ? projectVersion_ : ++projectVersion_;
    auto* published = plan.get();
    plans_.push_back(std::move(plan));
    pending_.store(published, std::memory_order_release);
    reclaim();
    return true;
}

void Runtime::reclaim() noexcept
{
    if (readers_.load(std::memory_order_acquire) != 0) return;
    const auto* keepPending = pending_.load(std::memory_order_acquire);
    const auto* keepActive = active_.load(std::memory_order_acquire);
    plans_.erase(std::remove_if(plans_.begin(), plans_.end(), [&](const auto& plan) {
        return plan.get() != keepPending && plan.get() != keepActive;
    }), plans_.end());
}

bool Runtime::channelCommand(std::size_t channel, const std::string& command) noexcept
{
    if (channel >= channelCount) return false;
    const auto found = std::find(channelCommands.begin(), channelCommands.end(), command);
    if (found == channelCommands.end()) return false;
    return input_.push({CommandKind::Channel,
                        static_cast<std::uint8_t>(found - channelCommands.begin()),
                        static_cast<std::uint16_t>(channel)});
}

bool Runtime::recallScene(std::size_t scene) noexcept
{
    const auto* plan = pending_.load(std::memory_order_acquire);
    if (plan == nullptr || scene >= plan->project.scenes.size()) return false;
    return input_.push({CommandKind::Scene, 0, static_cast<std::uint16_t>(scene)});
}

bool Runtime::memoryCommand(MemoryCommand command) noexcept
{
    return input_.push({CommandKind::Memory, static_cast<std::uint8_t>(command), 0});
}

void Runtime::setMaterial(const Material& material) noexcept
{
    materialIn_.write(material);
}

bool Runtime::pushLiveInput(const unsigned char* bytes, int size) noexcept
{
    if (bytes == nullptr || size < 1 || size > 3) return false;
    LiveNote note;
    std::memcpy(note.bytes, bytes, static_cast<std::size_t>(size));
    note.size = size;
    return liveNotes_.push(note);
}

std::size_t Runtime::takeEvents(Packet* out, std::size_t capacity) noexcept
{
    std::size_t count = 0;
    while (count < capacity && output_.pop(out[count])) ++count;
    return count;
}

void Runtime::pushInput(const juce::MidiBuffer& buffer) noexcept
{
    scheduledInput_.addEvents(buffer, 0, -1, 0);
}

int Runtime::offsetOf(double beat) const noexcept
{
    const int last = std::max(0, blockSamples_ - 1);
    if (!(blockBeatsPerSample_ > 0) || !std::isfinite(beat)) return 0;
    const double samples = std::round((beat - blockBegin_) / blockBeatsPerSample_);
    if (!(samples > 0)) return 0;
    return samples >= last ? last : static_cast<int>(samples);
}

void Runtime::drainTo(int offset) noexcept
{
    // A controller's notes arrive between blocks: they count from its start.
    for (; liveRead_ < liveCount_; ++liveRead_) {
        capture_.advanceTo(0);
        capture_.note(0, liveBlock_[liveRead_].bytes, liveBlock_[liveRead_].size);
    }
    const int last = std::max(0, blockSamples_ - 1);
    while (inputAt_ != inputEnd_) {
        const auto event = *inputAt_;
        if (event.samplePosition >= offset) break;
        const int at = std::clamp(event.samplePosition, 0, last);
        capture_.advanceTo(at);
        capture_.note(at, event.data, event.numBytes);
        ++inputAt_;
    }
    if (blockSamples_ > 0) capture_.advanceTo(std::min(offset, last));
}

void Runtime::reach(double beat) noexcept
{
    drainTo(offsetOf(beat));
}

double Runtime::nextBarWait() const noexcept
{
    const auto wait = [](double beat) {
        if (!std::isfinite(beat) || beat < 0) return 0.0;
        const double bar = std::ceil(beat / beatsPerBar - 1.0e-9) * beatsPerBar;
        return std::max(0.0, bar - beat);
    };
    if (scheduler_->playing()) return wait(blockBegin_);
    if (hostPlaying_) return wait(hostBeat_);
    return 0.0;
}

void Runtime::report() noexcept
{
    outgoing_.revision = ++materialRevision_;
    outgoing_.material = material_;
    materialOut_.write(outgoing_);
}

void Runtime::captured(const NoteList& notes, CaptureMode mode) noexcept
{
    // A capture that heard nothing leaves the material as it was.
    if (notes.count == 0) return;
    if (material_.frozen) {
        ++materialRefused_;
        return;
    }
    if (mode == CaptureMode::Replace) material_.origin = notes;
    else materialRefused_ += merge(material_.origin, notes);
    material_.hasCurrent = false;
    material_.generation = 0;
    report();
}

void Runtime::memory(MemoryCommand command, int offset, bool fromOutside) noexcept
{
    const auto* plan = active_.load(std::memory_order_acquire);
    const auto bars = plan != nullptr ? plan->project.capture.bars : CaptureSettings{}.bars;
    switch (command) {
    case MemoryCommand::CaptureReplace:
    case MemoryCommand::CaptureAdd: {
        if (material_.frozen) {
            ++materialRefused_;
            return;
        }
        const auto mode = command == MemoryCommand::CaptureAdd ? CaptureMode::Add : CaptureMode::Replace;
        if (fromOutside) capture_.arm(offset, mode, bars, nextBarWait());
        else capture_.start(offset, mode, bars);
        return;
    }
    case MemoryCommand::CaptureEnd:
        capture_.end(offset);
        return;
    case MemoryCommand::Clear:
        if (material_.frozen) {
            ++materialRefused_;
            return;
        }
        if (material_.origin.count == 0 && !material_.hasCurrent && material_.generation == 0) return;
        material_.origin.clear();
        material_.origin.length = ticksPerBar;
        material_.current.clear();
        material_.hasCurrent = false;
        material_.generation = 0;
        report();
        return;
    case MemoryCommand::Freeze:
    case MemoryCommand::Unfreeze: {
        const bool frozen = command == MemoryCommand::Freeze;
        if (material_.frozen == frozen) return;
        material_.frozen = frozen;
        report();
        return;
    }
    case MemoryCommand::Revert:
        if (material_.frozen) {
            ++materialRefused_;
            return;
        }
        if (!material_.hasCurrent && material_.generation == 0) return;
        material_.hasCurrent = false;
        material_.generation = 0;
        report();
        return;
    }
}

void Runtime::process(const Transport& transport, int numSamples, double sampleRate) noexcept
{
    readers_.fetch_add(1, std::memory_order_acq_rel);
    auto* plan = pending_.load(std::memory_order_acquire);
    if (plan == nullptr) {
        scheduledInput_.clear();
        LiveNote dropped;
        while (liveNotes_.pop(dropped)) {}
        readers_.fetch_sub(1, std::memory_order_acq_rel);
        return;
    }
    const auto* previous = active_.load(std::memory_order_acquire);
    if (plan != previous) {
        scheduler_->bind(plan->project, plan->registry, *this,
                         previous != nullptr && previous->projectVersion == plan->projectVersion);
        active_.store(plan, std::memory_order_release);
    }
    if (const auto* given = materialIn_.take()) material_ = *given;
    auto& scheduler = *scheduler_;
    const double beatsPerSample = transport.quarterNotesPerSample();
    const bool hostPlaying = transport.processingPlaying();
    const double hostBeat = transport.ppqPosition();
    // A seek or a loop wrap while both play: the sequence moves with the
    // arrangement instead of drifting away from it.
    if (hostPlaying && scheduler.playing() && std::isfinite(hostBeat)
        && std::abs(hostBeat - beat_) > 2.0 * beatsPerSample) {
        scheduler.shiftTimeline(hostBeat - beat_);
        beat_ = hostBeat;
    }
    const bool clockValid = numSamples > 0 && std::isfinite(beatsPerSample) && beatsPerSample > 0;
    blockSamples_ = std::max(0, numSamples);
    blockBeatsPerSample_ = clockValid ? beatsPerSample : 0.0;
    hostPlaying_ = hostPlaying;
    hostBeat_ = hostBeat;
    capture_.begin(blockSamples_, blockBeatsPerSample_);
    liveCount_ = 0;
    liveRead_ = 0;
    for (LiveNote note; liveCount_ < liveBlock_.size() && liveNotes_.pop(note);) liveBlock_[liveCount_++] = note;
    inputAt_ = scheduledInput_.begin();
    inputEnd_ = scheduledInput_.end();

    const int request = playRequest_.exchange(-1, std::memory_order_acq_rel);
    blockBegin_ = beat_;
    if (request == 0) {
        scheduler.beginCommand(beat_);
        scheduler.stop(beat_);
    }
    // Play starts it. The transport stopping does not stop it: it keeps its
    // own time at the current tempo, as the VST did after a host stop, so a
    // sequence can stop the arrangement and play on. The Stop a person gives
    // reaches it as a STOP of its own (the engine's setTransport).
    if (request == 1 || (hostPlaying && !previousHostPlaying_ && request != 0)) {
        if (!scheduler.playing()) beat_ = std::isfinite(hostBeat) ? hostBeat : 0.0;
        blockBegin_ = beat_;
        scheduler.beginCommand(beat_);
        scheduler.play(beat_);
    }
    previousHostPlaying_ = hostPlaying;
    Command command;
    for (int i = 0; i < 256 && input_.pop(command); ++i) {
        scheduler.beginCommand(beat_);
        if (command.kind == CommandKind::Channel)
            scheduler.command(command.index, channelCommands[command.name], beat_);
        else if (command.kind == CommandKind::Scene)
            scheduler.scene(command.index, beat_);
        else if (command.name < memoryCommands.size()) {
            drainTo(0);
            memory(static_cast<MemoryCommand>(command.name), 0, true);
        }
    }
    if (scheduler.playing() && clockValid) {
        const double end = beat_ + static_cast<double>(numSamples) * beatsPerSample;
        scheduler.advance(beat_, end);
        beat_ = end;
    }
    drainTo(blockSamples_);
    capture_.finish();
    scheduledInput_.clear();

    Status status;
    status.scene = scheduler.currentScene();
    status.pendingScene = scheduler.pendingScene();
    status.playing = scheduler.playing();
    status.beat = beat_;
    status.bpm = beatsPerSample * 60.0 * sampleRate;
    status.rejected = scheduler.rejected() + dropped_;
    status.guarded = scheduler.cycleGuards();
    for (std::size_t i = 0; i < channelCount; ++i) {
        status.playhead[i] = scheduler.states()[i].playhead;
        status.active[i] = scheduler.states()[i].active;
    }
    status.capture = capture_.state();
    status.captured = capture_.taken();
    status.captureRefused = capture_.refused() + materialRefused_;
    status.originNotes = material_.origin.count;
    status.currentNotes = material_.hasCurrent ? material_.current.count : 0;
    status.hasCurrent = material_.hasCurrent;
    status.frozen = material_.frozen;
    status.materialGeneration = material_.generation;
    status.materialRevision = materialRevision_;
    status_.write(status);
    liveScene_.store(status.scene, std::memory_order_release);
    readers_.fetch_sub(1, std::memory_order_acq_rel);
}

bool Runtime::send(const Event& event) noexcept
{
    if (event.action->target == memoryTarget) {
        const auto& name = event.release ? *event.descriptor->releaseCommand : event.action->command;
        MemoryCommand command;
        if (!memoryCommandNamed(name, command)) return false;
        const int offset = offsetOf(event.beat);
        drainTo(offset);
        memory(command, offset, false);
        return true;
    }
    Packet packet;
    packet.sequence = ++sequence_;
    const auto* plan = active_.load(std::memory_order_acquire);
    packet.registryRevision = plan != nullptr ? plan->revision : 0;
    packet.beat = event.beat;
    copyText(packet.target, event.action->target);
    copyText(packet.command, event.release ? *event.descriptor->releaseCommand : event.action->command);
    packet.valueType = static_cast<std::uint32_t>(event.value.index());
    if (const auto* flag = std::get_if<bool>(&event.value)) packet.number = *flag ? 1.0 : 0.0;
    else if (const auto* integer = std::get_if<std::int32_t>(&event.value)) packet.number = *integer;
    else if (const auto* number = std::get_if<double>(&event.value)) packet.number = *number;
    else if (const auto* choice = std::get_if<EnumValue>(&event.value)) packet.number = choice->id;
    if (output_.push(packet)) return true;
    ++dropped_;
    return false;
}

} // namespace mlh::one_ring
