#include "ipc.h"
#include "var_util.h"

#include <juce_events/juce_events.h>

#include <iostream>

namespace mlh {

namespace {

class ReaderThread : public juce::Thread {
public:
    explicit ReaderThread(std::shared_ptr<Ipc::CallbackState> state)
        : juce::Thread("mlh-ipc-reader"), state_(std::move(state)) {}

    void run() override
    {
        std::string line;
        while (!threadShouldExit() && std::getline(std::cin, line))
        {
            if (line.empty())
                continue;

            auto parsed = juce::JSON::parse(line);
            if (parsed.isVoid() || !parsed.isObject())
                continue;

            auto msg = parsed;
            // Dispatch onto the JUCE message thread so the engine core never
            // runs concurrently with the GUI/audio control path.
            const auto state = state_;
            juce::MessageManager::callAsync([state, msg]() mutable
            {
                if (state->active.load(std::memory_order_acquire) && state->handler)
                    state->handler(msg);
            });
        }

        // stdin reached EOF — the supervisor (Electron) is gone. Shut down
        // cleanly so we never leave an orphan native engine process behind.
        const auto state = state_;
        juce::MessageManager::callAsync([state]()
        {
            if (state->active.load(std::memory_order_acquire) && state->eofHandler)
                state->eofHandler();
        });
    }

private:
    std::shared_ptr<Ipc::CallbackState> state_;
};

} // namespace

Ipc::~Ipc()
{
    stop();
}

void Ipc::start(const Handler& handler, std::function<void()> eofHandler)
{
    handler_ = handler;
    callbackState_ = std::make_shared<CallbackState>();
    callbackState_->handler = handler_;
    callbackState_->eofHandler = std::move(eofHandler);
    reader_ = std::make_unique<ReaderThread>(callbackState_);
    reader_->startThread();
}

void Ipc::send(const juce::var& obj)
{
    // Stamp every outgoing message with the protocol version. The contract
    // documented in ipc.h always promised this field; it was never actually
    // written, so a peer had no way to detect a version mismatch.
    juce::var out = obj;
    if (auto* dyn = out.getDynamicObject())
        if (!dyn->hasProperty("v"))
            dyn->setProperty("v", kProtocolVersion);

    const juce::ScopedLock lock(writeLock_);
    // Single-line JSON so each stdout line is one complete message.
    std::cout << juce::JSON::toString(out, true).toStdString() << std::endl;
    std::cout.flush();
}

void Ipc::stop()
{
    if (callbackState_)
        callbackState_->active.store(false, std::memory_order_release);
    if (reader_)
    {
        reader_->signalThreadShouldExit();
        reader_->stopThread(2000);
        reader_.reset();
    }
    callbackState_.reset();
}

} // namespace mlh
