#pragma once

// Part two: what a One Ring node's voices played lately -- the take a WRITE
// turns into a generation (plans/active/one-ring-native.md, *Part two --
// design*). The audio callback owns it. It keeps the last 1,024 notes, each
// with where it started and ended on a clock of its own that only moves
// forward, so a seek or a loop does not fold the window.

#include "material.h"

#include <array>
#include <cstdint>

namespace mlh::one_ring {

constexpr std::size_t takeCapacity = 1024;

class Take {
public:
    Take() noexcept { open_.fill(-1); }

    // One block: `begin`, the notes as they sound, then `finish`.
    void begin(double beatsPerSample) noexcept;
    void on(int offset, int channel, int pitch, int velocity) noexcept;
    void off(int offset, int channel, int pitch) noexcept;
    void closeAll(int offset) noexcept;
    void finish(int numSamples) noexcept;

    // Beats on the take's clock at `offset` of this block.
    double at(int offset) const noexcept { return elapsed_ + offset * beatsPerSample_; }

    // What sounded in the `windowBeats` before `until` (on the take's clock):
    // notes that started inside it, a note still sounding cut there, in ticks
    // from the window's start. Answers how many notes did not fit.
    std::uint32_t generation(double until, double windowBeats, NoteList& out) const noexcept;

private:
    struct Played {
        double start = 0;
        double end = 0;
        bool open = false;
        std::uint8_t channel = 1, pitch = 60, velocity = 100;
    };

    std::array<Played, takeCapacity> played_{};
    std::size_t next_ = 0;  // where the next note goes
    std::size_t count_ = 0;
    // For each channel and pitch, the index of its sounding note, or -1.
    std::array<std::int16_t, 16 * 128> open_{};
    double elapsed_ = 0;
    double beatsPerSample_ = 0;
};

} // namespace mlh::one_ring
