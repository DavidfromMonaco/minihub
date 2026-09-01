#include "plugin_instance.h"

#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"

#include <algorithm>
#include <cstring>
#include <sstream>

namespace engine2 {
namespace {

Steinberg::Vst::HostApplication* hostApplication() {
    static auto* host = new Steinberg::Vst::HostApplication();
    static const bool installed = [] {
        Steinberg::Vst::PluginContextFactory::instance().setPluginContext(host);
        return true;
    }();
    (void)installed;
    return host;
}

bool succeeded(Steinberg::tresult result) noexcept {
    return result == Steinberg::kResultOk || result == Steinberg::kResultTrue;
}

} // namespace

PluginInstance::PluginInstance(std::filesystem::path modulePath)
    : modulePath_(std::move(modulePath)) {
    (void)hostApplication();
}

PluginInstance::~PluginInstance() { terminate(); }

bool PluginInstance::discoverAndCreate(std::string& error) {
    if (provider_) return true;
    if (!std::filesystem::exists(modulePath_)) {
        error = "VST3 module does not exist: " + modulePath_.string();
        return false;
    }
    std::string moduleError;
    module_ = VST3::Hosting::Module::create(modulePath_.string(), moduleError);
    if (!module_) {
        error = "VST3 module load failed: " + moduleError;
        return false;
    }
    const auto factory = module_->getFactory();
    for (const auto& info : factory.classInfos()) {
        if (info.category() != kVstAudioEffectClass) continue;
        className_ = info.name();
        provider_ = Steinberg::owned(new Steinberg::Vst::PlugProvider(factory, info, true));
        break;
    }
    if (!provider_) {
        error = "module contains no VST3 audio-effect class";
        module_.reset();
        return false;
    }
    if (!provider_->initialize()) {
        error = "VST3 initialize/connect failed for " + className_;
        provider_.reset();
        module_.reset();
        return false;
    }
    component_ = provider_->getComponentPtr();
    processor_ = Steinberg::U::cast<Steinberg::Vst::IAudioProcessor>(component_);
    if (!component_ || !processor_) {
        error = "VST3 class has no IComponent/IAudioProcessor";
        terminate();
        return false;
    }
    return true;
}

bool PluginInstance::configureBuses(std::string& error) {
    using namespace Steinberg::Vst;
    SpeakerArrangement stereo[] = {SpeakerArr::kStereo};
    const auto inputCount = component_->getBusCount(kAudio, kInput);
    const auto outputCount = component_->getBusCount(kAudio, kOutput);
    if (outputCount < 1) {
        error = className_ + " exposes no audio output bus";
        return false;
    }
    // Instruments normally have no main audio input. Effects are tolerated by
    // presenting a stereo main input, but Engine 2's prototype tracks use synths.
    if (inputCount == 0) {
        if (!succeeded(processor_->setBusArrangements(nullptr, 0, stereo, 1))) {
            error = className_ + " rejected a stereo output arrangement";
            return false;
        }
    } else {
        if (!succeeded(processor_->setBusArrangements(stereo, 1, stereo, 1))) {
            error = className_ + " rejected stereo input/output arrangements";
            return false;
        }
    }
    for (Steinberg::int32 i = 0; i < component_->getBusCount(kAudio, kOutput); ++i)
        component_->activateBus(kAudio, kOutput, i, i == 0);
    for (Steinberg::int32 i = 0; i < component_->getBusCount(kAudio, kInput); ++i)
        component_->activateBus(kAudio, kInput, i, i == 0);
    for (Steinberg::int32 i = 0; i < component_->getBusCount(kEvent, kInput); ++i)
        component_->activateBus(kEvent, kInput, i, i == 0);
    return true;
}

bool PluginInstance::prepare(double sampleRate, std::uint32_t maxBlockSize, bool offline,
                             std::string& error) {
    if (!discoverAndCreate(error)) return false;
    if (maxBlockSize == 0 || maxBlockSize > kMaxBlockSize) {
        error = "invalid VST3 maximum block size";
        return false;
    }
    sampleRate_ = sampleRate;
    maxBlockSize_ = maxBlockSize;
    offline_ = offline;
    if (!configureBuses(error)) return false;

    Steinberg::Vst::ProcessSetup setup {};
    setup.processMode = offline ? Steinberg::Vst::kOffline : Steinberg::Vst::kRealtime;
    setup.symbolicSampleSize = Steinberg::Vst::kSample32;
    setup.maxSamplesPerBlock = static_cast<Steinberg::int32>(maxBlockSize);
    setup.sampleRate = sampleRate;
    if (!succeeded(processor_->setupProcessing(setup))) {
        error = className_ + " setupProcessing failed";
        return false;
    }
    if (!processData_.prepare(*component_, 0, Steinberg::Vst::kSample32)) {
        error = className_ + " process buffer setup failed";
        return false;
    }

    std::size_t channelSlots = 0;
    for (Steinberg::int32 b = 0; b < processData_.numInputs; ++b)
        channelSlots += static_cast<std::size_t>(processData_.inputs[b].numChannels);
    for (Steinberg::int32 b = 0; b < processData_.numOutputs; ++b)
        channelSlots += static_cast<std::size_t>(processData_.outputs[b].numChannels);
    scratchChannels_.assign(channelSlots, std::vector<float>(maxBlockSize_, 0.0F));

    processData_.processMode = setup.processMode;
    processData_.symbolicSampleSize = Steinberg::Vst::kSample32;
    processData_.inputEvents = &inputEvents_;
    processData_.outputEvents = &outputEvents_;
    processData_.processContext = &processContext_;
    processData_.inputParameterChanges = nullptr;
    processData_.outputParameterChanges = nullptr;
    prepared_ = true;
    return true;
}

bool PluginInstance::start(std::string& error) {
    if (!prepared_) { error = "VST3 instance is not prepared"; return false; }
    if (!active_) {
        if (!succeeded(component_->setActive(true))) {
            error = className_ + " activation failed";
            return false;
        }
        active_ = true;
    }
    if (!processing_) {
        if (!succeeded(processor_->setProcessing(true))) {
            component_->setActive(false);
            active_ = false;
            error = className_ + " setProcessing(true) failed";
            return false;
        }
        processing_ = true;
    }
    return true;
}

void PluginInstance::stop() noexcept {
    if (processing_ && processor_) {
        processor_->setProcessing(false);
        processing_ = false;
    }
    if (active_ && component_) {
        component_->setActive(false);
        active_ = false;
    }
}

void PluginInstance::reset() noexcept {
    inputEvents_.clear();
    outputEvents_.clear();
    if (!prepared_ || !processor_ || !component_) return;
    const bool wasRunning = processing_;
    stop();
    Steinberg::Vst::ProcessSetup setup {
        offline_ ? Steinberg::Vst::kOffline : Steinberg::Vst::kRealtime,
        Steinberg::Vst::kSample32,
        static_cast<Steinberg::int32>(maxBlockSize_), sampleRate_};
    processor_->setupProcessing(setup);
    if (wasRunning) {
        std::string ignored;
        start(ignored);
    }
}

void PluginInstance::bindBuffers(float* left, float* right, std::uint32_t frames) noexcept {
    std::size_t scratch = 0;
    for (Steinberg::int32 b = 0; b < processData_.numInputs; ++b) {
        auto& bus = processData_.inputs[b];
        bus.silenceFlags = Steinberg::Vst::HostProcessData::kAllChannelsSilent;
        for (Steinberg::int32 c = 0; c < bus.numChannels; ++c) {
            auto& channel = scratchChannels_[scratch++];
            std::fill_n(channel.data(), frames, 0.0F);
            bus.channelBuffers32[c] = channel.data();
        }
    }
    bool assignedLeft = false;
    bool assignedRight = false;
    for (Steinberg::int32 b = 0; b < processData_.numOutputs; ++b) {
        auto& bus = processData_.outputs[b];
        bus.silenceFlags = 0;
        for (Steinberg::int32 c = 0; c < bus.numChannels; ++c) {
            if (b == 0 && c == 0) {
                bus.channelBuffers32[c] = left;
                assignedLeft = true;
            } else if (b == 0 && c == 1) {
                bus.channelBuffers32[c] = right;
                assignedRight = true;
            } else {
                auto& channel = scratchChannels_[scratch++];
                std::fill_n(channel.data(), frames, 0.0F);
                bus.channelBuffers32[c] = channel.data();
            }
        }
    }
    if (!assignedLeft) std::fill_n(left, frames, 0.0F);
    if (!assignedRight) std::fill_n(right, frames, 0.0F);
}

void PluginInstance::fillProcessContext(const TransportSnapshot& transport) noexcept {
    using namespace Steinberg::Vst;
    processContext_ = {};
    processContext_.sampleRate = sampleRate_;
    processContext_.projectTimeSamples = transport.samplePosition;
    processContext_.continousTimeSamples = transport.samplePosition;
    processContext_.projectTimeMusic = transport.ppqPosition;
    processContext_.tempo = transport.tempo;
    processContext_.cycleStartMusic = static_cast<double>(transport.loopStart) * transport.tempo /
                                      (60.0 * sampleRate_);
    processContext_.cycleEndMusic = static_cast<double>(transport.loopEnd) * transport.tempo /
                                    (60.0 * sampleRate_);
    processContext_.state = ProcessContext::kProjectTimeMusicValid |
                            ProcessContext::kTempoValid |
                            ProcessContext::kContTimeValid;
    if (transport.playing) processContext_.state |= ProcessContext::kPlaying;
    if (transport.loopActive) {
        processContext_.state |= ProcessContext::kCycleActive |
                                 ProcessContext::kCycleValid;
    }
}

bool PluginInstance::process(float* left, float* right, std::uint32_t frames,
                             std::span<const MidiEvent> midi,
                             const TransportSnapshot& transport) noexcept {
    if (!processing_ || frames > maxBlockSize_) return false;
    inputEvents_.clear();
    outputEvents_.clear();
    for (const auto& event : midi) {
        Steinberg::Vst::Event vst {};
        vst.busIndex = 0;
        vst.sampleOffset = static_cast<Steinberg::int32>(event.sampleOffset);
        vst.ppqPosition = transport.ppqPosition +
            (static_cast<double>(event.sampleOffset) * transport.tempo / (60.0 * sampleRate_));
        vst.flags = Steinberg::Vst::Event::kIsLive;
        if (event.type == MidiType::noteOn && event.velocity > 0.0F) {
            vst.type = Steinberg::Vst::Event::kNoteOnEvent;
            vst.noteOn.channel = static_cast<Steinberg::int16>(event.channel);
            vst.noteOn.pitch = static_cast<Steinberg::int16>(event.note);
            vst.noteOn.tuning = 0.0F;
            vst.noteOn.velocity = event.velocity;
            vst.noteOn.length = 0;
            vst.noteOn.noteId = -1;
        } else {
            vst.type = Steinberg::Vst::Event::kNoteOffEvent;
            vst.noteOff.channel = static_cast<Steinberg::int16>(event.channel);
            vst.noteOff.pitch = static_cast<Steinberg::int16>(event.note);
            vst.noteOff.tuning = 0.0F;
            vst.noteOff.velocity = event.velocity;
            vst.noteOff.noteId = -1;
        }
        if (!succeeded(inputEvents_.addEvent(vst))) return false;
    }
    bindBuffers(left, right, frames);
    fillProcessContext(transport);
    processData_.numSamples = static_cast<Steinberg::int32>(frames);
    if (!succeeded(processor_->process(processData_))) return false;
    if (processData_.numOutputs > 0 && processData_.outputs[0].numChannels == 1)
        std::copy_n(left, frames, right);
    return true;
}

std::uint32_t PluginInstance::latencySamples() const noexcept {
    return processor_ ? processor_->getLatencySamples() : 0;
}

void PluginInstance::terminate() noexcept {
    stop();
    processData_.inputEvents = nullptr;
    processData_.outputEvents = nullptr;
    processData_.processContext = nullptr;
    processData_.unprepare();
    processor_.reset();
    component_.reset();
    // PlugProvider disconnects component/controller, calls terminate on both,
    // and releases every SDK pointer before the DLL module is unloaded.
    provider_.reset();
    module_.reset();
    prepared_ = false;
}

} // namespace engine2
