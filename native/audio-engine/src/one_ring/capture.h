#pragma once

// A One Ring node's capture: the notes that reach its MIDI IN between a start
// and an end, as material. The audio callback owns it and feeds it a block at a
// time, its boundaries and its events in sample order.
//
// Positions are counted in beats elapsed since the capture began, not on a
// clock that a seek or a loop moves: a loop wrap during a capture does not fold
// notes onto each other. A Note On of velocity 0 is a Note Off. A second Note On
// on a sounding pitch and channel ends the first there. A note still held when
// the capture ends ends with it; one held before it began is not taken.

#include "material.h"

namespace mlh::one_ring {

enum class CaptureState : std::uint8_t { Off, Armed, Capturing };

class CaptureSink {
public:
    virtual ~CaptureSink() = default;
    // A capture ended: its notes, sorted, and its length.
    virtual void captured(const NoteList&, CaptureMode) noexcept = 0;
};

class Capture {
public:
    explicit Capture(CaptureSink& sink) noexcept : sink_(sink) { open_.fill(-1); }

    CaptureState state() const noexcept { return state_; }
    // Notes the running capture holds, or the last one took.
    std::uint32_t taken() const noexcept { return state_ == CaptureState::Capturing ? list_.count : lastTaken_; }
    // Notes that did not fit, over the node's life.
    std::uint64_t refused() const noexcept { return refused_; }

    // One block: `begin`, then boundaries and events in sample order, then `finish`.
    void begin(int numSamples, double beatsPerSample) noexcept;
    // Fires every boundary (an armed start, a window's end) at or before `offset`.
    void advanceTo(int offset) noexcept;
    void note(int offset, const unsigned char* bytes, int size) noexcept;
    void finish() noexcept;

    // Starts at `offset` of this block. A running capture is left alone.
    void start(int offset, CaptureMode, std::uint32_t bars) noexcept;
    // Starts after `beats` more beats from `offset` -- the next bar.
    void arm(int offset, CaptureMode, std::uint32_t bars, double beats) noexcept;
    // Ends at `offset` of this block; an armed capture is dropped.
    void end(int offset) noexcept;
    // Everything dropped, nothing reported: the node is going.
    void cancel() noexcept;

private:
    void open(int offset) noexcept;
    void close(int offset) noexcept;
    double beatsAt(int offset) const noexcept;
    static std::int32_t ticks(double beats) noexcept;
    void closeNote(std::size_t key, std::int32_t at) noexcept;

    CaptureSink& sink_;
    CaptureState state_ = CaptureState::Off;
    CaptureMode mode_ = CaptureMode::Replace;
    std::uint32_t bars_ = 1;
    NoteList list_;
    // For each channel and pitch, the sounding note's index in `list_`, or -1.
    std::array<std::int16_t, 16 * 128> open_{};
    std::uint32_t lastTaken_ = 0;
    std::uint64_t refused_ = 0;

    // The block being fed.
    int samples_ = 0;
    double beatsPerSample_ = 0;
    // Beats elapsed at `base_`, the offset the running capture counts from.
    double elapsed_ = 0;
    int base_ = 0;
    // Samples from this block's start to an armed start, or to the window's end;
    // -1 when there is none.
    long long armAt_ = -1;
    long long endAt_ = -1;
};

} // namespace mlh::one_ring
