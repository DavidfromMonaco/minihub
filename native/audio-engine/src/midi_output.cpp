#include "midi_output.h"
#include "var_util.h"

#include <algorithm>

namespace mlh {

PhysicalMidiOutput::~PhysicalMidiOutput()
{
    active_.store(nullptr, std::memory_order_release);
    for (auto& output : owned_)
        output->stopBackgroundThread();
}

juce::Array<juce::var> PhysicalMidiOutput::describeAvailableDevices()
{
    juce::Array<juce::var> result;
    for (const auto& info : juce::MidiOutput::getAvailableDevices())
    {
        juce::var item = makeObject();
        setProp(item, "identifier", info.identifier);
        setProp(item, "name", info.name);
        result.add(item);
    }
    return result;
}

bool PhysicalMidiOutput::selectDevice(const juce::String& identifier,
                                      const juce::String& name,
                                      juce::String& error)
{
    if (identifier.isEmpty() && name.isEmpty())
    {
        clearSelection();
        return true;
    }

    const auto devices = juce::MidiOutput::getAvailableDevices();
    auto found = std::find_if(devices.begin(), devices.end(), [&](const auto& info)
    {
        return (identifier.isNotEmpty() && info.identifier == identifier)
            || (name.isNotEmpty() && info.name == name);
    });
    if (found == devices.end())
    {
        error = "MIDI output not found: " + (name.isNotEmpty() ? name : identifier);
        return false;
    }

    auto output = juce::MidiOutput::openDevice(found->identifier);
    if (!output)
    {
        error = "Could not open MIDI output: " + found->name;
        return false;
    }
    output->startBackgroundThread();

    // Silence and detach the old port before publishing the new one. The old
    // object remains owned so an in-flight callback can finish safely.
    clearSelection();
    auto* published = output.get();
    owned_.push_back(std::move(output));
    selectedIdentifier_ = found->identifier;
    selectedName_ = found->name;
    active_.store(published, std::memory_order_release);
    error.clear();
    return true;
}

void PhysicalMidiOutput::clearSelection()
{
    if (active_.load(std::memory_order_acquire) != nullptr)
        panic();
    active_.store(nullptr, std::memory_order_release);
    selectedIdentifier_.clear();
    selectedName_.clear();
}

void PhysicalMidiOutput::sendBlock(const juce::MidiBuffer& buffer,
                                   double callbackStartMs,
                                   double sampleRate) noexcept
{
    auto* output = active_.load(std::memory_order_acquire);
    if (!output || buffer.isEmpty() || sampleRate <= 0.0)
        return;
    // JUCE converts each sample position to a native timestamp on its MIDI
    // output thread. The small native look-ahead keeps sample-zero messages in
    // the future as required by sendBlockOfMessages; no renderer clock exists
    // in this scheduling path.
    output->sendBlockOfMessages(buffer, std::max(1.0, callbackStartMs), sampleRate);
}

void PhysicalMidiOutput::panic() noexcept
{
    auto* output = active_.load(std::memory_order_acquire);
    if (!output)
        return;
    output->clearAllPendingMessages();
    for (int channel = 1; channel <= 16; ++channel)
    {
        output->sendMessageNow(juce::MidiMessage::allNotesOff(channel));
        output->sendMessageNow(juce::MidiMessage::allSoundOff(channel));
    }
}

} // namespace mlh
