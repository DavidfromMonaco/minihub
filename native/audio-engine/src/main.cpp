#include "engine.h"
#include "ipc.h"
#include "var_util.h"
#include "vst3_scanner.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <iostream>
#include <memory>

/**
 * MiniLab Hub native audio engine.
 *
 * A standalone native executable (C++ / JUCE 9) launched and supervised by the
 * Electron main process. It owns the audio device, VST3 plugin instances,
 * real-time processing, and native plugin editor windows. Electron talks to it
 * only over a versioned newline-delimited JSON IPC channel (stdin/stdout) for
 * CONTROL and MIDI messages — audio samples never cross that boundary.
 *
 * Two modes:
 *   - default: the engine (reads commands on stdin, writes responses on stdout)
 *   - `--scan-file <path>`: scan a single VST3 file and print its metadata as
 *     JSON lines, then exit. Used by the engine for out-of-process scanning so a
 *     crashing plugin never takes down the engine and plugin stdout noise never
 *     corrupts the engine's IPC channel.
 */

class MlhEngineApplication : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "MiniLab Hub Audio Engine"; }
    const juce::String getApplicationVersion() override { return "1.0.0"; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise(const juce::String&) override
    {
        engine_ = std::make_unique<mlh::Engine>(ipc_);
        ipc_.start([this](const juce::var& msg)
        {
            engine_->handleCommand(msg);
        });
        // Let the supervisor know the engine is alive.
        engine_->sendStatus();
    }

    void shutdown() override
    {
        ipc_.stop();
        engine_.reset();
    }

private:
    mlh::Ipc ipc_;
    std::unique_ptr<mlh::Engine> engine_;
};

class ScanApplication : public juce::JUCEApplication {
public:
    explicit ScanApplication(juce::String file) : file_(std::move(file)) {}

    const juce::String getApplicationName() override { return "MiniLab Hub VST3 Scanner"; }
    const juce::String getApplicationVersion() override { return "1.0.0"; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise(const juce::String&) override
    {
        const auto records = mlh::Vst3Scanner::scanFile(file_);
        for (const auto& r : records)
        {
            juce::var o = mlh::makeObject();
            // Serialize the full plugin description (incl. uniqueId) so the
            // parent can reconstruct it and later instantiate the plugin.
            if (auto xml = r.description.createXml())
                mlh::setProp(o, "descriptionXml", xml->toString());
            mlh::setProp(o, "pluginId", r.pluginId);
            mlh::setProp(o, "name", r.name);
            mlh::setProp(o, "manufacturer", r.manufacturer);
            mlh::setProp(o, "category", r.category);
            mlh::setProp(o, "path", r.path);
            mlh::setProp(o, "isInstrument", r.isInstrument);
            mlh::setProp(o, "numInputChannels", r.numInputChannels);
            mlh::setProp(o, "numOutputChannels", r.numOutputChannels);
            mlh::setProp(o, "role", r.role);
            std::cout << juce::JSON::toString(o, true).toStdString() << std::endl;
        }
        std::cout.flush();
        quit();
    }

    void shutdown() override {}

private:
    juce::String file_;
};

namespace {
juce::String gScanFile;
}

juce::JUCEApplicationBase* juce_CreateApplication()
{
    if (gScanFile.isNotEmpty())
        return new ScanApplication(gScanFile);
    return new MlhEngineApplication();
}

int main(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        if (juce::String(argv[i]) == "--scan-file" && i + 1 < argc)
        {
            gScanFile = argv[i + 1];
            break;
        }
    }

    juce::JUCEApplicationBase::createInstance = &juce_CreateApplication;
    return juce::JUCEApplicationBase::main(argc, (const char**) argv);
}
