#pragma once

// One Ring's random draws, step conditions and value sources. Ported from One
// Ring 0.4's core with its behaviour unchanged (plans/active/one-ring-native.md).

#include "commands.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace mlh::one_ring {

constexpr std::size_t channelCount = 16;
constexpr std::size_t maximumSteps = 64;

enum class RandomStream : std::uint64_t { Probability = 1, Value, Mutation, Humanize };

struct RandomKey {
    std::uint64_t seed = 0;
    std::uint64_t execution = 0;
    std::uint64_t loop = 0;
    std::uint32_t channel = 0;
    std::uint32_t step = 0;
};

// Counter-based draws keep unrelated channels and UI refreshes from changing
// the random sequence. The integer algorithm is part of the saved format: a
// saved seed must replay the same sequence, and the renderer's copy of this
// algorithm (MUTATE, NEW SEED) must draw what this one draws.
class Random {
public:
    explicit Random(RandomKey, RandomStream) noexcept;
    std::uint64_t next() noexcept;
    double unit() noexcept;
    std::uint64_t below(std::uint64_t exclusiveMaximum) noexcept;
    bool probability(double percent) noexcept;
private:
    std::uint64_t state_;
};

enum class ConditionKind { Always, EveryNthLoop, FirstLoop, LastLoop,
                           ChannelActive, ChannelInactive };
struct Condition {
    ConditionKind kind = ConditionKind::Always;
    std::uint32_t interval = 2;
    std::size_t channel = 0;
};

struct ConditionContext {
    std::uint64_t loop = 1;
    std::uint32_t repeats = 0; // zero denotes infinity, which has no last loop
    std::array<bool, channelCount> active{};
};

bool evaluate(const Condition&, const ConditionContext&) noexcept;
bool evaluate(const std::vector<Condition>&, const ConditionContext&) noexcept;

enum class ValueMode { Fixed, Range, Choice };
struct ValueSource {
    ValueMode mode = ValueMode::Fixed;
    Value fixed;
    Value minimum;
    Value maximum;
    std::vector<Value> choices;
};

// Called off the audio thread when compiling a configuration. Random ranges
// never silently coerce an enum, boolean or floating-point value into an int.
Validation validate(const CommandDescriptor&, const ValueSource&) noexcept;
Value sample(const ValueSource&, Random&) noexcept;

} // namespace mlh::one_ring
