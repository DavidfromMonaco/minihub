#include "take.h"

#include <algorithm>
#include <cmath>

namespace mlh::one_ring {
namespace {

std::size_t keyOf(int channel, int pitch) noexcept
{
    return static_cast<std::size_t>((std::clamp(channel, 1, 16) - 1) * 128 + std::clamp(pitch, 0, 127));
}

} // namespace

void Take::begin(double beatsPerSample) noexcept
{
    beatsPerSample_ = std::isfinite(beatsPerSample) && beatsPerSample > 0 ? beatsPerSample : 0;
}

void Take::on(int offset, int channel, int pitch, int velocity) noexcept
{
    const auto key = keyOf(channel, pitch);
    off(offset, channel, pitch);
    // The oldest note makes way; if it was still sounding, it is forgotten.
    auto& slot = played_[next_];
    if (count_ == takeCapacity && slot.open) {
        const auto slotKey = keyOf(slot.channel, slot.pitch);
        if (open_[slotKey] == static_cast<std::int16_t>(next_)) open_[slotKey] = -1;
    }
    slot = {at(offset), 0.0, true, static_cast<std::uint8_t>(channel), static_cast<std::uint8_t>(pitch),
            static_cast<std::uint8_t>(velocity)};
    open_[key] = static_cast<std::int16_t>(next_);
    next_ = (next_ + 1) % takeCapacity;
    count_ = std::min(count_ + 1, takeCapacity);
}

void Take::off(int offset, int channel, int pitch) noexcept
{
    const auto key = keyOf(channel, pitch);
    const auto index = open_[key];
    if (index < 0) return;
    auto& note = played_[static_cast<std::size_t>(index)];
    note.end = std::max(note.start, at(offset));
    note.open = false;
    open_[key] = -1;
}

void Take::closeAll(int offset) noexcept
{
    for (std::size_t key = 0; key < open_.size(); ++key) {
        const auto index = open_[key];
        if (index < 0) continue;
        auto& note = played_[static_cast<std::size_t>(index)];
        note.end = std::max(note.start, at(offset));
        note.open = false;
        open_[key] = -1;
    }
}

void Take::finish(int numSamples) noexcept
{
    elapsed_ = at(std::max(0, numSamples));
}

std::uint32_t Take::generation(double until, double windowBeats, NoteList& out) const noexcept
{
    out.clear();
    const double from = until - windowBeats;
    out.length = static_cast<std::int32_t>(std::clamp(std::llround(windowBeats * ticksPerBeat),
                                                      static_cast<long long>(1),
                                                      static_cast<long long>(maximumMaterialTicks)));
    std::uint32_t refused = 0;
    const std::size_t oldest = (next_ + takeCapacity - count_) % takeCapacity;
    for (std::size_t n = 0; n < count_; ++n) {
        const auto& note = played_[(oldest + n) % takeCapacity];
        if (note.start < from - 1.0e-9 || note.start >= until - 1.0e-9) continue;
        const double end = note.open ? until : std::min(note.end, until);
        MaterialNote made;
        made.start = static_cast<std::int32_t>(std::clamp(std::llround((note.start - from) * ticksPerBeat),
                                                          0LL, static_cast<long long>(out.length - 1)));
        made.duration = static_cast<std::int32_t>(std::clamp(std::llround((end - note.start) * ticksPerBeat),
                                                             1LL, static_cast<long long>(maximumMaterialTicks)));
        made.pitch = note.pitch;
        made.velocity = note.velocity;
        made.channel = note.channel;
        if (!out.add(made)) ++refused;
    }
    out.sort();
    return refused;
}

} // namespace mlh::one_ring
