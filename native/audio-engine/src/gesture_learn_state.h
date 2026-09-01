#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>

namespace mlh {

/** Lock-free state shared by hosted-parameter callbacks and the message thread.
 *  Parameter callbacks only touch atomics; names and plugin APIs stay out of
 *  the real-time path. */
class GestureLearnState {
public:
    struct Touch {
        int parameterIndex = -1;
        float normalizedValue = 0.0f;
        bool capturedByLearn = false;
    };

    void reset(int parameterCount)
    {
        count_ = parameterCount > 0 ? parameterCount : 0;
        gestures_ = count_ > 0
            ? std::make_unique<std::atomic<uint8_t>[]>(static_cast<size_t>(count_))
            : nullptr;
        for (int i = 0; i < count_; ++i)
            gestures_[static_cast<size_t>(i)].store(0, std::memory_order_relaxed);
        pending_.store(0, std::memory_order_release);
        armed_.store(false, std::memory_order_release);
    }

    void gestureChanged(int parameterIndex, bool starting) noexcept
    {
        if (!valid(parameterIndex))
            return;
        gestures_[static_cast<size_t>(parameterIndex)].store(
            starting ? 1 : 0, std::memory_order_release);
    }

    /** Returns true when a gesture-aware touch was recorded and the caller
     *  should schedule message-thread delivery. */
    bool valueChanged(int parameterIndex, float normalizedValue) noexcept
    {
        if (!valid(parameterIndex)
            || gestures_[static_cast<size_t>(parameterIndex)].load(std::memory_order_acquire) == 0)
            return false;
        uint32_t valueBits = 0;
        static_assert(sizeof(valueBits) == sizeof(normalizedValue));
        std::memcpy(&valueBits, &normalizedValue, sizeof(valueBits));
        const bool captured = armed_.load(std::memory_order_acquire);
        const uint32_t parameterBits = static_cast<uint32_t>(parameterIndex) + 1u;
        const uint32_t indexBits = parameterBits
                                 | (captured ? captureMask : 0u);
        const uint64_t packed = (static_cast<uint64_t>(indexBits) << 32)
                              | valueBits;
        if (!captured)
        {
            pending_.store(packed, std::memory_order_release);
            return true;
        }

        // LEARN means the first distinct reliable parameter, not whichever
        // unrelated parameter happened to update last before the 30 Hz drain.
        // Repeated values from that first knob still update the displayed value.
        uint64_t current = pending_.load(std::memory_order_acquire);
        for (;;)
        {
            if (current != 0)
            {
                const uint32_t currentIndex = static_cast<uint32_t>(current >> 32);
                if ((currentIndex & captureMask) != 0
                    && (currentIndex & indexMask) != parameterBits)
                    return false;
            }
            if (pending_.compare_exchange_weak(current, packed,
                                               std::memory_order_acq_rel,
                                               std::memory_order_acquire))
                return true;
        }
    }

    std::optional<Touch> consume() noexcept
    {
        const uint64_t packed = pending_.exchange(0, std::memory_order_acq_rel);
        if (packed == 0)
            return std::nullopt;
        Touch result;
        const uint32_t indexBits = static_cast<uint32_t>(packed >> 32);
        result.parameterIndex = static_cast<int>(indexBits & indexMask) - 1;
        uint32_t valueBits = static_cast<uint32_t>(packed);
        std::memcpy(&result.normalizedValue, &valueBits, sizeof(result.normalizedValue));
        result.capturedByLearn = (indexBits & captureMask) != 0;
        if (result.capturedByLearn)
            armed_.store(false, std::memory_order_release);
        return result;
    }

    void setArmed(bool armed) noexcept
    {
        if (armed)
        {
            // A touch recorded before the button click is Last Touched data,
            // not the answer to the new Learn operation.
            pending_.store(0, std::memory_order_release);
            armed_.store(true, std::memory_order_release);
            return;
        }
        armed_.store(false, std::memory_order_release);
        uint64_t current = pending_.load(std::memory_order_acquire);
        if ((static_cast<uint32_t>(current >> 32) & captureMask) != 0)
            pending_.compare_exchange_strong(current, 0,
                                             std::memory_order_acq_rel,
                                             std::memory_order_acquire);
    }
    bool isArmed() const noexcept { return armed_.load(std::memory_order_acquire); }

private:
    bool valid(int index) const noexcept
    {
        return gestures_ != nullptr && index >= 0 && index < count_;
    }

    std::unique_ptr<std::atomic<uint8_t>[]> gestures_;
    static constexpr uint32_t captureMask = 0x80000000u;
    static constexpr uint32_t indexMask = 0x7fffffffu;
    int count_ = 0;
    std::atomic<uint64_t> pending_ { 0 };
    std::atomic<bool> armed_ { false };
};

} // namespace mlh
