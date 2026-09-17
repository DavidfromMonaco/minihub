#include "voices.h"

#include "../scales.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace mlh::one_ring {
namespace {

constexpr double infinite = std::numeric_limits<double>::infinity();

int clampWhole(std::int64_t value, int low, int high) noexcept
{
    return static_cast<int>(std::clamp<std::int64_t>(value, low, high));
}

} // namespace

bool valid(const VoiceRules& r) noexcept
{
    return r.channel >= 0 && r.channel <= 16 && r.root >= 0 && r.root <= 11
        && r.scale >= 0 && r.scale < static_cast<int>(kScaleCount)
        && r.transpose >= -48 && r.transpose <= 48 && r.octave >= -3 && r.octave <= 3
        && r.octaveSpread >= 0 && r.octaveSpread <= 3 && r.octaveChance >= 0 && r.octaveChance <= 100
        && r.low >= 0 && r.high <= 127 && r.low <= r.high
        && r.velocityScale >= 0 && r.velocityScale <= 200 && r.velocitySpread >= 0 && r.velocitySpread <= 127
        && r.velocityLow >= 1 && r.velocityHigh <= 127 && r.velocityLow <= r.velocityHigh
        && r.gateScale >= 5 && r.gateScale <= 400 && r.gateSpread >= 0 && r.gateSpread <= 100
        && r.shortest >= shortestDuration && r.longest <= longestDuration && r.shortest <= r.longest
        && r.order >= NoteOrder::AsPlayed && r.order <= NoteOrder::Shuffled
        && r.density >= 0 && r.density <= 100;
}

bool operator==(const VoiceRules& a, const VoiceRules& b) noexcept
{
    return a.channel == b.channel && a.root == b.root && a.scale == b.scale && a.transpose == b.transpose
        && a.octave == b.octave && a.octaveSpread == b.octaveSpread && a.octaveChance == b.octaveChance
        && a.low == b.low && a.high == b.high && a.velocityScale == b.velocityScale
        && a.velocitySpread == b.velocitySpread && a.velocityLow == b.velocityLow && a.velocityHigh == b.velocityHigh
        && a.gateScale == b.gateScale && a.gateSpread == b.gateSpread && a.shortest == b.shortest
        && a.longest == b.longest && a.order == b.order && a.density == b.density;
}

void Voices::setRule(std::size_t voice, VoiceRule rule, std::int32_t value) noexcept
{
    if (voice >= voiceCount) return;
    auto& r = rules_[voice];
    switch (rule) {
    case VoiceRule::Transpose: r.transpose = std::clamp(value, -48, 48); break;
    case VoiceRule::Octave: r.octave = std::clamp(value, -3, 3); break;
    case VoiceRule::Root: r.root = std::clamp(value, 0, 11); break;
    case VoiceRule::Scale: r.scale = std::clamp(value, 0, static_cast<int>(kScaleCount) - 1); break;
    case VoiceRule::Velocity: r.velocityScale = std::clamp(value, 0, 200); break;
    case VoiceRule::Gate: r.gateScale = std::clamp(value, 5, 400); break;
    case VoiceRule::Density: r.density = std::clamp(value, 0, 100); break;
    }
}

void Voices::setMaterial(const NoteList& list) noexcept
{
    material_ = list;
    const auto lower = [this](std::uint16_t a, std::uint16_t b) {
        const auto& x = material_.notes[a];
        const auto& y = material_.notes[b];
        return x.pitch != y.pitch ? x.pitch < y.pitch : x.start < y.start;
    };
    for (std::uint32_t i = 0; i < material_.count; ++i) {
        const auto index = static_cast<std::uint16_t>(i);
        std::uint32_t j = i;
        while (j > 0 && lower(index, rising_[j - 1])) {
            rising_[j] = rising_[j - 1];
            --j;
        }
        rising_[j] = index;
    }
}

int Voices::transformPitch(const VoiceRules& r, int pitch, Random& random) const noexcept
{
    // Every draw is taken whatever the rules say, so a rule changed on one
    // voice leaves the other draws of the step where they were.
    const double chance = random.unit();
    const auto pick = random.below(2 * static_cast<std::uint64_t>(r.octaveSpread) + 1);
    int note = pitch + r.transpose + 12 * r.octave;
    if (r.octaveSpread > 0 && chance * 100.0 < r.octaveChance)
        note += 12 * (static_cast<int>(pick) - r.octaveSpread);
    if (r.scale != 0) note = nearestInScale(note, r.root, r.scale);
    // Folded in by octaves, which keeps the scale; a range narrower than an
    // octave keeps its lowest note.
    while (note < r.low) note += 12;
    while (note > r.high) note -= 12;
    if (note < r.low) note = r.low;
    return std::clamp(note, 0, 127);
}

int Voices::transformVelocity(const VoiceRules& r, int velocity, Random& random) const noexcept
{
    const auto pick = random.below(2 * static_cast<std::uint64_t>(r.velocitySpread) + 1);
    const auto scaled = std::llround(static_cast<double>(velocity) * r.velocityScale / 100.0);
    return clampWhole(scaled + static_cast<std::int64_t>(pick) - r.velocitySpread,
                      std::max(1, r.velocityLow), std::min(127, r.velocityHigh));
}

double Voices::transformDuration(const VoiceRules& r, double ticks, Random& random) const noexcept
{
    const double draw = random.unit();
    double scaled = ticks * r.gateScale / 100.0;
    if (r.gateSpread > 0) scaled *= 1.0 + (draw * 2.0 - 1.0) * r.gateSpread / 100.0;
    return std::clamp(scaled, static_cast<double>(r.shortest), static_cast<double>(r.longest));
}

void Voices::schedule(std::size_t voice, const MaterialNote& note, double beat, double durationTicks,
                      Random& random, int holdChannel) noexcept
{
    const auto& r = rules_[voice];
    const double density = random.unit();
    const int pitch = transformPitch(r, note.pitch, random);
    const int velocity = transformVelocity(r, note.velocity, random);
    const double ticks = transformDuration(r, std::isinf(durationTicks) ? 0.0 : durationTicks, random);
    if (!(density * 100.0 < r.density)) return;
    if (pendingCount_ >= pendingCapacity) {
        ++refused_;
        return;
    }
    Pending pending;
    pending.beat = beat;
    pending.duration = std::isinf(durationTicks) ? infinite : ticks / ticksPerBeat;
    pending.channel = static_cast<std::uint8_t>(r.channel > 0 ? r.channel : note.channel);
    pending.pitch = static_cast<std::uint8_t>(pitch);
    pending.velocity = static_cast<std::uint8_t>(velocity);
    pending.voice = static_cast<std::uint8_t>(voice);
    pending.hold = static_cast<std::int8_t>(holdChannel);
    pending.order = ++order_;
    pending_[pendingCount_++] = pending;
}

void Voices::play(std::size_t voice, std::int32_t slot, double stepBeats, double beat, const RandomKey& key) noexcept
{
    if (voice >= voiceCount || material_.count == 0 || !(stepBeats > 0) || !std::isfinite(beat)) return;
    const double slotTicks = stepBeats * ticksPerBeat;
    const auto slots = std::max<std::int64_t>(1, static_cast<std::int64_t>(std::ceil(material_.length / slotTicks - 1.0e-9)));
    const std::int64_t wanted = slot < 0 ? static_cast<std::int64_t>(key.step) : slot;
    const auto index = (wanted % slots + slots) % slots;
    const double from = static_cast<double>(index) * slotTicks;
    const double to = from + slotTicks;
    Random random(key, RandomStream::Voice);
    for (std::uint32_t i = 0; i < material_.count; ++i) {
        const auto& note = material_.notes[i];
        const double start = note.start;
        if (start < from || start >= to) continue;
        schedule(voice, note, beat + (start - from) / ticksPerBeat, note.duration, random, -1);
    }
}

void Voices::note(std::size_t voice, std::int32_t index, double stepBeats, double beat, const RandomKey& key,
                  int holdChannel) noexcept
{
    if (voice >= voiceCount || material_.count == 0 || index < 0 || !std::isfinite(beat)) return;
    const auto count = material_.count;
    const auto position = static_cast<std::uint32_t>(index) % count;
    std::uint32_t chosen = position;
    switch (rules_[voice].order) {
    case NoteOrder::AsPlayed: break;
    case NoteOrder::Rising: chosen = rising_[position]; break;
    case NoteOrder::Falling: chosen = rising_[count - 1 - position]; break;
    case NoteOrder::Shuffled: {
        // One order per loop of the channel: the step's key, at step 0.
        RandomKey loop = key;
        loop.step = 0;
        Random shuffle(loop, RandomStream::Order);
        std::array<std::uint16_t, materialCapacity> order{};
        for (std::uint32_t i = 0; i < count; ++i) order[i] = static_cast<std::uint16_t>(i);
        for (std::uint32_t i = count - 1; i > 0; --i)
            std::swap(order[i], order[static_cast<std::size_t>(shuffle.below(i + 1))]);
        chosen = order[position];
        break;
    }
    }
    Random random(key, RandomStream::Voice);
    schedule(voice, material_.notes[chosen], beat,
             holdChannel >= 0 ? infinite : std::max(0.0, stepBeats) * ticksPerBeat, random, holdChannel);
}

void Voices::release(std::size_t voice, int holdChannel, double beat) noexcept
{
    if (voice >= voiceCount) return;
    for (std::size_t i = 0; i < soundingCount_; ++i) {
        auto& sounding = sounding_[i];
        if (sounding.voice != voice || (holdChannel >= 0 && sounding.hold != holdChannel)) continue;
        sounding.end = std::min(sounding.end, beat);
        sounding.hold = -1;
    }
    for (std::size_t i = 0; i < pendingCount_;) {
        auto& pending = pending_[i];
        if (pending.voice != voice || (holdChannel >= 0 && pending.hold != holdChannel)) {
            ++i;
            continue;
        }
        if (beat <= pending.beat) {
            pending_[i] = pending_[--pendingCount_];
            continue;
        }
        pending.duration = std::min(pending.duration, beat - pending.beat);
        pending.hold = -1;
        ++i;
    }
}

void Voices::removeSounding(std::size_t index) noexcept
{
    sounding_[index] = sounding_[--soundingCount_];
}

void Voices::render(double blockBegin, double beatsPerSample, int numSamples, NoteSink& sink, int upto) noexcept
{
    if (numSamples <= 0 || !(beatsPerSample > 0) || !std::isfinite(blockBegin)) return;
    if (upto < 0 || upto > numSamples) upto = numSamples;
    // What rounds to a sample of this block is this block's: a note lands on
    // the sample nearest its beat whatever the size of the blocks.
    const double blockEnd = blockBegin + (upto - 0.5) * beatsPerSample;
    const auto offsetOf = [&](double beat) {
        const double samples = std::round((beat - blockBegin) / beatsPerSample);
        if (!(samples > 0)) return 0;
        return samples >= numSamples - 1 ? numSamples - 1 : static_cast<int>(samples);
    };
    // Earliest first; a Note Off before a Note On at the same moment; then the
    // order the notes were asked in, so a block's size never reorders them.
    const auto earlier = [](double a, std::uint64_t aOrder, double b, std::uint64_t bOrder) {
        return a < b || (a == b && aOrder < bOrder);
    };
    for (std::size_t guard = 0; guard < 4 * pendingCapacity; ++guard) {
        std::size_t off = soundingCount_, on = pendingCount_;
        for (std::size_t i = 0; i < soundingCount_; ++i) {
            const auto& sounding = sounding_[i];
            if (sounding.end >= blockEnd) continue;
            if (off == soundingCount_ || earlier(sounding.end, sounding.order, sounding_[off].end, sounding_[off].order))
                off = i;
        }
        for (std::size_t i = 0; i < pendingCount_; ++i) {
            const auto& pending = pending_[i];
            if (pending.beat >= blockEnd) continue;
            if (on == pendingCount_ || earlier(pending.beat, pending.order, pending_[on].beat, pending_[on].order))
                on = i;
        }
        const bool hasOff = off < soundingCount_;
        const bool hasOn = on < pendingCount_;
        if (!hasOff && !hasOn) return;
        if (hasOff && (!hasOn || sounding_[off].end <= pending_[on].beat)) {
            const auto sounding = sounding_[off];
            sink.noteOff(offsetOf(sounding.end), sounding.channel, sounding.pitch);
            removeSounding(off);
            continue;
        }
        const auto pending = pending_[on];
        pending_[on] = pending_[--pendingCount_];
        const int at = offsetOf(pending.beat);
        for (std::size_t i = 0; i < soundingCount_; ++i) {
            if (sounding_[i].channel != pending.channel || sounding_[i].pitch != pending.pitch) continue;
            sink.noteOff(at, pending.channel, pending.pitch);
            removeSounding(i);
            break;
        }
        std::size_t voiceNotes = 0;
        for (std::size_t i = 0; i < soundingCount_; ++i) voiceNotes += sounding_[i].voice == pending.voice;
        if (voiceNotes >= voicePolyphony || soundingCount_ >= soundingCapacity) {
            ++refused_;
            continue;
        }
        sink.noteOn(at, pending.channel, pending.pitch, pending.velocity);
        Sounding sounding;
        sounding.end = pending.beat + pending.duration;
        sounding.channel = pending.channel;
        sounding.pitch = pending.pitch;
        sounding.voice = pending.voice;
        sounding.hold = pending.hold;
        sounding.order = pending.order;
        sounding_[soundingCount_++] = sounding;
    }
}

void Voices::releaseAll(NoteSink& sink, int offset) noexcept
{
    for (std::size_t i = 0; i < soundingCount_; ++i)
        sink.noteOff(offset, sounding_[i].channel, sounding_[i].pitch);
    soundingCount_ = 0;
    pendingCount_ = 0;
}

void Voices::drop() noexcept
{
    soundingCount_ = 0;
    pendingCount_ = 0;
}

void Voices::shift(double delta) noexcept
{
    if (!std::isfinite(delta)) return;
    for (std::size_t i = 0; i < pendingCount_; ++i) pending_[i].beat += delta;
    for (std::size_t i = 0; i < soundingCount_; ++i)
        if (std::isfinite(sounding_[i].end)) sounding_[i].end += delta;
}

std::array<std::uint32_t, voiceCount> Voices::sounding() const noexcept
{
    std::array<std::uint32_t, voiceCount> counts{};
    for (std::size_t i = 0; i < soundingCount_; ++i) ++counts[sounding_[i].voice];
    return counts;
}

} // namespace mlh::one_ring
