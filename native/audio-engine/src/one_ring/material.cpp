#include "material.h"

#include <algorithm>

namespace mlh::one_ring {
namespace {

bool before(const MaterialNote& a, const MaterialNote& b) noexcept
{
    if (a.start != b.start) return a.start < b.start;
    if (a.pitch != b.pitch) return a.pitch < b.pitch;
    return a.channel < b.channel;
}

} // namespace

bool NoteList::add(const MaterialNote& note) noexcept
{
    if (count >= materialCapacity) return false;
    notes[count++] = note;
    return true;
}

bool NoteList::contains(std::uint8_t channel, std::uint8_t pitch, std::int32_t start) const noexcept
{
    return std::any_of(notes.begin(), notes.begin() + count, [&](const MaterialNote& note) {
        return note.channel == channel && note.pitch == pitch && note.start == start;
    });
}

void NoteList::sort() noexcept
{
    // Insertion sort: at most 256 notes, already nearly in order when captured,
    // and stable, so equal notes keep the order they were played in.
    for (std::uint32_t i = 1; i < count; ++i) {
        const auto note = notes[i];
        std::uint32_t j = i;
        while (j > 0 && before(note, notes[j - 1])) {
            notes[j] = notes[j - 1];
            --j;
        }
        notes[j] = note;
    }
}

bool valid(const MaterialNote& note, std::int32_t length) noexcept
{
    return note.pitch <= 127 && note.velocity >= 1 && note.velocity <= 127
        && note.channel >= 1 && note.channel <= 16
        && note.start >= 0 && note.start < length
        && note.duration >= 1 && note.duration <= maximumMaterialTicks;
}

std::uint32_t merge(NoteList& into, const NoteList& from) noexcept
{
    std::uint32_t refused = 0;
    for (std::uint32_t i = 0; i < from.count; ++i) {
        const auto& note = from.notes[i];
        if (into.contains(note.channel, note.pitch, note.start)) continue;
        if (!into.add(note)) ++refused;
    }
    into.length = std::max(into.length, from.length);
    into.sort();
    return refused;
}

} // namespace mlh::one_ring
