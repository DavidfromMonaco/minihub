#include "vst3_scanner.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <iostream>
#if defined(_WIN32)
#include <process.h>
#ifndef NOMINMAX
#define NOMINMAX 1
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace {
juce::int64 currentProcessId() noexcept
{
#if defined(_WIN32)
    return static_cast<juce::int64>(_getpid());
#else
    return static_cast<juce::int64>(getpid());
#endif
}

std::vector<mlh::PluginRecord> testHelperResult(const juce::String& path)
{
    if (!path.startsWith("minihub-test://")) return {};
    if (path.contains("hung"))
    {
        juce::Thread::sleep(5000);
        return {};
    }
    if (path.contains("crashing"))
    {
#if defined(_WIN32)
        ::TerminateProcess(::GetCurrentProcess(), 0xc0000005u);
#endif
        return {};
    }
    mlh::PluginRecord record;
    record.pluginId = path;
    record.name = "LANDR Mastering Pro";
    record.manufacturer = "LANDR";
    record.category = "Fx|Mastering";
    record.path = path;
    record.numInputChannels = 2;
    record.numOutputChannels = 2;
    record.role = "audio-effect";
    record.description.name = record.name;
    record.description.manufacturerName = record.manufacturer;
    record.description.category = record.category;
    record.description.pluginFormatName = "VST3";
    record.description.fileOrIdentifier = record.pluginId;
    record.description.uniqueId = static_cast<int>(0xd955cbeau);
    record.description.numInputChannels = 2;
    record.description.numOutputChannels = 2;
    std::cout << "SPLICE:: Validity...........: UNKNOWN_ERROR\n";
    return { record };
}
}

int main(int argc, char* argv[])
{
    juce::String scanFile, resultFile, createdAt;
    juce::int64 parentPid = 0;
    for (int i = 1; i < argc; ++i)
    {
        const juce::String argument(argv[i]);
        if (argument == "--scan-file" && i + 1 < argc) scanFile = argv[++i];
        else if (argument == "--scan-result" && i + 1 < argc) resultFile = argv[++i];
        else if (argument == "--parent-pid" && i + 1 < argc) parentPid = juce::String(argv[++i]).getLargeIntValue();
        else if (argument == "--created-at" && i + 1 < argc) createdAt = argv[++i];
    }
    if (scanFile.isEmpty() || resultFile.isEmpty())
    {
        std::cerr << "[scanner] --scan-file and --scan-result are required" << std::endl;
        return 64;
    }

    std::cerr << "[native-process] role=scan pid=" << currentProcessId()
              << " parentPid=" << parentPid << " createdAt=" << createdAt
              << " audioDeviceOpen=false lifetime=bounded reason=vst3-metadata" << std::endl;

    // This helper links no juce_audio_devices module and has no Engine class.
    // ScopedJuceInitialiser_GUI supplies the message infrastructure required by
    // some VST3 factories without creating any hardware audio endpoint.
    juce::ScopedJuceInitialiser_GUI juceRuntime;
    const auto records = scanFile.startsWith("minihub-test://")
        ? testHelperResult(scanFile)
        : mlh::Vst3Scanner::scanFile(scanFile);
    const auto json = mlh::Vst3Scanner::serializeScanResult(records);
    if (!juce::File(resultFile).replaceWithText(json, false, false, "\n"))
    {
        std::cerr << "[scanner] could not write helper result" << std::endl;
        return 1;
    }
    return 0;
}
