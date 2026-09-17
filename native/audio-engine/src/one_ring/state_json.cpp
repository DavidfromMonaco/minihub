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

bool isWhole(const juce::var& value)
{
    return value.isInt() || value.isInt64() || (value.isDouble() && std::trunc(static_cast<double>(value)) == static_cast<double>(value));
}

int wholeIn(const juce::var& value, int low, int high, const char* message)
{
    if (!isWhole(value)) throw std::invalid_argument(message);
    const double number = value;
    if (number < low || number > high) throw std::invalid_argument(message);
    return static_cast<int>(number);
}

// Part two's capture settings. A content saved before them has none, and
// captures one bar, replacing.
CaptureSettings readCapture(const juce::var& object)
{
    CaptureSettings settings;
    if (object.isVoid() || object.isUndefined()) return settings;
    if (!object.isObject()) throw std::invalid_argument("Invalid capture settings");
    if (object.hasProperty("mode"))
        settings.mode = static_cast<CaptureMode>(wholeIn(object["mode"], 0, 1, "Invalid capture mode"));
    if (object.hasProperty("bars"))
        settings.bars = static_cast<std::uint32_t>(wholeIn(object["bars"], 0, static_cast<int>(maximumCaptureBars),
                                                           "A capture lasts 0 to 16 bars"));
    return settings;
}

NoteList readNotes(const juce::var& object)
{
    if (!object.isObject()) throw std::invalid_argument("A note list is an object");
    NoteList list;
    list.length = wholeIn(object["length"], 1, maximumMaterialTicks, "A material lasts 1 tick to 64 bars");
    const auto* notes = object["notes"].getArray();
    if (notes == nullptr) throw std::invalid_argument("A note list needs its notes");
    if (notes->size() > static_cast<int>(materialCapacity)) throw std::invalid_argument("A material holds at most 256 notes");
    for (const auto& item : *notes) {
        MaterialNote note;
        note.pitch = static_cast<std::uint8_t>(wholeIn(item["pitch"], 0, 127, "A note's pitch is 0 to 127"));
        note.velocity = static_cast<std::uint8_t>(wholeIn(item["velocity"], 1, 127, "A note's velocity is 1 to 127"));
        note.channel = static_cast<std::uint8_t>(wholeIn(item["channel"], 1, 16, "A note's channel is 1 to 16"));
        note.start = wholeIn(item["start"], 0, list.length - 1, "A note starts inside its material");
        note.duration = wholeIn(item["duration"], 1, maximumMaterialTicks, "A note lasts 1 tick to 64 bars");
        list.add(note);
    }
    list.sort();
    return list;
}

juce::var notesToVar(const NoteList& list)
{
    juce::var object(new juce::DynamicObject());
    object.getDynamicObject()->setProperty("length", list.length);
    juce::Array<juce::var> notes;
    for (std::uint32_t i = 0; i < list.count; ++i) {
        const auto& note = list.notes[i];
        juce::var item(new juce::DynamicObject());
        auto* fields = item.getDynamicObject();
        fields->setProperty("pitch", static_cast<int>(note.pitch));
        fields->setProperty("velocity", static_cast<int>(note.velocity));
        fields->setProperty("channel", static_cast<int>(note.channel));
        fields->setProperty("start", note.start);
        fields->setProperty("duration", note.duration);
        notes.add(item);
    }
    object.getDynamicObject()->setProperty("notes", notes);
    return object;
}

int ruleIn(const juce::var& object, const char* key, int fallback, int low, int high)
{
    if (!object.hasProperty(key)) return fallback;
    return wholeIn(object[key], low, high, "Invalid voice rules");
}

// Part two's writer. A content saved before it has none: four bars, no feedback.
WriterSettings readWriter(const juce::var& object)
{
    WriterSettings settings;
    if (object.isVoid() || object.isUndefined()) return settings;
    if (!object.isObject()) throw std::invalid_argument("Invalid writer settings");
    if (object.hasProperty("bars"))
        settings.bars = static_cast<std::uint32_t>(wholeIn(object["bars"], 1, static_cast<int>(maximumWriterBars),
                                                           "A generation lasts 1 to 16 bars"));
    if (object.hasProperty("feedback")) {
        if (!object["feedback"].isBool()) throw std::invalid_argument("Invalid writer settings");
        settings.feedback = object["feedback"];
    }
    if (object.hasProperty("feedbackMode"))
        settings.feedbackMode = static_cast<CaptureMode>(wholeIn(object["feedbackMode"], 0, 1, "Invalid feedback mode"));
    if (object.hasProperty("delayBars"))
        settings.delayBars = static_cast<std::uint32_t>(wholeIn(object["delayBars"], 0,
            static_cast<int>(maximumFeedbackDelayBars), "A feedback delay is 0 to 64 bars"));
    if (object.hasProperty("limit"))
        settings.limit = static_cast<std::uint32_t>(wholeIn(object["limit"], 1,
            static_cast<int>(maximumFeedbackGenerations), "A feedback limit is 1 to 999 generations"));
    return settings;
}

// Part two's voices. A scene saved before them has none: every voice changes nothing.
std::array<VoiceRules, voiceCount> readVoices(const juce::var& list)
{
    std::array<VoiceRules, voiceCount> voices{};
    if (list.isVoid() || list.isUndefined()) return voices;
    const auto* items = list.getArray();
    if (items == nullptr || items->size() != static_cast<int>(voiceCount))
        throw std::invalid_argument("A scene has four voices");
    for (int i = 0; i < static_cast<int>(voiceCount); ++i) {
        const auto& item = items->getReference(i);
        if (!item.isObject()) throw std::invalid_argument("Invalid voice rules");
        auto& r = voices[static_cast<std::size_t>(i)];
        const VoiceRules d;
        r.channel = ruleIn(item, "channel", d.channel, 0, 16);
        r.root = ruleIn(item, "root", d.root, 0, 11);
        r.scale = ruleIn(item, "scale", d.scale, 0, 10);
        r.transpose = ruleIn(item, "transpose", d.transpose, -48, 48);
        r.octave = ruleIn(item, "octave", d.octave, -3, 3);
        r.octaveSpread = ruleIn(item, "octaveSpread", d.octaveSpread, 0, 3);
        r.octaveChance = ruleIn(item, "octaveChance", d.octaveChance, 0, 100);
        r.low = ruleIn(item, "low", d.low, 0, 127);
        r.high = ruleIn(item, "high", d.high, 0, 127);
        r.velocityScale = ruleIn(item, "velocityScale", d.velocityScale, 0, 200);
        r.velocitySpread = ruleIn(item, "velocitySpread", d.velocitySpread, 0, 127);
        r.velocityLow = ruleIn(item, "velocityLow", d.velocityLow, 1, 127);
        r.velocityHigh = ruleIn(item, "velocityHigh", d.velocityHigh, 1, 127);
        r.gateScale = ruleIn(item, "gateScale", d.gateScale, 5, 400);
        r.gateSpread = ruleIn(item, "gateSpread", d.gateSpread, 0, 100);
        r.shortest = ruleIn(item, "shortest", d.shortest, shortestDuration, longestDuration);
        r.longest = ruleIn(item, "longest", d.longest, shortestDuration, longestDuration);
        r.order = static_cast<NoteOrder>(ruleIn(item, "order", static_cast<int>(d.order), 0, 3));
        r.density = ruleIn(item, "density", d.density, 0, 100);
        if (!valid(r)) throw std::invalid_argument("Invalid voice rules");
    }
    return voices;
}

} // namespace

Material readMaterial(const juce::var& object)
{
    if (!object.isObject()) throw std::invalid_argument("A material is an object");
    Material material;
    material.origin = readNotes(object["origin"]);
    const auto& current = object["current"];
    if (!(current.isVoid() || current.isUndefined())) {
        material.current = readNotes(current);
        material.hasCurrent = true;
    }
    material.generation = static_cast<std::uint32_t>(wholeIn(object["generation"], 0, 999999, "Invalid generation"));
    if (!object["frozen"].isBool()) throw std::invalid_argument("A material says whether it is frozen");
    material.frozen = object["frozen"];
    return material;
}

juce::var writeNotes(const NoteList& list)
{
    return notesToVar(list);
}

juce::var writeVoices(const std::array<VoiceRules, voiceCount>& voices)
{
    juce::Array<juce::var> list;
    for (const auto& r : voices) {
        juce::var item(new juce::DynamicObject());
        auto* f = item.getDynamicObject();
        f->setProperty("channel", r.channel);
        f->setProperty("root", r.root);
        f->setProperty("scale", r.scale);
        f->setProperty("transpose", r.transpose);
        f->setProperty("octave", r.octave);
        f->setProperty("octaveSpread", r.octaveSpread);
        f->setProperty("octaveChance", r.octaveChance);
        f->setProperty("low", r.low);
        f->setProperty("high", r.high);
        f->setProperty("velocityScale", r.velocityScale);
        f->setProperty("velocitySpread", r.velocitySpread);
        f->setProperty("velocityLow", r.velocityLow);
        f->setProperty("velocityHigh", r.velocityHigh);
        f->setProperty("gateScale", r.gateScale);
        f->setProperty("gateSpread", r.gateSpread);
        f->setProperty("shortest", r.shortest);
        f->setProperty("longest", r.longest);
        f->setProperty("order", static_cast<int>(r.order));
        f->setProperty("density", r.density);
        list.add(item);
    }
    return list;
}

juce::var writeMaterial(const Material& material)
{
    juce::var object(new juce::DynamicObject());
    auto* fields = object.getDynamicObject();
    fields->setProperty("origin", writeNotes(material.origin));
    fields->setProperty("current", material.hasCurrent ? writeNotes(material.current) : juce::var());
    fields->setProperty("generation", static_cast<juce::int64>(material.generation));
    fields->setProperty("frozen", material.frozen);
    return object;
}

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
    project.capture = readCapture(state["capture"]);
    project.writer = readWriter(state["writer"]);
    const auto* scenes = state["scenes"].getArray();
    if (scenes == nullptr || scenes->isEmpty()) throw std::invalid_argument("Missing scenes");
    // Refused before 33 scenes are laid out, not after.
    if (scenes->size() > static_cast<int>(maximumScenes))
        throw std::invalid_argument("A sequence has at most 32 scenes");
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
        scene.voices = readVoices(item["voices"]);
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
