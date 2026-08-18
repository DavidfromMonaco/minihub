#pragma once

#include "vst3_scanner.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <memory>

namespace mlh {

/**
 * A single live VST3 plugin instance inside a serial chain.
 *
 * Owns the real-time plugin instance, its native editor window, and its
 * serialized state. Only stable, reconstructable data (instanceId, pluginId,
 * name, role, bypass, serialized state) is ever exposed to the outside world —
 * native pointers/handles never leave the engine.
 */
class PluginInstance {
public:
    PluginInstance() = default;
    ~PluginInstance();

    PluginInstance(const PluginInstance&) = delete;
    PluginInstance& operator=(const PluginInstance&) = delete;

    /** Create the plugin from a registry record. Must run OFF the message thread
     *  (VST3 instantiation can require an unblocked message thread). */
    bool create(const PluginRecord& record, double sampleRate, int blockSize,
                juce::String& error);

    void prepareToPlay(double sampleRate, int blockSize);
    void reset();

    /** Process one block. Called from the real-time audio callback only. */
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);

    juce::AudioPluginInstance* get() const { return plugin_.get(); }

    const juce::String& instanceId() const { return instanceId_; }
    const juce::String& pluginId() const { return pluginId_; }
    const juce::String& name() const { return name_; }
    const juce::String& role() const { return role_; }
    bool isInstrument() const { return isInstrument_; }
    bool isReady() const { return isReady_; }
    const juce::String& error() const { return error_; }

    bool bypassed() const { return bypassed_; }
    void setBypassed(bool b) { bypassed_ = b; }

    void setInstanceId(const juce::String& id) { instanceId_ = id; }

    // ---- Native editor window (owned by the engine, never embedded in Electron) ----

    /** Open (or re-show) the plugin's own native editor in a top-level window.
     *  MUST be called on the JUCE message thread. Returns false and fills
     *  `message` when the plugin exposes no editor or the editor cannot be
     *  created. */
    bool openEditor(juce::String& message);

    /** Hide the editor window. The plugin instance stays loaded and keeps
     *  processing audio. */
    void closeEditor();

    /** True while the editor window exists AND is actually on screen. This is
     *  what `editorStatus` reports — never a bare "the command succeeded". */
    bool editorVisible() const;

    /** Size of the editor window currently on screen (0 when there is none). */
    int editorWidth() const;
    int editorHeight() const;

    // Serialized plugin state (base64). Safe to persist/restore.
    juce::var getState() const;
    bool setState(const juce::var& state, juce::String& error);

private:
    void showEditorWindow();

    std::unique_ptr<juce::AudioPluginInstance> plugin_;
    // The window owns the editor component (JUCE reference-host pattern), so
    // there is exactly one owner and no destruction-order hazard.
    std::unique_ptr<juce::DocumentWindow> editorWindow_;

    juce::String instanceId_;
    juce::String pluginId_;
    juce::String name_;
    juce::String role_;
    bool isInstrument_ = false;
    bool isReady_ = false;
    bool bypassed_ = false;
    juce::String error_;
};

} // namespace mlh
