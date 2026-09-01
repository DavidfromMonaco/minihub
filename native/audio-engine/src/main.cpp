#include "engine.h"
#include "ipc.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <iostream>
#include <memory>
#if defined(_WIN32)
#include <process.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

/**
 * MiniLab Hub native audio engine.
 *
 * A standalone native executable (C++ / JUCE 9) launched and supervised by the
 * Electron main process. It owns the audio device, VST3 plugin instances,
 * real-time processing, and native plugin editor windows. Electron talks to it
 * only over a versioned newline-delimited JSON IPC channel (stdin/stdout) for
 * CONTROL and MIDI messages — audio samples never cross that boundary.
 *
 * This executable has exactly one role: the live engine. VST discovery runs in
 * the sibling `mlh-vst3-scanner.exe`, which cannot construct Engine and cannot
 * open Engine 2's PortAudio device.
 */

namespace {
mlh::EngineRuntimeIdentity gRuntimeIdentity;

juce::int64 currentProcessId() noexcept
{
#if defined(_WIN32)
    return static_cast<juce::int64>(_getpid());
#else
    return static_cast<juce::int64>(getpid());
#endif
}
}

class MlhEngineApplication : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "MiniLab Hub Audio Engine"; }
    const juce::String getApplicationVersion() override { return "1.0.0"; }
    // Electron owns the single-application policy. JUCE's process-global
    // single-instance gate can briefly see the previous engine while Windows
    // is still releasing it and makes the replacement exit successfully (0)
    // before handshake, permanently stranding the new renderer in error.
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise(const juce::String&) override
    {
        engine_ = std::make_unique<mlh::Engine>(ipc_, gRuntimeIdentity);
        ipc_.start(
            [this](const juce::var& msg)
            {
                if (engine_)
                    engine_->handleCommand(msg);
            },
            [this]()
            {
                if (engine_)
                    engine_->requestShutdown(false);
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

juce::JUCEApplicationBase* juce_CreateApplication()
{
    return new MlhEngineApplication();
}

int main(int argc, char* argv[])
{
    gRuntimeIdentity.processId = currentProcessId();
    gRuntimeIdentity.role = "live";
    juce::StringArray arguments;
    for (int i = 1; i < argc; ++i)
    {
        const juce::String argument(argv[i]);
        arguments.add(argument);
        if (argument == "--role" && i + 1 < argc)
        {
            gRuntimeIdentity.role = argv[i + 1];
            arguments.add(argv[i + 1]);
            ++i;
        }
        else if (argument == "--parent-pid" && i + 1 < argc)
        {
            gRuntimeIdentity.parentProcessId = juce::String(argv[i + 1]).getLargeIntValue();
            arguments.add(argv[i + 1]);
            ++i;
        }
        else if (argument == "--created-at" && i + 1 < argc)
        {
            gRuntimeIdentity.createdAt = argv[i + 1];
            arguments.add(argv[i + 1]);
            ++i;
        }
        else if (argument == "--scan-file")
        {
            std::cerr << "[native-process] rejected role=scan executable=mlh-audio-engine audioDeviceOpen=false" << std::endl;
            return 64;
        }
    }
    gRuntimeIdentity.arguments = arguments.joinIntoString(" ");
    if (gRuntimeIdentity.role != "live")
    {
        std::cerr << "[native-process] rejected role=" << gRuntimeIdentity.role
                  << " executable=mlh-audio-engine audioDeviceOpen=false" << std::endl;
        return 64;
    }

    // Defence in depth beyond Electron's requestSingleInstanceLock and the JS
    // supervisor guard. A manually or accidentally spawned second native live
    // engine exits before constructing Engine 2's PortAudio runtime, so it can never
    // create a second Windows audio session.
#if defined(_WIN32)
    // Use one deterministic per-session namespace so all launch paths contend
    // for the same live-engine mutex.
    HANDLE liveEngineLock = CreateMutexW(nullptr, TRUE,
                                         L"Local\\MiniHub.LiveAudioEngine.v1");
    const bool duplicateLiveEngine = liveEngineLock != nullptr
        && GetLastError() == ERROR_ALREADY_EXISTS;
    if (liveEngineLock == nullptr || duplicateLiveEngine)
#else
    juce::InterProcessLock liveEngineLock("MiniHub.LiveAudioEngine.v1");
    if (!liveEngineLock.enter(0))
#endif
    {
#if defined(_WIN32)
        if (liveEngineLock != nullptr)
            CloseHandle(liveEngineLock);
#endif
        std::cerr << "[native-process] rejected duplicate role=live pid="
                  << gRuntimeIdentity.processId << " audioDeviceOpen=false" << std::endl;
        return 73;
    }

    std::cerr << "[native-process] role=live pid=" << gRuntimeIdentity.processId
              << " parentPid=" << gRuntimeIdentity.parentProcessId
              << " createdAt=" << gRuntimeIdentity.createdAt
              << " audioDevice=owned lifetime=application reason=electron-main-singleton args=\""
              << gRuntimeIdentity.arguments << "\"" << std::endl;

    juce::JUCEApplicationBase::createInstance = &juce_CreateApplication;
    const int result = juce::JUCEApplicationBase::main(argc, (const char**) argv);
#if defined(_WIN32)
    ReleaseMutex(liveEngineLock);
    CloseHandle(liveEngineLock);
#else
    liveEngineLock.exit();
#endif
    return result;
}
