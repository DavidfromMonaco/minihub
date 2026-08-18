#include "plugin_host.h"

#include <algorithm>

namespace mlh {

namespace {

// A plugin editor that reports a degenerate size (some VST3 views only learn
// their real size once attached to a real peer) would produce an unusable
// sliver of a window. Below this threshold we fall back to a readable default.
constexpr int kMinEditorSize = 200;
constexpr int kFallbackEditorWidth = 800;
constexpr int kFallbackEditorHeight = 520;

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
    EditorWindow(const juce::String& title, juce::AudioProcessorEditor* editor)
        : juce::DocumentWindow(title, juce::Colours::darkgrey,
                               juce::DocumentWindow::minimiseButton | juce::DocumentWindow::closeButton)
    {
        setUsingNativeTitleBar(true);
        setSize(kFallbackEditorWidth, kFallbackEditorHeight);
        // `true` = size this window to the editor. The previous code passed
        // `false`, which left the window at the default 136x39 and made the
        // editor effectively invisible even though it had been created.
        setContentOwned(editor, true);
        setResizable(editor->isResizable(), false);
        setConstrainer(&constrainer_);
    }

    ~EditorWindow() override
    {
        clearContentComponent();
    }

    void closeButtonPressed() override
    {
        setVisible(false);
    }

    float getDesktopScaleFactor() const override { return 1.0f; }

private:
    class DecoratorConstrainer final : public juce::BorderedComponentBoundsConstrainer {
    public:
        explicit DecoratorConstrainer(juce::DocumentWindow& w) : window_(w) {}

        juce::ComponentBoundsConstrainer* getWrappedConstrainer() const override
        {
            auto* editor = dynamic_cast<juce::AudioProcessorEditor*>(window_.getContentComponent());
            return editor != nullptr ? editor->getConstrainer() : nullptr;
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
            return nativeFrame.addedTo(window_.getContentComponentBorder());
        }

    private:
        juce::DocumentWindow& window_;
    };

    DecoratorConstrainer constrainer_ { *this };
};

} // namespace

PluginInstance::~PluginInstance()
{
    // Destroy the window (and with it the editor's peer) before the editor and
    // the plugin itself. Member order already guarantees this; closing first
    // just makes the intent explicit and detaches the editor from the screen.
    // The window owns the editor, so destroying it detaches and deletes the
    // editor before the plugin itself goes away.
    editorWindow_.reset();
    if (plugin_)
        plugin_->reset();
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
    error_.clear();
    return true;
}

void PluginInstance::prepareToPlay(double sampleRate, int blockSize)
{
    if (!plugin_)
        return;
    plugin_->setPlayConfigDetails(2, 2, sampleRate, blockSize);
    plugin_->prepareToPlay(sampleRate, blockSize);
}

void PluginInstance::reset()
{
    if (plugin_)
        plugin_->reset();
}

void PluginInstance::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    if (plugin_)
        plugin_->processBlock(buffer, midi);
}

void PluginInstance::showEditorWindow()
{
    if (!editorWindow_)
        return;

    editorWindow_->setVisible(true);
    if (editorWindow_->isMinimised())
        editorWindow_->setMinimised(false);

    // The engine is a background console process spawned by Electron, so
    // Windows denies it the foreground and a plain toFront() leaves the editor
    // buried behind the Electron window. Promoting the window to topmost and
    // immediately demoting it again puts it at the top of the normal z-order
    // without pinning it above everything else.
    editorWindow_->setAlwaysOnTop(true);
    editorWindow_->toFront(true);
    editorWindow_->setAlwaysOnTop(false);
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

    editorWindow_ = std::make_unique<EditorWindow>(name_, editor);
    editorWindow_->centreWithSize(editorWindow_->getWidth(), editorWindow_->getHeight());
    showEditorWindow();
    return true;
}

void PluginInstance::closeEditor()
{
    if (editorWindow_)
        editorWindow_->setVisible(false);
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
    return true;
}

} // namespace mlh
