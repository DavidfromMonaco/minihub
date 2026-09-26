#pragma once

#include "plugin_host.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

namespace mlh {

/** A plugin instance's id as the automation FIFO carries it (D-065): FNV-1a
 *  over its UTF-8, so an event stays sixteen bytes and a chain stays small
 *  enough for the stacks the tests build them on. */
inline uint64_t automationInstanceKey(const char* id) noexcept
{
    uint64_t hash = 1469598103934665603ull;
    for (; id != nullptr && *id != 0; ++id)
    {
        hash ^= static_cast<unsigned char>(*id);
        hash *= 1099511628211ull;
    }
    return hash;
}

/**
 * A serial chain of VST3 plugin instances for one VST node in the Hub network.
 *
 * The order of the plugin list is the processing order.
 *
 * Threading contract (this is the part that keeps the audio callback safe):
 *   - the plugin vector is mutated ONLY on the message thread, holding `lock_`
 *     for the whole mutation (including the destruction of a removed plugin)
 *   - the audio callback holds the SAME lock for the whole traversal, but takes
 *     it with tryEnter: it never blocks and never spins. If an edit is in
 *     flight the block is skipped (silence for that block) instead of the audio
 *     thread waiting on the message thread.
 *
 * Holding the lock across the traversal is what makes the raw pointers safe: a
 * plugin can no longer be destroyed while the audio thread is inside its
 * processBlock (the previous snapshot-then-release scheme was a use-after-free).
 *
 * MIDI is injected from the control thread through a lock-free ring buffer and
 * consumed inside the audio callback. `midiEnabled`/`outputEnabled` reflect
 * the Hub routing topology and gate whether MIDI reaches the chain and whether
 * the chain reaches the physical output.
 */
class Chain {
public:
    explicit Chain(juce::String chainId) : chainId_(std::move(chainId)) {}

    const juce::String& chainId() const { return chainId_; }

    // ---- message-thread mutations (take the lock) ----
    /** Insert at `index`. Returns false (and drops `p`) when the chain is full. */
    bool insertPlugin(int index, std::unique_ptr<PluginInstance> p);
    bool removePlugin(const juce::String& instanceId);
    bool reorderPlugin(const juce::String& instanceId, int toIndex);
    bool setPluginBypass(const juce::String& instanceId, bool bypassed);

    // ---- message-thread read ----
    /** Message-thread-only snapshot of the processing order.
     *
     *  Deliberately does NOT take `lock_`, for exactly the reason spelled out
     *  on `find()` below: mutations are serialised on the message thread, a
     *  read/read traversal against the audio callback is safe, and taking the
     *  lock here made the callback's try-lock drop otherwise healthy blocks.
     *  It used to be called once per second per chain from the diagnostics
     *  timer while audio was playing, allocating its vector under the lock. */
    std::vector<PluginInstance*> copyPlugins() const;

    /** Message-thread-only lookup. It deliberately does not take `lock_`:
     *  message-thread mutations are serialized, and a read/read traversal with
     *  the audio callback is safe. Taking the lock here could make the audio
     *  callback's try-lock drop an otherwise healthy block. */
    PluginInstance* find(const juce::String& instanceId);

    // Lock-free MIDI injection (control thread -> audio callback).
    void pushMidi(const juce::MidiBuffer& buffer);
    /** Queue only if the destination still belongs to the epoch captured by
     *  the producer. A concurrent Stop increments the epoch and rejects a
     *  stale callback before it can enqueue a post-Stop Note On. */
    void pushMidi(const juce::MidiBuffer& buffer, uint32_t expectedEpoch);
    uint32_t midiEpoch() const noexcept
    {
        return midiEpoch_.load(std::memory_order_acquire);
    }
    void pullMidi(juce::MidiBuffer& dest, int numSamples);
    /** Host automation (D-065), from the thread that plays the arrangement:
     *  a value for one plugin's parameter, handed to it before its next
     *  block. Lock-free; dropped when full, as MIDI is. */
    void pushAutomation(uint64_t instanceKey, uint32_t parameterId, float value) noexcept;
    /** Drop every queued event without emitting it (audio thread). */
    void discardQueuedMidi();

    bool midiEnabled() const { return midiEnabled_.load(std::memory_order_relaxed); }
    void setMidiEnabled(bool b);

    /**
     * Ask the audio thread to silence every held note on the next block.
     *
     * Losing the MIDI route (cable pulled, node deleted, device unplugged)
     * means the matching Note Offs will never arrive, so the instrument would
     * hold those notes forever. Safe to call from the message thread; the
     * messages themselves are emitted inside the callback.
     */
    void panic();
    bool outputEnabled() const { return outputEnabled_.load(std::memory_order_relaxed); }
    void setOutputEnabled(bool b) { outputEnabled_.store(b, std::memory_order_relaxed); }

    void prepareToPlay(double sampleRate, int blockSize, bool offline = false);
    void setPlayHead(juce::AudioPlayHead* playHead);
    void reset();
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi,
                      int numSamples, uint64_t blockId,
                      float instrumentGain = 1.0f,
                      float* peakBeforeInstrumentGain = nullptr,
                      float* peakAfterInstrumentGain = nullptr);
    /** Sum of the serial VST3 processor latencies. Control thread only. */
    int latencySamples() const;

private:
    juce::String chainId_;
    std::vector<std::unique_ptr<PluginInstance>> plugins_;
    mutable juce::SpinLock lock_;
    std::atomic<bool> midiEnabled_{false};
    std::atomic<bool> outputEnabled_{false};
    std::atomic<bool> panicPending_{false};
    juce::AudioPlayHead* playHead_ = nullptr;

    // Reused across blocks so the audio callback never allocates a MidiBuffer.
    static constexpr int kMidiScratchBytes = 8192;
    juce::MidiBuffer emptyMidi_;

    static constexpr int kMaxPlugins = 16;

    // Lock-free MIDI ring buffer (AbstractFifo manages indices atomically).
    static constexpr int kFifoSize = 4096;
    struct MidiEvent {
        int samplePos = 0;
        uint8_t bytes[3] = {};
        int numBytes = 0;
        uint32_t epoch = 0;
    };
    juce::AbstractFifo midiFifo_{kFifoSize};
    std::array<MidiEvent, kFifoSize> midiEvents_{};
    static constexpr int kAutomationFifoSize = 256;
    struct AutomationEvent {
        uint64_t instanceKey = 0;
        uint32_t parameterId = 0;
        float value = 0;
    };
    juce::AbstractFifo automationFifo_{kAutomationFifoSize};
    std::array<AutomationEvent, kAutomationFifoSize> automationEvents_{};
    /** Audio thread, lock held: every queued value to the plugin it names. */
    void applyAutomation() noexcept;
    std::atomic<uint32_t> midiEpoch_{1};
    // Audio-thread-owned registry. Explicit Note Offs are emitted from this
    // state before CC123/CC120 so instruments that ignore either CC still stop.
    std::array<uint16_t, 16 * 128> activeNotes_{};
};

} // namespace mlh
