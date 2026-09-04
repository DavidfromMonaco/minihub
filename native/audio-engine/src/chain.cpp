#include "chain.h"

#include "realtime_drops.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

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
    // No lock: see the contract on the declaration.
    std::vector<PluginInstance*> out;
    out.reserve(plugins_.size());
    for (const auto& p : plugins_)
        out.push_back(p.get());
    return out;
}

int Chain::latencySamples() const
{
    const juce::SpinLock::ScopedLockType guard(lock_);
    int total = 0;
    for (const auto& plugin : plugins_)
        if (plugin && plugin->isReady() && !plugin->bypassed())
            total = std::min(131072, total + std::max(0, plugin->latencySamples()));
    return total;
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
    pushMidi(buffer, midiEpoch_.load(std::memory_order_acquire));
}

void Chain::pushMidi(const juce::MidiBuffer& buffer, uint32_t expectedEpoch)
{
    for (const auto& meta : buffer)
    {
        if (expectedEpoch != midiEpoch_.load(std::memory_order_acquire))
            return;
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
        ev.epoch = expectedEpoch;
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

void Chain::prepareToPlay(double sampleRate, int blockSize, bool offline)
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    // Grow the scratch MIDI buffer here rather than on the first block: a
    // plugin that emits MIDI would otherwise allocate inside the callback once.
    emptyMidi_.ensureSize(kMidiScratchBytes);
    for (auto& p : plugins_)
        p->prepareToPlay(sampleRate, blockSize, offline);
}

void Chain::reset()
{
    const juce::SpinLock::ScopedLockType sl(lock_);
    activeNotes_.fill(0);
    for (auto& p : plugins_)
        p->reset();
}

void Chain::setPlayHead(juce::AudioPlayHead* playHead)
{
    const juce::SpinLock::ScopedLockType guard(lock_);
    playHead_ = playHead;
    for (auto& plugin : plugins_) plugin->setPlayHead(playHead);
}

void Chain::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi,
                         int numSamples, uint64_t blockId,
                         float instrumentGain, float* peakBeforeInstrumentGain,
                         float* peakAfterInstrumentGain)
{
    if (peakBeforeInstrumentGain) *peakBeforeInstrumentGain = 0.0f;
    if (peakAfterInstrumentGain) *peakAfterInstrumentGain = 0.0f;
    if (numSamples <= 0 || numSamples > buffer.getNumSamples())
        return;
    // Real-time thread. Never block: if the message thread is mid-edit
    // (add / remove / reorder / bypass / state restore) we drop this block
    // rather than spin against it. The lock is then held for the whole
    // traversal, which is what guarantees no plugin is destroyed underneath us.
    const juce::SpinLock::ScopedTryLockType sl(lock_);
    if (!sl.isLocked())
    {
        // Silence for this block. Counted so it stops being invisible.
        RealtimeDropCounters::chainBlockSkipped();
        return;
    }

    if (panicPending_.exchange(false, std::memory_order_relaxed))
    {
        // Explicit Note Offs come first. Dexed/Vital and other instruments do
        // not all interpret CC123/CC120 identically, while this registry is the
        // exact set of notes actually delivered by this chain.
        for (int channel = 1; channel <= 16; ++channel)
        {
            for (int pitch = 0; pitch < 128; ++pitch)
            {
                auto& held = activeNotes_[static_cast<size_t>((channel - 1) * 128 + pitch)];
                while (held > 0)
                {
                    midi.addEvent(juce::MidiMessage::noteOff(channel, pitch), 0);
                    --held;
                }
            }
            midi.addEvent(juce::MidiMessage::allNotesOff(channel), 0);
            midi.addEvent(juce::MidiMessage::allSoundOff(channel), 0);
        }
        // Keep only events queued after panic (for example sample-zero note
        // chase on the first block after seek/export). Epoch filtering drops
        // stale pre-panic notes without swallowing the new transport block.
        pullMidi(midi, numSamples);
    }
    // Only pull MIDI into chains that are MIDI-connected in the Hub network.
    else if (midiEnabled())
    {
        pullMidi(midi, numSamples);
    }

    for (const auto& event : midi)
    {
        const auto message = event.getMessage();
        const int channel = message.getChannel();
        if (channel < 1 || channel > 16) continue;
        if (message.isNoteOn())
        {
            auto& held = activeNotes_[static_cast<size_t>((channel - 1) * 128
                                                          + message.getNoteNumber())];
            if (held < std::numeric_limits<uint16_t>::max()) ++held;
        }
        else if (message.isNoteOff())
        {
            auto& held = activeNotes_[static_cast<size_t>((channel - 1) * 128
                                                          + message.getNoteNumber())];
            if (held > 0) --held;
        }
        else if (message.isAllNotesOff() || message.isAllSoundOff())
        {
            for (int pitch = 0; pitch < 128; ++pitch)
                activeNotes_[static_cast<size_t>((channel - 1) * 128 + pitch)] = 0;
        }
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
            p->processBlock(buffer, midi, numSamples, blockId);
            const float before = std::max(buffer.getMagnitude(0, 0, numSamples),
                                          buffer.getNumChannels()>1
                                              ? buffer.getMagnitude(1, 0, numSamples) : 0.0f);
            if (peakBeforeInstrumentGain) *peakBeforeInstrumentGain = before;
            const float gain = std::isfinite(instrumentGain)
                ? std::clamp(instrumentGain, 0.0f, 2.0f) : 1.0f;
            if (gain != 1.0f) buffer.applyGain(0, numSamples, gain);
            if (peakAfterInstrumentGain)
                *peakAfterInstrumentGain = std::max(buffer.getMagnitude(0, 0, numSamples),
                                                     buffer.getNumChannels()>1
                                                         ? buffer.getMagnitude(1, 0, numSamples) : 0.0f);
        }
        else
        {
            // Reused member buffer: clear() keeps its capacity, so the audio
            // thread never allocates one.
            emptyMidi_.clear();
            p->processBlock(buffer, emptyMidi_, numSamples, blockId);
        }
    }
}

} // namespace mlh
