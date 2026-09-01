#pragma once

#include "audio_graph.h"

#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"

#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace engine2 {

class PluginInstance final : public IProcessor {
public:
    explicit PluginInstance(std::filesystem::path modulePath);
    ~PluginInstance() override;
    PluginInstance(const PluginInstance&) = delete;
    PluginInstance& operator=(const PluginInstance&) = delete;

    bool discoverAndCreate(std::string& error);
    bool prepare(double sampleRate, std::uint32_t maxBlockSize, bool offline,
                 std::string& error) override;
    bool start(std::string& error) override;
    void stop() noexcept override;
    void reset() noexcept override;
    bool process(float* left, float* right, std::uint32_t frames,
                 std::span<const MidiEvent> midi,
                 const TransportSnapshot& transport) noexcept override;
    [[nodiscard]] std::uint32_t latencySamples() const noexcept override;
    [[nodiscard]] const char* name() const noexcept override { return className_.c_str(); }
    [[nodiscard]] const std::filesystem::path& path() const noexcept { return modulePath_; }
    [[nodiscard]] bool isCreated() const noexcept { return provider_ != nullptr; }

private:
    bool configureBuses(std::string& error);
    void bindBuffers(float* left, float* right, std::uint32_t frames) noexcept;
    void fillProcessContext(const TransportSnapshot& transport) noexcept;
    void terminate() noexcept;

    std::filesystem::path modulePath_;
    std::string className_ {"uninitialized VST3"};
    std::shared_ptr<VST3::Hosting::Module> module_;
    Steinberg::IPtr<Steinberg::Vst::PlugProvider> provider_;
    Steinberg::IPtr<Steinberg::Vst::IComponent> component_;
    Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
    Steinberg::Vst::HostProcessData processData_;
    Steinberg::Vst::EventList inputEvents_ {static_cast<Steinberg::int32>(kMaxMidiEventsPerBlock)};
    Steinberg::Vst::EventList outputEvents_ {64};
    Steinberg::Vst::ProcessContext processContext_ {};
    std::vector<std::vector<float>> scratchChannels_;
    double sampleRate_ {kDefaultSampleRate};
    std::uint32_t maxBlockSize_ {kTargetBlockSize};
    bool offline_ {false};
    bool prepared_ {false};
    bool active_ {false};
    bool processing_ {false};
};

} // namespace engine2

