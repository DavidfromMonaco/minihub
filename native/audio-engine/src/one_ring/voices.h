#pragma once

// Part two: the notes a One Ring node plays from its material
// (plans/active/one-ring-native.md, *Part two -- design*). Four voices, each
// with rules; a channel of the sequence aimed at a voice plays notes through it,
// so a note is placed by everything a channel already does. The audio callback
// owns all of it, on fixed capacities.
//
// A step's notes are scheduled on One Ring's clock and rendered block by block,
// Note Ons and Note Offs in time order. A voice keeps at most 32 notes sounding,
// a node at most 512 waiting to start. One key sounds once: a note that starts
// on a key already sounding ends the sounding one first.

#include "generative.h"
#include "material.h"

#include <array>
#include <cstdint>

namespace mlh::one_ring {

constexpr std::size_t voiceCount = 4;
constexpr std::size_t voicePolyphony = 32;
constexpr std::size_t pendingCapacity = 512;
constexpr std::size_t soundingCapacity = voiceCount * voicePolyphony;
// The shortest and longest a rule may make a note: a sixty-fourth, 64 beats.
constexpr std::int32_t shortestDuration = ticksPerBeat / 16;
constexpr std::int32_t longestDuration = 64 * ticksPerBeat;

enum class NoteOrder : std::uint8_t { AsPlayed, Rising, Falling, Shuffled };

// What a voice does to the material's notes. The defaults change nothing.
struct VoiceRules {
    // 0 keeps each note's own channel.
    std::int32_t channel = 0;
    std::int32_t root = 0;
    // An index in the Arpeggiator's scales (scales.h); 0 is chromatic.
    std::int32_t scale = 0;
    std::int32_t transpose = 0;       // -48 to 48 semitones
    std::int32_t octave = 0;          // -3 to 3
    std::int32_t octaveSpread = 0;    // 0 to 3 octaves either way
    std::int32_t octaveChance = 0;    // percent
    std::int32_t low = 0;             // lowest and highest pitch; a note outside
    std::int32_t high = 127;          // is folded in by octaves
    std::int32_t velocityScale = 100; // 0 to 200 percent
    std::int32_t velocitySpread = 0;  // 0 to 127 either way
    std::int32_t velocityLow = 1;
    std::int32_t velocityHigh = 127;
    std::int32_t gateScale = 100;     // 5 to 400 percent
    std::int32_t gateSpread = 0;      // 0 to 100 percent either way
    std::int32_t shortest = shortestDuration; // ticks
    std::int32_t longest = longestDuration;   // ticks
    NoteOrder order = NoteOrder::AsPlayed;
    std::int32_t density = 100;       // percent: the chance each note plays
};

// The rules a voice's own commands move, live.
enum class VoiceRule : std::uint8_t { Transpose, Octave, Root, Scale, Velocity, Gate, Density };

// Is every rule inside its range?
bool valid(const VoiceRules&) noexcept;
bool operator==(const VoiceRules&, const VoiceRules&) noexcept;
inline bool operator!=(const VoiceRules& a, const VoiceRules& b) noexcept { return !(a == b); }

class NoteSink {
public:
    virtual ~NoteSink() = default;
    virtual void noteOn(int offset, int channel, int pitch, int velocity) noexcept = 0;
    virtual void noteOff(int offset, int channel, int pitch) noexcept = 0;
};

class Voices {
public:
    // The scene's rules: what the voices go back to at a recall and at STOP.
    void setRules(const std::array<VoiceRules, voiceCount>& rules) noexcept { rules_ = rules; }
    const std::array<VoiceRules, voiceCount>& rules() const noexcept { return rules_; }
    // A rule command; the value is clamped to the rule's range.
    void setRule(std::size_t voice, VoiceRule, std::int32_t value) noexcept;
    // The notes the voices play from.
    void setMaterial(const NoteList&) noexcept;

    // During the scheduler's advance: what a step asks, on One Ring's clock.
    // `key` is the step's own random key; `stepBeats` its channel's step.
    void play(std::size_t voice, std::int32_t slot, double stepBeats, double beat, const RandomKey& key) noexcept;
    // `holdChannel` is the Legato channel that holds the note until it
    // releases it, or -1 for a note that lasts the step times the gate.
    void note(std::size_t voice, std::int32_t index, double stepBeats, double beat, const RandomKey& key,
              int holdChannel) noexcept;
    // The notes `holdChannel` holds on this voice end at `beat`; -1 ends all of the voice's.
    void release(std::size_t voice, int holdChannel, double beat) noexcept;

    // One block: every Note On and Note Off falling in it before sample
    // `upto` (the whole block by default), in time order. Called again with a
    // later `upto`, it goes on from there.
    void render(double blockBegin, double beatsPerSample, int numSamples, NoteSink&, int upto = -1) noexcept;
    // Every sounding note ends at `offset`; nothing waiting starts.
    void releaseAll(NoteSink&, int offset) noexcept;
    // Everything forgotten and nothing sent: a panic silenced the instruments.
    void drop() noexcept;
    // The clock moved: what waits moves with it.
    void shift(double delta) noexcept;

    std::array<std::uint32_t, voiceCount> sounding() const noexcept;
    std::uint64_t refused() const noexcept { return refused_; }

private:
    struct Pending {
        double beat = 0;
        double duration = 0; // beats; infinite while a Legato channel holds it
        std::uint8_t channel = 1, pitch = 60, velocity = 100, voice = 0;
        std::int8_t hold = -1;
        std::uint64_t order = 0; // when it was asked for
    };
    struct Sounding {
        double end = 0;
        std::uint8_t channel = 1, pitch = 60, voice = 0;
        std::int8_t hold = -1;
        std::uint64_t order = 0;
    };

    void schedule(std::size_t voice, const MaterialNote& note, double beat, double durationTicks,
                  Random& random, int holdChannel) noexcept;
    int transformPitch(const VoiceRules&, int pitch, Random&) const noexcept;
    int transformVelocity(const VoiceRules&, int velocity, Random&) const noexcept;
    double transformDuration(const VoiceRules&, double ticks, Random&) const noexcept;
    void removeSounding(std::size_t index) noexcept;

    std::array<VoiceRules, voiceCount> rules_{};
    NoteList material_;
    // The material's notes by pitch, low to high: the Rising order.
    std::array<std::uint16_t, materialCapacity> rising_{};
    std::array<Pending, pendingCapacity> pending_{};
    std::size_t pendingCount_ = 0;
    std::array<Sounding, soundingCapacity> sounding_{};
    std::size_t soundingCount_ = 0;
    std::uint64_t order_ = 0;
    std::uint64_t refused_ = 0;
};

} // namespace mlh::one_ring
