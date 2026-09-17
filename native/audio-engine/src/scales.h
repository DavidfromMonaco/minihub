#pragma once

// The eleven scales MiniHub quantizes notes to, in the order the Arpeggiator's
// page lists them (arpeggiatorState.js ARP_SCALES): the Arpeggiator and a One
// Ring node's voices read this one table, so a scale means the same in both.

#include <algorithm>
#include <array>
#include <cstdlib>

namespace mlh {

constexpr std::size_t kScaleCount = 11;

constexpr std::array<std::array<int, 12>, kScaleCount> kScales{{
    {{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}},
    {{0, 2, 4, 5, 7, 9, 11, -1, -1, -1, -1, -1}},
    {{0, 2, 3, 5, 7, 8, 10, -1, -1, -1, -1, -1}},
    {{0, 2, 3, 5, 7, 8, 11, -1, -1, -1, -1, -1}},
    {{0, 2, 3, 5, 7, 9, 10, -1, -1, -1, -1, -1}},
    {{0, 1, 3, 5, 7, 8, 10, -1, -1, -1, -1, -1}},
    {{0, 2, 4, 6, 7, 9, 11, -1, -1, -1, -1, -1}},
    {{0, 2, 4, 5, 7, 9, 10, -1, -1, -1, -1, -1}},
    {{0, 1, 3, 5, 6, 8, 10, -1, -1, -1, -1, -1}},
    {{0, 2, 4, 7, 9, -1, -1, -1, -1, -1, -1, -1}},
    {{0, 3, 5, 7, 10, -1, -1, -1, -1, -1, -1, -1}}
}};

inline int scaleSize(int scale) noexcept
{
    int size = 0;
    for (const int degree : kScales[static_cast<std::size_t>(std::clamp(scale, 0, static_cast<int>(kScaleCount) - 1))])
        if (degree >= 0) ++size;
    return size;
}

inline bool inScale(int note, int root, int scale) noexcept
{
    const auto& degrees = kScales[static_cast<std::size_t>(std::clamp(scale, 0, static_cast<int>(kScaleCount) - 1))];
    const int pitchClass = ((note - std::clamp(root, 0, 11)) % 12 + 12) % 12;
    return std::find(degrees.begin(), degrees.end(), pitchClass) != degrees.end();
}

// The nearest note of the scale at any height, a transposed note beyond the
// MIDI range included; on a tie, the lower one.
inline int nearestInScale(int note, int root, int scale) noexcept
{
    for (int distance = 0; distance <= 6; ++distance) {
        if (inScale(note - distance, root, scale)) return note - distance;
        if (inScale(note + distance, root, scale)) return note + distance;
    }
    return note;
}

// The nearest MIDI note of the scale; on a tie, the lower one.
inline int quantizeToScale(int note, int root, int scale) noexcept
{
    int best = note, distance = 128;
    for (int candidate = 0; candidate < 128; ++candidate)
        if (inScale(candidate, root, scale) && std::abs(candidate - note) < distance) {
            best = candidate;
            distance = std::abs(candidate - note);
        }
    return best;
}

} // namespace mlh
