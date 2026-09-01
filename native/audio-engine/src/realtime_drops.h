#pragma once

#include <atomic>
#include <cstdint>

namespace mlh {

/**
 * Process-wide counters for the two real-time paths that answer a contended
 * block with silence instead of audio.
 *
 * Both are deliberate designs: `Chain::processBlock` try-locks and gives up so
 * it can never block on a message-thread edit, and `PluginInstance` refuses to
 * enter a plugin that a control mutation currently owns. What was missing is
 * that a dropped block is indistinguishable from a healthy one for every other
 * metric: the callback still returns on time, writes finite zeros, and raises
 * no PortAudio underflow. A run could therefore report a clean bill of health
 * while the listener heard a click for every drop.
 *
 * These counters make that failure mode observable. They are plain relaxed
 * atomics: the audio thread only ever increments, and readers tolerate a stale
 * value by construction.
 */
struct RealtimeDropCounters final {
    /** A whole VST chain skipped because a message-thread edit held its lock. */
    static std::atomic<std::uint64_t>& chainBlocksSkipped() noexcept
    {
        static std::atomic<std::uint64_t> value {0};
        return value;
    }

    /** One plugin skipped because a control mutation (state, prepare, reset)
     *  owned it while the callback tried to enter. */
    static std::atomic<std::uint64_t>& pluginBlocksSkipped() noexcept
    {
        static std::atomic<std::uint64_t> value {0};
        return value;
    }

    static void chainBlockSkipped() noexcept
    {
        chainBlocksSkipped().fetch_add(1, std::memory_order_relaxed);
    }

    static void pluginBlockSkipped() noexcept
    {
        pluginBlocksSkipped().fetch_add(1, std::memory_order_relaxed);
    }
};

} // namespace mlh
