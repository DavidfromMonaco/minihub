#include "ipc.h"
#include "var_util.h"

#include <juce_events/juce_events.h>

#include <iostream>

namespace mlh {

namespace {

class ReaderThread : public juce::Thread {
public:
    explicit ReaderThread(Ipc::Handler handler)
        : juce::Thread("mlh-ipc-reader"), handler_(std::move(handler)) {}

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
            juce::MessageManager::callAsync([this, msg]() mutable
            {
                if (handler_)
                    handler_(msg);
            });
        }

        // stdin reached EOF — the supervisor (Electron) is gone. Shut down
        // cleanly so we never leave an orphan native engine process behind.
        juce::MessageManager::callAsync([]()
        {
            if (auto* app = juce::JUCEApplicationBase::getInstance())
                app->quit();
        });
    }

private:
    Ipc::Handler handler_;
};

} // namespace

Ipc::~Ipc()
{
    stop();
}

void Ipc::start(const Handler& handler)
{
    handler_ = handler;
    reader_ = std::make_unique<ReaderThread>(handler_);
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
    if (reader_)
    {
        reader_->signalThreadShouldExit();
        reader_->stopThread(2000);
        reader_.reset();
    }
}

} // namespace mlh
