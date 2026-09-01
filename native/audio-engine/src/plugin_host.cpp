#include "plugin_host.h"
#include "var_util.h"

#include <algorithm>
#include <cmath>
#include <cstring>

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

// A plugin editor that reports a degenerate size (some VST3 views only learn
// their real size once attached to a real peer) would produce an unusable
// sliver of a window. Below this threshold we fall back to a readable default.
constexpr int kMinEditorSize = 200;
constexpr int kFallbackEditorWidth = 800;
constexpr int kFallbackEditorHeight = 520;
constexpr int kHostHeaderHeight = 42;
constexpr int kHostFooterHeight = 76;

/**
 * MiniHub's audio DAG is stereo, so every hosted processor receives exactly
 * two audio channels. VST3 scanners may report (and some plug-ins activate)
 * many auxiliary stereo output buses by default. Passing a two-channel JUCE
 * buffer to a processor whose active layout owns 32/64 channels makes JUCE's
 * VST3 HostBufferMapper index beyond the buffer.
 *
 * Preserve the plug-in's accepted main layouts whenever they already fit the
 * graph, disable only auxiliary buses, and ask the plug-in to approve the
 * complete layout before applying it. This is deliberately not the old blind
 * setPlayConfigDetails(2, 2): instruments keep zero inputs, mono processors
 * keep mono, and an incompatible plug-in is rejected with an explicit error.
 */
bool configureBusesForStereoGraph(juce::AudioPluginInstance& plugin,
                                  juce::String& error)
{
    constexpr int kGraphChannels = 2;
    const auto current = plugin.getBusesLayout();
    auto requested = current;

    for (const bool input : { true, false })
    {
        auto& buses = requested.getBuses(input);
        for (int index = 1; index < buses.size(); ++index)
            buses.set(index, juce::AudioChannelSet::disabled());

        if (!buses.isEmpty() && buses[0].size() > kGraphChannels)
            buses.set(0, juce::AudioChannelSet::stereo());
    }

    const auto fitsStereoGraph = [=](const juce::AudioProcessor::BusesLayout& layout)
    {
        const auto channelTotal = [&layout](bool input)
        {
            int total = 0;
            for (const auto& bus : layout.getBuses(input))
                total += bus.size();
            return total;
        };
        return channelTotal(true) <= kGraphChannels
            && channelTotal(false) <= kGraphChannels;
    };

    if (!fitsStereoGraph(requested))
    {
        error = "Plugin bus layout cannot fit MiniHub's stereo graph";
        return false;
    }

    if (requested == current)
        return true;

    if (!plugin.checkBusesLayoutSupported(requested))
    {
        // A multichannel main bus may reject stereo but accept mono. Preserve
        // all other requested layouts and probe that declared capability too.
        auto monoFallback = requested;
        if (!monoFallback.outputBuses.isEmpty()
            && current.getMainOutputChannelSet().size() > kGraphChannels)
            monoFallback.outputBuses.set(0, juce::AudioChannelSet::mono());
        if (!monoFallback.inputBuses.isEmpty()
            && current.getMainInputChannelSet().size() > kGraphChannels)
            monoFallback.inputBuses.set(0, juce::AudioChannelSet::mono());

        if (monoFallback == requested
            || !fitsStereoGraph(monoFallback)
            || !plugin.checkBusesLayoutSupported(monoFallback))
        {
            error = "Plugin rejected a MiniHub-compatible bus layout";
            return false;
        }
        requested = std::move(monoFallback);
    }

    if (!plugin.setBusesLayout(requested)
        || plugin.getTotalNumInputChannels() > kGraphChannels
        || plugin.getTotalNumOutputChannels() > kGraphChannels)
    {
        error = "Plugin failed to apply its accepted MiniHub bus layout";
        return false;
    }
    return true;
}

} // namespace

class MiniHubPluginHostComponent final : public juce::Component,
                                         private juce::ComponentListener {
public:
    MiniHubPluginHostComponent(juce::AudioProcessorEditor* editor,
                               juce::String chainId,
                               juce::String instanceId,
                               juce::String pluginId)
        : editor_(editor)
    {
        title_.setText(pluginEditorWindowTitle(editor_->getAudioProcessor()->getName()),
                       juce::dontSendNotification);
        identity_.setText(std::move(chainId) + " / " + std::move(instanceId)
                          + " / " + std::move(pluginId), juce::dontSendNotification);
        identity_.setFont(juce::FontOptions(11.0f));
        identity_.setColour(juce::Label::textColourId, juce::Colours::lightgrey);
        lastTouched_.setText(pluginEditorUntouchedText(), juce::dontSendNotification);
        detail_.setText("Move a plugin control. Learn is armed from MiniHub.",
                        juce::dontSendNotification);
        detail_.setFont(juce::FontOptions(12.0f));

        addAndMakeVisible(title_);
        addAndMakeVisible(identity_);
        addAndMakeVisible(lastTouched_);
        addAndMakeVisible(detail_);
        addAndMakeVisible(*editor_);
        editor_->addComponentListener(this);
        setSize(std::max(kMinEditorSize, editor_->getWidth()),
                std::max(kMinEditorSize, editor_->getHeight()) + chromeHeight());
    }

    ~MiniHubPluginHostComponent() override
    {
        editor_->removeComponentListener(this);
    }

    static int chromeHeight() { return kHostHeaderHeight + kHostFooterHeight; }
    juce::BorderSize<int> chromeBorder() const
    {
        return { kHostHeaderHeight, 0, kHostFooterHeight, 0 };
    }
    juce::ComponentBoundsConstrainer* editorConstrainer() const
    {
        return editor_->getConstrainer();
    }
    bool editorResizable() const { return editor_->isResizable(); }

    void setLearnArmed(bool armed)
    {
        armed_ = armed;
        if (armed)
            detail_.setText(pluginEditorLearnArmedText(),
                            juce::dontSendNotification);
        else
            detail_.setText("Move a plugin control. Learn is armed from MiniHub.",
                            juce::dontSendNotification);
    }

    void showTouched(const PluginInstance::TouchedParameter& touched, bool captured)
    {
        lastTouched_.setText("Last touched: " + touched.name, juce::dontSendNotification);
        detail_.setText("ID: " + touched.parameterId + "    Value: "
                        + juce::String(touched.normalizedValue, 3)
                        + (captured ? "    Captured" : ""), juce::dontSendNotification);
        if (captured)
            setLearnArmed(false);
    }

    void paint(juce::Graphics& g) override
    {
        g.fillAll(juce::Colour(0xff202328));
        g.setColour(juce::Colour(0xff343941));
        g.fillRect(0, kHostHeaderHeight, getWidth(), 1);
        g.fillRect(0, getHeight() - kHostFooterHeight, getWidth(), 1);
    }

    void resized() override
    {
        layingOut_ = true;
        auto header = getLocalBounds().removeFromTop(kHostHeaderHeight).reduced(8, 5);
        title_.setBounds(header.removeFromLeft(std::min(260, header.getWidth() / 2)));
        identity_.setBounds(header);

        auto footer = getLocalBounds().removeFromBottom(kHostFooterHeight).reduced(8, 5);
        lastTouched_.setBounds(footer.removeFromTop(30));
        detail_.setBounds(footer);
        editor_->setBounds(0, kHostHeaderHeight, getWidth(),
                           std::max(0, getHeight() - chromeHeight()));
        layingOut_ = false;
    }

private:
    void componentMovedOrResized(juce::Component& component, bool, bool wasResized) override
    {
        if (!layingOut_ && wasResized && &component == editor_.get())
        {
            const int width = std::max(kMinEditorSize, editor_->getWidth());
            const int height = std::max(kMinEditorSize, editor_->getHeight()) + chromeHeight();
            setSize(width, height);
            if (auto* window = findParentComponentOfClass<juce::DocumentWindow>())
                window->setContentComponentSize(width, height);
        }
    }

    std::unique_ptr<juce::AudioProcessorEditor> editor_;
    juce::Label title_;
    juce::Label identity_;
    juce::Label lastTouched_;
    juce::Label detail_;
    bool armed_ = false;
    bool layingOut_ = false;
};

namespace {

/** A native top-level window hosting a plugin's own editor component.
 *
 *  Mirrors JUCE's reference host (extras/AudioPluginHost PluginWindow):
 *    - the window OWNS the editor and sizes itself to it
 *    - a bordered constrainer forwards the editor's own size limits, so a
 *      plugin that resizes its view (Vital, Analog Lab V, ...) resizes the
 *      window with it instead of being clipped
 *    - getDesktopScaleFactor() == 1 so Windows DPI scaling is applied once by
 *      the plugin, not twice
 *
 *  Closing the window only hides it - the plugin instance stays loaded and
 *  keeps processing audio.
 */
class EditorWindow final : public juce::DocumentWindow {
public:
    EditorWindow(const juce::String& title, MiniHubPluginHostComponent* host,
                 std::function<void()> closing)
        : juce::DocumentWindow(title, juce::Colours::darkgrey,
                               juce::DocumentWindow::minimiseButton | juce::DocumentWindow::closeButton),
          closing_(std::move(closing))
    {
        setUsingNativeTitleBar(true);
        setSize(kFallbackEditorWidth, kFallbackEditorHeight);
        // `true` = size this window to the editor. The previous code passed
        // `false`, which left the window at the default 136x39 and made the
        // editor effectively invisible even though it had been created.
        setContentOwned(host, true);
        setResizable(host->editorResizable(), false);
        setConstrainer(&constrainer_);
    }

    ~EditorWindow() override
    {
        clearContentComponent();
    }

    void closeButtonPressed() override
    {
        if (closing_)
            closing_();
        setVisible(false);
    }

    float getDesktopScaleFactor() const override { return 1.0f; }

private:
    class DecoratorConstrainer final : public juce::BorderedComponentBoundsConstrainer {
    public:
        explicit DecoratorConstrainer(juce::DocumentWindow& w) : window_(w) {}

        juce::ComponentBoundsConstrainer* getWrappedConstrainer() const override
        {
            auto* host = dynamic_cast<MiniHubPluginHostComponent*>(window_.getContentComponent());
            return host != nullptr ? host->editorConstrainer() : nullptr;
        }

        juce::BorderSize<int> getAdditionalBorder() const override
        {
            const auto nativeFrame = [&]() -> juce::BorderSize<int>
            {
                if (auto* peer = window_.getPeer())
                    if (const auto frameSize = peer->getFrameSizeIfPresent())
                        return *frameSize;
                return {};
            }();
            auto border = nativeFrame.addedTo(window_.getContentComponentBorder());
            if (auto* host = dynamic_cast<MiniHubPluginHostComponent*>(window_.getContentComponent()))
                border = border.addedTo(host->chromeBorder());
            return border;
        }

    private:
        juce::DocumentWindow& window_;
    };

    DecoratorConstrainer constrainer_ { *this };
    std::function<void()> closing_;
};

} // namespace

PluginInstance::~PluginInstance()
{
    // Destroy the window (and with it the editor's peer) before the editor and
    // the plugin itself. Member order already guarantees this; closing first
    // just makes the intent explicit and detaches the editor from the screen.
    // The window owns the editor, so destroying it detaches and deletes the
    // editor before the plugin itself goes away.
    learnState_.setArmed(false);
    activeLearnId_.clear();
    stopTimer();
    detachParameterListeners();
    if (plugin_) plugin_->removeListener(this);
    editorWindow_.reset();
    hostComponent_ = nullptr;
    if (plugin_)
        plugin_->reset();
}

void PluginInstance::setRuntimeIdentity(const juce::String& chainId,
                                        const juce::String& instanceId,
                                        juce::int64 generation)
{
    chainId_ = chainId;
    instanceId_ = instanceId;
    generation_ = generation;
}

bool PluginInstance::create(const PluginRecord& record, double sampleRate,
                            int blockSize, juce::String& error)
{
    pluginId_ = record.pluginId;
    name_ = record.name;
    role_ = record.role;
    isInstrument_ = record.isInstrument;

    // Use the full plugin description captured during scanning (incl. the
    // uniqueId that VST3 instantiation needs) rather than a hand-built subset.
    juce::PluginDescription desc = record.description;
    desc.pluginFormatName = "VST3";

    juce::VST3PluginFormat format;
    plugin_ = format.createInstanceFromDescription(desc, sampleRate, blockSize, error);
    if (plugin_ == nullptr)
    {
        error_ = error.isNotEmpty() ? error : "Failed to create plugin instance";
        isReady_ = false;
        return false;
    }

    isReady_ = true;

    if (!configureBusesForStereoGraph(*plugin_, error))
    {
        error_ = error;
        isReady_ = false;
        plugin_.reset();
        return false;
    }

    plugin_->addListener(this);
    error_.clear();
    return true;
}

void PluginInstance::audioProcessorParameterChanged(juce::AudioProcessor*, int, float)
{
    stateRevision_.fetch_add(1, std::memory_order_relaxed);
}

void PluginInstance::audioProcessorChanged(juce::AudioProcessor*, const juce::AudioProcessorListener::ChangeDetails& details)
{
    if (details.programChanged || details.nonParameterStateChanged)
        stateRevision_.fetch_add(1, std::memory_order_relaxed);
}

void PluginInstance::attachParameterListeners()
{
    jassert(juce::MessageManager::existsAndIsCurrentThread());
    if (!plugin_ || parameterListenersAttached_)
        return;

    const auto& parameters = plugin_->getParameters();
    learnState_.reset(parameters.size());
    for (int i = 0; i < parameters.size(); ++i)
    {
        if (auto* parameter = parameters[i])
            parameter->addListener(this);
    }
    parameterListenersAttached_ = true;
}

void PluginInstance::detachParameterListeners()
{
    jassert(juce::MessageManager::existsAndIsCurrentThread());
    if (plugin_ && parameterListenersAttached_)
        for (auto* parameter : plugin_->getParameters())
            if (parameter != nullptr)
                parameter->removeListener(this);
    parameterListenersAttached_ = false;
    learnState_.reset(0);
}

void PluginInstance::parameterGestureChanged(int parameterIndex, bool gestureIsStarting)
{
    learnState_.gestureChanged(parameterIndex, gestureIsStarting);
}

void PluginInstance::parameterValueChanged(int parameterIndex, float newValue)
{
    // This callback may be invoked from a plugin/audio thread. Record only
    // atomics here: JUCE AsyncUpdater/callAsync are not guaranteed real-time
    // safe. The visible native host drains the pending touch on its timer.
    learnState_.valueChanged(parameterIndex, newValue);
}

void PluginInstance::timerCallback()
{
    const auto pending = learnState_.consume();
    if (!pending || !plugin_ || pending->parameterIndex < 0)
        return;
    const auto& parameters = plugin_->getParameters();
    if (pending->parameterIndex >= parameters.size())
    {
        if (pending->capturedByLearn)
            learnState_.setArmed(true);
        return;
    }
    auto* parameter = parameters[pending->parameterIndex];
    auto* hosted = dynamic_cast<juce::HostedAudioProcessorParameter*>(parameter);
    if (hosted == nullptr)
    {
        // The callback state tentatively disarms on capture. If JUCE cannot
        // provide a stable hosted ID, keep Learn armed instead of consuming a
        // gesture that MiniHub cannot bind safely.
        if (pending->capturedByLearn)
            learnState_.setArmed(true);
        return; // Learn never fabricates an index-based identity.
    }

    const bool captured = pending->capturedByLearn;
    const juce::String capturedLearnId = captured ? activeLearnId_ : juce::String();
    TouchedParameter touched { hosted->getParameterID(), parameter->getName(100),
                               capturedLearnId, pending->normalizedValue, true, captured };
    if (hostComponent_ != nullptr)
        hostComponent_->showTouched(touched, captured);
    if (parameterTouchedCallback_)
        parameterTouchedCallback_(*this, touched);
    if (captured)
        cancelParameterLearn("captured");
}

bool PluginInstance::armParameterLearn(const juce::String& learnId, juce::String& error)
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
    if (!editorVisible() || !parameterListenersAttached_)
    {
        error = "plugin editor is not open";
        return false;
    }
    activeLearnId_ = learnId;
    learnState_.setArmed(true);
    if (hostComponent_ != nullptr)
        hostComponent_->setLearnArmed(true);
    return true;
}

void PluginInstance::cancelParameterLearn(const juce::String& reason)
{
    learnState_.setArmed(false);
    const juce::String endedLearnId = activeLearnId_;
    activeLearnId_.clear();
    if (hostComponent_ != nullptr)
        hostComponent_->setLearnArmed(false);
    if (endedLearnId.isNotEmpty() && parameterLearnEndedCallback_)
        parameterLearnEndedCallback_(*this, endedLearnId, reason);
    foregroundEditorIfAllowed();
}

void PluginInstance::foregroundEditorIfAllowed()
{
    if (editorVisible() && !learnArmed()) showEditorWindow();
}

void PluginInstance::prepareToPlay(double sampleRate, int blockSize)
{
    signalMeter_.prepare(sampleRate);
    if (!plugin_)
        return;
    // The VST3 format has already negotiated and activated the plugin's bus
    // layout during instantiation. Preserve that accepted layout and configure
    // only the processing contract, matching JUCE's standard host lifecycle.
    // setPlayConfigDetails would renegotiate channels blindly (especially
    // dangerous for 0-in/2-out instruments).
    plugin_->setProcessingPrecision(juce::AudioProcessor::singlePrecision);
    plugin_->setRateAndBufferSizeDetails(sampleRate, blockSize);
    plugin_->prepareToPlay(sampleRate, blockSize);
}

void PluginInstance::reset()
{
    signalMeter_.reset();
    if (plugin_)
        plugin_->reset();
}

void PluginInstance::setPlayHead(juce::AudioPlayHead* playHead)
{
    assignedPlayHead_ = playHead;
    if (plugin_) plugin_->setPlayHead(playHead);
}

void PluginInstance::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    if (!plugin_)
        return;

    const double started = juce::Time::getMillisecondCounterHiRes();
    // VST and FX boundaries are metered passively. Floating-point samples,
    // including values above 0 dBFS, reach and leave every processor unchanged
    // by the host. Only the plugin itself may alter its signal.
    signalMeter_.observe(buffer, buffer.getNumSamples(), AudioSignalBoundary::input);
    plugin_->processBlock(buffer, midi);
    signalMeter_.observe(buffer, buffer.getNumSamples(), AudioSignalBoundary::output);

    const float elapsed = static_cast<float>(
        juce::Time::getMillisecondCounterHiRes() - started);
    lastProcessingMilliseconds_.store(elapsed, std::memory_order_release);
    const auto publishMaximum = [elapsed](std::atomic<float>& destination) noexcept
    {
        float observed = destination.load(std::memory_order_relaxed);
        while (elapsed > observed
               && !destination.compare_exchange_weak(observed, elapsed,
                                                     std::memory_order_release,
                                                     std::memory_order_relaxed)) {}
    };
    publishMaximum(maximumRecentProcessingMilliseconds_);
    publishMaximum(maximumProcessingMilliseconds_);
    processingCalls_.fetch_add(1, std::memory_order_relaxed);
}

PluginProcessingTelemetry PluginInstance::takeProcessingTelemetry() noexcept
{
    PluginProcessingTelemetry result;
    result.lastMilliseconds = lastProcessingMilliseconds_.load(std::memory_order_acquire);
    result.maximumRecentMilliseconds = maximumRecentProcessingMilliseconds_.exchange(
        0.0f, std::memory_order_acq_rel);
    result.maximumMilliseconds = maximumProcessingMilliseconds_.load(std::memory_order_acquire);
    result.processCalls = processingCalls_.load(std::memory_order_acquire);
    return result;
}

int PluginInstance::enabledOutputBusesForTesting() const
{
    if (plugin_ == nullptr)
        return 0;
    int enabled = 0;
    for (int index = 0; index < plugin_->getBusCount(false); ++index)
        if (auto* bus = plugin_->getBus(false, index); bus != nullptr && bus->isEnabled())
            ++enabled;
    return enabled;
}

void PluginInstance::showEditorWindow()
{
    if (!editorWindow_)
        return;

    // Parameter objects belong to the hosted plugin and are observed only
    // while its native editor is on screen. Keeping this on JUCE's message
    // thread avoids walking thousands of parameters from the load worker and
    // removes every listener before the hidden editor can outlive observation.
    attachParameterListeners();
    editorWindow_->setVisible(true);
    if (editorWindow_->isMinimised())
        editorWindow_->setMinimised(false);

    editorWindow_->toFront(true);
    editorWindow_->grabKeyboardFocus();
#if JUCE_WINDOWS
    // JUCE's toFront() is intra-process; Electron owns the foreground queue in
    // another process. Temporarily join that queue for this explicit action.
    if (auto* peer = editorWindow_->getPeer())
    {
        auto hwnd = static_cast<HWND>(peer->getNativeHandle());
        if (hwnd != nullptr)
        {
            ::ShowWindow(hwnd, SW_RESTORE);
            const HWND foreground = ::GetForegroundWindow();
            const DWORD currentThread = ::GetCurrentThreadId();
            const DWORD foregroundThread = foreground != nullptr
                ? ::GetWindowThreadProcessId(foreground, nullptr) : 0;
            const bool attached = foregroundThread != 0 && foregroundThread != currentThread
                && ::AttachThreadInput(currentThread, foregroundThread, TRUE) != FALSE;
            ::BringWindowToTop(hwnd);
            ::SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                           SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            ::SetActiveWindow(hwnd);
            ::SetFocus(hwnd);
            ::SetForegroundWindow(hwnd);
            if (attached) ::AttachThreadInput(currentThread, foregroundThread, FALSE);
        }
    }
#endif
    // Observe only while a real editor is visible. This timer reads lock-free
    // state; it never enumerates parameters or calls a plugin from the audio
    // callback, and bulk parameter discovery remains demand-driven.
    startTimerHz(30);
}

bool PluginInstance::openEditor(juce::String& message)
{
    if (!plugin_)
    {
        message = "plugin not loaded";
        return false;
    }

    // VST3 editors may only be created and shown from the message thread.
    if (!juce::MessageManager::existsAndIsCurrentThread())
    {
        message = "editor must be opened on the message thread";
        return false;
    }

    if (editorWindow_ != nullptr)
    {
        showEditorWindow();
        return true;
    }

    if (!plugin_->hasEditor())
    {
        message = "plugin provides no editor";
        return false;
    }

    auto* editor = plugin_->createEditorAndMakeActive();
    if (editor == nullptr)
    {
        message = "plugin editor creation failed";
        return false;
    }

    // Some VST3 views report a degenerate size until they are attached to a
    // real peer; without this the window would be an unusable sliver.
    if (editor->getWidth() < kMinEditorSize || editor->getHeight() < kMinEditorSize)
    {
        editor->setSize(std::max(editor->getWidth(), kFallbackEditorWidth),
                        std::max(editor->getHeight(), kFallbackEditorHeight));
    }

    hostComponent_ = new MiniHubPluginHostComponent(editor, chainId_, instanceId_, pluginId_);
    editorWindow_ = std::make_unique<EditorWindow>(
        pluginEditorWindowTitle(name_), hostComponent_, [this]()
        {
            cancelParameterLearn("editor-closed");
            stopTimer();
            detachParameterListeners();
            if (editorClosedCallback_)
                editorClosedCallback_(*this);
        });
    editorWindow_->centreWithSize(editorWindow_->getWidth(), editorWindow_->getHeight());
    showEditorWindow();
    return true;
}

void PluginInstance::closeEditor()
{
    cancelParameterLearn("editor-closed");
    stopTimer();
    if (editorWindow_)
        editorWindow_->setVisible(false);
    detachParameterListeners();
}

bool PluginInstance::editorVisible() const
{
    return editorWindow_ != nullptr && editorWindow_->isVisible()
           && editorWindow_->isOnDesktop();
}

int PluginInstance::editorWidth() const
{
    return editorWindow_ ? editorWindow_->getWidth() : 0;
}

int PluginInstance::editorHeight() const
{
    return editorWindow_ ? editorWindow_->getHeight() : 0;
}

juce::var PluginInstance::getState() const
{
    if (!plugin_)
        return juce::var();

    juce::MemoryBlock block;
    plugin_->getStateInformation(block);
    return juce::var(block.toBase64Encoding());
}

bool PluginInstance::setState(const juce::var& state, juce::String& error)
{
    if (!plugin_)
    {
        error = "plugin not loaded";
        return false;
    }
    if (!state.isString())
    {
        error = "invalid state payload";
        return false;
    }

    juce::MemoryBlock block;
    if (!block.fromBase64Encoding(state.toString()))
    {
        error = "invalid base64 state";
        return false;
    }

    plugin_->setStateInformation(block.getData(), static_cast<int>(block.getSize()));
    capturedStateRevision_ = observedStateRevision_ = stateRevision_.load(std::memory_order_relaxed);
    stableStateTicks_ = 0;
    return true;
}

bool PluginInstance::takeStateSnapshotIfDue(juce::var& state, bool force)
{
    jassert(juce::MessageManager::existsAndIsCurrentThread());
    const auto revision=stateRevision_.load(std::memory_order_acquire);
    if (!force && revision==capturedStateRevision_) return false;
    if (!force) {
        if (revision!=observedStateRevision_) { observedStateRevision_=revision; stableStateTicks_=0; return false; }
        if (++stableStateTicks_<5) return false;
    }
    state=getState(); capturedStateRevision_=observedStateRevision_=revision; stableStateTicks_=0;
    return !state.isVoid();
}

juce::var PluginInstance::getParameters() const
{
    juce::Array<juce::var> params;
    if (!plugin_)
        return params;

    const auto& list = plugin_->getParameters();
    for (int i = 0; i < list.size(); ++i)
    {
        auto* param = list.getUnchecked(i);
        if (param == nullptr)
            continue;
        juce::var p = makeObject();

        // Stable identity: prefer the plugin-provided parameter ID (the VST3
        // ParamID) exposed through JUCE's hosted-parameter interface. Names
        // and array positions are NOT stable across plugin versions, so they
        // are never used as the persisted identity.
        juce::String id;
        bool idStable = false;
        if (auto* hosted = dynamic_cast<juce::HostedAudioProcessorParameter*>(param))
        {
            id = hosted->getParameterID();
            idStable = true;
        }
        else
        {
            // No stable ID available (should not happen for VST3): fall back to
            // the parameter index and mark the record explicitly as unstable
            // rather than silently pretending the display name is stable.
            id = "param-" + juce::String(param->getParameterIndex());
            idStable = false;
        }

        setProp(p, "parameterId", id);
        setProp(p, "idStable", idStable);
        setProp(p, "name", param->getName(100));
        setProp(p, "normalizedValue", param->getValue());
        setProp(p, "automatable", param->isAutomatable());
        // JUCE's hosted VST3 parameter does not expose kIsReadOnly. Do not turn
        // that missing capability into an authoritative false (or infer it
        // from names/categories): JSON null means explicitly unknown.
        setProp(p, "readOnly", juce::var());
        setProp(p, "label", param->getLabel());
        setProp(p, "index", param->getParameterIndex());
        params.add(p);
    }
    return params;
}

bool PluginInstance::setParameterNormalized(const juce::String& parameterId,
                                            float normalizedValue,
                                            juce::String& error)
{
    jassert(juce::MessageManager::existsAndIsCurrentThread());
    if (!plugin_ || !isReady_)
    {
        error = "plugin is not ready";
        return false;
    }

    const auto rebuildIndex = [this]()
    {
        stableParameterIndices_.clear();
        const auto& parameters = plugin_->getParameters();
        for (int i = 0; i < parameters.size(); ++i)
        {
            auto* hosted = dynamic_cast<juce::HostedAudioProcessorParameter*>(parameters[i]);
            if (hosted != nullptr && !stableParameterIndices_.count(hosted->getParameterID()))
                stableParameterIndices_.emplace(hosted->getParameterID(), i);
        }
        parameterIndexBuilt_ = true;
    };

    if (!parameterIndexBuilt_)
        rebuildIndex();

    auto found = stableParameterIndices_.find(parameterId);
    if (found == stableParameterIndices_.end())
    {
        error = "stable parameter ID not found";
        return false;
    }

    // Resolve the index back to the current hosted parameter and re-check its
    // stable ID before dereferencing. If a non-conforming plugin changed its
    // parameter array, rebuild once rather than trusting a stale cache entry.
    const auto resolve = [this, &parameterId](int index) -> juce::AudioProcessorParameter*
    {
        const auto& parameters = plugin_->getParameters();
        if (index < 0 || index >= parameters.size())
            return nullptr;
        auto* parameter = parameters[index];
        auto* hosted = dynamic_cast<juce::HostedAudioProcessorParameter*>(parameter);
        return hosted != nullptr && hosted->getParameterID() == parameterId ? parameter : nullptr;
    };

    auto* parameter = resolve(found->second);
    if (parameter == nullptr)
    {
        rebuildIndex();
        found = stableParameterIndices_.find(parameterId);
        parameter = found != stableParameterIndices_.end() ? resolve(found->second) : nullptr;
    }
    if (parameter == nullptr)
    {
        error = "stable parameter ID no longer resolves";
        return false;
    }

    // MiniHub is the host. AudioProcessorParameter::setValue is the JUCE host
    // automation entry point; setValueNotifyingHost is for changes originating
    // inside a plugin/editor and would incorrectly notify MiniHub back.
    parameter->setValue(juce::jlimit(0.0f, 1.0f, normalizedValue));
    failedParameterIds_.erase(parameterId);
    return true;
}

} // namespace mlh
