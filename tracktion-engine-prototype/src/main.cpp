#ifndef NOMINMAX
 #define NOMINMAX
#endif

#include <JuceHeader.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <numeric>
#include <string>
#include <vector>

#if JUCE_WINDOWS
 #include <windows.h>
 #include <psapi.h>
#endif

namespace te = tracktion::engine;

namespace
{
constexpr double offlineSampleRate = 48000.0;
constexpr int offlineBlockSize = 512;
constexpr double arrangementSeconds = 4.0;

struct Options
{
    juce::File vst1 { R"(C:\Program Files\Common Files\VST3\Dexed.vst3)" };
    juce::File vst2 { R"(C:\Program Files\Common Files\VST3\Vital.vst3)" };
    juce::File outputDirectory { juce::File::getCurrentWorkingDirectory().getChildFile ("artifacts") };
    int cycles = 3;
    int sessionAuditHoldMs = 0;
};

struct AudioMetrics
{
    double peak = 0.0;
    double rms = 0.0;
    int64_t samples = 0;
    int64_t samplesAtOrAboveUnity = 0;
    int channels = 0;
    double sampleRate = 0.0;
};

struct LoadedAudio
{
    juce::AudioBuffer<float> buffer;
    double sampleRate = 0.0;
};

struct ResourceSnapshot
{
    uint64_t workingSetBytes = 0;
    uint32_t handleCount = 0;
};

double toDb (double linear)
{
    return linear > 0.0 ? 20.0 * std::log10 (linear) : -200.0;
}

void pumpMessages (int milliseconds)
{
    const auto end = juce::Time::getMillisecondCounterHiRes() + milliseconds;

    while (juce::Time::getMillisecondCounterHiRes() < end)
    {
        if (! juce::MessageManager::getInstance()->runDispatchLoopUntil (10))
            break;
    }
}

ResourceSnapshot readResources()
{
    ResourceSnapshot result;

   #if JUCE_WINDOWS
    PROCESS_MEMORY_COUNTERS_EX counters {};
    counters.cb = sizeof (counters);

    if (GetProcessMemoryInfo (GetCurrentProcess(),
                              reinterpret_cast<PROCESS_MEMORY_COUNTERS*> (&counters),
                              sizeof (counters)))
        result.workingSetBytes = static_cast<uint64_t> (counters.WorkingSetSize);

    DWORD handles = 0;
    if (GetProcessHandleCount (GetCurrentProcess(), &handles))
        result.handleCount = handles;
   #endif

    return result;
}

int currentProcessId()
{
   #if JUCE_WINDOWS
    return static_cast<int> (::GetCurrentProcessId());
   #else
    return 0;
   #endif
}

class PrototypePropertyStorage final : public te::PropertyStorage
{
public:
    explicit PrototypePropertyStorage (juce::File root)
        : PropertyStorage ("MiniHubTracktionPrototype"), storageRoot (std::move (root))
    {
        storageRoot.createDirectory();
    }

    juce::File getAppCacheFolder() override
    {
        auto folder = storageRoot.getChildFile ("engine-cache");
        folder.createDirectory();
        return folder;
    }

    juce::File getAppPrefsFolder() override
    {
        auto folder = storageRoot.getChildFile ("engine-prefs");
        folder.createDirectory();
        return folder;
    }

    void removeProperty (te::SettingID) override {}
    juce::var getProperty (te::SettingID, const juce::var& fallback) override { return fallback; }
    void setProperty (te::SettingID, const juce::var&) override {}
    std::unique_ptr<juce::XmlElement> getXmlProperty (te::SettingID) override { return {}; }
    void setXmlProperty (te::SettingID, const juce::XmlElement&) override {}
    void removePropertyItem (te::SettingID, juce::StringRef) override {}
    juce::var getPropertyItem (te::SettingID, juce::StringRef, const juce::var& fallback) override { return fallback; }
    void setPropertyItem (te::SettingID, juce::StringRef, const juce::var&) override {}
    std::unique_ptr<juce::XmlElement> getXmlPropertyItem (te::SettingID, juce::StringRef) override { return {}; }
    void setXmlPropertyItem (te::SettingID, juce::StringRef, const juce::XmlElement&) override {}

private:
    juce::File storageRoot;
};

class PrototypeEngineBehaviour final : public te::EngineBehaviour
{
public:
    bool autoInitialiseDeviceManager() override { return false; }
    bool shouldOpenAudioInputByDefault() override { return false; }
};

class PrototypeUIBehaviour final : public te::UIBehaviour
{
public:
    void runTaskWithProgressBar (te::ThreadPoolJobWithProgress& task) override
    {
        TaskRunner runner (task);

        while (runner.isThreadRunning())
            if (! juce::MessageManager::getInstance()->runDispatchLoopUntil (10))
                break;
    }

    void showWarningMessage (const juce::String& message) override
    {
        std::cerr << "Tracktion warning: " << message << '\n';
    }

    void showWarningAlert (const juce::String& title, const juce::String& message) override
    {
        std::cerr << title << ": " << message << '\n';
    }

private:
    struct TaskRunner final : juce::Thread
    {
        explicit TaskRunner (te::ThreadPoolJobWithProgress& t)
            : juce::Thread (t.getJobName()), task (t)
        {
            startThread();
        }

        ~TaskRunner() override
        {
            task.signalJobShouldExit();
            waitForThreadToExit (10000);
        }

        void run() override
        {
            while (! threadShouldExit())
                if (task.runJob() == juce::ThreadPoolJob::jobHasFinished)
                    break;
        }

        te::ThreadPoolJobWithProgress& task;
    };
};

class MasterCaptureProcessor final : public juce::AudioProcessor
{
public:
    MasterCaptureProcessor()
        : AudioProcessor (BusesProperties()
                              .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                              .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
    {
    }

    const juce::String getName() const override { return "Non-mutating master capture"; }

    void prepareToPlay (double newSampleRate, int) override
    {
        sampleRate.store (newSampleRate);
        const auto capacity = static_cast<size_t> (std::max (1.0, newSampleRate) * 20.0 * 2.0);
        storage.assign (capacity, 0.0f);
        writeSamples.store (0);
    }

    void releaseResources() override {}

    bool isBusesLayoutSupported (const BusesLayout& layout) const override
    {
        return layout.getMainOutputChannelSet() == layout.getMainInputChannelSet()
            && ! layout.getMainOutputChannelSet().isDisabled();
    }

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        if (! capturing.load (std::memory_order_relaxed))
            return;

        const auto channels = std::min (2, buffer.getNumChannels());
        auto position = writeSamples.load (std::memory_order_relaxed);

        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
        {
            for (int channel = 0; channel < channels; ++channel)
            {
                if (position >= storage.size())
                {
                    overflowed.store (true, std::memory_order_relaxed);
                    return;
                }

                storage[position++] = buffer.getSample (channel, sample);
            }
        }

        capturedChannels.store (channels, std::memory_order_relaxed);
        writeSamples.store (position, std::memory_order_release);
        callbackCount.fetch_add (1, std::memory_order_relaxed);
    }

    void beginCapture()
    {
        writeSamples.store (0);
        callbackCount.store (0);
        capturedChannels.store (0);
        overflowed.store (false);
        capturing.store (true, std::memory_order_release);
    }

    AudioMetrics endCapture()
    {
        capturing.store (false, std::memory_order_release);

        AudioMetrics result;
        result.channels = capturedChannels.load();
        result.sampleRate = sampleRate.load();
        result.samples = static_cast<int64_t> (writeSamples.load());
        long double sumSquares = 0.0;

        for (size_t i = 0; i < writeSamples.load(); ++i)
        {
            const auto value = static_cast<double> (storage[i]);
            result.peak = std::max (result.peak, std::abs (value));
            sumSquares += value * value;
            if (std::abs (value) >= 1.0)
                ++result.samplesAtOrAboveUnity;
        }

        if (result.samples > 0)
            result.rms = std::sqrt (static_cast<double> (sumSquares / result.samples));

        return result;
    }

    uint64_t getCallbackCount() const { return callbackCount.load(); }
    bool didOverflow() const { return overflowed.load(); }

    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock&) override {}
    void setStateInformation (const void*, int) override {}

private:
    std::vector<float> storage;
    std::atomic<size_t> writeSamples { 0 };
    std::atomic<uint64_t> callbackCount { 0 };
    std::atomic<int> capturedChannels { 0 };
    std::atomic<double> sampleRate { 0.0 };
    std::atomic<bool> capturing { false };
    std::atomic<bool> overflowed { false };
};

class MeterTap
{
public:
    explicit MeterTap (te::LevelMeterPlugin& plugin) : meter (plugin.measurer)
    {
        meter.setMode (te::LevelMeasurer::peakMode);
        meter.addClient (client);
    }

    ~MeterTap() { meter.removeClient (client); }

    double pollPeakDb()
    {
        double result = -200.0;
        const auto channels = std::max (2, client.getNumChannelsUsed());

        for (int channel = 0; channel < channels; ++channel)
            result = std::max (result, static_cast<double> (client.getAndClearAudioLevel (channel).dB));

        peakDb = std::max (peakDb, result);
        if (result > -80.0)
            ++activePolls;
        ++polls;
        return result;
    }

    double peakDb = -200.0;
    int activePolls = 0;
    int polls = 0;

private:
    te::LevelMeasurer& meter;
    te::LevelMeasurer::Client client;
};

juce::PluginDescription scanVst3 (te::Engine& engine, const juce::File& file)
{
    if (! file.exists())
        throw std::runtime_error ("VST3 path does not exist: " + file.getFullPathName().toStdString());

    juce::AudioPluginFormat* format = nullptr;

    for (auto* candidate : engine.getPluginManager().pluginFormatManager.getFormats())
        if (candidate != nullptr && candidate->getName() == "VST3")
            format = candidate;
    if (format == nullptr)
        throw std::runtime_error ("JUCE VST3 host format is not available");

    juce::OwnedArray<juce::PluginDescription> descriptions;
    format->findAllTypesForFile (descriptions, file.getFullPathName());

    if (descriptions.isEmpty())
        throw std::runtime_error ("No VST3 type was discovered in: " + file.getFullPathName().toStdString());

    auto* selected = descriptions[0];
    for (auto* candidate : descriptions)
        if (candidate->isInstrument)
            selected = candidate;

    engine.getPluginManager().knownPluginList.addType (*selected);
    return *selected;
}

te::MidiClip& addMidiClip (te::AudioTrack& track, int midiChannel, int baseNote)
{
    const tracktion::TimeRange range { tracktion::TimePosition::fromSeconds (0.0),
                                      tracktion::TimePosition::fromSeconds (arrangementSeconds) };
    auto* clip = dynamic_cast<te::MidiClip*> (
        track.insertNewClip (te::TrackItem::Type::midi, "Prototype MIDI", range, nullptr));

    if (clip == nullptr)
        throw std::runtime_error ("Tracktion could not create a MIDI clip");

    clip->setMidiChannel (te::MidiChannel (midiChannel));
    auto& sequence = clip->getSequence();

    for (int step = 0; step < 8; ++step)
    {
        const auto pitch = baseNote + ((step % 2) * 7);
        sequence.addNote (pitch,
                          tracktion::BeatPosition::fromBeats (step),
                          tracktion::BeatDuration::fromBeats (0.9),
                          96,
                          0,
                          &track.edit.getUndoManager());
    }

    return *clip;
}

te::ExternalPlugin& addVst3 (te::Edit& edit,
                             te::AudioTrack& track,
                             const juce::PluginDescription& description)
{
    auto plugin = edit.getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, description);
    auto* external = dynamic_cast<te::ExternalPlugin*> (plugin.get());

    if (external == nullptr)
        throw std::runtime_error ("Tracktion did not create an ExternalPlugin wrapper");

    track.pluginList.insertPlugin (plugin, 0, nullptr);
    pumpMessages (100);

    if (external->getWrappedAudioProcessor() == nullptr)
        throw std::runtime_error (("VST3 load failed: " + external->getLoadError()).toStdString());

    return *external;
}

std::unique_ptr<LoadedAudio> loadAudio (const juce::File& file)
{
    juce::AudioFormatManager manager;
    manager.registerBasicFormats();
    auto reader = std::unique_ptr<juce::AudioFormatReader> (manager.createReaderFor (file));

    if (reader == nullptr || reader->lengthInSamples <= 0
        || reader->lengthInSamples > std::numeric_limits<int>::max())
        return {};

    auto result = std::make_unique<LoadedAudio>();
    result->sampleRate = reader->sampleRate;
    result->buffer.setSize (static_cast<int> (reader->numChannels),
                            static_cast<int> (reader->lengthInSamples));
    if (! reader->read (&result->buffer, 0, result->buffer.getNumSamples(), 0, true, true))
        return {};

    return result;
}

AudioMetrics measure (const LoadedAudio& audio)
{
    AudioMetrics result;
    result.channels = audio.buffer.getNumChannels();
    result.sampleRate = audio.sampleRate;
    result.samples = static_cast<int64_t> (audio.buffer.getNumChannels()) * audio.buffer.getNumSamples();
    long double sumSquares = 0.0;

    for (int channel = 0; channel < audio.buffer.getNumChannels(); ++channel)
    {
        auto* samples = audio.buffer.getReadPointer (channel);
        for (int i = 0; i < audio.buffer.getNumSamples(); ++i)
        {
            const auto value = static_cast<double> (samples[i]);
            result.peak = std::max (result.peak, std::abs (value));
            sumSquares += value * value;
            if (std::abs (value) >= 1.0)
                ++result.samplesAtOrAboveUnity;
        }
    }

    if (result.samples > 0)
        result.rms = std::sqrt (static_cast<double> (sumSquares / result.samples));

    return result;
}

struct Comparison
{
    double maxAbsoluteError = 0.0;
    double rmsError = 0.0;
    bool shapeMatches = false;
};

Comparison compare (const LoadedAudio& actual,
                    const LoadedAudio& left,
                    const LoadedAudio* right = nullptr)
{
    Comparison result;
    result.shapeMatches = actual.sampleRate == left.sampleRate
                       && actual.buffer.getNumChannels() == left.buffer.getNumChannels()
                       && actual.buffer.getNumSamples() == left.buffer.getNumSamples()
                       && (right == nullptr
                           || (right->sampleRate == left.sampleRate
                               && right->buffer.getNumChannels() == left.buffer.getNumChannels()
                               && right->buffer.getNumSamples() == left.buffer.getNumSamples()));

    if (! result.shapeMatches)
        return result;

    long double sumSquares = 0.0;
    int64_t count = 0;

    for (int channel = 0; channel < actual.buffer.getNumChannels(); ++channel)
    {
        for (int sample = 0; sample < actual.buffer.getNumSamples(); ++sample)
        {
            auto expected = static_cast<double> (left.buffer.getSample (channel, sample));
            if (right != nullptr)
                expected += static_cast<double> (right->buffer.getSample (channel, sample));
            const auto error = static_cast<double> (actual.buffer.getSample (channel, sample)) - expected;
            result.maxAbsoluteError = std::max (result.maxAbsoluteError, std::abs (error));
            sumSquares += error * error;
            ++count;
        }
    }

    if (count > 0)
        result.rmsError = std::sqrt (static_cast<double> (sumSquares / count));

    return result;
}

juce::var metricsToVar (const AudioMetrics& metrics)
{
    auto object = new juce::DynamicObject();
    object->setProperty ("peakLinear", metrics.peak);
    object->setProperty ("peakDbFS", toDb (metrics.peak));
    object->setProperty ("rmsLinear", metrics.rms);
    object->setProperty ("rmsDbFS", toDb (metrics.rms));
    object->setProperty ("sampleValues", static_cast<double> (metrics.samples));
    object->setProperty ("samplesAtOrAboveUnity", static_cast<double> (metrics.samplesAtOrAboveUnity));
    object->setProperty ("channels", metrics.channels);
    object->setProperty ("sampleRate", metrics.sampleRate);
    return juce::var (object);
}

class ResultRecorder
{
public:
    explicit ResultRecorder (juce::DynamicObject& destination) : root (destination) {}

    void check (const juce::String& name, bool pass, const juce::String& detail)
    {
        auto object = new juce::DynamicObject();
        object->setProperty ("name", name);
        object->setProperty ("pass", pass);
        object->setProperty ("detail", detail);
        checks.add (juce::var (object));
        allPassed = allPassed && pass;
        std::cout << (pass ? "PASS " : "FAIL ") << name << " - " << detail << '\n';
    }

    void finish()
    {
        root.setProperty ("checks", juce::var (checks));
        root.setProperty ("technicalPass", allPassed);
    }

    bool passed() const { return allPassed; }

private:
    juce::DynamicObject& root;
    juce::Array<juce::var> checks;
    bool allPassed = true;
};

bool render (te::Engine& engine,
             te::Edit& edit,
             const juce::File& file,
             const juce::Array<te::Track*>& tracks)
{
    file.deleteFile();
    te::Renderer::Parameters params (edit);
    params.destFile = file;
    params.audioFormat = engine.getAudioFileFormatManager().getWavFormat();
    params.bitDepth = 32;
    params.blockSizeForAudio = offlineBlockSize;
    params.sampleRateForAudio = offlineSampleRate;
    params.time = { tracktion::TimePosition::fromSeconds (0.0),
                    tracktion::TimePosition::fromSeconds (arrangementSeconds) };
    // Tracktion develop 494e91d currently has a defect in toBitSet(Array<Track*>):
    // it sets every track bit instead of testing membership in `tracks`.
    // Build the documented Renderer::Parameters mask directly until upstream fixes it.
    const auto allTracks = te::getAllTracks (edit);
    for (auto* track : tracks)
        if (const auto index = allTracks.indexOf (track); index >= 0)
            params.tracksToDo.setBit (index);
    params.usePlugins = true;
    params.useMasterPlugins = true;
    params.realTimeRender = false;
    params.shouldNormalise = false;
    params.ditheringEnabled = false;
    params.canRenderInMono = false;
    params.checkNodesForAudio = true;

    return te::Renderer::renderToFile ("MiniHub Tracktion offline probe", params) == file;
}

bool writeTestTone (const juce::File& file, double frequency, float amplitude)
{
    file.deleteFile();
    auto stream = std::unique_ptr<juce::FileOutputStream> (file.createOutputStream());
    if (stream == nullptr)
        return false;

    juce::WavAudioFormat format;
    const auto writerOptions = juce::AudioFormatWriterOptions {}
        .withSampleRate (offlineSampleRate)
        .withNumChannels (2)
        .withBitsPerSample (32)
        .withSampleFormat (juce::AudioFormatWriterOptions::SampleFormat::floatingPoint);
    auto output = std::unique_ptr<juce::OutputStream> (stream.release());
    auto writer = format.createWriterFor (output, writerOptions);
    if (writer == nullptr)
        return false;

    const auto samples = static_cast<int> (offlineSampleRate * arrangementSeconds);
    juce::AudioBuffer<float> buffer (2, samples);
    for (int sample = 0; sample < samples; ++sample)
    {
        const auto value = amplitude * static_cast<float> (
            std::sin (juce::MathConstants<double>::twoPi * frequency * sample / offlineSampleRate));
        buffer.setSample (0, sample, value);
        buffer.setSample (1, sample, value);
    }

    return writer->writeFromAudioSampleBuffer (buffer, 0, samples);
}

Options parseOptions (int argc, char** argv)
{
    Options options;

    for (int i = 1; i < argc; ++i)
    {
        const juce::String argument (argv[i]);
        auto next = [&]() -> juce::String
        {
            if (i + 1 >= argc)
                throw std::runtime_error ("Missing value after " + argument.toStdString());
            return juce::String (argv[++i]);
        };

        if (argument == "--vst1")
            options.vst1 = juce::File (next());
        else if (argument == "--vst2")
            options.vst2 = juce::File (next());
        else if (argument == "--output")
            options.outputDirectory = juce::File (next());
        else if (argument == "--cycles")
            options.cycles = std::max (1, next().getIntValue());
        else if (argument == "--session-audit-hold-ms")
            options.sessionAuditHoldMs = std::max (0, next().getIntValue());
        else if (argument == "--help")
        {
            std::cout << "minihub_tracktion_probe [--vst1 path] [--vst2 path] "
                         "[--output directory] [--cycles n] [--session-audit-hold-ms n]\n";
            std::exit (0);
        }
        else
            throw std::runtime_error ("Unknown argument: " + argument.toStdString());
    }

    return options;
}

struct CycleContext
{
    std::unique_ptr<te::Edit> edit;
    te::AudioTrack* track1 = nullptr;
    te::AudioTrack* track2 = nullptr;
    te::ExternalPlugin* plugin1 = nullptr;
    te::ExternalPlugin* plugin2 = nullptr;
    te::LevelMeterPlugin* masterMeter = nullptr;
};

CycleContext createCycle (te::Engine& engine,
                          const juce::PluginDescription& plugin1,
                          const juce::PluginDescription& plugin2)
{
    CycleContext context;
    context.edit = std::make_unique<te::Edit> (engine, te::Edit::EditRole::forEditing);
    context.edit->ensureNumberOfAudioTracks (2);
    auto tracks = te::getAudioTracks (*context.edit);

    if (tracks.size() != 2)
        throw std::runtime_error ("Tracktion did not create exactly two audio tracks");

    context.track1 = tracks[0];
    context.track2 = tracks[1];
    context.track1->setName ("Track 1 - " + plugin1.name);
    context.track2->setName ("Track 2 - " + plugin2.name);
    context.track1->getOutput().setOutputToDefaultDevice (false);
    context.track2->getOutput().setOutputToDefaultDevice (false);
    context.track1->getVolumePlugin()->setVolumeDb (0.0f);
    context.track2->getVolumePlugin()->setVolumeDb (0.0f);
    context.edit->getMasterVolumePlugin()->setVolumeDb (0.0f);

    addMidiClip (*context.track1, 1, 48);
    addMidiClip (*context.track2, 2, 72);
    context.plugin1 = &addVst3 (*context.edit, *context.track1, plugin1);
    context.plugin2 = &addVst3 (*context.edit, *context.track2, plugin2);

    auto masterMeter = context.edit->getPluginCache().createNewPlugin (te::LevelMeterPlugin::xmlTypeName, {});
    context.masterMeter = dynamic_cast<te::LevelMeterPlugin*> (masterMeter.get());
    if (context.masterMeter == nullptr)
        throw std::runtime_error ("Could not create the master level meter");
    context.edit->getMasterPluginList().insertPlugin (masterMeter,
                                                      context.edit->getMasterPluginList().size(),
                                                      nullptr);

    auto& transport = context.edit->getTransport();
    transport.setLoopRange ({ tracktion::TimePosition::fromSeconds (0.0),
                              tracktion::TimePosition::fromSeconds (arrangementSeconds) });
    transport.looping = true;
    transport.setPosition (tracktion::TimePosition::fromSeconds (0.0));
    context.edit->tempoSequence.getTempo (0)->setBpm (120.0);
    context.edit->setLatencyCompensationEnabled (true);
    pumpMessages (200);
    return context;
}

int runProbe (const Options& options)
{
    options.outputDirectory.createDirectory();
    auto rootObject = new juce::DynamicObject();
    juce::var root (rootObject);
    ResultRecorder recorder (*rootObject);

    rootObject->setProperty ("schema", "minihub-tracktion-prototype/v1");
    rootObject->setProperty ("capturedAt", juce::Time::getCurrentTime().toISO8601 (true));
    rootObject->setProperty ("processId", currentProcessId());

    auto versions = new juce::DynamicObject();
    versions->setProperty ("tracktionSourceVersion", MINIHUB_TE_SOURCE_VERSION);
    versions->setProperty ("tracktionRuntimeVersionString", te::Engine::getVersion());
    versions->setProperty ("tracktionGitRevision", MINIHUB_TE_GIT_REVISION);
    versions->setProperty ("juceVersion", juce::SystemStats::getJUCEVersion());
    versions->setProperty ("juceGitRevision", MINIHUB_JUCE_GIT_REVISION);
    rootObject->setProperty ("versions", juce::var (versions));

    te::Engine engine (std::make_unique<PrototypePropertyStorage> (
                           options.outputDirectory.getChildFile ("isolated-state")),
                       std::make_unique<PrototypeUIBehaviour>(),
                       std::make_unique<PrototypeEngineBehaviour>());

    auto& deviceLayer = engine.getDeviceManager();
    deviceLayer.initialise (0, 2);
    pumpMessages (500);

    auto& juceDeviceManager = deviceLayer.deviceManager;
    if (juceDeviceManager.getCurrentAudioDeviceType() != "Windows Audio")
    {
        juceDeviceManager.setCurrentAudioDeviceType ("Windows Audio", true);
        pumpMessages (500);
    }

    auto* audioDevice = juceDeviceManager.getCurrentAudioDevice();
    recorder.check ("Windows shared audio device opened",
                    audioDevice != nullptr && juceDeviceManager.getCurrentAudioDeviceType() == "Windows Audio",
                    audioDevice != nullptr
                        ? juceDeviceManager.getCurrentAudioDeviceType() + " / " + audioDevice->getName()
                        : "no current audio device");

    if (audioDevice == nullptr)
        throw std::runtime_error ("A Windows shared audio output device is required for the real-time tests");

    auto deviceObject = new juce::DynamicObject();
    deviceObject->setProperty ("backend", juceDeviceManager.getCurrentAudioDeviceType());
    deviceObject->setProperty ("name", audioDevice->getName());
    deviceObject->setProperty ("typeName", audioDevice->getTypeName());
    deviceObject->setProperty ("sampleRate", audioDevice->getCurrentSampleRate());
    deviceObject->setProperty ("bufferSize", audioDevice->getCurrentBufferSizeSamples());
    deviceObject->setProperty ("outputLatencySamples", audioDevice->getOutputLatencyInSamples());
    deviceObject->setProperty ("engineInstances", te::Engine::getEngines().size());
    deviceObject->setProperty ("audioDeviceManagerInstances", 1);
    deviceObject->setProperty ("exclusiveMode", false);
    rootObject->setProperty ("device", juce::var (deviceObject));

    recorder.check ("Exactly one Tracktion Engine instance",
                    te::Engine::getEngines().size() == 1,
                    juce::String (te::Engine::getEngines().size()) + " instance(s)");

    deviceLayer.enableOutputClipping (false);
    auto captureProcessor = std::make_unique<MasterCaptureProcessor>();
    auto* capture = captureProcessor.get();
    deviceLayer.setGlobalOutputAudioProcessor (std::move (captureProcessor));

    const auto plugin1Description = scanVst3 (engine, options.vst1);
    const auto plugin2Description = scanVst3 (engine, options.vst2);

    auto plugins = new juce::DynamicObject();
    plugins->setProperty ("track1Name", plugin1Description.name);
    plugins->setProperty ("track1Manufacturer", plugin1Description.manufacturerName);
    plugins->setProperty ("track1Path", options.vst1.getFullPathName());
    plugins->setProperty ("track1IsInstrument", plugin1Description.isInstrument);
    plugins->setProperty ("track2Name", plugin2Description.name);
    plugins->setProperty ("track2Manufacturer", plugin2Description.manufacturerName);
    plugins->setProperty ("track2Path", options.vst2.getFullPathName());
    plugins->setProperty ("track2IsInstrument", plugin2Description.isInstrument);
    rootObject->setProperty ("plugins", juce::var (plugins));

    recorder.check ("Two different VST3 types discovered",
                    plugin1Description.createIdentifierString() != plugin2Description.createIdentifierString(),
                    plugin1Description.name + " + " + plugin2Description.name);
    recorder.check ("Both VST3s are instruments",
                    plugin1Description.isInstrument && plugin2Description.isInstrument,
                    "instrument flags: " + juce::String (plugin1Description.isInstrument ? "true" : "false")
                        + ", " + juce::String (plugin2Description.isInstrument ? "true" : "false"));

    const auto baselineResources = readResources();
    juce::Array<juce::var> cycleResults;
    std::unique_ptr<CycleContext> finalCycle;
    AudioMetrics firstRealtimeMetrics;
    double firstTrack1MeterDb = -200.0;
    double firstTrack2MeterDb = -200.0;
    double firstMasterMeterDb = -200.0;
    juce::File masterFile, track1File, track2File, repeatedMasterFile;

    std::cout << "TRACE session Edit create begin\n";
    auto cycle = std::make_unique<CycleContext> (
        createCycle (engine, plugin1Description, plugin2Description));
    std::cout << "TRACE session Edit create done\n";
    auto track1Meter = std::make_unique<MeterTap> (*cycle->track1->getLevelMeterPlugin());
    auto track2Meter = std::make_unique<MeterTap> (*cycle->track2->getLevelMeterPlugin());
    auto masterMeter = std::make_unique<MeterTap> (*cycle->masterMeter);

    for (int cycleIndex = 0; cycleIndex < options.cycles; ++cycleIndex)
    {
        auto& transport = cycle->edit->getTransport();
        cycle->edit->tempoSequence.getTempo (0)->setBpm (120.0);

        recorder.check ("Cycle " + juce::String (cycleIndex + 1) + ": independent tracks and clips",
                        cycle->track1 != cycle->track2
                            && cycle->track1->getClips().size() == 1
                            && cycle->track2->getClips().size() == 1
                            && cycle->plugin1 != cycle->plugin2,
                        "2 Track objects, 2 MIDI clips, 2 ExternalPlugin wrappers");

        if (cycleIndex == 0 && options.sessionAuditHoldMs > 0)
        {
            std::cout << "SESSION_AUDIT_READY pid=" << currentProcessId()
                      << " holdMs=" << options.sessionAuditHoldMs << '\n' << std::flush;
            transport.playFromStart (true);
            const auto holdEnd = juce::Time::getMillisecondCounterHiRes() + options.sessionAuditHoldMs;
            while (juce::Time::getMillisecondCounterHiRes() < holdEnd)
            {
                pumpMessages (25);
                track1Meter->pollPeakDb();
                track2Meter->pollPeakDb();
                masterMeter->pollPeakDb();
            }
            transport.stop (false, false);
            transport.setPosition (tracktion::TimePosition::fromSeconds (0.0));
        }

        capture->beginCapture();
        transport.playFromStart (true);
        const auto firstPlayEnd = juce::Time::getMillisecondCounterHiRes() + 1200.0;
        while (juce::Time::getMillisecondCounterHiRes() < firstPlayEnd)
        {
            pumpMessages (20);
            track1Meter->pollPeakDb();
            track2Meter->pollPeakDb();
            masterMeter->pollPeakDb();
        }
        const auto firstPosition = transport.getPosition().inSeconds();
        transport.stop (false, false);
        pumpMessages (100);

        const auto stoppedAfterFirstPlay = ! transport.isPlaying();
        transport.setPosition (tracktion::TimePosition::fromSeconds (0.0));
        const auto resetPosition = transport.getPosition().inSeconds();
        transport.play (false);
        pumpMessages (450);
        cycle->edit->tempoSequence.getTempo (0)->setBpm (132.0);
        pumpMessages (650);
        const auto secondPosition = transport.getPosition().inSeconds();
        const auto stillPlayingAfterTempo = transport.isPlaying();
        transport.stop (false, false);
        auto realtimeMetrics = capture->endCapture();

        recorder.check ("Cycle " + juce::String (cycleIndex + 1) + ": Play/Stop/reset/replay",
                        firstPosition > 0.5 && stoppedAfterFirstPlay
                            && std::abs (resetPosition) < 0.05 && secondPosition > 0.5,
                        "first=" + juce::String (firstPosition, 3)
                            + "s reset=" + juce::String (resetPosition, 3)
                            + "s replay=" + juce::String (secondPosition, 3) + "s");
        recorder.check ("Cycle " + juce::String (cycleIndex + 1) + ": tempo change retained transport",
                        stillPlayingAfterTempo
                            && std::abs (cycle->edit->tempoSequence.getTempo (0)->getBpm() - 132.0) < 0.01,
                        "tempo=" + juce::String (cycle->edit->tempoSequence.getTempo (0)->getBpm(), 1));
        recorder.check ("Cycle " + juce::String (cycleIndex + 1) + ": both tracks audible simultaneously",
                        track1Meter->peakDb > -80.0 && track2Meter->peakDb > -80.0
                            && masterMeter->peakDb > -80.0 && realtimeMetrics.peak > 0.0001,
                        "track1=" + juce::String (track1Meter->peakDb, 2)
                            + " dBFS track2=" + juce::String (track2Meter->peakDb, 2)
                            + " dBFS master=" + juce::String (masterMeter->peakDb, 2)
                            + " dBFS capture=" + juce::String (toDb (realtimeMetrics.peak), 2) + " dBFS");
        recorder.check ("Cycle " + juce::String (cycleIndex + 1) + ": real-time output not clipped by host",
                        realtimeMetrics.samplesAtOrAboveUnity == 0
                            && ! deviceLayer.hasOutputClipped (true)
                            && ! capture->didOverflow(),
                        juce::String (realtimeMetrics.samplesAtOrAboveUnity)
                            + " captured sample value(s) >= unity; host clipping disabled");

        const auto suffix = cycleIndex == 0 ? juce::String() : "-cycle-" + juce::String (cycleIndex + 1);
        masterFile = options.outputDirectory.getChildFile ("master" + suffix + ".wav");
        track1File = options.outputDirectory.getChildFile ("track-1" + suffix + ".wav");
        track2File = options.outputDirectory.getChildFile ("track-2" + suffix + ".wav");
        const auto renderStart = juce::Time::getMillisecondCounterHiRes();
        const auto masterRendered = render (engine, *cycle->edit, masterFile,
                                            { cycle->track1, cycle->track2 });
        const auto track1Rendered = render (engine, *cycle->edit, track1File, { cycle->track1 });
        const auto track2Rendered = render (engine, *cycle->edit, track2File, { cycle->track2 });
        const auto renderElapsedMs = juce::Time::getMillisecondCounterHiRes() - renderStart;

        recorder.check ("Cycle " + juce::String (cycleIndex + 1) + ": master and stems rendered offline",
                        masterRendered && track1Rendered && track2Rendered,
                        "3 WAV files in " + juce::String (renderElapsedMs, 1) + " ms");
        recorder.check ("Cycle " + juce::String (cycleIndex + 1) + ": export faster than real time",
                        renderElapsedMs < arrangementSeconds * 3.0 * 1000.0,
                        juce::String (renderElapsedMs, 1) + " ms for 12 seconds of output");

        transport.setPosition (tracktion::TimePosition::fromSeconds (0.0));
        transport.play (false);
        pumpMessages (500);
        const auto recoveredAfterExport = transport.isPlaying();
        transport.stop (false, false);
        recorder.check ("Cycle " + juce::String (cycleIndex + 1) + ": transport recovered after export",
                        recoveredAfterExport && ! transport.isPlaying(),
                        "Play succeeded after offline graph teardown");

        auto cycleObject = new juce::DynamicObject();
        cycleObject->setProperty ("cycle", cycleIndex + 1);
        cycleObject->setProperty ("track1PeakDbFS", track1Meter->peakDb);
        cycleObject->setProperty ("track2PeakDbFS", track2Meter->peakDb);
        cycleObject->setProperty ("masterMeterPeakDbFS", masterMeter->peakDb);
        cycleObject->setProperty ("realtimeMaster", metricsToVar (realtimeMetrics));
        cycleObject->setProperty ("renderElapsedMs", renderElapsedMs);
        const auto resources = readResources();
        cycleObject->setProperty ("workingSetBytes", static_cast<double> (resources.workingSetBytes));
        cycleObject->setProperty ("handleCount", static_cast<int> (resources.handleCount));
        cycleResults.add (juce::var (cycleObject));

        if (cycleIndex == 0)
        {
            firstRealtimeMetrics = realtimeMetrics;
            firstTrack1MeterDb = track1Meter->peakDb;
            firstTrack2MeterDb = track2Meter->peakDb;
            firstMasterMeterDb = masterMeter->peakDb;
        }

    }

    // A DAW session owns one long-lived Edit. Test cycles exercise repeated
    // playback/export on that same session, matching the proposed MiniHub host.
    track1Meter.reset();
    track2Meter.reset();
    masterMeter.reset();
    finalCycle = std::move (cycle);
    std::cout << "TRACE stability cycles complete; meter clients removed\n";

    rootObject->setProperty ("cycles", juce::var (cycleResults));

    // Use deterministic audio clips to distinguish Tracktion's summing maths
    // from any oscillator/random state internal to third-party instruments.
    auto summationEdit = std::make_unique<te::Edit> (engine, te::Edit::EditRole::forEditing);
    summationEdit->ensureNumberOfAudioTracks (2);
    auto summationTracks = te::getAudioTracks (*summationEdit);
    const auto tone1File = options.outputDirectory.getChildFile ("sum-input-220hz.wav");
    const auto tone2File = options.outputDirectory.getChildFile ("sum-input-330hz.wav");
    const auto tonesWritten = writeTestTone (tone1File, 220.0, 0.20f)
                           && writeTestTone (tone2File, 330.0, 0.15f);
    const te::ClipPosition tonePosition {
        { tracktion::TimePosition::fromSeconds (0.0),
          tracktion::TimePosition::fromSeconds (arrangementSeconds) }
    };
    auto toneClip1 = summationTracks[0]->insertWaveClip ("220 Hz", tone1File, tonePosition, false);
    auto toneClip2 = summationTracks[1]->insertWaveClip ("330 Hz", tone2File, tonePosition, false);
    summationTracks[0]->getVolumePlugin()->setVolumeDb (0.0f);
    summationTracks[1]->getVolumePlugin()->setVolumeDb (0.0f);
    summationEdit->getMasterVolumePlugin()->setVolumeDb (0.0f);

    const auto sumMasterFile = options.outputDirectory.getChildFile ("sum-master.wav");
    const auto sumTrack1File = options.outputDirectory.getChildFile ("sum-track-1.wav");
    const auto sumTrack2File = options.outputDirectory.getChildFile ("sum-track-2.wav");
    const auto sumRendered = tonesWritten && toneClip1 != nullptr && toneClip2 != nullptr
        && render (engine, *summationEdit, sumMasterFile,
                   { summationTracks[0], summationTracks[1] })
        && render (engine, *summationEdit, sumTrack1File, { summationTracks[0] })
        && render (engine, *summationEdit, sumTrack2File, { summationTracks[1] });
    auto loadedSumMaster = loadAudio (sumMasterFile);
    auto loadedSumTrack1 = loadAudio (sumTrack1File);
    auto loadedSumTrack2 = loadAudio (sumTrack2File);
    AudioMetrics sumMasterMetrics, sumTrack1Metrics, sumTrack2Metrics;
    Comparison structuralSumComparison;
    if (loadedSumMaster && loadedSumTrack1 && loadedSumTrack2)
    {
        sumMasterMetrics = measure (*loadedSumMaster);
        sumTrack1Metrics = measure (*loadedSumTrack1);
        sumTrack2Metrics = measure (*loadedSumTrack2);
        structuralSumComparison = compare (*loadedSumMaster, *loadedSumTrack1, loadedSumTrack2.get());
    }
    recorder.check ("Deterministic two-track summation rendered",
                    sumRendered && loadedSumMaster && loadedSumTrack1 && loadedSumTrack2,
                    "two independent sine clips, master gain explicitly 0 dB");
    recorder.check ("Tracktion master is the unmodified linear sum of deterministic tracks",
                    structuralSumComparison.shapeMatches
                        && structuralSumComparison.maxAbsoluteError < 0.00002
                        && structuralSumComparison.rmsError < 0.000002,
                    "track1=" + juce::String (toDb (sumTrack1Metrics.peak), 2)
                        + " dBFS track2=" + juce::String (toDb (sumTrack2Metrics.peak), 2)
                        + " dBFS master=" + juce::String (toDb (sumMasterMetrics.peak), 2)
                        + " dBFS maxError=" + juce::String (structuralSumComparison.maxAbsoluteError, 9));
    recorder.check ("Deterministic master has headroom without limiter",
                    sumMasterMetrics.samplesAtOrAboveUnity == 0 && sumMasterMetrics.peak < 1.0,
                    "peak=" + juce::String (toDb (sumMasterMetrics.peak), 2)
                        + " dBFS, no limiter/normalisation");

    auto loadedMaster = loadAudio (masterFile);
    auto loadedTrack1 = loadAudio (track1File);
    auto loadedTrack2 = loadAudio (track2File);
    recorder.check ("Rendered WAV files are readable",
                    loadedMaster != nullptr && loadedTrack1 != nullptr && loadedTrack2 != nullptr,
                    "JUCE AudioFormatReader opened master and both stems");

    AudioMetrics masterMetrics, track1Metrics, track2Metrics;
    Comparison sumComparison;
    if (loadedMaster && loadedTrack1 && loadedTrack2)
    {
        masterMetrics = measure (*loadedMaster);
        track1Metrics = measure (*loadedTrack1);
        track2Metrics = measure (*loadedTrack2);
        sumComparison = compare (*loadedMaster, *loadedTrack1, loadedTrack2.get());

        recorder.check ("Both exported stems are non-silent and independent",
                        track1Metrics.peak > 0.0001 && track2Metrics.peak > 0.0001,
                        "track1=" + juce::String (toDb (track1Metrics.peak), 2)
                            + " dBFS track2=" + juce::String (toDb (track2Metrics.peak), 2) + " dBFS");
        recorder.check ("Separately rendered VST stems reconstruct the VST master",
                        sumComparison.shapeMatches
                            && sumComparison.maxAbsoluteError < 0.00002
                            && sumComparison.rmsError < 0.000002,
                        "maxError=" + juce::String (sumComparison.maxAbsoluteError, 9)
                            + " rmsError=" + juce::String (sumComparison.rmsError, 9));
        recorder.check ("No structural clipping in exported master",
                        masterMetrics.samplesAtOrAboveUnity == 0,
                        juce::String (masterMetrics.samplesAtOrAboveUnity)
                            + " sample value(s) at or above unity; no limiter/normalisation/dither");
    }

    repeatedMasterFile = options.outputDirectory.getChildFile ("master-repeat.wav");
    const auto repeatRendered = finalCycle != nullptr
        && render (engine, *finalCycle->edit, repeatedMasterFile,
                   { finalCycle->track1, finalCycle->track2 });
    auto loadedRepeat = loadAudio (repeatedMasterFile);
    Comparison deterministicComparison;
    if (loadedMaster && loadedRepeat)
        deterministicComparison = compare (*loadedRepeat, *loadedMaster);
    recorder.check ("Offline master render is sample-deterministic",
                    repeatRendered && loadedRepeat != nullptr
                        && deterministicComparison.shapeMatches
                        && deterministicComparison.maxAbsoluteError < 0.000002,
                    "maxRepeatDifference="
                        + juce::String (deterministicComparison.maxAbsoluteError, 9));

    const auto originalDeviceName = audioDevice->getName();
    juceDeviceManager.closeAudioDevice();
    pumpMessages (100);
    if (finalCycle != nullptr)
        finalCycle->edit->getTransport().freePlaybackContext();
    pumpMessages (100);
    deviceLayer.closeDevices();
    pumpMessages (200);
    const auto deviceClosed = juceDeviceManager.getCurrentAudioDevice() == nullptr;
    const auto deviceClosedFile = options.outputDirectory.getChildFile ("master-device-closed.wav");
    const auto deviceClosedStart = juce::Time::getMillisecondCounterHiRes();
    const auto renderedWithDeviceClosed = finalCycle != nullptr
        && render (engine, *finalCycle->edit, deviceClosedFile,
                   { finalCycle->track1, finalCycle->track2 });
    const auto deviceClosedElapsed = juce::Time::getMillisecondCounterHiRes() - deviceClosedStart;
    auto loadedDeviceClosed = loadAudio (deviceClosedFile);
    Comparison deviceIndependentComparison;
    if (loadedMaster && loadedDeviceClosed)
        deviceIndependentComparison = compare (*loadedDeviceClosed, *loadedMaster);
    recorder.check ("Offline export works with real-time device closed",
                    deviceClosed && renderedWithDeviceClosed && loadedDeviceClosed != nullptr,
                    "device '" + originalDeviceName + "' closed; render completed in "
                        + juce::String (deviceClosedElapsed, 1) + " ms");
    recorder.check ("Device-closed export matches the monitored arrangement",
                    deviceIndependentComparison.shapeMatches
                        && deviceIndependentComparison.maxAbsoluteError < 0.000002,
                    "maxDifference="
                        + juce::String (deviceIndependentComparison.maxAbsoluteError, 9));

    const auto finalResources = readResources();
    const auto workingSetGrowth = static_cast<int64_t> (finalResources.workingSetBytes)
                                - static_cast<int64_t> (baselineResources.workingSetBytes);
    const auto handleGrowth = static_cast<int64_t> (finalResources.handleCount)
                            - static_cast<int64_t> (baselineResources.handleCount);
    recorder.check ("Stability cycles completed without abnormal handle accumulation",
                    handleGrowth < 128,
                    "handle delta=" + juce::String (handleGrowth)
                        + ", working-set delta=" + juce::String (workingSetGrowth / (1024 * 1024)) + " MiB");

    auto gain = new juce::DynamicObject();
    gain->setProperty ("track1Offline", metricsToVar (track1Metrics));
    gain->setProperty ("track2Offline", metricsToVar (track2Metrics));
    gain->setProperty ("masterOffline", metricsToVar (masterMetrics));
    gain->setProperty ("masterRealtime", metricsToVar (firstRealtimeMetrics));
    gain->setProperty ("track1RealtimeMeterPeakDbFS", firstTrack1MeterDb);
    gain->setProperty ("track2RealtimeMeterPeakDbFS", firstTrack2MeterDb);
    gain->setProperty ("masterRealtimeMeterPeakDbFS", firstMasterMeterDb);
    gain->setProperty ("linearSumMaxError", sumComparison.maxAbsoluteError);
    gain->setProperty ("linearSumRmsError", sumComparison.rmsError);
    gain->setProperty ("normalisationEnabled", false);
    gain->setProperty ("ditheringEnabled", false);
    gain->setProperty ("hostOutputClippingEnabled", false);
    gain->setProperty ("limiterInserted", false);
    rootObject->setProperty ("gain", juce::var (gain));

    auto structuralGain = new juce::DynamicObject();
    structuralGain->setProperty ("track1", metricsToVar (sumTrack1Metrics));
    structuralGain->setProperty ("track2", metricsToVar (sumTrack2Metrics));
    structuralGain->setProperty ("master", metricsToVar (sumMasterMetrics));
    structuralGain->setProperty ("linearSumMaxError", structuralSumComparison.maxAbsoluteError);
    structuralGain->setProperty ("linearSumRmsError", structuralSumComparison.rmsError);
    structuralGain->setProperty ("masterGainDb", 0.0);
    structuralGain->setProperty ("limiterInserted", false);
    rootObject->setProperty ("structuralGain", juce::var (structuralGain));

    auto offline = new juce::DynamicObject();
    offline->setProperty ("sampleRate", offlineSampleRate);
    offline->setProperty ("blockSize", offlineBlockSize);
    offline->setProperty ("realTimeRender", false);
    offline->setProperty ("masterPath", masterFile.getFullPathName());
    offline->setProperty ("track1Path", track1File.getFullPathName());
    offline->setProperty ("track2Path", track2File.getFullPathName());
    offline->setProperty ("repeatPath", repeatedMasterFile.getFullPathName());
    offline->setProperty ("deviceClosedPath", deviceClosedFile.getFullPathName());
    offline->setProperty ("repeatMaxDifference", deterministicComparison.maxAbsoluteError);
    offline->setProperty ("deviceClosedMaxDifference", deviceIndependentComparison.maxAbsoluteError);
    rootObject->setProperty ("offline", juce::var (offline));

    auto resources = new juce::DynamicObject();
    resources->setProperty ("baselineWorkingSetBytes", static_cast<double> (baselineResources.workingSetBytes));
    resources->setProperty ("finalWorkingSetBytes", static_cast<double> (finalResources.workingSetBytes));
    resources->setProperty ("workingSetGrowthBytes", static_cast<double> (workingSetGrowth));
    resources->setProperty ("baselineHandleCount", static_cast<int> (baselineResources.handleCount));
    resources->setProperty ("finalHandleCount", static_cast<int> (finalResources.handleCount));
    resources->setProperty ("handleGrowth", static_cast<double> (handleGrowth));
    rootObject->setProperty ("resources", juce::var (resources));

    recorder.finish();
    rootObject->setProperty ("verdict", recorder.passed() ? "PASS" : "FAIL");
    rootObject->setProperty ("note",
                             "Licence suitability is evaluated separately in the Markdown reports; "
                             "technicalPass alone is not the final MiniHub verdict.");

    const auto resultsFile = options.outputDirectory.getChildFile ("prototype-results.json");
    resultsFile.replaceWithText (juce::JSON::toString (root, true));
    std::cout << "RESULTS " << resultsFile.getFullPathName() << '\n';

    finalCycle.reset();
    pumpMessages (500);
    return recorder.passed() ? 0 : 2;
}
} // namespace

int main (int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInitialiser;
    std::cout << std::unitbuf;
    std::cerr << std::unitbuf;

    try
    {
        return runProbe (parseOptions (argc, argv));
    }
    catch (const std::exception& error)
    {
        std::cerr << "FATAL " << error.what() << '\n';
        return 1;
    }
}
