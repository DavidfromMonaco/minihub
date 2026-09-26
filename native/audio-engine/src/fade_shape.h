#pragma once
#include <algorithm>
#include <cmath>

namespace mlh {

/** An audio clip's fade (D-062): a length in seconds, one of Reaper's seven
 * shapes, a curvature from -1 to 1, and an optional low-pass sweep. The same
 * arithmetic as `src/renderer/js/core/fades.js`, which draws what this plays;
 * the two are pinned to the same values by their tests. */
struct ClipFade final {
    double seconds = 0.0;
    int shape = 1;
    float curve = 0.0f;
    bool lowPass = false;
};

inline constexpr int kFadeShapes = 7;

/** A shape's gain at `x`, 0 at the silent end to 1 at full level. */
inline float fadeShapeGain(int shape, double x) noexcept
{
    const double t = std::clamp(x, 0.0, 1.0);
    double g = t;
    switch (shape) {
        case 1: g = 1.0 - (1.0 - t) * (1.0 - t); break;
        case 2: g = t * t; break;
        case 3: { const double u = 1.0 - t; g = 1.0 - u * u * u * u; break; }
        case 4: g = t * t * t * t; break;
        case 5: g = t * t * (3.0 - 2.0 * t); break;
        case 6: { const double u = 1.0 - t; g = t < 0.5 ? 8.0 * t * t * t * t : 1.0 - 8.0 * u * u * u * u; break; }
        default: break;
    }
    return static_cast<float>(g);
}

/** The shape bent by its curvature: raised to 4^-curve. The ends stay put. */
inline float fadeGain(int shape, float curve, double x) noexcept
{
    const float g = fadeShapeGain(shape, x);
    if (curve == 0.0f || g <= 0.0f || g >= 1.0f) return g;
    return std::pow(g, std::pow(4.0f, -std::clamp(curve, -1.0f, 1.0f)));
}

/** The low-pass fade's cutoff for a gain: 20 Hz silent, 20 kHz at full level. */
inline double lowPassCutoffHz(float gain) noexcept
{
    return 20.0 * std::pow(1000.0, std::clamp(static_cast<double>(gain), 0.0, 1.0));
}

}
