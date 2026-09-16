#include "state_json.h"

#include <cmath>
#include <limits>
#include <stdexcept>

namespace mlh::one_ring {
namespace {

std::string text(const juce::var& object, const char* key)
{
    return object[key].toString().toStdString();
}

bool isNumber(const juce::var& value)
{
    return value.isInt() || value.isInt64() || value.isDouble();
}

Value readValue(const juce::var& object)
{
    const int type = object["type"];
    const auto& value = object["value"];
    if (type == 1 && !value.isBool()) throw std::invalid_argument("Boolean value required");
    if (type >= 2 && type <= 4) {
        if (!isNumber(value)) throw std::invalid_argument("Numeric value required");
        const double number = value;
        if (!std::isfinite(number)) throw std::invalid_argument("Finite value required");
        if (type != 3 && (std::trunc(number) != number
                          || number < std::numeric_limits<std::int32_t>::min()
                          || number > std::numeric_limits<std::int32_t>::max()))
            throw std::invalid_argument("32-bit integer value required");
    }
    switch (type) {
    case 0: return {};
    case 1: return static_cast<bool>(value);
    case 2: return static_cast<std::int32_t>(static_cast<double>(value));
    case 3: return static_cast<double>(value);
    case 4: return EnumValue{static_cast<std::int32_t>(static_cast<double>(value))};
    default: throw std::invalid_argument("Unknown value type");
    }
}

ValueSource readSource(const juce::var& object)
{
    ValueSource source;
    const int mode = object["mode"];
    if (mode < 0 || mode > 2) throw std::invalid_argument("Invalid value mode");
    source.mode = static_cast<ValueMode>(mode);
    source.fixed = readValue(object["fixed"]);
    source.minimum = readValue(object["min"]);
    source.maximum = readValue(object["max"]);
    if (const auto* values = object["choices"].getArray())
        for (const auto& value : *values) source.choices.push_back(readValue(value));
    return source;
}

Action readAction(const juce::var& object)
{
    return {text(object, "target"), text(object, "command"), readSource(object["value"])};
}

// A field a cell leaves out keeps the value the cell started from.
void readStep(const juce::var& object, Step& step)
{
    if (object.hasProperty("enabled")) step.enabled = object["enabled"];
    if (object.hasProperty("probability")) step.probability = object["probability"];
    if (object.hasProperty("value")) step.value = readSource(object["value"]);
    if (object.hasProperty("locked")) step.locked = object["locked"];
    if (object.hasProperty("lockedFields"))
        step.lockedFields = static_cast<std::uint32_t>(static_cast<int>(object["lockedFields"]));
    if (const auto* conditions = object["conditions"].getArray()) {
        step.conditions.clear();
        for (const auto& item : *conditions) {
            const int kind = item["kind"];
            if (kind < 0 || kind > 5) throw std::invalid_argument("Invalid condition");
            step.conditions.push_back({static_cast<ConditionKind>(kind),
                                       static_cast<std::uint32_t>(static_cast<int>(item["interval"])),
                                       static_cast<std::size_t>(static_cast<int>(item["channel"]))});
        }
    }
}

// Whole, a channel lists its 64 cells in order, as the VST writes them. Sparse,
// it lists only the cells that differ from its `blank` -- the cell every other
// index holds, an empty one when absent. The blank is what keeps a channel with a
// typed command small: choosing a command gives all 64 cells its default value.
// An empty list is a sparse channel with nothing programmed.
void readSteps(const juce::var& list, const juce::var& blankCell, Channel& channel)
{
    const auto* steps = list.getArray();
    if (steps == nullptr) throw std::invalid_argument("A channel needs its cells");
    const bool sparse = steps->isEmpty() || steps->getReference(0).hasProperty("index");
    if (!sparse) {
        if (steps->size() != static_cast<int>(maximumSteps))
            throw std::invalid_argument("A channel must preserve 64 authored cells");
        for (int i = 0; i < static_cast<int>(maximumSteps); ++i)
            readStep(steps->getReference(i), channel.steps[static_cast<std::size_t>(i)]);
        return;
    }
    Step blank;
    if (blankCell.isObject()) readStep(blankCell, blank);
    channel.steps.fill(blank);
    std::array<bool, maximumSteps> seen{};
    for (const auto& item : *steps) {
        const auto& index = item["index"];
        if (!(index.isInt() || index.isInt64()) || static_cast<int>(index) < 0
            || static_cast<int>(index) >= static_cast<int>(maximumSteps))
            throw std::invalid_argument("A listed cell needs an index from 0 to 63");
        const auto position = static_cast<std::size_t>(static_cast<int>(index));
        if (seen[position]) throw std::invalid_argument("A cell is listed twice");
        seen[position] = true;
        readStep(item, channel.steps[position]);
    }
}

} // namespace

Project readProject(const juce::var& state)
{
    if (!state.isObject()) throw std::invalid_argument("A One Ring state is an object");
    Project project;
    project.version = static_cast<std::uint32_t>(static_cast<int>(state["version"]));
    if (project.version != 1) throw std::invalid_argument("Unsupported One Ring state version");
    project.seed = std::stoull(text(state, "seed"));
    project.mutation = std::stoull(text(state, "mutation"));
    project.selectedScene = static_cast<std::size_t>(static_cast<int>(state["selectedScene"]));
    const int timing = state["sceneTiming"], position = state["scenePosition"];
    if (timing < 0 || timing > 1 || position < 0 || position > 1)
        throw std::invalid_argument("Invalid scene behavior");
    project.sceneTiming = static_cast<SceneTiming>(timing);
    project.scenePosition = static_cast<ScenePosition>(position);
    const auto* scenes = state["scenes"].getArray();
    if (scenes == nullptr || scenes->isEmpty()) throw std::invalid_argument("Missing scenes");
    for (const auto& item : *scenes) {
        Scene scene;
        scene.id = text(item, "id");
        scene.name = text(item, "name");
        const auto* channels = item["channels"].getArray();
        if (channels == nullptr || channels->size() != static_cast<int>(channelCount))
            throw std::invalid_argument("A scene must contain 16 channels");
        for (int index = 0; index < static_cast<int>(channelCount); ++index) {
            const auto& source = channels->getReference(index);
            auto& channel = scene.channels[static_cast<std::size_t>(index)];
            channel.target = readAction(source["target"]);
            channel.length = static_cast<std::size_t>(static_cast<int>(source["length"]));
            channel.resolution = {static_cast<std::uint32_t>(static_cast<int>(source["numerator"])),
                                  static_cast<std::uint32_t>(static_cast<int>(source["denominator"]))};
            const int mode = source["mode"];
            if (mode < 0 || mode > 1) throw std::invalid_argument("Invalid step mode");
            channel.mode = static_cast<StepMode>(mode);
            channel.repeats = static_cast<std::uint32_t>(static_cast<int>(source["repeats"]));
            channel.enabled = source["enabled"];
            channel.offsetSteps = source["offset"];
            channel.swing = source["swing"];
            channel.humanize = source["humanize"];
            channel.mutableFields = static_cast<std::uint32_t>(static_cast<int>(source["mutableFields"]));
            readSteps(source["steps"], source["blank"], channel);
            if (const auto* follow = source["follow"].getArray())
                for (const auto& action : *follow) channel.follow.push_back(readAction(action));
        }
        project.scenes.push_back(std::move(scene));
    }
    return project;
}

CommandRegistry readRegistry(const juce::var& root)
{
    CommandRegistry registry;
    const auto* modules = root["modules"].getArray();
    if (modules == nullptr) throw std::invalid_argument("A registry lists its modules");
    for (const auto& entry : *modules) {
        ModuleDescriptor module;
        module.id = text(entry, "id");
        module.label = text(entry, "label");
        // The ids travel in fixed-size packets, as they do from the VST.
        if (module.id.size() >= 256) throw std::invalid_argument("Target ID exceeds packet capacity");
        if (const auto* commands = entry["commands"].getArray())
            for (const auto& item : *commands) {
                CommandDescriptor command;
                command.id = text(item, "id");
                command.label = text(item, "label");
                if (command.id.size() >= 128) throw std::invalid_argument("Command ID exceeds packet capacity");
                const int type = item["type"];
                if (type < 0 || type > 4) throw std::invalid_argument("Invalid command type");
                command.type = static_cast<ValueType>(type);
                command.minimum = item["minimum"];
                command.maximum = item["maximum"];
                if (const auto* choices = item["choices"].getArray())
                    for (const auto& choice : *choices)
                        command.choices.push_back({EnumValue{static_cast<int>(choice["id"])}, text(choice, "label")});
                if (item.hasProperty("releaseCommand")) {
                    command.releaseCommand = text(item, "releaseCommand");
                    command.releaseValue = readValue(item["releaseValue"]);
                }
                module.commands.push_back(std::move(command));
            }
        registry.registerModule(std::move(module));
    }
    return registry;
}

} // namespace mlh::one_ring
