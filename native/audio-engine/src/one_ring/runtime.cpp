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

template <std::size_t N>
void copyText(char (&out)[N], const std::string& text) noexcept
{
    const auto size = std::min(N - 1, text.size());
    std::memcpy(out, text.data(), size);
    out[size] = 0;
}

} // namespace

Runtime::Runtime() : scheduler_(std::make_unique<Scheduler>()) {}

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

std::size_t Runtime::takeEvents(Packet* out, std::size_t capacity) noexcept
{
    std::size_t count = 0;
    while (count < capacity && output_.pop(out[count])) ++count;
    return count;
}

void Runtime::process(const Transport& transport, int numSamples, double sampleRate) noexcept
{
    readers_.fetch_add(1, std::memory_order_acq_rel);
    auto* plan = pending_.load(std::memory_order_acquire);
    if (plan == nullptr) {
        readers_.fetch_sub(1, std::memory_order_acq_rel);
        return;
    }
    const auto* previous = active_.load(std::memory_order_acquire);
    if (plan != previous) {
        scheduler_->bind(plan->project, plan->registry, *this,
                         previous != nullptr && previous->projectVersion == plan->projectVersion);
        active_.store(plan, std::memory_order_release);
    }
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
    const int request = playRequest_.exchange(-1, std::memory_order_acq_rel);
    if (request == 0) scheduler.stop(beat_);
    // Play starts it and Stop does not stop it: it keeps its own time at the
    // current tempo until its own STOP, as the VST did after a host stop.
    if (request == 1 || (hostPlaying && !previousHostPlaying_ && request != 0)) {
        if (!scheduler.playing()) beat_ = std::isfinite(hostBeat) ? hostBeat : 0.0;
        scheduler.play(beat_);
    }
    previousHostPlaying_ = hostPlaying;
    Command command;
    for (int i = 0; i < 256 && input_.pop(command); ++i) {
        if (command.kind == CommandKind::Channel)
            scheduler.command(command.index, channelCommands[command.name], beat_);
        else
            scheduler.scene(command.index, beat_);
    }
    if (scheduler.playing() && numSamples > 0 && std::isfinite(beatsPerSample) && beatsPerSample > 0) {
        const double end = beat_ + static_cast<double>(numSamples) * beatsPerSample;
        scheduler.advance(beat_, end);
        beat_ = end;
    }
    Status status;
    status.scene = scheduler.currentScene();
    status.playing = scheduler.playing();
    status.beat = beat_;
    status.bpm = beatsPerSample * 60.0 * sampleRate;
    status.rejected = scheduler.rejected() + dropped_;
    status.guarded = scheduler.cycleGuards();
    for (std::size_t i = 0; i < channelCount; ++i) {
        status.playhead[i] = scheduler.states()[i].playhead;
        status.active[i] = scheduler.states()[i].active;
    }
    status_.write(status);
    liveScene_.store(status.scene, std::memory_order_release);
    readers_.fetch_sub(1, std::memory_order_acq_rel);
}

bool Runtime::send(const Event& event) noexcept
{
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
