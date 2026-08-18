#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <map>
#include <string>
#include <vector>

namespace mlh {

/**
 * A discovered VST3 plugin with the metadata we persist. `pluginId` is the
 * stable, reconstructable identity (the plugin file path) — never a runtime
 * handle or pointer.
 */
struct PluginRecord {
    juce::String pluginId;      // stable identity (file path)
    juce::String name;
    juce::String manufacturer;
    juce::String category;
    juce::String path;
    bool isInstrument = false;
    int numInputChannels = 0;
    int numOutputChannels = 0;
    // Role mapped from real plugin capability: 'instrument' | 'audio-effect' | 'unknown'
    juce::String role;
    // The full plugin description (incl. uniqueId) needed to instantiate the
    // plugin later. Reconstructed from the scan; never a runtime handle.
    juce::PluginDescription description;
};

/**
 * Real VST3 discovery.
 *
 * Scanning is performed OUT OF PROCESS: the engine spawns a child process per
 * `.vst3` file so that (a) a crashing/uncooperative plugin only kills the child,
 * never the audio engine, and (b) plugin stdout noise never corrupts the engine's
 * IPC channel. Metadata is read directly from the plugin API (PluginDescription),
 * not filename heuristics. Only standard Windows VST3 locations are scanned —
 * never VST2 folders.
 */
class Vst3Scanner {
public:
    /** Scan the standard locations (out of process). Pure: touches no member
     *  state, so it is safe to run on a worker thread while the message thread
     *  keeps serving commands. */
    static std::vector<PluginRecord> scanAll();

    /** Install a scan result as the registry. Message thread only. */
    void setRecords(std::vector<PluginRecord> records);

    /** Scan a single `.vst3` file in-process. Used by the child `--scan-file` mode. */
    static std::vector<PluginRecord> scanFile(const juce::String& path);

    /** Enumerate `.vst3` files under the given search paths (no plugin loading). */
    static juce::StringArray findVst3Files(const juce::FileSearchPath& paths);

    const std::vector<PluginRecord>& records() const { return records_; }
    const PluginRecord* find(const juce::String& pluginId) const;

private:
    std::vector<PluginRecord> records_;
    std::map<juce::String, size_t> index_;
};

} // namespace mlh
