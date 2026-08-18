#include "chain.h"

#include <algorithm>
#include <cstring>

namespace mlh {

PluginInstance* Chain::find(const juce::String& instanceId)
{
    const juce::SpinLock::ScopedLockType sl(lock_);
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

int Chain::size() const
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    return static_cast<int>(plugins_.size());
}

void Chain::pushMidi(const juce::MidiBuffer& buffer)
{
    for (const auto& meta : buffer)
    {
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
        std::memcpy(ev.bytes, msg.getRawData(), static_cast<size_t>(n));
        midiFifo_.finishedWrite(1);
    }
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
        dest.addEvent(juce::MidiMessage(ev.bytes, ev.numBytes, 0.0), pos);
        midiFifo_.finishedRead(1);
    }
}

void Chain::prepareToPlay(double sampleRate, int blockSize)
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    for (auto& p : plugins_)
        p->prepareToPlay(sampleRate, blockSize);
}

void Chain::reset()
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    for (auto& p : plugins_)
        p->reset();
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

    // Only pull MIDI into chains that are MIDI-connected in the Hub graph.
    if (midiEnabled())
        pullMidi(midi, buffer.getNumSamples());

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
