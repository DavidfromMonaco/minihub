#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <atomic>
#include <memory>
#include <vector>

namespace mlh {

/** Audio-thread MIDI destination used by the existing native routing plans.
 * Tests can provide a deterministic virtual sink; production owns a JUCE
 * MidiOutput and uses its timestamped background scheduler. */
class MidiOutputSink {
public:
    virtual ~MidiOutputSink() = default;
    virtual void sendBlock(const juce::MidiBuffer&, double callbackStartMs,
                           double sampleRate) noexcept = 0;
    virtual void panic() noexcept = 0;
};

class PhysicalMidiOutput final : public MidiOutputSink {
public:
    ~PhysicalMidiOutput() override;

    static juce::Array<juce::var> describeAvailableDevices();
    bool selectDevice(const juce::String& identifier, const juce::String& name,
                      juce::String& error);
    void clearSelection();

    void sendBlock(const juce::MidiBuffer&, double callbackStartMs,
                   double sampleRate) noexcept override;
    void panic() noexcept override;

    juce::String selectedIdentifier() const { return selectedIdentifier_; }
    juce::String selectedName() const { return selectedName_; }
    bool available() const noexcept { return active_.load(std::memory_order_acquire) != nullptr; }

private:
    // Opened devices are retained until Engine shutdown. That makes an atomic
    // raw pointer safe while the audio callback overlaps an output selection.
    std::vector<std::unique_ptr<juce::MidiOutput>> owned_;
    std::atomic<juce::MidiOutput*> active_ { nullptr };
    juce::String selectedIdentifier_, selectedName_;
};

} // namespace mlh
