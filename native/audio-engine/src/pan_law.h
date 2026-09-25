#pragma once

#include <algorithm>
#include <cmath>

namespace mlh {

/** Stereo balance, the one pan law of the engine: a Sequencer track's and a
 *  Mixer strip's.
 *
 *  Centred, nothing moves -- a pan left at zero is the signal it always was,
 *  in a project written before pans existed as in a new one. Turned to one
 *  side, the other side falls on a quarter sine, reaching silence at the end;
 *  the near side is never raised, so no pan can push a mix into clipping.
 *  That is the balance workstations put on a stereo track (the sources here
 *  are stereo: instruments and takes), rather than a mono pan's +3 dB law.
 *
 *  Pure, allocation-free, and safe on the audio thread. */
struct BalanceGains
{
    float left = 1.0f;
    float right = 1.0f;
};

[[nodiscard]] inline float boundedPan(float pan) noexcept
{
    return std::isfinite(pan) ? std::clamp(pan, -1.0f, 1.0f) : 0.0f;
}

[[nodiscard]] inline BalanceGains balanceGains(float pan) noexcept
{
    const float p = boundedPan(pan);
    if (p == 0.0f) return {};
    // Exact at the ends: cos(pi/2) in float is not zero, and "hard right"
    // must leave nothing at all on the left.
    if (p <= -1.0f) return { 1.0f, 0.0f };
    if (p >= 1.0f) return { 0.0f, 1.0f };
    // theta runs from 0 (left) to pi/2 (right), pi/4 at the centre, where
    // sqrt(2) * cos and sqrt(2) * sin are both exactly one.
    constexpr float quarterPi = 0.78539816339744830962f;
    constexpr float sqrt2 = 1.41421356237309504880f;
    const float theta = (p + 1.0f) * quarterPi;
    return { std::min(1.0f, sqrt2 * std::cos(theta)), std::min(1.0f, sqrt2 * std::sin(theta)) };
}

} // namespace mlh
