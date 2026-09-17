#pragma once

// What a One Ring node plays notes from: the notes it captured, or was given,
// kept apart from the rules that transform them (plans/active/one-ring-native.md,
// *Part two -- design*). Fixed capacity, so the audio callback captures into it
// and plays from it without allocating.

#include <array>
#include <cstddef>
#include <cstdint>

namespace mlh::one_ring {

constexpr std::int32_t ticksPerBeat = 960; // the Sequencer's resolution
constexpr std::int32_t beatsPerBar = 4;    // as Next bar counts a bar
constexpr std::int32_t ticksPerBar = ticksPerBeat * beatsPerBar;
constexpr std::size_t materialCapacity = 256;
constexpr std::int32_t maximumMaterialTicks = 64 * ticksPerBar;
constexpr std::uint32_t maximumCaptureBars = 16;

enum class CaptureMode : std::uint8_t { Replace, Add };

struct CaptureSettings {
    CaptureMode mode = CaptureMode::Replace;
    // 0: until CAPTURE_END.
    std::uint32_t bars = 1;
};

struct MaterialNote {
    // Ticks from the material's start.
    std::int32_t start = 0;
    std::int32_t duration = 1;
    std::uint8_t pitch = 60;
    std::uint8_t velocity = 100;
    std::uint8_t channel = 1;
};

struct NoteList {
    std::int32_t length = ticksPerBar;
    std::uint32_t count = 0;
    std::array<MaterialNote, materialCapacity> notes{};

    // False when the list is full.
    bool add(const MaterialNote&) noexcept;
    bool contains(std::uint8_t channel, std::uint8_t pitch, std::int32_t start) const noexcept;
    // By start, then pitch, then channel: the same notes always read the same.
    void sort() noexcept;
    void clear() noexcept { count = 0; }
};

struct Material {
    NoteList origin;
    // What feedback made of the origin; the voices play the origin until then.
    NoteList current;
    bool hasCurrent = false;
    std::uint32_t generation = 0;
    // Nothing a sequence does changes frozen material.
    bool frozen = false;

    const NoteList& playing() const noexcept { return hasCurrent ? current : origin; }
};

// Is `note` one a material of `length` ticks may hold?
bool valid(const MaterialNote& note, std::int32_t length) noexcept;

// `from` joined to `into`: a note already there (same channel, pitch and start)
// is skipped, the longer length is kept. Answers how many notes did not fit.
std::uint32_t merge(NoteList& into, const NoteList& from) noexcept;

} // namespace mlh::one_ring
