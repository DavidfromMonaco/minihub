#include "engine.h"
#include "var_util.h"

#include <thread>

namespace mlh {

namespace {

constexpr const char* kWASAPILowLatencyType = "Windows Audio (Low Latency Mode)";

// Preallocated MIDI capacity so the audio callback never grows a MidiBuffer.
constexpr int kMidiBufferBytes = 8192;

juce::var makeError(const juce::String& code, const juce::String& message)
{
    juce::var out = makeObject();
    setProp(out, "type", "error");
    setProp(out, "code", code);
    setProp(out, "message", message);
    return out;
}

} // namespace

Engine::Engine(Ipc& ipc) : ipc_(ipc)
{
    deviceManager_.addAudioCallback(this);
}

Engine::~Engine()
{
    *alive_ = false;
    stopAudio();
    chains_.clear();
}

void Engine::stopAudio()
{
    // Detach the callback FIRST, then drop the chain array the callback reads.
    // Any chain/plugin destruction must happen strictly after this point.
    deviceManager_.removeAudioCallback(this);
    audioChainCount_.store(0, std::memory_order_release);
    deviceManager_.closeAudioDevice();
}

void Engine::handleCommand(const juce::var& msg)
{
    const juce::String type = msg["type"].toString();

    if (type == "hello") cmdHello(msg);
    else if (type == "listDevices") cmdListDevices(msg);
    else if (type == "selectDevice") cmdSelectDevice(msg);
    else if (type == "getDeviceState") cmdGetDeviceState(msg);
    else if (type == "scanVst3") cmdScanVst3(msg);
    else if (type == "listPlugins") cmdListPlugins(msg);
    else if (type == "createInstance") cmdCreateInstance(msg);
    else if (type == "removeInstance") cmdRemoveInstance(msg);
    else if (type == "reorderChain") cmdReorderChain(msg);
    else if (type == "setBypass") cmdSetBypass(msg);
    else if (type == "midi") cmdMidi(msg);
    else if (type == "setChainMidiEnabled") cmdSetChainMidiEnabled(msg);
    else if (type == "setChainOutputEnabled") cmdSetChainOutputEnabled(msg);
    else if (type == "openEditor") cmdOpenEditor(msg);
    else if (type == "closeEditor") cmdCloseEditor(msg);
    else if (type == "getState") cmdGetState(msg);
    else if (type == "setState") cmdSetState(msg);
    else if (type == "shutdown") cmdShutdown(msg);
    else
        sendError("unknown-command", "Unknown command type: " + type);
}

void Engine::sendStatus()
{
    juce::var out = makeObject();
    setProp(out, "type", "status");
    setProp(out, "engine",
            engineRunning_ ? "running" : (engineError_.isNotEmpty() ? "error" : "stopped"));
    setProp(out, "error", engineError_.isNotEmpty() ? engineError_ : juce::var());
    setProp(out, "scanning", scanning_);
    ipc_.send(out);
}

void Engine::sendError(const juce::String& code, const juce::String& message)
{
    ipc_.send(makeError(code, message));
}

void Engine::sendDeviceState()
{
    juce::var out = makeObject();
    setProp(out, "type", "deviceState");
    setProp(out, "running", engineRunning_);
    setProp(out, "device", currentOutputDevice_);
    setProp(out, "sampleRate", currentSampleRate_);
    setProp(out, "bufferSize", currentBlockSize_);
    setProp(out, "error", engineError_.isNotEmpty() ? engineError_ : juce::var());
    ipc_.send(out);
}

void Engine::sendChainChanged(const juce::String& chainId)
{
    Chain* chain = getChain(chainId);
    if (!chain)
        return;

    juce::var out = makeObject();
    setProp(out, "type", "chainChanged");
    setProp(out, "chainId", chainId);

    juce::Array<juce::var> instances;
    for (auto* p : chain->copyPlugins())
    {
        juce::var inst = makeObject();
        setProp(inst, "instanceId", p->instanceId());
        setProp(inst, "pluginId", p->pluginId());
        setProp(inst, "name", p->name());
        setProp(inst, "role", p->role());
        setProp(inst, "bypassed", p->bypassed());
        setProp(inst, "status", p->isReady() ? "ready" : "error");
        instances.add(inst);
    }
    setProp(out, "instances", instances);
    ipc_.send(out);
}

void Engine::sendInstanceStatus(const juce::String& chainId, PluginInstance* inst)
{
    juce::var out = makeObject();
    setProp(out, "type", "instanceStatus");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", inst->instanceId());
    setProp(out, "status", inst->isReady() ? "ready" : "error");
    setProp(out, "error", inst->isReady() ? juce::var() : inst->error());
    ipc_.send(out);
}

// ---- commands ----

void Engine::cmdHello(const juce::var& msg)
{
    juce::var out = makeObject();
    setProp(out, "type", "hello");
    setProp(out, "protocolVersion", kProtocolVersion);
    setProp(out, "engineVersion", "1.0.0");
    setProp(out, "juceVersion", juce::SystemStats::getJUCEVersion());
    setProp(out, "platform", "win-x64");
    ipc_.send(out);
}

void Engine::cmdListDevices(const juce::var& msg)
{
    juce::var out = makeObject();
    setProp(out, "type", "devices");

    juce::Array<juce::var> outputs;
    for (auto* type : deviceManager_.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        for (const auto& name : type->getDeviceNames(false))
        {
            juce::var dev = makeObject();
            setProp(dev, "name", name);
            setProp(dev, "type", type->getTypeName());
            setProp(dev, "isWASAPI", type->getTypeName() == kWASAPILowLatencyType);
            outputs.add(dev);
        }
    }
    setProp(out, "outputs", outputs);
    setProp(out, "current", currentOutputDevice_);
    ipc_.send(out);
}

void Engine::cmdSelectDevice(const juce::var& msg)
{
    const juce::var deviceVar = msg["device"];
    const juce::String deviceName = deviceVar.isObject() ? deviceVar["name"].toString() : juce::String();
    const double sampleRate = msg["sampleRate"].isDouble() ? static_cast<double>(msg["sampleRate"]) : 48000.0;
    const int bufferSize = msg["bufferSize"].isInt() ? static_cast<int>(msg["bufferSize"]) : 0;

    if (deviceName.isEmpty())
    {
        sendError("device-invalid", "No output device name provided");
        return;
    }

    juce::AudioIODeviceType* targetType = nullptr;
    for (auto* type : deviceManager_.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        if (type->getDeviceNames(false).contains(deviceName))
        {
            targetType = type;
            break;
        }
    }
    if (targetType == nullptr)
    {
        sendError("device-not-found", "Output device not found: " + deviceName);
        return;
    }

    deviceManager_.setCurrentAudioDeviceType(targetType->getTypeName(), true);

    juce::AudioDeviceManager::AudioDeviceSetup setup;
    setup.outputDeviceName = deviceName;
    setup.inputDeviceName = juce::String();
    setup.sampleRate = sampleRate;
    setup.bufferSize = bufferSize;
    setup.useDefaultInputChannels = true;
    setup.useDefaultOutputChannels = true;

    const juce::String err = deviceManager_.setAudioDeviceSetup(setup, true);
    if (err.isNotEmpty())
    {
        engineError_ = err;
        engineRunning_ = false;
        sendError("device-open", err);
        sendStatus();
        return;
    }

    currentOutputDevice_ = deviceName;
    engineRunning_ = true;
    engineError_.clear();
    sendDeviceState();
    sendStatus();
}

void Engine::cmdGetDeviceState(const juce::var& msg)
{
    sendDeviceState();
    sendStatus();
}

void Engine::sendPlugins()
{
    juce::var out = makeObject();
    setProp(out, "type", "plugins");
    juce::Array<juce::var> plugins;
    for (const auto& r : scanner_.records())
    {
        juce::var p = makeObject();
        setProp(p, "pluginId", r.pluginId);
        setProp(p, "name", r.name);
        setProp(p, "manufacturer", r.manufacturer);
        setProp(p, "category", r.category);
        setProp(p, "path", r.path);
        setProp(p, "isInstrument", r.isInstrument);
        setProp(p, "numInputChannels", r.numInputChannels);
        setProp(p, "numOutputChannels", r.numOutputChannels);
        setProp(p, "role", r.role);
        plugins.add(p);
    }
    setProp(out, "plugins", plugins);
    setProp(out, "count", static_cast<int>(plugins.size()));
    ipc_.send(out);
}

void Engine::cmdScanVst3(const juce::var& msg)
{
    // Scanning spawns one child process per .vst3 file and takes tens of
    // seconds. Running it inline blocked the message thread, which is also the
    // thread that opens plugin editors and services every other command - a
    // click on "Open Plugin" during a scan simply sat in the queue. Do the work
    // on a worker thread and install the result back on the message thread.
    if (scanning_)
    {
        sendError("scan-busy", "A VST3 scan is already running");
        return;
    }
    scanning_ = true;

    {
        juce::var out = makeObject();
        setProp(out, "type", "status");
        setProp(out, "engine", engineRunning_ ? "running" : "stopped");
        setProp(out, "scanning", true);
        ipc_.send(out);
    }

    auto alive = alive_;
    std::thread([this, alive]()
    {
        auto records = Vst3Scanner::scanAll();
        juce::MessageManager::callAsync([this, alive, records = std::move(records)]() mutable
        {
            if (!*alive)
                return;
            scanner_.setRecords(std::move(records));
            scanning_ = false;
            sendPlugins();
            sendStatus();
        });
    }).detach();
}

void Engine::cmdListPlugins(const juce::var& msg)
{
    sendPlugins();
}

Chain* Engine::getOrCreateChain(const juce::String& chainId)
{
    auto it = chains_.find(chainId);
    if (it != chains_.end())
        return it->second.get();

    const int count = audioChainCount_.load(std::memory_order_relaxed);
    if (count >= kMaxChains)
    {
        sendError("chain-limit", "Too many VST chains (max " + juce::String(kMaxChains) + ")");
        return nullptr;
    }

    auto chain = std::make_unique<Chain>(chainId);
    chain->prepareToPlay(currentSampleRate_, currentBlockSize_);
    Chain* raw = chain.get();
    chains_[chainId] = std::move(chain);

    // Publish to the audio thread last: the release store makes the fully
    // constructed chain visible before the callback can see the new count.
    audioChains_[static_cast<size_t>(count)] = raw;
    audioChainCount_.store(count + 1, std::memory_order_release);
    return raw;
}

Chain* Engine::getChain(const juce::String& chainId)
{
    auto it = chains_.find(chainId);
    return it == chains_.end() ? nullptr : it->second.get();
}

Chain* Engine::requireChain(const juce::String& chainId)
{
    Chain* chain = getChain(chainId);
    if (chain == nullptr)
        sendError("chain-not-found", "Unknown chain: " + chainId);
    return chain;
}

PluginInstance* Engine::lookupInstance(const juce::String& chainId,
                                       const juce::String& instanceId,
                                       juce::String& code,
                                       juce::String& message)
{
    Chain* chain = getChain(chainId);
    if (chain == nullptr)
    {
        code = "chain-not-found";
        message = "Unknown chain: " + chainId;
        return nullptr;
    }
    PluginInstance* inst = chain->find(instanceId);
    if (inst == nullptr)
    {
        code = "instance-not-found";
        message = "Unknown instance: " + instanceId;
        return nullptr;
    }
    return inst;
}

PluginInstance* Engine::requireInstance(const juce::String& chainId,
                                        const juce::String& instanceId)
{
    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr)
        sendError(code, message);
    return inst;
}

void Engine::cmdCreateInstance(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String pluginId = msg["pluginId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const int index = msg["index"].isInt() ? static_cast<int>(msg["index"]) : -1;

    if (chainId.isEmpty() || pluginId.isEmpty() || instanceId.isEmpty())
    {
        sendError("create-invalid", "chainId, pluginId and instanceId are required");
        return;
    }

    const PluginRecord* rec = scanner_.find(pluginId);
    if (rec == nullptr)
    {
        sendError("plugin-not-found", "Unknown plugin: " + pluginId);
        return;
    }

    Chain* chain = getOrCreateChain(chainId);
    if (chain == nullptr)
        return;

    // Creating an instance id that already exists replaces it. The renderer
    // rebuilds its chains after an engine restart or a renderer reload, and a
    // rebuild must never end up with two live plugins sharing one instanceId.
    if (chain->find(instanceId) != nullptr)
        chain->removePlugin(instanceId);

    // Report "loading" immediately, then "ready"/"error" after creation.
    {
        juce::var out = makeObject();
        setProp(out, "type", "instanceStatus");
        setProp(out, "chainId", chainId);
        setProp(out, "instanceId", instanceId);
        setProp(out, "status", "loading");
        ipc_.send(out);
    }

    // Copy the record so the background thread does not touch the registry.
    const PluginRecord recCopy = *rec;
    const double sr = currentSampleRate_;
    const int bs = currentBlockSize_;

    auto* inst = new PluginInstance();
    inst->setInstanceId(instanceId);
    auto alive = alive_;

    std::thread([this, alive, chainId, instanceId, recCopy, inst, index, sr, bs]()
    {
        juce::String error;
        const bool ok = inst->create(recCopy, sr, bs, error);

        juce::MessageManager::callAsync([this, alive, chainId, instanceId, inst, ok, error, index]()
        {
            // The engine may have been torn down while the plugin was loading.
            if (!*alive)
            {
                delete inst;
                return;
            }

            Chain* c = getChain(chainId);
            if (c == nullptr)
            {
                delete inst;
                return;
            }

            if (!ok)
            {
                sendError("plugin-load", "Failed to load '" + inst->name() + "': " + error);
                sendInstanceStatus(chainId, inst);
                delete inst;
                return;
            }

            inst->prepareToPlay(currentSampleRate_, currentBlockSize_);
            if (c->find(instanceId) != nullptr)
                c->removePlugin(instanceId);
            const juce::String name = inst->name();
            if (!c->insertPlugin(index, std::unique_ptr<PluginInstance>(inst)))
            {
                // `inst` has been destroyed by the failed insert - never touch
                // it again past this point.
                sendError("chain-full", "Chain '" + chainId + "' is full, dropped '" + name + "'");
                return;
            }
            sendChainChanged(chainId);
            sendInstanceStatus(chainId, inst);
        });
    }).detach();
}

void Engine::cmdRemoveInstance(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    if (requireInstance(chainId, instanceId) == nullptr)
        return;

    // The destructor closes the editor and releases the plugin; removePlugin
    // holds the chain lock across it so the audio thread is never inside the
    // plugin while it goes away.
    getChain(chainId)->removePlugin(instanceId);
    sendChainChanged(chainId);
}

void Engine::cmdReorderChain(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const int toIndex = msg["toIndex"].isInt() ? static_cast<int>(msg["toIndex"]) : 0;
    Chain* chain = requireChain(chainId);
    if (chain == nullptr)
        return;
    if (!chain->reorderPlugin(instanceId, toIndex))
    {
        sendError("instance-not-found", "Unknown instance: " + instanceId);
        return;
    }
    sendChainChanged(chainId);
}

void Engine::cmdSetBypass(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    const bool bypassed = msg["bypassed"].isBool() ? static_cast<bool>(msg["bypassed"]) : false;
    Chain* chain = requireChain(chainId);
    if (chain == nullptr)
        return;
    if (!chain->setPluginBypass(instanceId, bypassed))
    {
        sendError("instance-not-found", "Unknown instance: " + instanceId);
        return;
    }
    sendChainChanged(chainId);
}

void Engine::cmdMidi(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    Chain* chain = requireChain(chainId);
    if (chain == nullptr)
        return;
    // Only forward MIDI to chains that are MIDI-connected in the Hub graph.
    if (!chain->midiEnabled())
        return;

    const juce::var dataVar = msg["data"];
    const auto* arr = dataVar.getArray();
    if (arr == nullptr || arr->size() == 0)
        return;

    uint8_t bytes[3] = {};
    int n = 0;
    for (const auto& b : *arr)
    {
        if (n >= 3)
            break;
        bytes[n++] = static_cast<uint8_t>(static_cast<int>(b));
    }
    if (n == 0)
        return;

    juce::MidiBuffer buffer;
    buffer.addEvent(juce::MidiMessage(bytes, n, 0.0), 0);
    chain->pushMidi(buffer);
}

void Engine::cmdSetChainMidiEnabled(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const bool enabled = msg["enabled"].isBool() ? static_cast<bool>(msg["enabled"]) : false;
    Chain* chain = getOrCreateChain(chainId);
    if (chain == nullptr)
        return;
    chain->setMidiEnabled(enabled);
}

void Engine::cmdSetChainOutputEnabled(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const bool enabled = msg["enabled"].isBool() ? static_cast<bool>(msg["enabled"]) : false;
    Chain* chain = getOrCreateChain(chainId);
    if (chain == nullptr)
        return;
    chain->setOutputEnabled(enabled);
}

void Engine::cmdOpenEditor(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();

    juce::var out = makeObject();
    setProp(out, "type", "editorStatus");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);

    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr)
    {
        // Always answer the request: a silent failure leaves the UI showing
        // "opening editor..." forever.
        setProp(out, "open", false);
        setProp(out, "message", message);
        ipc_.send(out);
        sendError(code, message);
        return;
    }

    const bool ok = inst->openEditor(message);

    // Report what is actually on screen, not merely that the command ran.
    setProp(out, "open", ok && inst->editorVisible());
    setProp(out, "width", inst->editorWidth());
    setProp(out, "height", inst->editorHeight());
    if (!ok)
        setProp(out, "message", message.isNotEmpty() ? message : juce::String("editor could not be opened"));
    ipc_.send(out);

    if (!ok)
        sendError("editor-open", "Could not open the editor for '" + inst->name() + "': " + message);
}

void Engine::cmdCloseEditor(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    juce::String code, message;
    PluginInstance* inst = lookupInstance(chainId, instanceId, code, message);
    if (inst == nullptr)
        return; // closing something that is already gone is not an error

    inst->closeEditor();

    juce::var out = makeObject();
    setProp(out, "type", "editorStatus");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);
    setProp(out, "open", inst->editorVisible());
    ipc_.send(out);
}

void Engine::cmdGetState(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    PluginInstance* inst = requireInstance(chainId, instanceId);
    if (inst == nullptr)
        return;

    juce::var out = makeObject();
    setProp(out, "type", "pluginState");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);
    setProp(out, "state", inst->getState());
    ipc_.send(out);
}

void Engine::cmdSetState(const juce::var& msg)
{
    const juce::String chainId = msg["chainId"].toString();
    const juce::String instanceId = msg["instanceId"].toString();
    PluginInstance* inst = requireInstance(chainId, instanceId);
    if (inst == nullptr)
        return;

    juce::String error;
    if (!inst->setState(msg["state"], error))
    {
        sendError("state-invalid", error);
        return;
    }
    juce::var out = makeObject();
    setProp(out, "type", "stateApplied");
    setProp(out, "chainId", chainId);
    setProp(out, "instanceId", instanceId);
    ipc_.send(out);
}

void Engine::cmdShutdown(const juce::var& msg)
{
    // Stop the audio callback BEFORE destroying anything it touches, then close
    // all editors and release the chains; the process exits after the ack.
    stopAudio();
    chains_.clear();
    juce::var out = makeObject();
    setProp(out, "type", "shutdownAck");
    ipc_.send(out);
    juce::JUCEApplicationBase::getInstance()->quit();
}

// ---- AudioIODeviceCallback (real-time) ----

void Engine::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    // Called on the audio device thread, before streaming starts. Allocation is
    // allowed here; IPC and engine bookkeeping are marshalled to the message
    // thread so they never race with command handling.
    const double sr = device->getCurrentSampleRate();
    const int bs = device->getCurrentBufferSizeSamples();
    const juce::String name = device->getName();

    scratch_.setSize(2, bs);
    chainMidi_.ensureSize(kMidiBufferBytes);

    const int numChains = audioChainCount_.load(std::memory_order_acquire);
    for (int c = 0; c < numChains; ++c)
        audioChains_[static_cast<size_t>(c)]->prepareToPlay(sr, bs);

    auto alive = alive_;
    juce::MessageManager::callAsync([this, alive, sr, bs, name]()
    {
        if (!*alive)
            return;
        currentSampleRate_ = sr;
        currentBlockSize_ = bs;
        currentOutputDevice_ = name;
        engineRunning_ = true;
        engineError_.clear();
        sendDeviceState();
        sendStatus();
    });
}

void Engine::audioDeviceStopped()
{
    const int numChains = audioChainCount_.load(std::memory_order_acquire);
    for (int c = 0; c < numChains; ++c)
        audioChains_[static_cast<size_t>(c)]->reset();

    auto alive = alive_;
    juce::MessageManager::callAsync([this, alive]()
    {
        if (!*alive)
            return;
        engineRunning_ = false;
        sendDeviceState();
        sendStatus();
    });
}

void Engine::audioDeviceIOCallbackWithContext(const float* const* /*inputChannelData*/,
                                              int /*numInputChannels*/,
                                              float* const* outputChannelData,
                                              int numOutputChannels,
                                              int numSamples,
                                              const juce::AudioIODeviceCallbackContext& /*context*/)
{
    for (int ch = 0; ch < numOutputChannels; ++ch)
        juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);

    if (scratch_.getNumSamples() < numSamples || scratch_.getNumChannels() < 2)
        return;

    const int numChains = audioChainCount_.load(std::memory_order_acquire);
    for (int c = 0; c < numChains; ++c)
    {
        Chain& chain = *audioChains_[static_cast<size_t>(c)];
        if (!chain.outputEnabled())
            continue;

        // Reuse a single stereo scratch buffer across chains (sequential).
        juce::AudioBuffer<float> view(scratch_.getArrayOfWritePointers(), 2, 0, numSamples);
        view.clear();

        // Reused member buffer: clear() keeps capacity, so the callback never
        // allocates a MidiBuffer.
        chainMidi_.clear();
        chain.processBlock(view, chainMidi_);

        const int mix = std::min(2, numOutputChannels);
        for (int ch = 0; ch < mix; ++ch)
            juce::FloatVectorOperations::add(outputChannelData[ch], view.getReadPointer(ch), numSamples);
    }
}

} // namespace mlh
