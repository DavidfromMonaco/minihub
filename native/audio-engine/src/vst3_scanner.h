#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <map>
#include <atomic>
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
    /**
     * VST3 component class UID: 32 ASCII hex characters, or empty when the
     * module could not be read.
     *
     * `pluginId` is an absolute path on THIS machine. It names a plugin here
     * and nowhere else, which is exactly what INTENT.md section 2 forbids
     * baking in: a catalog keyed on it cannot be carried to another machine,
     * nor compared with anything recorded on one. The component class UID is
     * the identity the plugin declares about itself, and it is the same
     * everywhere.
     *
     * Written the way the SDK writes it: on Windows COM_COMPATIBLE is 1, so
     * `FUID::toString` and `VST3::UID::toString` (whose default `comFormat`
     * is true here) produce the same 32 characters. Whoever compares two of
     * these compares plain strings -- no byte reordering anywhere.
     *
     * Empty is normal, not an error: the catalog must never lose a plugin
     * because its UID could not be read (invariant 12).
     */
    juce::String classId;
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
    static std::vector<PluginRecord> scanAll(const std::atomic<bool>* cancelled = nullptr);

    /** Install a scan result as the registry. Message thread only. */
    void setRecords(std::vector<PluginRecord> records);

    /** Scan a single `.vst3` file in-process. Used by the child `--scan-file` mode. */
    static std::vector<PluginRecord> scanFile(const juce::String& path);

    /** Scan one `.vst3` file in a disposable helper process. Parent-engine
     *  code must use this entry point: a malformed plug-in may fault while
     *  merely reporting its classes/metadata. */
    static std::vector<PluginRecord> scanFileIsolated(
        const juce::String& path,
        const std::atomic<bool>* cancelled = nullptr,
        juce::uint32 timeoutMs = 30000);

    /** Encode/decode the private, versioned helper-result document. The parent
     *  reads this from a dedicated temporary file, never from plugin-controlled
     *  stdout. Public so the native regression helper can exercise the exact
     *  production protocol. */
    static juce::String serializeScanResult(const std::vector<PluginRecord>& records);
    static bool deserializeScanResult(const juce::String& json,
                                      std::vector<PluginRecord>& records);

    /** Enumerate `.vst3` files under the given search paths (no plugin loading). */
    static juce::StringArray findVst3Files(const juce::FileSearchPath& paths);

    const std::vector<PluginRecord>& records() const { return records_; }
    const PluginRecord* find(const juce::String& pluginId) const;

private:
    std::vector<PluginRecord> records_;
    std::map<juce::String, size_t> index_;
};

} // namespace mlh
