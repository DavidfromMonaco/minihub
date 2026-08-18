#pragma once

#include "plugin_host.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <memory>
#include <vector>

namespace mlh {

/**
 * A serial chain of VST3 plugin instances for one VST node in the Hub graph.
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

    // ---- message-thread read (takes the lock, allocates) ----
    std::vector<PluginInstance*> copyPlugins() const;

    /** Number of plugins currently in the chain (message thread). */
    int size() const;

    PluginInstance* find(const juce::String& instanceId);

    // Lock-free MIDI injection (control thread -> audio callback).
    void pushMidi(const juce::MidiBuffer& buffer);
    void pullMidi(juce::MidiBuffer& dest, int numSamples);

    bool midiEnabled() const { return midiEnabled_.load(std::memory_order_relaxed); }
    void setMidiEnabled(bool b) { midiEnabled_.store(b, std::memory_order_relaxed); }
    bool outputEnabled() const { return outputEnabled_.load(std::memory_order_relaxed); }
    void setOutputEnabled(bool b) { outputEnabled_.store(b, std::memory_order_relaxed); }

    void prepareToPlay(double sampleRate, int blockSize);
    void reset();
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);

private:
    juce::String chainId_;
    std::vector<std::unique_ptr<PluginInstance>> plugins_;
    mutable juce::SpinLock lock_;
    std::atomic<bool> midiEnabled_{false};
    std::atomic<bool> outputEnabled_{false};

    // Reused across blocks so the audio callback never allocates a MidiBuffer.
    juce::MidiBuffer emptyMidi_;

    static constexpr int kMaxPlugins = 16;

    // Lock-free MIDI ring buffer (AbstractFifo manages indices atomically).
    static constexpr int kFifoSize = 4096;
    struct MidiEvent {
        int samplePos = 0;
        uint8_t bytes[3] = {};
        int numBytes = 0;
    };
    juce::AbstractFifo midiFifo_{kFifoSize};
    std::array<MidiEvent, kFifoSize> midiEvents_{};
};

} // namespace mlh
