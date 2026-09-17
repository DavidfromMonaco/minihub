#pragma once

// One Ring's sequence: scenes of 16 channels of up to 64 cells, their checks,
// and MUTATE. Ported from One Ring 0.4's core with its behaviour unchanged
// (plans/active/one-ring-native.md).

#include "generative.h"
#include "material.h"
#include "voices.h"

#include <string>

namespace mlh::one_ring {

enum class StepMode { Trigger, Legato };
enum class SceneTiming { Immediate, NextBar };
enum class ScenePosition { Restart, Preserve };
enum MutationField : std::uint32_t { MutateEnabled = 1, MutateProbability = 2, MutateValue = 4 };

struct Action {
    std::string target;
    std::string command;
    ValueSource value;
};

struct Step {
    bool enabled = false;
    double probability = 100.0;
    std::vector<Condition> conditions;
    ValueSource value;
    bool locked = false;
    std::uint32_t lockedFields = 0;
};

struct Resolution {
    std::uint32_t numerator = 1;
    std::uint32_t denominator = 16;
    double beats() const noexcept { return 4.0 * numerator / denominator; }
};

struct Channel {
    Action target;
    std::array<Step, maximumSteps> steps{};
    std::size_t length = 16;
    Resolution resolution;
    StepMode mode = StepMode::Trigger;
    std::uint32_t repeats = 0;
    bool enabled = true;
    double offsetSteps = 0;
    double swing = 0;
    double humanize = 0;
    std::uint32_t mutableFields = MutateEnabled | MutateProbability | MutateValue;
    std::vector<Action> follow;
};

struct Scene {
    std::string id;
    std::string name;
    std::array<Channel, channelCount> channels{};
    // Part two: what each voice does to the material while this scene plays.
    std::array<VoiceRules, voiceCount> voices{};
};

struct Project {
    std::uint32_t version = 1;
    std::uint64_t seed = 1;
    std::uint64_t mutation = 0;
    std::vector<Scene> scenes;
    std::size_t selectedScene = 0;
    SceneTiming sceneTiming = SceneTiming::Immediate;
    ScenePosition scenePosition = ScenePosition::Restart;
    // Part two. The material itself travels apart (Runtime::setMaterial).
    CaptureSettings capture;
    WriterSettings writer;
};

Project makeProject(SceneTiming, ScenePosition);
std::vector<std::string> validate(const Project&, const CommandRegistry&);
void mutate(Channel&, std::uint64_t seed, std::uint64_t mutation, std::size_t channel);

} // namespace mlh::one_ring
