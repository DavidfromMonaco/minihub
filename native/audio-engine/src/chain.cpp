#include "chain.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace mlh {

PluginInstance* Chain::find(const juce::String& instanceId)
{
    jassert(juce::MessageManager::existsAndIsCurrentThread());
    for (auto& p : plugins_)
        if (p->instanceId() == instanceId)
            return p.get();
    return nullptr;
}

bool Chain::insertPlugin(int index, std::unique_ptr<PluginInstance> p)
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    if (plugins_.size() >= kMaxPlugins)
        return false;
    const int i = std::clamp(index, 0, static_cast<int>(plugins_.size()));
    p->setPlayHead(playHead_);
    plugins_.insert(plugins_.begin() + i, std::move(p));
    return true;
}

bool Chain::removePlugin(const juce::String& instanceId)
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    for (auto it = plugins_.begin(); it != plugins_.end(); ++it)
    {
        if ((*it)->instanceId() == instanceId)
        {
            plugins_.erase(it);
            return true;
        }
    }
    return false;
}

bool Chain::reorderPlugin(const juce::String& instanceId, int toIndex)
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    int from = -1;
    for (int i = 0; i < static_cast<int>(plugins_.size()); ++i)
        if (plugins_[static_cast<size_t>(i)]->instanceId() == instanceId)
        {
            from = i;
            break;
        }
    if (from < 0)
        return false;

    auto p = std::move(plugins_[static_cast<size_t>(from)]);
    plugins_.erase(plugins_.begin() + from);
    const int i = std::clamp(toIndex, 0, static_cast<int>(plugins_.size()));
    plugins_.insert(plugins_.begin() + i, std::move(p));
    return true;
}

bool Chain::setPluginBypass(const juce::String& instanceId, bool bypassed)
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    for (auto& p : plugins_)
        if (p->instanceId() == instanceId)
        {
            p->setBypassed(bypassed);
            return true;
        }
    return false;
}

std::vector<PluginInstance*> Chain::copyPlugins() const
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    std::vector<PluginInstance*> out;
    out.reserve(plugins_.size());
    for (const auto& p : plugins_)
        out.push_back(p.get());
    return out;
}

void Chain::setMidiEnabled(bool b)
{
    const bool was = midiEnabled_.exchange(b, std::memory_order_relaxed);
    // Losing the route means every Note Off that would have followed is now
    // never going to arrive: silence what is currently held.
    if (was && !b)
        panic();
}

void Chain::panic()
{
    midiEpoch_.fetch_add(1, std::memory_order_acq_rel);
    panicPending_.store(true, std::memory_order_relaxed);
}

void Chain::pushMidi(const juce::MidiBuffer& buffer)
{
    for (const auto& meta : buffer)
    {
        const auto epoch = midiEpoch_.load(std::memory_order_acquire);
        const juce::MidiMessage msg = meta.getMessage();
        const int n = msg.getRawDataSize();
        if (n <= 0 || n > 3)
            continue; // only channel messages (no sysex) for this milestone

        int start1, size1, start2, size2;
        midiFifo_.prepareToWrite(1, start1, size1, start2, size2);
        if (size1 + size2 == 0)
            continue; // full — drop rather than block the control thread

        const int slot = (size1 > 0) ? start1 : start2;
        auto& ev = midiEvents_[static_cast<size_t>(slot)];
        ev.samplePos = meta.samplePosition;
        ev.numBytes = n;
        ev.epoch = epoch;
        std::memcpy(ev.bytes, msg.getRawData(), static_cast<size_t>(n));
        midiFifo_.finishedWrite(1);
    }
}

void Chain::discardQueuedMidi()
{
    const int available = midiFifo_.getNumReady();
    if (available > 0)
        midiFifo_.finishedRead(available);
}

void Chain::pullMidi(juce::MidiBuffer& dest, int numSamples)
{
    const int available = midiFifo_.getNumReady();
    for (int i = 0; i < available; ++i)
    {
        int start1, size1, start2, size2;
        midiFifo_.prepareToRead(1, start1, size1, start2, size2);
        if (size1 + size2 == 0)
            break;

        const int slot = (size1 > 0) ? start1 : start2;
        const auto& ev = midiEvents_[static_cast<size_t>(slot)];
        const int pos = std::clamp(ev.samplePos, 0, numSamples - 1);
        if (ev.epoch == midiEpoch_.load(std::memory_order_acquire))
            dest.addEvent(juce::MidiMessage(ev.bytes, ev.numBytes, 0.0), pos);
        midiFifo_.finishedRead(1);
    }
}

void Chain::prepareToPlay(double sampleRate, int blockSize)
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    // Grow the scratch MIDI buffer here rather than on the first block: a
    // plugin that emits MIDI would otherwise allocate inside the callback once.
    emptyMidi_.ensureSize(kMidiScratchBytes);
    for (auto& p : plugins_)
        p->prepareToPlay(sampleRate, blockSize);
}

void Chain::reset()
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    for (auto& p : plugins_)
        p->reset();
}

void Chain::setPlayHead(juce::AudioPlayHead* playHead)
{
    const juce::SpinLock::ScopedLockType guard(lock_);
    playHead_ = playHead;
    for (auto& plugin : plugins_) plugin->setPlayHead(playHead);
}

void Chain::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    // Real-time thread. Never block: if the message thread is mid-edit
    // (add / remove / reorder / bypass / state restore) we drop this block
    // rather than spin against it. The lock is then held for the whole
    // traversal, which is what guarantees no plugin is destroyed underneath us.
    const juce::SpinLock::ScopedTryLockType sl(lock_);
    if (!sl.isLocked())
        return;

    if (panicPending_.exchange(false, std::memory_order_relaxed))
    {
        // Drop anything still queued (those notes belong to a route that no
        // longer exists) and silence the instruments. MidiMessage stores three
        // bytes inline and the buffer is pre-sized, so this does not allocate.
        for (int channel = 1; channel <= 16; ++channel)
        {
            midi.addEvent(juce::MidiMessage::allNotesOff(channel), 0);
            midi.addEvent(juce::MidiMessage::allSoundOff(channel), 0);
        }
        // Keep only events queued after panic (for example sample-zero note
        // chase on the first block after seek/export). Epoch filtering drops
        // stale pre-panic notes without swallowing the new transport block.
        pullMidi(midi, buffer.getNumSamples());
    }
    // Only pull MIDI into chains that are MIDI-connected in the Hub graph.
    else if (midiEnabled())
    {
        pullMidi(midi, buffer.getNumSamples());
    }

    // MIDI is consumed by the first instrument in the chain; subsequent
    // instruments (if any) receive no MIDI. Effects before the first
    // instrument process silence - they never "magically" receive audio.
    bool midiConsumed = false;
    for (auto& owned : plugins_)
    {
        auto* p = owned.get();
        if (!p->isReady() || p->bypassed())
            continue;

        if (p->isInstrument() && !midiConsumed)
        {
            midiConsumed = true;
            p->processBlock(buffer, midi);
        }
        else
        {
            // Reused member buffer: clear() keeps its capacity, so the audio
            // thread never allocates one.
            emptyMidi_.clear();
            p->processBlock(buffer, emptyMidi_);
        }
    }
}

} // namespace mlh
