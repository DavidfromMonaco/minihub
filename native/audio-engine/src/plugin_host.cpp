#include "plugin_host.h"

#include "realtime_drops.h"

#include "var_util.h"
#include "vst3_audio_buffer_bridge.h"

#include <pluginterfaces/base/funknown.h>
#include <pluginterfaces/gui/iplugview.h>
#include <pluginterfaces/vst/ivsteditcontroller.h>
#include <pluginterfaces/vst/ivstmidicontrollers.h>
#include <pluginterfaces/vst/ivstparameterchanges.h>
#include <public.sdk/source/vst/hosting/eventlist.h>
#include <public.sdk/source/vst/hosting/hostclasses.h>
#include <public.sdk/source/vst/hosting/module.h>
#include <public.sdk/source/vst/hosting/plugprovider.h>
#include <public.sdk/source/vst/utility/memoryibstream.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#if JUCE_WINDOWS
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace mlh {

juce::String pluginEditorWindowTitle(const juce::String& pluginName)
{
    return juce::String::fromUTF8(u8"MiniHub · ") + pluginName;
}

juce::String pluginEditorUntouchedText()
{
    return juce::String::fromUTF8(u8"Last touched: —");
}

juce::String pluginEditorLearnArmedText()
{
    return juce::String::fromUTF8(u8"Learn armed in MiniHub — move one plugin control.");
}

namespace {

bool succeeded(Steinberg::tresult result) noexcept
{
    return result == Steinberg::kResultOk || result == Steinberg::kResultTrue;
}

Steinberg::Vst::HostApplication* hostApplication()
{
    static auto* host = new Steinberg::Vst::HostApplication();
    static const bool installed = []
    {
        Steinberg::Vst::PluginContextFactory::instance().setPluginContext(host);
        return true;
    }();
    (void)installed;
    return host;
}

juce::String fromVstString(const Steinberg::Vst::TChar* text)
{
    if (text == nullptr)
        return {};
#if JUCE_WINDOWS
    static_assert(sizeof(wchar_t) == sizeof(Steinberg::Vst::TChar));
    return juce::String(reinterpret_cast<const wchar_t*>(text));
#else
    return juce::String::fromUTF8(reinterpret_cast<const char*>(text));
#endif
}

template <typename Interface>
Steinberg::tresult fixedQueryInterface(Interface* self, const Steinberg::TUID iid,
                                       void** object) noexcept
{
    if (object == nullptr)
        return Steinberg::kInvalidArgument;
    if (Steinberg::FUnknownPrivate::iidEqual(iid, Interface::iid)
        || Steinberg::FUnknownPrivate::iidEqual(iid, Steinberg::FUnknown::iid))
    {
        *object = self;
        self->addRef();
        return Steinberg::kResultTrue;
    }
    *object = nullptr;
    return Steinberg::kNoInterface;
}

class FixedParameterValueQueue final : public Steinberg::Vst::IParamValueQueue {
public:
    struct Point { Steinberg::int32 offset = 0; Steinberg::Vst::ParamValue value = 0.0; };
    static constexpr int kMaximumPoints = 32;

    void reset(Steinberg::Vst::ParamID id) noexcept { id_ = id; count_ = 0; }
    Steinberg::Vst::ParamID PLUGIN_API getParameterId() override { return id_; }
    Steinberg::int32 PLUGIN_API getPointCount() override { return count_; }
    Steinberg::tresult PLUGIN_API getPoint(Steinberg::int32 index,
                                            Steinberg::int32& offset,
                                            Steinberg::Vst::ParamValue& value) override
    {
        if (index < 0 || index >= count_)
            return Steinberg::kResultFalse;
        offset = points_[static_cast<size_t>(index)].offset;
        value = points_[static_cast<size_t>(index)].value;
        return Steinberg::kResultTrue;
    }
    Steinberg::tresult PLUGIN_API addPoint(Steinberg::int32 offset,
                                           Steinberg::Vst::ParamValue value,
                                           Steinberg::int32& index) override
    {
        for (int i = 0; i < count_; ++i)
        {
            if (points_[static_cast<size_t>(i)].offset == offset)
            {
                points_[static_cast<size_t>(i)].value = value;
                index = i;
                return Steinberg::kResultTrue;
            }
        }
        if (count_ >= kMaximumPoints)
            return Steinberg::kOutOfMemory;
        int destination = count_;
        while (destination > 0
               && points_[static_cast<size_t>(destination - 1)].offset > offset)
        {
            points_[static_cast<size_t>(destination)] =
                points_[static_cast<size_t>(destination - 1)];
            --destination;
        }
        points_[static_cast<size_t>(destination)] = {offset, value};
        ++count_;
        index = destination;
        return Steinberg::kResultTrue;
    }
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID iid,
                                                  void** object) override
    {
        return fixedQueryInterface(this, iid, object);
    }
    Steinberg::uint32 PLUGIN_API addRef() override { return 1000; }
    Steinberg::uint32 PLUGIN_API release() override { return 1000; }

private:
    Steinberg::Vst::ParamID id_ = Steinberg::Vst::kNoParamId;
    int count_ = 0;
    std::array<Point, kMaximumPoints> points_ {};
};

class FixedParameterChanges final : public Steinberg::Vst::IParameterChanges {
public:
    static constexpr int kMaximumParameters = 256;
    void clear() noexcept { used_ = 0; }
    bool add(Steinberg::Vst::ParamID id, Steinberg::int32 offset,
             Steinberg::Vst::ParamValue value) noexcept
    {
        Steinberg::int32 queueIndex = 0;
        auto* queue = addParameterData(id, queueIndex);
        Steinberg::int32 pointIndex = 0;
        return queue != nullptr && succeeded(queue->addPoint(offset, value, pointIndex));
    }
    Steinberg::int32 PLUGIN_API getParameterCount() override { return used_; }
    Steinberg::Vst::IParamValueQueue* PLUGIN_API getParameterData(
        Steinberg::int32 index) override
    {
        return index >= 0 && index < used_ ? &queues_[static_cast<size_t>(index)] : nullptr;
    }
    Steinberg::Vst::IParamValueQueue* PLUGIN_API addParameterData(
        const Steinberg::Vst::ParamID& id, Steinberg::int32& index) override
    {
        for (int i = 0; i < used_; ++i)
            if (queues_[static_cast<size_t>(i)].getParameterId() == id)
            {
                index = i;
                return &queues_[static_cast<size_t>(i)];
            }
        if (used_ >= kMaximumParameters)
            return nullptr;
        index = used_;
        queues_[static_cast<size_t>(used_)].reset(id);
        return &queues_[static_cast<size_t>(used_++)];
    }
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID iid,
                                                  void** object) override
    {
        return fixedQueryInterface(this, iid, object);
    }
    Steinberg::uint32 PLUGIN_API addRef() override { return 1000; }
    Steinberg::uint32 PLUGIN_API release() override { return 1000; }

private:
    int used_ = 0;
    std::array<FixedParameterValueQueue, kMaximumParameters> queues_ {};
};

void appendMaximum(std::atomic<float>& destination, float value) noexcept
{
    float observed = destination.load(std::memory_order_relaxed);
    while (value > observed
           && !destination.compare_exchange_weak(observed, value,
                                                 std::memory_order_release,
                                                 std::memory_order_relaxed)) {}
}

} // namespace

class DirectVst3Plugin final {
public:
    explicit DirectVst3Plugin(PluginInstance& owner) : owner_(owner)
    {
        (void)hostApplication();
        midiAssignments_.fill(Steinberg::Vst::kNoParamId);
    }

    ~DirectVst3Plugin() { terminate(); }

    bool create(const PluginRecord& record, std::string& error)
    {
        const auto path = record.path.isNotEmpty() ? record.path : record.pluginId;
        if (!juce::File(path).exists())
        {
            error = "VST3 module does not exist: " + path.toStdString();
            return false;
        }

        std::string moduleError;
        module_ = VST3::Hosting::Module::create(path.toStdString(), moduleError);
        if (!module_)
        {
            error = "VST3 module load failed: " + moduleError;
            return false;
        }

        const auto factory = module_->getFactory();
        VST3::Hosting::ClassInfo selected;
        bool found = false;
        for (const auto& info : factory.classInfos())
        {
            if (info.category() != kVstAudioEffectClass)
                continue;
            if (!found || record.name.toStdString() == info.name())
            {
                selected = info;
                found = true;
                if (record.name.toStdString() == info.name())
                    break;
            }
        }
        if (!found)
        {
            error = "module contains no VST3 audio-effect class";
            module_.reset();
            return false;
        }

        className_ = selected.name();
        provider_ = Steinberg::owned(
            new Steinberg::Vst::PlugProvider(factory, selected, true));
        if (!provider_->initialize())
        {
            error = "VST3 initialize/connect failed for " + className_;
            terminate();
            return false;
        }
        component_ = provider_->getComponentPtr();
        processor_ = Steinberg::U::cast<Steinberg::Vst::IAudioProcessor>(component_);
        controller_ = provider_->getController();
        if (!component_ || !processor_ || !controller_)
        {
            error = "VST3 class is missing IComponent, IAudioProcessor or IEditController";
            terminate();
            return false;
        }

        handler_ = Steinberg::owned(new ComponentHandler(*this));
        controller_->setComponentHandler(handler_);
        midiMapping_ = Steinberg::U::cast<Steinberg::Vst::IMidiMapping>(controller_);
        buildParameterIndex();
        buildMidiAssignments();
        return true;
    }

    bool prepare(double sampleRate, int blockSize, bool offline, std::string& error)
    {
        if (!component_ || !processor_)
        {
            error = "VST3 instance is not created";
            return false;
        }
        if (blockSize <= 0 || blockSize > 4096)
        {
            error = "invalid VST3 maximum block size";
            return false;
        }
        stop();
        prepared_ = false;
        processData_ = {};
        audioBridge_.reset();
        if (!configureBuses(error))
            return false;

        if (!succeeded(processor_->canProcessSampleSize(Steinberg::Vst::kSample32)))
        {
            error = className_ + " cannot process required float32 samples";
            return false;
        }

        sampleRate_ = sampleRate;
        maximumBlockSize_ = blockSize;
        offline_ = offline;
        Steinberg::Vst::ProcessSetup setup {};
        setup.processMode = offline ? Steinberg::Vst::kOffline : Steinberg::Vst::kRealtime;
        setup.symbolicSampleSize = Steinberg::Vst::kSample32;
        setup.maxSamplesPerBlock = blockSize;
        setup.sampleRate = sampleRate;
        if (!succeeded(processor_->setupProcessing(setup)))
        {
            error = className_ + " setupProcessing failed";
            return false;
        }
        if (!audioBridge_.prepare(*component_, blockSize,
                                  mainInputBus_, mainOutputBus_,
                                  !owner_.isInstrument(), error))
        {
            if (error.empty())
                error = className_ + " planar process-buffer setup failed";
            return false;
        }

        audioBridge_.attach(processData_);
        processData_.processMode = setup.processMode;
        processData_.symbolicSampleSize = Steinberg::Vst::kSample32;
        processData_.inputEvents = &inputEvents_;
        processData_.outputEvents = &outputEvents_;
        processData_.inputParameterChanges = &inputParameters_;
        processData_.outputParameterChanges = &outputParameters_;
        processData_.processContext = &processContext_;
        prepared_ = true;
        return start(error);
    }

    void reset() noexcept
    {
        inputEvents_.clear();
        outputEvents_.clear();
        inputParameters_.clear();
        outputParameters_.clear();
        if (!prepared_ || !processor_ || !component_)
            return;
        const bool resume = processing_;
        stop();
        if (resume)
        {
            std::string ignored;
            start(ignored);
        }
    }

    bool process(juce::AudioBuffer<float>& audio, int numSamples,
                 const juce::MidiBuffer& midi,
                 juce::AudioPlayHead* playHead, uint64_t blockId) noexcept
    {
        if (!processing_ || numSamples <= 0 || numSamples > maximumBlockSize_
            || audio.getNumChannels() < 1 || audio.getNumSamples() < numSamples)
            return false;

        inputEvents_.clear();
        outputEvents_.clear();
        inputParameters_.clear();
        outputParameters_.clear();
        drainPendingParameters();
        fillProcessContext(playHead);
        convertMidi(midi, numSamples);
        if (!audioBridge_.beginBlock(audio, numSamples))
            return false;
        processData_.numSamples = numSamples;
        if (!succeeded(processor_->process(processData_)))
            return false;
        const bool copied = audioBridge_.copyMainOutputTo(audio, numSamples);
        if (blockId != 0 && blockId == lastProcessBlockId_)
            ++processCallsInCurrentBlock_;
        else
            processCallsInCurrentBlock_ = 1;
        lastProcessBlockId_ = blockId;
        owner_.recordVst3BufferProcess(blockId, processCallsInCurrentBlock_,
                                       numSamples, copied,
                                       audioBridge_.layoutTrace());
        if (!copied)
            return false;
        collectOutputParameters();
        return true;
    }

    int totalInputChannels() const noexcept { return inputChannels_; }
    int totalOutputChannels() const noexcept { return outputChannels_; }
    int enabledOutputBuses() const noexcept { return enabledOutputBuses_; }
    Vst3AudioBufferLayoutTrace audioBufferLayoutTrace() const noexcept
    {
        return audioBridge_.layoutTrace();
    }
    int latencySamples() const noexcept
    {
        return processor_ ? static_cast<int>(processor_->getLatencySamples()) : 0;
    }
    int parameterCount() const noexcept
    {
        return controller_ ? controller_->getParameterCount() : 0;
    }

    int parameterIndex(Steinberg::Vst::ParamID id) const noexcept
    {
        const auto found = parameterIndices_.find(id);
        return found != parameterIndices_.end() ? found->second : -1;
    }

    juce::String parameterId(int index) const
    {
        Steinberg::Vst::ParameterInfo info {};
        return controller_ && succeeded(controller_->getParameterInfo(index, info))
            ? juce::String(static_cast<juce::int64>(info.id)) : juce::String();
    }

    juce::String parameterName(int index) const
    {
        Steinberg::Vst::ParameterInfo info {};
        return controller_ && succeeded(controller_->getParameterInfo(index, info))
            ? fromVstString(info.title) : juce::String();
    }

    juce::var parameters() const
    {
        juce::Array<juce::var> result;
        if (!controller_)
            return result;
        const auto count = controller_->getParameterCount();
        for (int index = 0; index < count; ++index)
        {
            Steinberg::Vst::ParameterInfo info {};
            if (!succeeded(controller_->getParameterInfo(index, info)))
                continue;
            juce::var item = makeObject();
            setProp(item, "parameterId", juce::String(static_cast<juce::int64>(info.id)));
            setProp(item, "idStable", true);
            setProp(item, "name", fromVstString(info.title));
            setProp(item, "normalizedValue", controller_->getParamNormalized(info.id));
            setProp(item, "automatable",
                    (info.flags & Steinberg::Vst::ParameterInfo::kCanAutomate) != 0);
            setProp(item, "readOnly",
                    (info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) != 0);
            setProp(item, "label", fromVstString(info.units));
            setProp(item, "index", index);
            result.add(item);
        }
        return result;
    }

    bool setParameter(const juce::String& stableId, float value, std::string& error)
    {
        if (!controller_)
        {
            error = "plugin controller is unavailable";
            return false;
        }
        const auto parsed = stableId.getLargeIntValue();
        const auto id = static_cast<Steinberg::Vst::ParamID>(parsed);
        const int index = parameterIndex(id);
        if (index < 0 || juce::String(static_cast<juce::int64>(id)) != stableId)
        {
            error = "stable parameter ID not found";
            return false;
        }
        const auto normalized = std::clamp(static_cast<double>(value), 0.0, 1.0);
        if (!succeeded(controller_->setParamNormalized(id, normalized)))
        {
            error = "VST3 controller rejected the parameter value";
            return false;
        }
        if (!queueParameter(id, normalized))
        {
            error = "VST3 parameter transfer queue is full";
            return false;
        }
        owner_.directParameterValue(index, static_cast<float>(normalized));
        return true;
    }

    bool getState(std::vector<Steinberg::uint8>& component,
                  std::vector<Steinberg::uint8>& controller,
                  std::string& error)
    {
        if (!component_)
        {
            error = "plugin component is unavailable";
            return false;
        }
        Steinberg::ResizableMemoryIBStream componentStream;
        if (!succeeded(component_->getState(&componentStream)))
        {
            error = "VST3 component getState failed";
            return false;
        }
        component = componentStream.take();
        if (controller_)
        {
            Steinberg::ResizableMemoryIBStream controllerStream;
            if (succeeded(controller_->getState(&controllerStream)))
                controller = controllerStream.take();
        }
        return true;
    }

    bool setState(const std::vector<Steinberg::uint8>& component,
                  const std::vector<Steinberg::uint8>& controller,
                  std::string& error)
    {
        if (!component_ || component.empty())
        {
            error = "VST3 component state is missing";
            return false;
        }
        const bool resume = processing_;
        stop();
        auto makeStream = [](const std::vector<Steinberg::uint8>& bytes)
        {
            auto stream = std::make_unique<Steinberg::ResizableMemoryIBStream>(bytes.size());
            Steinberg::int32 written = 0;
            stream->write(const_cast<Steinberg::uint8*>(bytes.data()),
                          static_cast<Steinberg::int32>(bytes.size()), &written);
            stream->rewind();
            return stream;
        };
        auto componentStream = makeStream(component);
        if (!succeeded(component_->setState(componentStream.get())))
        {
            error = "VST3 component setState failed";
            if (resume) { std::string ignored; start(ignored); }
            return false;
        }
        if (controller_)
        {
            componentStream->rewind();
            controller_->setComponentState(componentStream.get());
            if (!controller.empty())
            {
                auto controllerStream = makeStream(controller);
                controller_->setState(controllerStream.get());
            }
        }
        if (resume)
        {
            std::string startError;
            if (!start(startError))
            {
                error = startError;
                return false;
            }
        }
        return true;
    }

    bool openEditor(std::string& error)
    {
#if JUCE_WINDOWS
        if (!controller_)
        {
            error = "plugin controller is unavailable";
            return false;
        }
        if (!editor_)
            editor_ = std::make_unique<EditorWindow>(*this);
        return editor_->open(error);
#else
        error = "Engine 2 VST3 editors currently require Windows";
        return false;
#endif
    }

    void closeEditor() noexcept
    {
#if JUCE_WINDOWS
        if (editor_) editor_->hide();
#endif
    }
    bool editorVisible() const noexcept
    {
#if JUCE_WINDOWS
        return editor_ && editor_->visible();
#else
        return false;
#endif
    }
    int editorWidth() const noexcept
    {
#if JUCE_WINDOWS
        return editor_ ? editor_->width() : 0;
#else
        return 0;
#endif
    }
    int editorHeight() const noexcept
    {
#if JUCE_WINDOWS
        return editor_ ? editor_->height() : 0;
#else
        return 0;
#endif
    }
    void foregroundEditor() noexcept
    {
#if JUCE_WINDOWS
        if (editor_) editor_->foreground();
#endif
    }

    void drainControllerFeedback()
    {
        ParameterTransfer item;
        while (popFeedback(item))
        {
            if (controller_)
                controller_->setParamNormalized(item.id, item.value);
        }
    }

private:
    struct ParameterTransfer {
        Steinberg::Vst::ParamID id = Steinberg::Vst::kNoParamId;
        Steinberg::Vst::ParamValue value = 0.0;
    };
    static constexpr uint32_t kTransferCapacity = 1024;

    class ComponentHandler final
        : public Steinberg::U::Implements<
              Steinberg::U::Directly<Steinberg::Vst::IComponentHandler>> {
    public:
        explicit ComponentHandler(DirectVst3Plugin& plugin) : plugin_(plugin) {}
        Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID id) override
        {
            plugin_.owner_.directParameterGesture(plugin_.parameterIndex(id), true);
            return Steinberg::kResultTrue;
        }
        Steinberg::tresult PLUGIN_API performEdit(Steinberg::Vst::ParamID id,
                                                   Steinberg::Vst::ParamValue value) override
        {
            if (plugin_.controller_)
                plugin_.controller_->setParamNormalized(id, value);
            plugin_.queueParameter(id, value);
            plugin_.owner_.directParameterValue(plugin_.parameterIndex(id),
                                                static_cast<float>(value));
            return Steinberg::kResultTrue;
        }
        Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID id) override
        {
            plugin_.owner_.directParameterGesture(plugin_.parameterIndex(id), false);
            return Steinberg::kResultTrue;
        }
        Steinberg::tresult PLUGIN_API restartComponent(Steinberg::int32) override
        {
            plugin_.owner_.directNonParameterStateChanged();
            return Steinberg::kResultTrue;
        }
    private:
        DirectVst3Plugin& plugin_;
    };

#if JUCE_WINDOWS
    class EditorWindow final {
    public:
        class Frame final
            : public Steinberg::U::Implements<
                  Steinberg::U::Directly<Steinberg::IPlugFrame>> {
        public:
            explicit Frame(EditorWindow& window) : window_(window) {}
            Steinberg::tresult PLUGIN_API resizeView(Steinberg::IPlugView* view,
                                                      Steinberg::ViewRect* size) override
            {
                return window_.resizeFromPlugin(view, size);
            }
        private:
            EditorWindow& window_;
        };

        explicit EditorWindow(DirectVst3Plugin& plugin) : plugin_(plugin) {}
        ~EditorWindow() { destroy(); }

        bool open(std::string& error)
        {
            if (window_ != nullptr)
            {
                ::ShowWindow(window_, SW_RESTORE);
                foreground();
                return true;
            }
            std::cerr << "[vst3-editor] plugin=\"" << plugin_.className_
                      << "\" phase=create-view" << std::endl;
            view_ = Steinberg::owned(plugin_.controller_->createView(
                Steinberg::Vst::ViewType::kEditor));
            if (!view_)
            {
                error = "plugin provides no VST3 editor view";
                return false;
            }
            if (!succeeded(view_->isPlatformTypeSupported(Steinberg::kPlatformTypeHWND)))
            {
                error = "plugin editor does not support HWND";
                view_.reset();
                return false;
            }
            Steinberg::ViewRect size {};
            if (!succeeded(view_->getSize(&size)) || size.getWidth() < 64 || size.getHeight() < 64)
                size = {0, 0, 800, 520};

            std::cerr << "[vst3-editor] plugin=\"" << plugin_.className_
                      << "\" phase=create-host size=" << size.getWidth()
                      << 'x' << size.getHeight() << std::endl;
            registerClass();
            RECT outer {0, 0, size.getWidth(), size.getHeight()};
            ::AdjustWindowRectEx(&outer, WS_OVERLAPPEDWINDOW, FALSE, 0);
            const auto title = pluginEditorWindowTitle(plugin_.owner_.name());
            window_ = ::CreateWindowExW(0, windowClassName(), title.toWideCharPointer(),
                                        WS_OVERLAPPEDWINDOW,
                                        CW_USEDEFAULT, CW_USEDEFAULT,
                                        outer.right - outer.left, outer.bottom - outer.top,
                                        nullptr, nullptr, ::GetModuleHandleW(nullptr), this);
            if (window_ == nullptr)
            {
                error = "could not create native VST3 editor window";
                view_.reset();
                return false;
            }
            contentWindow_ = ::CreateWindowExW(
                0, L"STATIC", nullptr,
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0, 0, size.getWidth(), size.getHeight(), window_, nullptr,
                ::GetModuleHandleW(nullptr), nullptr);
            if (contentWindow_ == nullptr)
            {
                error = "could not create native VST3 editor content window";
                destroy();
                return false;
            }
            frame_ = Steinberg::owned(new Frame(*this));
            view_->setFrame(frame_);
            std::cerr << "[vst3-editor] plugin=\"" << plugin_.className_
                      << "\" phase=attach" << std::endl;
            if (!succeeded(view_->attached(contentWindow_, Steinberg::kPlatformTypeHWND)))
            {
                error = "attaching VST3 editor view failed";
                destroy();
                return false;
            }
            attached_ = true;
            resizing_ = true;
            view_->onSize(&size);
            resizing_ = false;
            std::cerr << "[vst3-editor] plugin=\"" << plugin_.className_
                      << "\" phase=attached" << std::endl;
            ::ShowWindow(window_, SW_SHOW);
            ::UpdateWindow(window_);
            foreground();
            return true;
        }

        void hide() noexcept
        {
            if (window_) ::ShowWindow(window_, SW_HIDE);
        }
        bool visible() const noexcept { return window_ && ::IsWindowVisible(window_) != FALSE; }
        int width() const noexcept
        {
            RECT rect {};
            return window_ && ::GetClientRect(window_, &rect) ? rect.right - rect.left : 0;
        }
        int height() const noexcept
        {
            RECT rect {};
            return window_ && ::GetClientRect(window_, &rect) ? rect.bottom - rect.top : 0;
        }
        void foreground() noexcept
        {
            if (!window_)
                return;
            ::ShowWindow(window_, SW_RESTORE);
            const HWND foreground = ::GetForegroundWindow();
            const DWORD currentThread = ::GetCurrentThreadId();
            const DWORD foregroundThread = foreground
                ? ::GetWindowThreadProcessId(foreground, nullptr) : 0;
            const bool attached = foregroundThread != 0 && foregroundThread != currentThread
                && ::AttachThreadInput(currentThread, foregroundThread, TRUE) != FALSE;
            ::BringWindowToTop(window_);
            ::SetForegroundWindow(window_);
            ::SetFocus(window_);
            if (attached) ::AttachThreadInput(currentThread, foregroundThread, FALSE);
        }

    private:
        static const wchar_t* windowClassName() { return L"MiniHubEngine2Vst3Editor"; }
        static void registerClass()
        {
            static const bool registered = []
            {
                WNDCLASSEXW type {};
                type.cbSize = sizeof(type);
                type.style = CS_DBLCLKS;
                type.lpfnWndProc = &EditorWindow::windowProc;
                type.hInstance = ::GetModuleHandleW(nullptr);
                type.hCursor = ::LoadCursor(nullptr, IDC_ARROW);
                type.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
                type.lpszClassName = windowClassName();
                ::RegisterClassExW(&type);
                return true;
            }();
            (void)registered;
        }
        static LRESULT CALLBACK windowProc(HWND window, UINT message,
                                           WPARAM wParam, LPARAM lParam)
        {
            auto* self = reinterpret_cast<EditorWindow*>(
                ::GetWindowLongPtrW(window, GWLP_USERDATA));
            if (message == WM_NCCREATE)
            {
                auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
                self = static_cast<EditorWindow*>(create->lpCreateParams);
                // CreateWindowEx sends WM_NCCREATE before it returns, so keep
                // the real HWND immediately for the default message path.
                self->window_ = window;
                ::SetWindowLongPtrW(window, GWLP_USERDATA,
                                    reinterpret_cast<LONG_PTR>(self));
            }
            return self ? self->handleMessage(message, wParam, lParam)
                        : ::DefWindowProcW(window, message, wParam, lParam);
        }
        LRESULT handleMessage(UINT message, WPARAM wParam, LPARAM lParam)
        {
            if (message == WM_CLOSE)
            {
                hide();
                plugin_.owner_.directEditorClosed();
                return 0;
            }
            if (message == WM_SIZE && attached_ && view_)
            {
                Steinberg::ViewRect size {0, 0,
                    static_cast<Steinberg::int32>(LOWORD(lParam)),
                    static_cast<Steinberg::int32>(HIWORD(lParam))};
                if (contentWindow_)
                    ::SetWindowPos(contentWindow_, nullptr, 0, 0,
                                   size.getWidth(), size.getHeight(),
                                   SWP_NOZORDER | SWP_NOACTIVATE);
                if (!resizing_)
                {
                    resizing_ = true;
                    view_->onSize(&size);
                    resizing_ = false;
                }
                return 0;
            }
            return ::DefWindowProcW(window_, message, wParam, lParam);
        }
        Steinberg::tresult resizeFromPlugin(Steinberg::IPlugView* view,
                                             Steinberg::ViewRect* size)
        {
            if (!window_ || !view_ || view != view_.get() || size == nullptr)
                return Steinberg::kInvalidArgument;
            RECT outer {0, 0, size->getWidth(), size->getHeight()};
            ::AdjustWindowRectEx(&outer, WS_OVERLAPPEDWINDOW, FALSE, 0);
            resizing_ = true;
            ::SetWindowPos(window_, nullptr, 0, 0,
                           outer.right - outer.left, outer.bottom - outer.top,
                           SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
            resizing_ = false;
            return Steinberg::kResultTrue;
        }
        void destroy() noexcept
        {
            if (view_)
            {
                view_->setFrame(nullptr);
                if (attached_) view_->removed();
            }
            attached_ = false;
            frame_.reset();
            view_.reset();
            if (window_)
            {
                ::DestroyWindow(window_);
                window_ = nullptr;
            }
            contentWindow_ = nullptr;
        }

        DirectVst3Plugin& plugin_;
        HWND window_ = nullptr;
        HWND contentWindow_ = nullptr;
        bool attached_ = false;
        bool resizing_ = false;
        Steinberg::IPtr<Steinberg::IPlugView> view_;
        Steinberg::IPtr<Frame> frame_;
    };
#endif

    bool configureBuses(std::string& error)
    {
        using namespace Steinberg::Vst;
        const auto inputCount = component_->getBusCount(kAudio, kInput);
        const auto outputCount = component_->getBusCount(kAudio, kOutput);
        if (outputCount < 1)
        {
            error = className_ + " exposes no audio output bus";
            return false;
        }

        const auto findMainBus = [&](BusDirection direction, Steinberg::int32 count)
        {
            for (Steinberg::int32 index = 0; index < count; ++index)
            {
                BusInfo info {};
                if (succeeded(component_->getBusInfo(kAudio, direction, index, info))
                    && info.busType == kMain)
                    return index;
            }
            return count > 0 ? Steinberg::int32{0} : Steinberg::int32{-1};
        };
        mainInputBus_ = findMainBus(kInput, inputCount);
        mainOutputBus_ = findMainBus(kOutput, outputCount);
        if (!owner_.isInstrument() && mainInputBus_ < 0)
        {
            error = className_ + " is an effect but exposes no main audio input bus";
            return false;
        }

        // The SDK requires one arrangement entry for every exposed bus.
        //
        // A VST3 plug-in is entitled to refuse every arrangement a host
        // proposes and keep its own: kResultFalse from setBusArrangements means
        // "not accepted", not "broken". Treating it as fatal made Analog Lab V
        // unloadable even though its own default layout is a plain stereo main
        // out that MiniHub can drive as-is.
        //
        // The ladder below runs from the most MiniHub-friendly proposal down to
        // simply accepting what the plug-in already exposes. Whichever rung
        // lands, the negotiated main bus is validated below - that check, not
        // the proposal, is what the stereo graph actually depends on.
        enum class AuxiliaryPolicy { keepCurrent, matchMain, silenced };

        const auto currentArrangement = [&](BusDirection direction, Steinberg::int32 index)
        {
            SpeakerArrangement arrangement = SpeakerArr::kEmpty;
            return succeeded(processor_->getBusArrangement(direction, index, arrangement))
                ? arrangement : SpeakerArr::kEmpty;
        };

        const auto tryArrangement = [&](SpeakerArrangement main, AuxiliaryPolicy policy)
        {
            const auto fill = [&](BusDirection direction, Steinberg::int32 count)
            {
                std::vector<SpeakerArrangement> values(static_cast<size_t>(count),
                                                       SpeakerArr::kEmpty);
                for (Steinberg::int32 index = 0; index < count; ++index)
                {
                    if (policy == AuxiliaryPolicy::keepCurrent)
                        values[static_cast<size_t>(index)] = currentArrangement(direction, index);
                    else if (policy == AuxiliaryPolicy::matchMain)
                        values[static_cast<size_t>(index)] = main;
                }
                return values;
            };
            auto inputs = fill(kInput, inputCount);
            auto outputs = fill(kOutput, outputCount);
            // The graph-facing buses are never left to the policy.
            if (!owner_.isInstrument() && mainInputBus_ >= 0)
                inputs[static_cast<size_t>(mainInputBus_)] = main;
            outputs[static_cast<size_t>(mainOutputBus_)] = main;
            return succeeded(processor_->setBusArrangements(
                inputs.empty() ? nullptr : inputs.data(), inputCount,
                outputs.data(), outputCount));
        };

        for (const auto main : { SpeakerArr::kStereo, SpeakerArr::kMono })
        {
            if (tryArrangement(main, AuxiliaryPolicy::keepCurrent)
                || tryArrangement(main, AuxiliaryPolicy::matchMain)
                || tryArrangement(main, AuxiliaryPolicy::silenced))
                break;
        }
        // No rung landed. That is not fatal: the plug-in simply keeps its own
        // layout, which the validation below either accepts or rejects on its
        // real merits instead of on the host's failed proposal.

        for (Steinberg::int32 index = 0; index < outputCount; ++index)
        {
            const bool active = index == mainOutputBus_;
            if (active && !succeeded(component_->activateBus(kAudio, kOutput, index, true)))
            {
                error = className_ + " could not activate its main output bus";
                return false;
            }
            if (!active)
                component_->activateBus(kAudio, kOutput, index, false);
        }
        for (Steinberg::int32 index = 0; index < inputCount; ++index)
        {
            const bool active = !owner_.isInstrument() && index == mainInputBus_;
            if (active && !succeeded(component_->activateBus(kAudio, kInput, index, true)))
            {
                error = className_ + " could not activate its main input bus";
                return false;
            }
            if (!active)
                component_->activateBus(kAudio, kInput, index, false);
        }
        for (Steinberg::int32 index = 0;
             index < component_->getBusCount(kEvent, kInput); ++index)
            component_->activateBus(kEvent, kInput, index, index == 0);

        SpeakerArrangement arrangement = SpeakerArr::kEmpty;
        inputChannels_ = !owner_.isInstrument() && mainInputBus_ >= 0
            && succeeded(processor_->getBusArrangement(kInput, mainInputBus_, arrangement))
            ? SpeakerArr::getChannelCount(arrangement) : 0;
        arrangement = SpeakerArr::kEmpty;
        outputChannels_ = succeeded(processor_->getBusArrangement(
            kOutput, mainOutputBus_, arrangement))
            ? SpeakerArr::getChannelCount(arrangement) : 0;
        if (outputChannels_ < 1 || outputChannels_ > 2
            || (!owner_.isInstrument() && (inputChannels_ < 1 || inputChannels_ > 2)))
        {
            // The real gate now, so it has to say what it actually saw.
            error = className_ + " bus layout does not fit MiniHub's stereo graph"
                  + " (main output " + std::to_string(outputChannels_) + " ch, main input "
                  + std::to_string(inputChannels_) + " ch, buses "
                  + std::to_string(inputCount) + " in / " + std::to_string(outputCount)
                  + " out)";
            return false;
        }
        enabledOutputBuses_ = 1;
        return true;
    }

    bool start(std::string& error)
    {
        if (!prepared_)
        {
            error = "VST3 instance is not prepared";
            return false;
        }
        if (!active_)
        {
            if (!succeeded(component_->setActive(true)))
            {
                error = className_ + " activation failed";
                return false;
            }
            active_ = true;
        }
        if (!processing_)
        {
            if (!succeeded(processor_->setProcessing(true)))
            {
                component_->setActive(false);
                active_ = false;
                error = className_ + " setProcessing(true) failed";
                return false;
            }
            processing_ = true;
        }
        return true;
    }

    void stop() noexcept
    {
        if (processing_ && processor_)
        {
            processor_->setProcessing(false);
            processing_ = false;
        }
        if (active_ && component_)
        {
            component_->setActive(false);
            active_ = false;
        }
    }

    void terminate() noexcept
    {
#if JUCE_WINDOWS
        editor_.reset();
#endif
        stop();
        processData_.inputEvents = nullptr;
        processData_.outputEvents = nullptr;
        processData_.inputParameterChanges = nullptr;
        processData_.outputParameterChanges = nullptr;
        processData_.processContext = nullptr;
        processData_ = {};
        audioBridge_.reset();
        if (controller_) controller_->setComponentHandler(nullptr);
        handler_.reset();
        midiMapping_.reset();
        processor_.reset();
        controller_.reset();
        component_.reset();
        provider_.reset();
        module_.reset();
        prepared_ = false;
    }

    void fillProcessContext(juce::AudioPlayHead* playHead) noexcept
    {
        using namespace Steinberg::Vst;
        processContext_ = {};
        processContext_.sampleRate = sampleRate_;
        processContext_.tempo = 120.0;
        if (playHead)
        {
            if (const auto position = playHead->getPosition())
            {
                if (const auto samples = position->getTimeInSamples())
                {
                    processContext_.projectTimeSamples = *samples;
                    processContext_.continousTimeSamples = *samples;
                    processContext_.state |= ProcessContext::kContTimeValid;
                }
                if (const auto ppq = position->getPpqPosition())
                {
                    processContext_.projectTimeMusic = *ppq;
                    processContext_.state |= ProcessContext::kProjectTimeMusicValid;
                }
                if (const auto bpm = position->getBpm())
                {
                    processContext_.tempo = *bpm;
                    processContext_.state |= ProcessContext::kTempoValid;
                }
                if (position->getIsPlaying()) processContext_.state |= ProcessContext::kPlaying;
                if (position->getIsRecording()) processContext_.state |= ProcessContext::kRecording;
                if (position->getIsLooping())
                {
                    processContext_.state |= ProcessContext::kCycleActive;
                    if (const auto loop = position->getLoopPoints())
                    {
                        processContext_.cycleStartMusic = loop->ppqStart;
                        processContext_.cycleEndMusic = loop->ppqEnd;
                        processContext_.state |= ProcessContext::kCycleValid;
                    }
                }
                if (const auto signature = position->getTimeSignature())
                {
                    processContext_.timeSigNumerator = signature->numerator;
                    processContext_.timeSigDenominator = signature->denominator;
                    processContext_.state |= ProcessContext::kTimeSigValid;
                }
            }
        }
    }

    void convertMidi(const juce::MidiBuffer& midi, int numSamples) noexcept
    {
        using namespace Steinberg::Vst;
        for (const auto metadata : midi)
        {
            const auto message = metadata.getMessage();
            const auto channel = static_cast<Steinberg::int16>(
                std::clamp(message.getChannel() - 1, 0, 15));
            Event event {};
            event.busIndex = 0;
            event.sampleOffset = std::clamp(metadata.samplePosition, 0, numSamples - 1);
            event.ppqPosition = processContext_.projectTimeMusic
                + static_cast<double>(event.sampleOffset) * processContext_.tempo
                    / (60.0 * std::max(1.0, sampleRate_));
            event.flags = Event::kIsLive;
            bool addEvent = true;
            if (message.isNoteOn())
            {
                event.type = Event::kNoteOnEvent;
                event.noteOn.channel = channel;
                event.noteOn.pitch = static_cast<Steinberg::int16>(message.getNoteNumber());
                event.noteOn.tuning = 0.0f;
                event.noteOn.velocity = message.getFloatVelocity();
                event.noteOn.length = 0;
                event.noteOn.noteId = -1;
            }
            else if (message.isNoteOff())
            {
                event.type = Event::kNoteOffEvent;
                event.noteOff.channel = channel;
                event.noteOff.pitch = static_cast<Steinberg::int16>(message.getNoteNumber());
                event.noteOff.tuning = 0.0f;
                event.noteOff.velocity = message.getFloatVelocity();
                event.noteOff.noteId = -1;
            }
            else if (message.isAftertouch())
            {
                event.type = Event::kPolyPressureEvent;
                event.polyPressure.channel = channel;
                event.polyPressure.pitch = static_cast<Steinberg::int16>(message.getNoteNumber());
                event.polyPressure.pressure = static_cast<float>(message.getAfterTouchValue()) / 127.0f;
                event.polyPressure.noteId = -1;
            }
            else
            {
                addEvent = false;
                int controller = -1;
                double value = 0.0;
                if (message.isController())
                {
                    controller = message.getControllerNumber();
                    value = static_cast<double>(message.getControllerValue()) / 127.0;
                }
                else if (message.isPitchWheel())
                {
                    controller = kPitchBend;
                    value = static_cast<double>(message.getPitchWheelValue()) / 16383.0;
                }
                else if (message.isChannelPressure())
                {
                    controller = kAfterTouch;
                    value = static_cast<double>(message.getChannelPressureValue()) / 127.0;
                }
                if (controller >= 0 && controller < kCountCtrlNumber)
                {
                    const auto id = midiAssignments_[static_cast<size_t>(channel) * kCountCtrlNumber
                                                     + static_cast<size_t>(controller)];
                    if (id != kNoParamId)
                        inputParameters_.add(id, event.sampleOffset, value);
                }
            }
            if (addEvent)
                inputEvents_.addEvent(event);
        }
    }

    void buildParameterIndex()
    {
        parameterIndices_.clear();
        if (!controller_)
            return;
        for (int index = 0; index < controller_->getParameterCount(); ++index)
        {
            Steinberg::Vst::ParameterInfo info {};
            if (succeeded(controller_->getParameterInfo(index, info)))
                parameterIndices_.emplace(info.id, index);
        }
    }

    void buildMidiAssignments()
    {
        midiAssignments_.fill(Steinberg::Vst::kNoParamId);
        if (!midiMapping_)
            return;
        for (int channel = 0; channel < 16; ++channel)
            for (int controller = 0; controller < Steinberg::Vst::kCountCtrlNumber; ++controller)
            {
                Steinberg::Vst::ParamID id = Steinberg::Vst::kNoParamId;
                if (succeeded(midiMapping_->getMidiControllerAssignment(
                        0, static_cast<Steinberg::int16>(channel),
                        static_cast<Steinberg::Vst::CtrlNumber>(controller), id)))
                    midiAssignments_[static_cast<size_t>(channel)
                                     * Steinberg::Vst::kCountCtrlNumber
                                     + static_cast<size_t>(controller)] = id;
            }
    }

    bool queueParameter(Steinberg::Vst::ParamID id,
                        Steinberg::Vst::ParamValue value) noexcept
    {
        const auto write = parameterWrite_.load(std::memory_order_relaxed);
        const auto next = (write + 1u) % kTransferCapacity;
        if (next == parameterRead_.load(std::memory_order_acquire))
            return false;
        pendingParameters_[write] = {id, value};
        parameterWrite_.store(next, std::memory_order_release);
        return true;
    }

    void drainPendingParameters() noexcept
    {
        auto read = parameterRead_.load(std::memory_order_relaxed);
        const auto write = parameterWrite_.load(std::memory_order_acquire);
        while (read != write)
        {
            const auto& item = pendingParameters_[read];
            inputParameters_.add(item.id, 0, item.value);
            read = (read + 1u) % kTransferCapacity;
        }
        parameterRead_.store(read, std::memory_order_release);
    }

    void queueFeedback(Steinberg::Vst::ParamID id,
                       Steinberg::Vst::ParamValue value) noexcept
    {
        const auto write = feedbackWrite_.load(std::memory_order_relaxed);
        const auto next = (write + 1u) % kTransferCapacity;
        if (next == feedbackRead_.load(std::memory_order_acquire))
            return;
        feedback_[write] = {id, value};
        feedbackWrite_.store(next, std::memory_order_release);
    }

    bool popFeedback(ParameterTransfer& item) noexcept
    {
        const auto read = feedbackRead_.load(std::memory_order_relaxed);
        if (read == feedbackWrite_.load(std::memory_order_acquire))
            return false;
        item = feedback_[read];
        feedbackRead_.store((read + 1u) % kTransferCapacity, std::memory_order_release);
        return true;
    }

    void collectOutputParameters() noexcept
    {
        for (int queueIndex = 0; queueIndex < outputParameters_.getParameterCount(); ++queueIndex)
        {
            auto* queue = outputParameters_.getParameterData(queueIndex);
            if (!queue || queue->getPointCount() <= 0)
                continue;
            Steinberg::int32 offset = 0;
            Steinberg::Vst::ParamValue value = 0.0;
            if (succeeded(queue->getPoint(queue->getPointCount() - 1, offset, value)))
            {
                queueFeedback(queue->getParameterId(), value);
                owner_.directParameterValue(parameterIndex(queue->getParameterId()),
                                            static_cast<float>(value));
            }
        }
    }

    PluginInstance& owner_;
    std::string className_;
    std::shared_ptr<VST3::Hosting::Module> module_;
    Steinberg::IPtr<Steinberg::Vst::PlugProvider> provider_;
    Steinberg::IPtr<Steinberg::Vst::IComponent> component_;
    Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
    Steinberg::OPtr<Steinberg::Vst::IEditController> controller_;
    Steinberg::IPtr<Steinberg::Vst::IMidiMapping> midiMapping_;
    Steinberg::IPtr<ComponentHandler> handler_;
    Steinberg::Vst::ProcessData processData_;
    Vst3AudioBufferBridge audioBridge_;
    Steinberg::Vst::EventList inputEvents_ {2048};
    Steinberg::Vst::EventList outputEvents_ {256};
    FixedParameterChanges inputParameters_;
    FixedParameterChanges outputParameters_;
    Steinberg::Vst::ProcessContext processContext_ {};
    std::map<Steinberg::Vst::ParamID, int> parameterIndices_;
    std::array<Steinberg::Vst::ParamID,
               16 * Steinberg::Vst::kCountCtrlNumber> midiAssignments_ {};
    std::array<ParameterTransfer, kTransferCapacity> pendingParameters_ {};
    std::atomic<uint32_t> parameterRead_ {0}, parameterWrite_ {0};
    std::array<ParameterTransfer, kTransferCapacity> feedback_ {};
    std::atomic<uint32_t> feedbackRead_ {0}, feedbackWrite_ {0};
#if JUCE_WINDOWS
    std::unique_ptr<EditorWindow> editor_;
#endif
    double sampleRate_ = 48000.0;
    int maximumBlockSize_ = 256;
    int inputChannels_ = 0;
    int outputChannels_ = 0;
    int enabledOutputBuses_ = 0;
    int mainInputBus_ = -1;
    int mainOutputBus_ = -1;
    uint64_t lastProcessBlockId_ = 0;
    uint32_t processCallsInCurrentBlock_ = 0;
    bool offline_ = false;
    bool prepared_ = false;
    bool active_ = false;
    bool processing_ = false;
};

PluginInstance::PluginInstance() = default;

PluginInstance::~PluginInstance()
{
    learnState_.setArmed(false);
    activeLearnId_.clear();
    stopTimer();
    beginControlMutation();
    plugin_.reset();
    endControlMutation();
}

void PluginInstance::setRuntimeIdentity(const juce::String& chainId,
                                        const juce::String& instanceId,
                                        juce::int64 generation)
{
    chainId_ = chainId;
    instanceId_ = instanceId;
    generation_ = generation;
}

bool PluginInstance::create(const PluginRecord& record, double sampleRate, int blockSize,
                            juce::String& error)
{
    pluginId_ = record.pluginId;
    classId_ = record.classId;
    name_ = record.name;
    role_ = record.role;
    isInstrument_ = record.isInstrument;
    plugin_ = std::make_unique<DirectVst3Plugin>(*this);
    std::string nativeError;
    if (!plugin_->create(record, nativeError))
    {
        error_ = error = juce::String(nativeError);
        plugin_.reset();
        return false;
    }
    learnState_.reset(plugin_->parameterCount());
    if (!plugin_->prepare(sampleRate, blockSize, false, nativeError))
    {
        error_ = error = juce::String(nativeError);
        plugin_.reset();
        return false;
    }
    isReady_ = true;
    error_.clear();
    return true;
}

void PluginInstance::prepareToPlay(double sampleRate, int blockSize, bool offline)
{
    signalMeter_.prepare(sampleRate);
    if (!plugin_)
        return;
    beginControlMutation();
    std::string error;
    const bool ok = plugin_->prepare(sampleRate, blockSize, offline, error);
    endControlMutation();
    if (!ok)
    {
        isReady_ = false;
        error_ = juce::String(error);
    }
}

void PluginInstance::reset()
{
    signalMeter_.reset();
    if (!plugin_)
        return;
    beginControlMutation();
    plugin_->reset();
    endControlMutation();
}

bool PluginInstance::beginRealtimeRead() noexcept
{
    if (controlMutation_.load(std::memory_order_acquire))
        return false;
    realtimeReaders_.fetch_add(1, std::memory_order_acq_rel);
    if (controlMutation_.load(std::memory_order_acquire))
    {
        realtimeReaders_.fetch_sub(1, std::memory_order_release);
        return false;
    }
    return true;
}

void PluginInstance::endRealtimeRead() noexcept
{
    realtimeReaders_.fetch_sub(1, std::memory_order_release);
}

void PluginInstance::beginControlMutation() const noexcept
{
    bool expected = false;
    while (!controlMutation_.compare_exchange_weak(expected, true,
                                                   std::memory_order_acq_rel))
    {
        expected = false;
        std::this_thread::yield();
    }
    while (realtimeReaders_.load(std::memory_order_acquire) != 0)
        std::this_thread::yield();
}

void PluginInstance::endControlMutation() const noexcept
{
    controlMutation_.store(false, std::memory_order_release);
}

void PluginInstance::processBlock(juce::AudioBuffer<float>& buffer,
                                  juce::MidiBuffer& midi,
                                  int numSamples,
                                  uint64_t blockId) noexcept
{
    if (!plugin_ || !isReady_ || numSamples <= 0
        || numSamples > buffer.getNumSamples())
        return;
    if (!beginRealtimeRead())
    {
        // A control mutation owns the plugin: this block produces nothing.
        RealtimeDropCounters::pluginBlockSkipped();
        return;
    }
    const double started = juce::Time::getMillisecondCounterHiRes();
    signalMeter_.observe(buffer, numSamples, AudioSignalBoundary::input);
    const bool processed = plugin_->process(buffer, numSamples, midi,
                                            assignedPlayHead_, blockId);
    if (!processed)
        buffer.clear(0, numSamples);
    signalMeter_.observe(buffer, numSamples, AudioSignalBoundary::output);
    endRealtimeRead();

    const float elapsed = static_cast<float>(
        juce::Time::getMillisecondCounterHiRes() - started);
    lastProcessingMilliseconds_.store(elapsed, std::memory_order_release);
    appendMaximum(maximumRecentProcessingMilliseconds_, elapsed);
    appendMaximum(maximumProcessingMilliseconds_, elapsed);
    processingCalls_.fetch_add(1, std::memory_order_relaxed);
}

PluginProcessingTelemetry PluginInstance::takeProcessingTelemetry() noexcept
{
    return {lastProcessingMilliseconds_.load(std::memory_order_acquire),
            maximumRecentProcessingMilliseconds_.exchange(0.0f, std::memory_order_acq_rel),
            maximumProcessingMilliseconds_.load(std::memory_order_acquire),
            processingCalls_.load(std::memory_order_acquire)};
}

Vst3BufferProcessTrace PluginInstance::vst3BufferProcessTrace() const noexcept
{
    Vst3BufferProcessTrace trace;
    trace.blockId = vst3BlockId_.load(std::memory_order_acquire);
    trace.processCallInBlock = vst3ProcessCallInBlock_.load(std::memory_order_acquire);
    trace.numSamples = vst3NumSamples_.load(std::memory_order_acquire);
    trace.inputBusCount = vst3InputBusCount_.load(std::memory_order_acquire);
    trace.outputBusCount = vst3OutputBusCount_.load(std::memory_order_acquire);
    trace.mainInputBus = vst3MainInputBus_.load(std::memory_order_acquire);
    trace.mainOutputBus = vst3MainOutputBus_.load(std::memory_order_acquire);
    trace.mainInputChannels = vst3MainInputChannels_.load(std::memory_order_acquire);
    trace.mainOutputChannels = vst3MainOutputChannels_.load(std::memory_order_acquire);
    trace.inputLeft = vst3InputLeft_.load(std::memory_order_acquire);
    trace.inputRight = vst3InputRight_.load(std::memory_order_acquire);
    trace.outputLeft = vst3OutputLeft_.load(std::memory_order_acquire);
    trace.outputRight = vst3OutputRight_.load(std::memory_order_acquire);
    trace.inputOutputDistinct = vst3InputOutputDistinct_.load(std::memory_order_acquire);
    trace.copiedToPluginInstance = vst3CopiedToPluginInstance_.load(std::memory_order_acquire);
    return trace;
}

void PluginInstance::recordVst3BufferProcess(
    uint64_t blockId, uint32_t processCallInBlock, int numSamples,
    bool copiedToPluginInstance, const Vst3AudioBufferLayoutTrace& layout) noexcept
{
    vst3InputBusCount_.store(layout.inputBusCount, std::memory_order_relaxed);
    vst3OutputBusCount_.store(layout.outputBusCount, std::memory_order_relaxed);
    vst3MainInputBus_.store(layout.mainInputBus, std::memory_order_relaxed);
    vst3MainOutputBus_.store(layout.mainOutputBus, std::memory_order_relaxed);
    vst3MainInputChannels_.store(layout.mainInputChannels, std::memory_order_relaxed);
    vst3MainOutputChannels_.store(layout.mainOutputChannels, std::memory_order_relaxed);
    vst3InputLeft_.store(layout.inputLeft, std::memory_order_relaxed);
    vst3InputRight_.store(layout.inputRight, std::memory_order_relaxed);
    vst3OutputLeft_.store(layout.outputLeft, std::memory_order_relaxed);
    vst3OutputRight_.store(layout.outputRight, std::memory_order_relaxed);
    vst3InputOutputDistinct_.store(layout.inputOutputDistinct, std::memory_order_relaxed);
    vst3CopiedToPluginInstance_.store(copiedToPluginInstance, std::memory_order_relaxed);
    vst3NumSamples_.store(numSamples, std::memory_order_relaxed);
    vst3ProcessCallInBlock_.store(processCallInBlock, std::memory_order_relaxed);
    vst3BlockId_.store(blockId, std::memory_order_release);
}

int PluginInstance::totalInputChannelsForTesting() const
{
    return plugin_ ? plugin_->totalInputChannels() : 0;
}

int PluginInstance::totalOutputChannelsForTesting() const
{
    return plugin_ ? plugin_->totalOutputChannels() : 0;
}

int PluginInstance::enabledOutputBusesForTesting() const
{
    return plugin_ ? plugin_->enabledOutputBuses() : 0;
}

int PluginInstance::latencySamples() const noexcept
{
    return plugin_ ? plugin_->latencySamples() : 0;
}

void PluginInstance::directParameterGesture(int parameterIndex, bool starting) noexcept
{
    if (parameterIndex >= 0)
        learnState_.gestureChanged(parameterIndex, starting);
}

void PluginInstance::directParameterValue(int parameterIndex,
                                          float normalizedValue) noexcept
{
    stateRevision_.fetch_add(1, std::memory_order_relaxed);
    if (parameterIndex >= 0)
        learnState_.valueChanged(parameterIndex, normalizedValue);
}

void PluginInstance::directNonParameterStateChanged() noexcept
{
    stateRevision_.fetch_add(1, std::memory_order_relaxed);
}

void PluginInstance::timerCallback()
{
    if (plugin_) plugin_->drainControllerFeedback();
    const auto pending = learnState_.consume();
    if (!pending || !plugin_ || pending->parameterIndex < 0
        || pending->parameterIndex >= plugin_->parameterCount())
        return;
    const bool captured = pending->capturedByLearn;
    const juce::String capturedLearnId = captured ? activeLearnId_ : juce::String();
    TouchedParameter touched {plugin_->parameterId(pending->parameterIndex),
                              plugin_->parameterName(pending->parameterIndex),
                              capturedLearnId, pending->normalizedValue, true, captured};
    if (touched.parameterId.isEmpty())
    {
        if (captured) learnState_.setArmed(true);
        return;
    }
    if (parameterTouchedCallback_) parameterTouchedCallback_(*this, touched);
    if (captured) cancelParameterLearn("captured");
}

bool PluginInstance::armParameterLearn(const juce::String& learnId,
                                       juce::String& error)
{
    if (learnId.isEmpty())
    {
        error = "learnId is required";
        return false;
    }
    if (!plugin_ || !isReady_)
    {
        error = "plugin is not ready";
        return false;
    }
    if (!editorVisible())
    {
        error = "plugin editor is not open";
        return false;
    }
    activeLearnId_ = learnId;
    learnState_.setArmed(true);
    return true;
}

void PluginInstance::cancelParameterLearn(const juce::String& reason)
{
    learnState_.setArmed(false);
    const auto ended = activeLearnId_;
    activeLearnId_.clear();
    if (ended.isNotEmpty() && parameterLearnEndedCallback_)
        parameterLearnEndedCallback_(*this, ended, reason);
    foregroundEditorIfAllowed();
}

bool PluginInstance::openEditor(juce::String& message)
{
    if (!plugin_ || !isReady_)
    {
        message = "plugin not loaded";
        return false;
    }
    if (!juce::MessageManager::existsAndIsCurrentThread())
    {
        message = "editor must be opened on the message thread";
        return false;
    }
    std::string error;
    if (!plugin_->openEditor(error))
    {
        message = juce::String(error);
        return false;
    }
    startTimerHz(30);
    return true;
}

void PluginInstance::closeEditor()
{
    cancelParameterLearn("editor-closed");
    if (plugin_) plugin_->closeEditor();
    stopTimer();
}

void PluginInstance::directEditorClosed()
{
    cancelParameterLearn("editor-closed");
    stopTimer();
    if (editorClosedCallback_) editorClosedCallback_(*this);
}

bool PluginInstance::editorVisible() const
{
    return plugin_ && plugin_->editorVisible();
}

void PluginInstance::foregroundEditorIfAllowed()
{
    if (plugin_ && editorVisible() && !learnArmed()) plugin_->foregroundEditor();
}

int PluginInstance::editorWidth() const
{
    return plugin_ ? plugin_->editorWidth() : 0;
}

int PluginInstance::editorHeight() const
{
    return plugin_ ? plugin_->editorHeight() : 0;
}

juce::var PluginInstance::getState() const
{
    if (!plugin_)
        return {};
    beginControlMutation();
    std::vector<Steinberg::uint8> component, controller;
    std::string error;
    const bool ok = plugin_->getState(component, controller, error);
    endControlMutation();
    if (!ok)
        return {};

    juce::XmlElement root("VST3PluginState");
    const auto append = [&root](const char* name,
                                const std::vector<Steinberg::uint8>& bytes)
    {
        if (bytes.empty()) return;
        juce::MemoryBlock block(bytes.data(), bytes.size());
        root.createNewChildElement(name)->addTextElement(block.toBase64Encoding());
    };
    append("IComponent", component);
    append("IEditController", controller);
    juce::MemoryBlock binary;
    juce::AudioProcessor::copyXmlToBinary(root, binary);
    return juce::var(binary.toBase64Encoding());
}

bool PluginInstance::setState(const juce::var& state, juce::String& error)
{
    if (!plugin_ || !state.isString())
    {
        error = plugin_ ? "invalid state payload" : "plugin not loaded";
        return false;
    }
    juce::MemoryBlock binary;
    if (!binary.fromBase64Encoding(state.toString()))
    {
        error = "invalid base64 state";
        return false;
    }
    auto xml = juce::AudioProcessor::getXmlFromBinary(binary.getData(),
                                                       static_cast<int>(binary.getSize()));
    if (!xml || !xml->hasTagName("VST3PluginState"))
    {
        error = "unsupported VST3 state document";
        return false;
    }
    const auto decode = [&xml](const char* name, juce::MemoryBlock& out)
    {
        auto* child = xml->getChildByName(name);
        if (!child) return false;
        return out.fromBase64Encoding(child->getAllSubText());
    };
    juce::MemoryBlock component, controller;
    if (!decode("IComponent", component))
    {
        error = "VST3 component state is missing";
        return false;
    }
    decode("IEditController", controller);
    return applyStateBlocks(component, controller, error);
}

/**
 * Apply a preset that arrived as raw VST3 chunks.
 *
 * A `.vstpreset` carries exactly this pair -- `Comp` and `Cont` -- so loading
 * one is a transfer of bytes, not a translation of them.
 *
 * It deliberately does NOT reuse setState(): that entry point expects the JUCE
 * binary-XML envelope `getState()` produces, and rebuilding that envelope on
 * the JavaScript side would mean reimplementing
 * `AudioProcessor::copyXmlToBinary` -- a magic number plus GZIP -- against a
 * JUCE internal free to change under us. The envelope stays where JUCE owns it.
 */
bool PluginInstance::setStateChunks(const juce::MemoryBlock& component,
                                    const juce::MemoryBlock& controller,
                                    juce::String& error)
{
    if (component.getSize() == 0)
    {
        error = "VST3 component state is empty";
        return false;
    }
    return applyStateBlocks(component, controller, error);
}

/** The half both state entry points share: hand the chunks to the plugin under
 *  the control-mutation guard, then resynchronise the revision counters so the
 *  freshly applied state is not immediately recaptured as a user edit. */
bool PluginInstance::applyStateBlocks(const juce::MemoryBlock& component,
                                      const juce::MemoryBlock& controller,
                                      juce::String& error)
{
    if (!plugin_)
    {
        error = "plugin not loaded";
        return false;
    }
    const auto toBytes = [](const juce::MemoryBlock& block)
    {
        std::vector<Steinberg::uint8> bytes;
        if (block.getSize() == 0)
            return bytes;
        const auto* begin = static_cast<const Steinberg::uint8*>(block.getData());
        bytes.assign(begin, begin + block.getSize());
        return bytes;
    };
    beginControlMutation();
    std::string nativeError;
    const bool ok = plugin_->setState(toBytes(component), toBytes(controller), nativeError);
    endControlMutation();
    if (!ok)
    {
        error = juce::String(nativeError);
        return false;
    }
    capturedStateRevision_ = observedStateRevision_ =
        stateRevision_.load(std::memory_order_relaxed);
    stableStateTicks_ = 0;
    return true;
}

bool PluginInstance::takeStateSnapshotIfDue(juce::var& state, bool force)
{
    const auto revision = stateRevision_.load(std::memory_order_acquire);
    if (!force && revision == capturedStateRevision_) return false;
    if (!force)
    {
        if (revision != observedStateRevision_)
        {
            observedStateRevision_ = revision;
            stableStateTicks_ = 0;
            return false;
        }
        if (++stableStateTicks_ < 5) return false;
    }
    state = getState();
    capturedStateRevision_ = observedStateRevision_ = revision;
    stableStateTicks_ = 0;
    return !state.isVoid();
}

juce::var PluginInstance::getParameters() const
{
    return plugin_ ? plugin_->parameters() : juce::var(juce::Array<juce::var>());
}

bool PluginInstance::setParameterNormalized(const juce::String& parameterId,
                                            float normalizedValue,
                                            juce::String& error)
{
    if (!plugin_ || !isReady_)
    {
        error = "plugin is not ready";
        return false;
    }
    std::string nativeError;
    if (!plugin_->setParameter(parameterId, normalizedValue, nativeError))
    {
        error = juce::String(nativeError);
        return false;
    }
    failedParameterIds_.erase(parameterId);
    return true;
}

} // namespace mlh
