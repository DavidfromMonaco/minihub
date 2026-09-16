#include "generative.h"

#include <algorithm>
#include <cmath>

namespace mlh::one_ring {
namespace {
std::uint64_t mix(std::uint64_t value) noexcept
{
    value = (value ^ (value >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
    value = (value ^ (value >> 27)) * UINT64_C(0x94d049bb133111eb);
    return value ^ (value >> 31);
}
}

Random::Random(RandomKey key, RandomStream stream) noexcept
    : state_(mix(key.seed))
{
    state_ = mix(state_ + key.execution);
    state_ = mix(state_ + key.loop);
    state_ = mix(state_ + key.channel);
    state_ = mix(state_ + key.step);
    state_ = mix(state_ + static_cast<std::uint64_t>(stream));
}

std::uint64_t Random::next() noexcept
{
    state_ += UINT64_C(0x9e3779b97f4a7c15);
    return mix(state_);
}

double Random::unit() noexcept { return static_cast<double>(next() >> 11) * 0x1.0p-53; }

std::uint64_t Random::below(std::uint64_t bound) noexcept
{
    if (bound == 0) return 0;
    // Rejection avoids bias for ranges that do not divide the integer domain.
    const auto threshold = (std::uint64_t(0) - bound) % bound;
    for (int attempt = 0; attempt < 8; ++attempt) {
        const auto value = next();
        if (value >= threshold) return value % bound;
    }
    // A finite fallback keeps even adversarial bounds bounded in real time.
    return next() % bound;
}

bool Random::probability(double percent) noexcept
{
    if (!std::isfinite(percent) || percent <= 0) return false;
    if (percent >= 100) return true;
    return unit() * 100.0 < percent;
}

bool evaluate(const Condition& condition, const ConditionContext& state) noexcept
{
    switch (condition.kind) {
    case ConditionKind::Always: return true;
    case ConditionKind::EveryNthLoop:
        return condition.interval > 0 && state.loop > 0 && state.loop % condition.interval == 0;
    case ConditionKind::FirstLoop: return state.loop == 1;
    case ConditionKind::LastLoop: return state.repeats > 0 && state.loop == state.repeats;
    case ConditionKind::ChannelActive:
        return condition.channel < channelCount && state.active[condition.channel];
    case ConditionKind::ChannelInactive:
        return condition.channel < channelCount && !state.active[condition.channel];
    }
    return false;
}

bool evaluate(const std::vector<Condition>& conditions, const ConditionContext& state) noexcept
{
    return std::all_of(conditions.begin(), conditions.end(),
                       [&](const auto& condition) { return evaluate(condition, state); });
}

Validation validate(const CommandDescriptor& command, const ValueSource& source) noexcept
{
    if (source.mode == ValueMode::Fixed) return validate(command, source.fixed);
    if (source.mode == ValueMode::Choice) {
        if (source.choices.empty()) return Validation::UnknownChoice;
        for (const auto& value : source.choices) {
            const auto result = validate(command, value);
            if (result != Validation::Ok) return result;
        }
        return Validation::Ok;
    }
    if (command.type != ValueType::Integer && command.type != ValueType::Float)
        return Validation::WrongType;
    const auto first = validate(command, source.minimum);
    if (first != Validation::Ok) return first;
    const auto last = validate(command, source.maximum);
    if (last != Validation::Ok) return last;
    if (const auto* minimum = std::get_if<std::int32_t>(&source.minimum))
        return *minimum <= std::get<std::int32_t>(source.maximum)
            ? Validation::Ok : Validation::OutOfRange;
    return std::get<double>(source.minimum) <= std::get<double>(source.maximum)
        ? Validation::Ok : Validation::OutOfRange;
}

Value sample(const ValueSource& source, Random& random) noexcept
{
    if (source.mode == ValueMode::Fixed) return source.fixed;
    if (source.mode == ValueMode::Choice)
        return source.choices.empty() ? Value{} : source.choices[random.below(source.choices.size())];
    if (const auto* minimum = std::get_if<std::int32_t>(&source.minimum)) {
        const auto* maximum = std::get_if<std::int32_t>(&source.maximum);
        if (!maximum || *maximum < *minimum) return {};
        const auto width = static_cast<std::uint64_t>(static_cast<std::int64_t>(*maximum) - *minimum) + 1;
        return static_cast<std::int32_t>(static_cast<std::int64_t>(*minimum)
                                         + static_cast<std::int64_t>(random.below(width)));
    }
    const auto* minimum = std::get_if<double>(&source.minimum);
    const auto* maximum = std::get_if<double>(&source.maximum);
    if (!minimum || !maximum || *maximum < *minimum) return {};
    const auto u = random.unit();
    // Convex interpolation avoids overflowing max-min for valid finite ends.
    return (1.0 - u) * *minimum + u * *maximum;
}

} // namespace mlh::one_ring
