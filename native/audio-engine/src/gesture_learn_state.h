#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>
#include <vector>

namespace mlh {

/** Lock-free state shared by hosted-parameter callbacks and the message thread.
 *  Parameter callbacks only touch atomics; names and plugin APIs stay out of
 *  the real-time path.
 *
 *  A PARAMETER ALREADY MOVING WHEN LEARN IS ARMED IS NOT THE ANSWER. Learn is
 *  armed by a click in the bindings bar, so the mouse that clicked was not in
 *  the plugin: a gesture going on at that moment is the plugin's own. Massive X
 *  was seen opening gestures of its own 23 times a second for half a minute
 *  after its window opened, and two Learns armed during it took that parameter
 *  within 50 ms. Such a parameter is set aside for this Learn, until it has
 *  been still for `quietMs` and moves again -- then it is a new gesture. */
class GestureLearnState {
public:
    static constexpr uint32_t quietMs = 200;

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
        lastTouch_ = count_ > 0
            ? std::make_unique<std::atomic<uint32_t>[]>(static_cast<size_t>(count_))
            : nullptr;
        movingAtArm_ = count_ > 0
            ? std::make_unique<std::atomic<uint8_t>[]>(static_cast<size_t>(count_))
            : nullptr;
        for (int i = 0; i < count_; ++i)
        {
            lastTouch_[static_cast<size_t>(i)].store(0, std::memory_order_relaxed);
            movingAtArm_[static_cast<size_t>(i)].store(0, std::memory_order_relaxed);
        }
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
        // Never 0, which means "never touched".
        const uint32_t now = nowMs() | 1u;
        const uint32_t previous = lastTouch_[static_cast<size_t>(parameterIndex)].exchange(now, std::memory_order_acq_rel);
        auto& moving = movingAtArm_[static_cast<size_t>(parameterIndex)];
        if (moving.load(std::memory_order_acquire) != 0)
        {
            if (previous != 0 && now - previous <= quietMs)
                return false;
            moving.store(0, std::memory_order_release);
        }
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
            // not the answer to the new Learn operation. A parameter touched
            // within `quietMs` of the click is moving by itself.
            pending_.store(0, std::memory_order_release);
            const uint32_t now = nowMs() | 1u;
            for (int i = 0; i < count_; ++i)
            {
                const uint32_t last = lastTouch_[static_cast<size_t>(i)].load(std::memory_order_acquire);
                movingAtArm_[static_cast<size_t>(i)].store(
                    last != 0 && now - last <= quietMs ? 1 : 0, std::memory_order_release);
            }
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

    /** The parameters set aside by the last arming, at most `limit` of them:
     *  what the log names, so the next plugin that moves by itself says which. */
    std::vector<int> movingAtArm(int limit) const
    {
        std::vector<int> found;
        for (int i = 0; i < count_ && static_cast<int>(found.size()) < limit; ++i)
            if (movingAtArm_[static_cast<size_t>(i)].load(std::memory_order_acquire) != 0)
                found.push_back(i);
        return found;
    }

    /** Tests move the clock by hand; 0 is the real one. */
    void setTimeForTesting(uint32_t ms) noexcept { testNowMs_.store(ms, std::memory_order_release); }

private:
    uint32_t nowMs() const noexcept
    {
        const uint32_t fixed = testNowMs_.load(std::memory_order_acquire);
        if (fixed != 0)
            return fixed;
        return static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
    }

    bool valid(int index) const noexcept
    {
        return gestures_ != nullptr && index >= 0 && index < count_;
    }

    std::unique_ptr<std::atomic<uint8_t>[]> gestures_;
    std::unique_ptr<std::atomic<uint32_t>[]> lastTouch_;
    std::unique_ptr<std::atomic<uint8_t>[]> movingAtArm_;
    std::atomic<uint32_t> testNowMs_ { 0 };
    static constexpr uint32_t captureMask = 0x80000000u;
    static constexpr uint32_t indexMask = 0x7fffffffu;
    int count_ = 0;
    std::atomic<uint64_t> pending_ { 0 };
    std::atomic<bool> armed_ { false };
};

} // namespace mlh
