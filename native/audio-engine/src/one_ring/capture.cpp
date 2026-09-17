#include "capture.h"

#include <algorithm>
#include <cmath>

namespace mlh::one_ring {
namespace {

constexpr double epsilon = 1.0e-9;

// A capture with no window of its own ends where the material would.
double windowBeats(std::uint32_t bars) noexcept
{
    const auto effective = bars > 0 ? bars : static_cast<std::uint32_t>(maximumMaterialTicks / ticksPerBar);
    return static_cast<double>(effective) * beatsPerBar;
}

} // namespace

std::int32_t Capture::ticks(double beats) noexcept
{
    if (!std::isfinite(beats) || beats <= 0) return 0;
    const double value = std::round(beats * ticksPerBeat);
    return value >= maximumMaterialTicks ? maximumMaterialTicks : static_cast<std::int32_t>(value);
}

double Capture::beatsAt(int offset) const noexcept
{
    return elapsed_ + static_cast<double>(offset - base_) * beatsPerSample_;
}

void Capture::begin(int numSamples, double beatsPerSample) noexcept
{
    samples_ = std::max(0, numSamples);
    beatsPerSample_ = std::isfinite(beatsPerSample) && beatsPerSample > 0 ? beatsPerSample : 0;
    base_ = 0;
    endAt_ = -1;
    if (state_ == CaptureState::Capturing && beatsPerSample_ > 0) {
        const double remaining = windowBeats(bars_) - elapsed_;
        endAt_ = remaining <= 0 ? 0 : static_cast<long long>(std::ceil(remaining / beatsPerSample_ - epsilon));
    }
}

void Capture::advanceTo(int offset) noexcept
{
    for (;;) {
        if (state_ == CaptureState::Armed && armAt_ >= 0 && armAt_ <= offset) {
            open(static_cast<int>(armAt_));
            continue;
        }
        if (state_ == CaptureState::Capturing && endAt_ >= 0 && endAt_ <= offset) {
            close(static_cast<int>(endAt_));
            continue;
        }
        return;
    }
}

void Capture::open(int offset) noexcept
{
    state_ = CaptureState::Capturing;
    list_.clear();
    list_.length = ticksPerBar;
    open_.fill(-1);
    elapsed_ = 0;
    base_ = offset;
    armAt_ = -1;
    endAt_ = beatsPerSample_ > 0
        ? offset + static_cast<long long>(std::ceil(windowBeats(bars_) / beatsPerSample_ - epsilon))
        : -1;
}

void Capture::closeNote(std::size_t key, std::int32_t at) noexcept
{
    const auto index = open_[key];
    if (index < 0) return;
    auto& note = list_.notes[static_cast<std::size_t>(index)];
    note.duration = std::max<std::int32_t>(1, at - note.start);
    open_[key] = -1;
}

void Capture::close(int offset) noexcept
{
    const auto end = ticks(beatsAt(offset));
    for (std::size_t key = 0; key < open_.size(); ++key) closeNote(key, end);
    const std::int32_t length = bars_ > 0
        ? static_cast<std::int32_t>(bars_) * ticksPerBar
        : std::clamp<std::int32_t>((end + ticksPerBar - 1) / ticksPerBar * ticksPerBar, ticksPerBar, maximumMaterialTicks);
    // A note that starts where the window ends belongs to the next one.
    std::uint32_t kept = 0;
    for (std::uint32_t i = 0; i < list_.count; ++i)
        if (list_.notes[i].start < length) list_.notes[kept++] = list_.notes[i];
    list_.count = kept;
    list_.length = length;
    list_.sort();
    lastTaken_ = list_.count;
    state_ = CaptureState::Off;
    endAt_ = -1;
    sink_.captured(list_, mode_);
    list_.clear();
}

void Capture::note(int offset, const unsigned char* bytes, int size) noexcept
{
    if (state_ != CaptureState::Capturing || bytes == nullptr || size < 3) return;
    const int status = bytes[0] & 0xF0;
    if (status != 0x80 && status != 0x90) return;
    const int channel = bytes[0] & 0x0F;
    const int pitch = bytes[1] & 0x7F;
    const int velocity = bytes[2] & 0x7F;
    const auto key = static_cast<std::size_t>(channel * 128 + pitch);
    const auto at = ticks(beatsAt(offset));
    // A Note Off, or a second Note On on the same key, ends what sounds there.
    closeNote(key, at);
    if (status == 0x80 || velocity == 0) return;
    MaterialNote added;
    added.start = at;
    added.pitch = static_cast<std::uint8_t>(pitch);
    added.velocity = static_cast<std::uint8_t>(velocity);
    added.channel = static_cast<std::uint8_t>(channel + 1);
    if (at >= maximumMaterialTicks || !list_.add(added)) {
        ++refused_;
        return;
    }
    open_[key] = static_cast<std::int16_t>(list_.count - 1);
}

void Capture::finish() noexcept
{
    if (samples_ > 0) advanceTo(samples_ - 1);
    if (state_ == CaptureState::Capturing) {
        elapsed_ = beatsAt(samples_);
        base_ = 0;
    } else if (state_ == CaptureState::Armed && armAt_ >= 0) {
        armAt_ -= samples_;
    }
}

void Capture::start(int offset, CaptureMode mode, std::uint32_t bars) noexcept
{
    if (state_ == CaptureState::Capturing) return;
    mode_ = mode;
    bars_ = std::min(bars, maximumCaptureBars);
    open(std::clamp(offset, 0, std::max(0, samples_ - 1)));
}

void Capture::arm(int offset, CaptureMode mode, std::uint32_t bars, double beats) noexcept
{
    if (state_ == CaptureState::Capturing) return;
    mode_ = mode;
    bars_ = std::min(bars, maximumCaptureBars);
    const int at = std::clamp(offset, 0, std::max(0, samples_ - 1));
    if (!(beats > epsilon) || beatsPerSample_ <= 0) {
        open(at);
        return;
    }
    state_ = CaptureState::Armed;
    armAt_ = at + static_cast<long long>(std::ceil(beats / beatsPerSample_ - epsilon));
}

void Capture::end(int offset) noexcept
{
    if (state_ == CaptureState::Armed) {
        state_ = CaptureState::Off;
        armAt_ = -1;
        return;
    }
    if (state_ == CaptureState::Capturing) close(std::max(offset, base_));
}

void Capture::cancel() noexcept
{
    state_ = CaptureState::Off;
    list_.clear();
    open_.fill(-1);
    armAt_ = -1;
    endAt_ = -1;
}

} // namespace mlh::one_ring
