#pragma once

#include <juce_core/juce_core.h>
#include <functional>
#include <memory>

namespace mlh {

/**
 * Versioned IPC boundary between Electron and the native audio engine.
 *
 * Messages are newline-delimited JSON objects over stdin (Electron -> engine)
 * and stdout (engine -> Electron). Every message carries a `"v"` protocol
 * version field so the contract can evolve without breaking older peers.
 *
 * Audio samples are NEVER sent over this channel — only CONTROL and MIDI
 * messages. Audio processing stays entirely inside the engine.
 */
constexpr int kProtocolVersion = 1;

class Ipc {
public:
    using Handler = std::function<void(const juce::var& msg)>;

    Ipc() = default;
    ~Ipc();

    Ipc(const Ipc&) = delete;
    Ipc& operator=(const Ipc&) = delete;

    /** Start a background thread reading newline-delimited JSON from stdin and
     *  dispatching each message to `handler` on the JUCE message thread. */
    void start(const Handler& handler);

    /** Send a JSON object (single line) to stdout. Thread-safe. */
    void send(const juce::var& obj);

    void stop();

private:
    Handler handler_;
    std::unique_ptr<juce::Thread> reader_;
    juce::CriticalSection writeLock_;
};

} // namespace mlh
