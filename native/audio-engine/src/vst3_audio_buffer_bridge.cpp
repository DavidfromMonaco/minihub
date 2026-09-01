#include "vst3_audio_buffer_bridge.h"

#include <algorithm>
#include <cstring>
#include <limits>

namespace mlh {

namespace {

const char* directionName(Steinberg::Vst::BusDirection direction) noexcept
{
    return direction == Steinberg::Vst::kInput ? "input" : "output";
}

} // namespace

bool Vst3AudioBufferBridge::prepare(Steinberg::Vst::IComponent& component,
                                    int maximumSamplesPerBlock,
                                    int mainInputBus,
                                    int mainOutputBus,
                                    bool acceptsEngineAudioInput,
                                    std::string& error)
{
    reset();
    if (maximumSamplesPerBlock <= 0)
    {
        error = "VST3 bridge received an invalid maximum block size";
        return false;
    }

    maximumSamplesPerBlock_ = maximumSamplesPerBlock;
    mainInputBus_ = mainInputBus;
    mainOutputBus_ = mainOutputBus;
    acceptsEngineAudioInput_ = acceptsEngineAudioInput;

    if (!prepareDirection(component, Steinberg::Vst::kInput, inputs_, error)
        || !prepareDirection(component, Steinberg::Vst::kOutput, outputs_, error))
    {
        reset();
        return false;
    }

    if (mainOutputBus_ < 0
        || mainOutputBus_ >= static_cast<int>(outputs_.buses.size())
        || outputs_.buses[static_cast<size_t>(mainOutputBus_)].info.channelCount < 1)
    {
        error = "VST3 bridge has no valid main output bus";
        reset();
        return false;
    }
    if (acceptsEngineAudioInput_
        && (mainInputBus_ < 0
            || mainInputBus_ >= static_cast<int>(inputs_.buses.size())
            || inputs_.buses[static_cast<size_t>(mainInputBus_)].info.channelCount < 1))
    {
        error = "VST3 effect bridge has no valid main input bus";
        reset();
        return false;
    }

    prepared_ = true;
    return true;
}

void Vst3AudioBufferBridge::reset() noexcept
{
    inputs_ = {};
    outputs_ = {};
    maximumSamplesPerBlock_ = 0;
    mainInputBus_ = -1;
    mainOutputBus_ = -1;
    acceptsEngineAudioInput_ = false;
    prepared_ = false;
}

void Vst3AudioBufferBridge::attach(Steinberg::Vst::ProcessData& processData) noexcept
{
    processData.numInputs = static_cast<Steinberg::int32>(inputs_.descriptors.size());
    processData.inputs = inputs_.descriptors.empty() ? nullptr : inputs_.descriptors.data();
    processData.numOutputs = static_cast<Steinberg::int32>(outputs_.descriptors.size());
    processData.outputs = outputs_.descriptors.empty() ? nullptr : outputs_.descriptors.data();
}

bool Vst3AudioBufferBridge::beginBlock(const juce::AudioBuffer<float>& engineAudio,
                                       int numSamples) noexcept
{
    if (!prepared_ || numSamples <= 0 || numSamples > maximumSamplesPerBlock_
        || engineAudio.getNumChannels() < 1 || engineAudio.getNumSamples() < numSamples)
        return false;

    for (size_t busIndex = 0; busIndex < inputs_.buses.size(); ++busIndex)
    {
        auto& bus = inputs_.buses[busIndex];
        auto& descriptor = inputs_.descriptors[busIndex];
        Steinberg::uint64 silenceFlags = 0;
        const bool copyEngineInput = acceptsEngineAudioInput_
                                  && static_cast<int>(busIndex) == mainInputBus_;
        for (int channel = 0; channel < bus.info.channelCount; ++channel)
        {
            auto* destination = bus.channelPointers[static_cast<size_t>(channel)];
            if (copyEngineInput)
            {
                const int sourceChannel = std::min(channel, engineAudio.getNumChannels() - 1);
                std::copy_n(engineAudio.getReadPointer(sourceChannel), numSamples, destination);
                if (channel < 64 && isSilent(destination, numSamples))
                    silenceFlags |= Steinberg::uint64{1} << channel;
            }
            else
            {
                std::fill_n(destination, numSamples, 0.0f);
                if (channel < 64)
                    silenceFlags |= Steinberg::uint64{1} << channel;
            }
        }
        descriptor.silenceFlags = silenceFlags;
    }

    for (size_t busIndex = 0; busIndex < outputs_.buses.size(); ++busIndex)
    {
        auto& bus = outputs_.buses[busIndex];
        auto& descriptor = outputs_.descriptors[busIndex];
        for (auto* channel : bus.channelPointers)
            std::fill_n(channel, numSamples, 0.0f);
        // The output state belongs to this process call. Do not carry a flag
        // written by the plug-in during the previous block into the next one.
        descriptor.silenceFlags = 0;
    }
    return true;
}

bool Vst3AudioBufferBridge::copyMainOutputTo(juce::AudioBuffer<float>& engineAudio,
                                              int numSamples) noexcept
{
    if (!prepared_ || numSamples <= 0 || numSamples > maximumSamplesPerBlock_
        || engineAudio.getNumSamples() < numSamples || engineAudio.getNumChannels() < 1
        || mainOutputBus_ < 0 || mainOutputBus_ >= static_cast<int>(outputs_.buses.size()))
        return false;

    const auto& bus = outputs_.buses[static_cast<size_t>(mainOutputBus_)];
    if (bus.channelPointers.empty())
        return false;

    for (int channel = 0; channel < engineAudio.getNumChannels(); ++channel)
    {
        const int sourceChannel = std::min(channel,
            static_cast<int>(bus.channelPointers.size()) - 1);
        engineAudio.copyFrom(channel, 0,
                             bus.channelPointers[static_cast<size_t>(sourceChannel)],
                             numSamples);
    }
    return true;
}

Vst3AudioBufferLayoutTrace Vst3AudioBufferBridge::layoutTrace() const noexcept
{
    Vst3AudioBufferLayoutTrace result;
    result.inputBusCount = inputBusCount();
    result.outputBusCount = outputBusCount();
    result.mainInputBus = mainInputBus_;
    result.mainOutputBus = mainOutputBus_;
    result.mainInputChannels = mainInputChannels();
    result.mainOutputChannels = mainOutputChannels();
    const auto* inputLeft = channelAddress(inputs_, mainInputBus_, 0);
    const auto* inputRight = channelAddress(inputs_, mainInputBus_, 1);
    const auto* outputLeft = channelAddress(outputs_, mainOutputBus_, 0);
    const auto* outputRight = channelAddress(outputs_, mainOutputBus_, 1);
    result.inputLeft = reinterpret_cast<std::uintptr_t>(inputLeft);
    result.inputRight = reinterpret_cast<std::uintptr_t>(inputRight);
    result.outputLeft = reinterpret_cast<std::uintptr_t>(outputLeft);
    result.outputRight = reinterpret_cast<std::uintptr_t>(outputRight);
    result.inputOutputDistinct =
        (inputLeft == nullptr || (inputLeft != outputLeft && inputLeft != outputRight))
        && (inputRight == nullptr || (inputRight != outputLeft && inputRight != outputRight));
    return result;
}

int Vst3AudioBufferBridge::mainInputChannels() const noexcept
{
    return mainInputBus_ >= 0 && mainInputBus_ < static_cast<int>(inputs_.buses.size())
        ? inputs_.buses[static_cast<size_t>(mainInputBus_)].info.channelCount : 0;
}

int Vst3AudioBufferBridge::mainOutputChannels() const noexcept
{
    return mainOutputBus_ >= 0 && mainOutputBus_ < static_cast<int>(outputs_.buses.size())
        ? outputs_.buses[static_cast<size_t>(mainOutputBus_)].info.channelCount : 0;
}

int Vst3AudioBufferBridge::inputBusCount() const noexcept
{
    return static_cast<int>(inputs_.buses.size());
}

int Vst3AudioBufferBridge::outputBusCount() const noexcept
{
    return static_cast<int>(outputs_.buses.size());
}

bool Vst3AudioBufferBridge::prepareDirection(Steinberg::Vst::IComponent& component,
                                             Steinberg::Vst::BusDirection direction,
                                             DirectionStorage& storage,
                                             std::string& error)
{
    const auto busCount = component.getBusCount(Steinberg::Vst::kAudio, direction);
    if (busCount < 0)
    {
        error = std::string("VST3 returned an invalid ") + directionName(direction)
              + " bus count";
        return false;
    }

    storage.buses.clear();
    storage.descriptors.clear();
    storage.buses.reserve(static_cast<size_t>(busCount));
    for (Steinberg::int32 busIndex = 0; busIndex < busCount; ++busIndex)
    {
        Steinberg::Vst::BusInfo info {};
        if (component.getBusInfo(Steinberg::Vst::kAudio, direction, busIndex, info)
            != Steinberg::kResultTrue || info.channelCount < 0)
        {
            error = std::string("VST3 returned invalid ") + directionName(direction)
                  + " bus information";
            return false;
        }

        BusStorage bus;
        bus.info = info;
        bus.channels.reserve(static_cast<size_t>(info.channelCount));
        bus.channelPointers.reserve(static_cast<size_t>(info.channelCount));
        for (Steinberg::int32 channel = 0; channel < info.channelCount; ++channel)
        {
            ChannelStorage owned;
            owned.samples = std::make_unique<Steinberg::Vst::Sample32[]>(
                static_cast<size_t>(maximumSamplesPerBlock_));
            std::fill_n(owned.samples.get(), maximumSamplesPerBlock_, 0.0f);
            bus.channelPointers.push_back(owned.samples.get());
            bus.channels.push_back(std::move(owned));
        }
        storage.buses.push_back(std::move(bus));
    }

    // Build the SDK-facing pointer arrays only after all owning vectors have
    // reached their final size. No later code resizes either collection.
    storage.descriptors.resize(static_cast<size_t>(busCount));
    for (size_t busIndex = 0; busIndex < storage.buses.size(); ++busIndex)
    {
        auto& bus = storage.buses[busIndex];
        auto& descriptor = storage.descriptors[busIndex];
        descriptor.numChannels = bus.info.channelCount;
        descriptor.silenceFlags = allChannelsSilent(bus.info.channelCount);
        descriptor.channelBuffers32 = bus.channelPointers.empty()
            ? nullptr : bus.channelPointers.data();
    }
    return true;
}

Steinberg::uint64 Vst3AudioBufferBridge::allChannelsSilent(int channelCount) noexcept
{
    if (channelCount <= 0)
        return 0;
    if (channelCount >= 64)
        return std::numeric_limits<Steinberg::uint64>::max();
    return (Steinberg::uint64{1} << channelCount) - 1;
}

bool Vst3AudioBufferBridge::isSilent(const Steinberg::Vst::Sample32* samples,
                                     int numSamples) noexcept
{
    for (int sample = 0; sample < numSamples; ++sample)
        if (samples[sample] != 0.0f)
            return false;
    return true;
}

Steinberg::Vst::Sample32* Vst3AudioBufferBridge::channelAddress(
    DirectionStorage& storage, int bus, int channel) noexcept
{
    return const_cast<Steinberg::Vst::Sample32*>(channelAddress(
        static_cast<const DirectionStorage&>(storage), bus, channel));
}

const Steinberg::Vst::Sample32* Vst3AudioBufferBridge::channelAddress(
    const DirectionStorage& storage, int bus, int channel) noexcept
{
    if (bus < 0 || bus >= static_cast<int>(storage.buses.size()))
        return nullptr;
    const auto& pointers = storage.buses[static_cast<size_t>(bus)].channelPointers;
    return channel >= 0 && channel < static_cast<int>(pointers.size())
        ? pointers[static_cast<size_t>(channel)] : nullptr;
}

} // namespace mlh
