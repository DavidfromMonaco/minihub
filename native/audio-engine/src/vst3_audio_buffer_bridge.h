#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace mlh {

/** Immutable address/layout information for one hosted VST3 instance.
 *
 * The addresses identify the bridge-owned planar buffers. They remain stable
 * from prepare() until reset(), including for every process() call.
 */
struct Vst3AudioBufferLayoutTrace {
    int inputBusCount = 0;
    int outputBusCount = 0;
    int mainInputBus = -1;
    int mainOutputBus = -1;
    int mainInputChannels = 0;
    int mainOutputChannels = 0;
    std::uintptr_t inputLeft = 0;
    std::uintptr_t inputRight = 0;
    std::uintptr_t outputLeft = 0;
    std::uintptr_t outputRight = 0;
    bool inputOutputDistinct = true;
};

/** Per-instance VST3 float32 planar audio boundary.
 *
 * This class is the sole owner of all sample buffers and channel-pointer
 * arrays supplied through ProcessData::inputs/outputs. Engine buffers never
 * alias VST buffers, so in-place processing is neither assumed nor accidental.
 */
class Vst3AudioBufferBridge final {
public:
    Vst3AudioBufferBridge() = default;
    ~Vst3AudioBufferBridge() = default;

    Vst3AudioBufferBridge(const Vst3AudioBufferBridge&) = delete;
    Vst3AudioBufferBridge& operator=(const Vst3AudioBufferBridge&) = delete;

    bool prepare(Steinberg::Vst::IComponent& component,
                 int maximumSamplesPerBlock,
                 int mainInputBus,
                 int mainOutputBus,
                 bool acceptsEngineAudioInput,
                 std::string& error);
    void reset() noexcept;

    /** Attach the bridge-owned descriptors to a ProcessData structure. */
    void attach(Steinberg::Vst::ProcessData& processData) noexcept;

    /** Copy/clear exactly numSamples frames and recompute all silence flags. */
    bool beginBlock(const juce::AudioBuffer<float>& engineAudio,
                    int numSamples) noexcept;

    /** Copy the negotiated main output back to Engine 2 exactly once. */
    bool copyMainOutputTo(juce::AudioBuffer<float>& engineAudio,
                          int numSamples) noexcept;

    Vst3AudioBufferLayoutTrace layoutTrace() const noexcept;
    int mainInputChannels() const noexcept;
    int mainOutputChannels() const noexcept;
    int inputBusCount() const noexcept;
    int outputBusCount() const noexcept;

private:
    struct ChannelStorage {
        std::unique_ptr<Steinberg::Vst::Sample32[]> samples;
    };

    struct BusStorage {
        Steinberg::Vst::BusInfo info {};
        std::vector<ChannelStorage> channels;
        std::vector<Steinberg::Vst::Sample32*> channelPointers;
    };

    struct DirectionStorage {
        std::vector<BusStorage> buses;
        std::vector<Steinberg::Vst::AudioBusBuffers> descriptors;
    };

    bool prepareDirection(Steinberg::Vst::IComponent& component,
                          Steinberg::Vst::BusDirection direction,
                          DirectionStorage& storage,
                          std::string& error);
    static Steinberg::uint64 allChannelsSilent(int channelCount) noexcept;
    static bool isSilent(const Steinberg::Vst::Sample32* samples,
                         int numSamples) noexcept;
    static Steinberg::Vst::Sample32* channelAddress(DirectionStorage& storage,
                                                     int bus,
                                                     int channel) noexcept;
    static const Steinberg::Vst::Sample32* channelAddress(
        const DirectionStorage& storage, int bus, int channel) noexcept;

    DirectionStorage inputs_;
    DirectionStorage outputs_;
    int maximumSamplesPerBlock_ = 0;
    int mainInputBus_ = -1;
    int mainOutputBus_ = -1;
    bool acceptsEngineAudioInput_ = false;
    bool prepared_ = false;
};

} // namespace mlh
