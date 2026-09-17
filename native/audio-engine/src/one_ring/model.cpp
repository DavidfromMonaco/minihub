#include "model.h"

#include <algorithm>
#include <cmath>

namespace mlh::one_ring {

Project makeProject(SceneTiming timing, ScenePosition position)
{
    Project project;
    project.sceneTiming = timing;
    project.scenePosition = position;
    for (const auto* name : {"A", "B", "C", "D"}) {
        Scene scene;
        scene.id = name;
        scene.name = std::string("Scene ") + name;
        project.scenes.push_back(std::move(scene));
    }
    return project;
}

std::vector<std::string> validate(const Project& project, const CommandRegistry& registry)
{
    std::vector<std::string> errors;
    if (project.version != 1) errors.push_back("Unsupported project version");
    if ((project.sceneTiming != SceneTiming::Immediate && project.sceneTiming != SceneTiming::NextBar)
        || (project.scenePosition != ScenePosition::Restart && project.scenePosition != ScenePosition::Preserve))
        errors.push_back("Invalid scene policy");
    if (project.scenes.empty() || project.selectedScene >= project.scenes.size())
        errors.push_back("Missing selected scene");
    std::vector<std::string> ids;
    const auto actionValid = [&](const Action& action, const ValueSource& value) {
        if (action.target.empty() && action.command.empty()) return true;
        const auto* command = registry.find(action.target, action.command);
        // Unavailable modules remain authored in the project. Runtime reports
        // them as missing instead of discarding the user's sequence on load.
        return !command || validate(*command, value) == Validation::Ok;
    };
    for (const auto& scene : project.scenes) {
        if (scene.id.empty() || std::find(ids.begin(), ids.end(), scene.id) != ids.end())
            errors.push_back("Missing or duplicate scene ID");
        ids.push_back(scene.id);
        for (const auto& voice : scene.voices)
            if (!valid(voice)) errors.push_back("Invalid voice rules");
        for (const auto& channel : scene.channels) {
            if (channel.mode != StepMode::Trigger && channel.mode != StepMode::Legato) errors.push_back("Invalid step mode");
            if (channel.length != 4 && channel.length != 8 && channel.length != 16
                && channel.length != 32 && channel.length != 64)
                errors.push_back("Channel length must be 4, 8, 16, 32 or 64");
            if (!channel.resolution.numerator || !channel.resolution.denominator)
                errors.push_back("Invalid resolution");
            if (channel.repeats != 0 && channel.repeats != 1 && channel.repeats != 2
                && channel.repeats != 3 && channel.repeats != 4 && channel.repeats != 8)
                errors.push_back("Invalid repeat count");
            if (!std::isfinite(channel.offsetSteps) || !std::isfinite(channel.swing)
                || !std::isfinite(channel.humanize) || channel.swing < 0 || channel.swing > 0.95
                || channel.humanize < 0 || channel.humanize > 0.45)
                errors.push_back("Invalid timing parameters");
            const auto* descriptor = registry.find(channel.target.target, channel.target.command);
            if (channel.mode == StepMode::Legato && descriptor && !descriptor->releaseCommand)
                errors.push_back("Target has not declared a legato release");
            for (const auto& step : channel.steps) {
                if (!std::isfinite(step.probability) || step.probability < 0 || step.probability > 100)
                    errors.push_back("Probability must be between 0 and 100");
                if (!actionValid(channel.target, step.value)) errors.push_back("Invalid step value");
                for (const auto& condition : step.conditions) {
                    if (condition.kind < ConditionKind::Always || condition.kind > ConditionKind::ChannelInactive)
                        errors.push_back("Invalid condition");
                    if (condition.kind == ConditionKind::EveryNthLoop && condition.interval == 0)
                        errors.push_back("Loop interval must be positive");
                    if ((condition.kind == ConditionKind::ChannelActive
                        || condition.kind == ConditionKind::ChannelInactive) && condition.channel >= channelCount)
                        errors.push_back("Condition channel is outside CH1-CH16");
                }
            }
            for (const auto& action : channel.follow)
                if (!actionValid(action, action.value)) errors.push_back("Invalid follow action");
        }
    }
    return errors;
}

void mutate(Channel& channel, std::uint64_t seed, std::uint64_t mutation, std::size_t index)
{
    for (std::size_t i = 0; i < channel.length; ++i) {
        auto& step = channel.steps[i];
        if (step.locked) continue;
        Random random({seed, mutation, 0, static_cast<std::uint32_t>(index),
                       static_cast<std::uint32_t>(i)}, RandomStream::Mutation);
        // Every field draws even when locked, so protecting one field never
        // changes the mutations of the remaining fields.
        const bool enabled = random.probability(50);
        const auto probability = static_cast<double>(random.below(101));
        const auto value = sample(step.value, random);
        const auto other = sample(step.value, random);
        const auto fields = channel.mutableFields & ~step.lockedFields;
        if (fields & MutateEnabled) step.enabled = enabled;
        if (fields & MutateProbability) step.probability = probability;
        if (fields & MutateValue) {
            if (step.value.mode == ValueMode::Range) {
                if (const auto* first = std::get_if<std::int32_t>(&value)) {
                    const auto second = std::get<std::int32_t>(other);
                    step.value.minimum = std::min(*first, second);
                    step.value.maximum = std::max(*first, second);
                } else if (const auto* firstFloat = std::get_if<double>(&value)) {
                    const auto second = std::get<double>(other);
                    step.value.minimum = std::min(*firstFloat, second);
                    step.value.maximum = std::max(*firstFloat, second);
                }
            } else if (step.value.mode == ValueMode::Choice && !step.value.choices.empty()) {
                const auto rotation = static_cast<std::ptrdiff_t>(random.below(step.value.choices.size()));
                std::rotate(step.value.choices.begin(), step.value.choices.begin() + rotation, step.value.choices.end());
            }
        }
    }
}

} // namespace mlh::one_ring
