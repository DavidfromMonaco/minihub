#include "audio_engine.h"
#include "audio_graph.h"
#include "plugin_instance.h"
#include "portaudio_device.h"
#include "wav_writer.h"

#include <windows.h>
#include <psapi.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
using namespace engine2;

namespace {

struct ProcessMetrics {
    std::uint64_t workingSet {0};
    std::uint64_t privateBytes {0};
    std::uint32_t handles {0};
};

ProcessMetrics metrics() {
    PROCESS_MEMORY_COUNTERS_EX memory {};
    memory.cb = sizeof(memory);
    GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),
                         sizeof(memory));
    DWORD handles = 0;
    GetProcessHandleCount(GetCurrentProcess(), &handles);
    return {static_cast<std::uint64_t>(memory.WorkingSetSize),
            static_cast<std::uint64_t>(memory.PrivateUsage), handles};
}

std::string jsonEscape(std::string_view input) {
    std::ostringstream out;
    for (const char ch : input) {
        switch (ch) {
        case '\\': out << "\\\\"; break;
        case '"': out << "\\\""; break;
        case '\n': out << "\\n"; break;
        case '\r': out << "\\r"; break;
        case '\t': out << "\\t"; break;
        default:
            if (static_cast<unsigned char>(ch) < 0x20) out << '?'; else out << ch;
        }
    }
    return out.str();
}

void writeResult(const fs::path& directory, std::string_view filename,
                 const std::string& json) {
    std::error_code ec;
    fs::create_directories(directory, ec);
    std::ofstream out(directory / filename, std::ios::binary | std::ios::trunc);
    out << json << '\n';
    std::cout << json << '\n';
}

class Arguments {
public:
    Arguments(int argc, char** argv) {
        for (int i = 1; i < argc; ++i) values_.emplace_back(argv[i]);
    }
    [[nodiscard]] std::string command() const { return values_.empty() ? "help" : values_[0]; }
    [[nodiscard]] std::string get(std::string_view key, std::string fallback = {}) const {
        for (std::size_t i = 1; i + 1 < values_.size(); ++i)
            if (values_[i] == key) return values_[i + 1];
        return fallback;
    }
    [[nodiscard]] int getInt(std::string_view key, int fallback) const {
        const auto value = get(key);
        return value.empty() ? fallback : std::stoi(value);
    }
private:
    std::vector<std::string> values_;
};

fs::path artifactDirectory(const Arguments& args) {
    const auto value = args.get("--artifacts", "artifacts");
    return fs::absolute(fs::path(value));
}

std::unique_ptr<AudioGraph> deterministicGraph(
    double rate, std::uint32_t maxBlock, bool offline,
    std::vector<ScheduledNote> sequence1 = makeFixedSequence(kDefaultSampleRate, 60),
    std::vector<ScheduledNote> sequence2 = makeFixedSequence(kDefaultSampleRate, 48),
    float gain1 = 1.0F, float gain2 = 1.0F) {
    AudioGraph::TrackConfig one {std::make_unique<DeterministicSynth>(0.0), gain1,
                                 std::move(sequence1)};
    AudioGraph::TrackConfig two {std::make_unique<DeterministicSynth>(0.03), gain2,
                                 std::move(sequence2)};
    return std::make_unique<AudioGraph>(rate, maxBlock, std::move(one), std::move(two), offline);
}

std::unique_ptr<AudioGraph> pluginGraph(const fs::path& dexed, const fs::path& vital,
                                        double rate, std::uint32_t maxBlock, bool offline) {
    auto sequence1 = makeFixedSequence(static_cast<std::uint32_t>(rate), 60);
    auto sequence2 = makeFixedSequence(static_cast<std::uint32_t>(rate), 48);
    AudioGraph::TrackConfig one {std::make_unique<PluginInstance>(dexed), 0.7F,
                                 std::move(sequence1)};
    AudioGraph::TrackConfig two {std::make_unique<PluginInstance>(vital), 0.7F,
                                 std::move(sequence2)};
    return std::make_unique<AudioGraph>(rate, maxBlock, std::move(one), std::move(two), offline);
}

bool prepareStart(AudioGraph& graph, std::string& error) {
    return graph.prepare(error) && graph.start(error);
}

bool renderNewDeterministic(std::uint64_t frames, std::vector<float>& output,
                            std::string& error,
                            std::vector<ScheduledNote> sequence1,
                            std::vector<ScheduledNote> sequence2) {
    auto graph = deterministicGraph(kDefaultSampleRate, kTargetBlockSize, true,
                                    std::move(sequence1), std::move(sequence2));
    if (!prepareStart(*graph, error)) return false;
    Transport transport(kDefaultSampleRate);
    transport.play();
    return renderOffline(*graph, transport, frames, output, error);
}

float peak(std::span<const float> samples) {
    float value = 0.0F;
    for (float sample : samples) value = std::max(value, std::abs(sample));
    return value;
}

double rms(std::span<const float> samples) {
    if (samples.empty()) return 0.0;
    long double sum = 0.0;
    for (float sample : samples) sum += static_cast<long double>(sample) * sample;
    return std::sqrt(static_cast<double>(sum / samples.size()));
}

std::uint64_t firstAudibleFrame(std::span<const float> samples, float threshold = 1.0e-6F) {
    for (std::size_t i = 0; i + 1 < samples.size(); i += 2)
        if (std::abs(samples[i]) > threshold || std::abs(samples[i + 1]) > threshold) return i / 2;
    return samples.size() / 2;
}

std::string metricJson(const ProcessMetrics& value) {
    std::ostringstream out;
    out << "{\"workingSet\":" << value.workingSet
        << ",\"privateBytes\":" << value.privateBytes
        << ",\"handles\":" << value.handles << '}';
    return out.str();
}

int selfTest(const Arguments& args) {
    const auto dir = artifactDirectory(args) / "core";
    const auto before = metrics();
    std::string error;
    bool deterministic = true;
    bool sumExact = true;
    bool midiOffset = false;
    bool transportStable = true;
    bool loopCorrect = false;
    bool pdcCorrect = false;
    bool offlineNoDevice = PortAudioDevice::activeStreamCount() == 0;
    std::uint64_t referenceHash = 0;
    std::vector<float> reference;
    constexpr std::uint64_t frames = kDefaultSampleRate * 2ULL;

    for (int exportIndex = 0; exportIndex < 10; ++exportIndex) {
        std::vector<float> rendered;
        if (!renderNewDeterministic(frames, rendered, error,
                                    makeFixedSequence(kDefaultSampleRate, 60),
                                    makeFixedSequence(kDefaultSampleRate, 48))) {
            deterministic = false;
            break;
        }
        if (exportIndex == 0) {
            reference = rendered;
            referenceHash = pcmHash(reference);
        } else if (rendered.size() != reference.size() ||
                   !std::equal(rendered.begin(), rendered.end(), reference.begin())) {
            deterministic = false;
        }
        if (!writeFloat32Wav(dir / ("deterministic-" + std::to_string(exportIndex + 1) + ".wav"),
                             rendered, kDefaultSampleRate, 2, error)) {
            deterministic = false;
            break;
        }
    }

    std::vector<float> onlyOne, onlyTwo, both;
    const std::vector<ScheduledNote> empty;
    if (!renderNewDeterministic(frames, onlyOne, error,
                                makeFixedSequence(kDefaultSampleRate, 60), empty) ||
        !renderNewDeterministic(frames, onlyTwo, error, empty,
                                makeFixedSequence(kDefaultSampleRate, 48)) ||
        !renderNewDeterministic(frames, both, error,
                                makeFixedSequence(kDefaultSampleRate, 60),
                                makeFixedSequence(kDefaultSampleRate, 48))) {
        sumExact = false;
    } else {
        for (std::size_t i = 0; i < both.size(); ++i) {
            if (both[i] != onlyOne[i] + onlyTwo[i]) { sumExact = false; break; }
        }
        writeFloat32Wav(dir / "linear-sum.wav", both, kDefaultSampleRate, 2, error);
    }

    {
        std::vector<ScheduledNote> offsetSequence {
            {17, MidiType::noteOn, 60, 1.0F}, {100, MidiType::noteOff, 60, 0.0F}};
        std::vector<float> output;
        if (renderNewDeterministic(256, output, error, offsetSequence, empty)) {
            const auto onset = firstAudibleFrame(output);
            midiOffset = onset == 18; // note is applied at 17; sine phase zero is the first sample.
        }
    }

    {
        auto graph = deterministicGraph(kDefaultSampleRate, kTargetBlockSize, true);
        if (!prepareStart(*graph, error)) {
            transportStable = false;
        } else {
            std::vector<float> block(kTargetBlockSize * 2);
            Transport transport(kDefaultSampleRate);
            for (int cycle = 0; cycle < 100; ++cycle) {
                transport.goToStart(); transport.play();
                transportStable &= graph->processBlock(block.data(), kTargetBlockSize, transport);
                transport.stop();
                transportStable &= graph->processBlock(block.data(), 64, transport);
                transport.seek(31 + cycle); transport.play();
                transportStable &= graph->processBlock(block.data(), 97, transport);
                transport.stop();
            }
            transport.setLoop(true, 32, 100);
            transport.seek(90); transport.play();
            loopCorrect = graph->processBlock(block.data(), 32, transport) &&
                          transport.snapshot().samplePosition == 54;
        }
    }

    std::array<std::uint32_t, 2> compensation {};
    {
        AudioGraph::TrackConfig one {std::make_unique<DelayTestProcessor>(0), 1.0F, {}};
        AudioGraph::TrackConfig two {std::make_unique<DelayTestProcessor>(127), 1.0F, {}};
        AudioGraph graph(kDefaultSampleRate, kTargetBlockSize, std::move(one), std::move(two), true);
        if (prepareStart(graph, error)) {
            Transport transport(kDefaultSampleRate); transport.play();
            std::vector<float> output(kTargetBlockSize * 2);
            compensation = graph.compensationDelays();
            pdcCorrect = graph.processBlock(output.data(), kTargetBlockSize, transport) &&
                         compensation[0] == 127 && compensation[1] == 0;
            for (std::uint32_t i = 0; i < kTargetBlockSize && pdcCorrect; ++i) {
                const float expected = i == 127 ? 0.5F : 0.0F;
                pdcCorrect = output[i * 2] == expected && output[i * 2 + 1] == expected;
            }
        }
    }

    offlineNoDevice &= PortAudioDevice::activeStreamCount() == 0;
    const auto after = metrics();
    const bool pass = deterministic && sumExact && midiOffset && transportStable && loopCorrect &&
                      pdcCorrect && offlineNoDevice;
    std::ostringstream json;
    json << "{\"suite\":\"engine2-core\",\"pass\":" << (pass ? "true" : "false")
         << ",\"deterministicExports\":10,\"pcmExact\":" << (deterministic ? "true" : "false")
         << ",\"pcmHash\":" << referenceHash
         << ",\"linearSumExact\":" << (sumExact ? "true" : "false")
         << ",\"midiOffsetExact\":" << (midiOffset ? "true" : "false")
         << ",\"transportCycles\":100,\"transportStable\":" << (transportStable ? "true" : "false")
         << ",\"loopBoundaryCorrect\":" << (loopCorrect ? "true" : "false")
         << ",\"pdcCorrect\":" << (pdcCorrect ? "true" : "false")
         << ",\"pdcDelays\":[" << compensation[0] << ',' << compensation[1] << ']'
         << ",\"offlinePortAudioStreams\":" << PortAudioDevice::activeStreamCount()
         << ",\"memoryBefore\":" << metricJson(before)
         << ",\"memoryAfter\":" << metricJson(after)
         << ",\"error\":\"" << jsonEscape(error) << "\"}";
    writeResult(dir, "core-results.json", json.str());
    return pass ? 0 : 2;
}

int pluginStress(const Arguments& args) {
    const fs::path dexed = args.get("--dexed");
    const fs::path vital = args.get("--vital");
    const int cycles = std::max(1, args.getInt("--cycles", 100));
    const auto dir = artifactDirectory(args) / "plugin-load-stress";
    const auto processStart = metrics();
    int completed = 0;
    int dexedSoundCycles = 0;
    int vitalSoundCycles = 0;
    std::vector<std::string> errors;
    std::vector<std::uint64_t> privateSamples;
    std::vector<std::uint32_t> handleSamples;

    // One uncounted warm-up separates one-time DLL/runtime initialization from
    // resources that grow across the 100 measured create/destroy cycles.
    {
        std::string warmError;
        auto warm = pluginGraph(dexed, vital, kDefaultSampleRate, 2048, false);
        if (prepareStart(*warm, warmError)) {
            Transport transport(kDefaultSampleRate); transport.play();
            std::vector<float> output(2048 * 2);
            warm->processBlock(output.data(), 2048, transport);
        }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const auto before = metrics();

    for (int cycle = 0; cycle < cycles; ++cycle) {
        std::string error;
        try {
            auto graph = pluginGraph(dexed, vital, kDefaultSampleRate, 2048, false);
            if (!prepareStart(*graph, error)) {
                if (errors.size() < 8) errors.push_back("cycle " + std::to_string(cycle + 1) + ": " + error);
                continue;
            }
            Transport transport(kDefaultSampleRate);
            std::vector<float> output(2048 * 2);
            transport.goToStart(); transport.play();
            if (!graph->processBlock(output.data(), 2048, transport)) {
                if (errors.size() < 8) errors.push_back("cycle process failed");
                continue;
            }
            auto peaks = graph->lastTrackPeaks();
            dexedSoundCycles += peaks[0] > 1.0e-7F ? 1 : 0;
            vitalSoundCycles += peaks[1] > 1.0e-7F ? 1 : 0;
            transport.stop();
            graph->processBlock(output.data(), 128, transport);
            transport.goToStart(); transport.play();
            if (!graph->processBlock(output.data(), 2048, transport)) continue;
            transport.stop();
            ++completed;
        } catch (const std::exception& exception) {
            if (errors.size() < 8) errors.push_back(exception.what());
        }
        if ((cycle + 1) % 10 == 0) {
            const auto sample = metrics();
            privateSamples.push_back(sample.privateBytes);
            handleSamples.push_back(sample.handles);
        }
    }

    const auto after = metrics();
    bool memoryPlateau = privateSamples.size() >= 4;
    if (memoryPlateau) {
        const auto begin = privateSamples.end() - 4;
        const auto [low, high] = std::minmax_element(begin, privateSamples.end());
        memoryPlateau = *high - *low <= 16ULL * 1024ULL * 1024ULL;
    }
    const bool noResidualHandles = after.handles <= before.handles;
    const bool pass = completed == cycles && dexedSoundCycles == cycles && vitalSoundCycles == cycles &&
                      PortAudioDevice::activeStreamCount() == 0 && memoryPlateau && noResidualHandles;
    std::ostringstream json;
    json << "{\"suite\":\"vst-load-unload-stress\",\"pass\":" << (pass ? "true" : "false")
         << ",\"attempted\":" << cycles << ",\"completed\":" << completed
         << ",\"dexedSoundCycles\":" << dexedSoundCycles
         << ",\"vitalSoundCycles\":" << vitalSoundCycles
         << ",\"activeStreams\":" << PortAudioDevice::activeStreamCount()
         << ",\"processStart\":" << metricJson(processStart)
         << ",\"memoryBefore\":" << metricJson(before)
         << ",\"memoryAfter\":" << metricJson(after) << ",\"privateByteSamples\":[";
    for (std::size_t i = 0; i < privateSamples.size(); ++i) {
        if (i) json << ','; json << privateSamples[i];
    }
    json << "],\"handleSamples\":[";
    for (std::size_t i = 0; i < handleSamples.size(); ++i) {
        if (i) json << ','; json << handleSamples[i];
    }
    json << "],\"memoryPlateau\":" << (memoryPlateau ? "true" : "false")
         << ",\"noResidualHandles\":" << (noResidualHandles ? "true" : "false")
         << ",\"errors\":[";
    for (std::size_t i = 0; i < errors.size(); ++i) {
        if (i) json << ','; json << "\"" << jsonEscape(errors[i]) << "\"";
    }
    json << "]}";
    writeResult(dir, "plugin-load-stress-results.json", json.str());
    return pass ? 0 : 3;
}

int pluginTransportStress(const Arguments& args) {
    const fs::path dexed = args.get("--dexed");
    const fs::path vital = args.get("--vital");
    const int cycles = std::max(1, args.getInt("--cycles", 100));
    const auto dir = artifactDirectory(args) / "plugin-transport-stress";
    const auto before = metrics();
    std::string error;
    int completed = 0;
    float dexedPeak = 0.0F, vitalPeak = 0.0F;
    std::vector<std::uint64_t> privateSamples;
    std::vector<std::uint32_t> handleSamples;
    auto graph = pluginGraph(dexed, vital, kDefaultSampleRate, 2048, false);
    ProcessMetrics loadedBefore {};
    if (prepareStart(*graph, error)) {
        loadedBefore = metrics();
        Transport transport(kDefaultSampleRate);
        std::vector<float> output(2048 * 2);
        for (int cycle = 0; cycle < cycles; ++cycle) {
            transport.goToStart(); transport.play();
            if (!graph->processBlock(output.data(), 2048, transport)) break;
            auto peaks = graph->lastTrackPeaks();
            dexedPeak = std::max(dexedPeak, peaks[0]);
            vitalPeak = std::max(vitalPeak, peaks[1]);
            transport.stop();
            if (!graph->processBlock(output.data(), 73, transport)) break;
            transport.seek((cycle * 17) % 257); transport.play();
            if (!graph->processBlock(output.data(), 1024, transport)) break;
            transport.stop();
            ++completed;
            if ((cycle + 1) % 10 == 0) {
                const auto sample = metrics();
                privateSamples.push_back(sample.privateBytes);
                handleSamples.push_back(sample.handles);
            }
        }
    }
    const auto loadedAfter = metrics();
    graph->stop();
    graph.reset();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const auto after = metrics();
    bool memoryPlateau = privateSamples.size() >= 4;
    if (memoryPlateau) {
        const auto begin = privateSamples.end() - 4;
        const auto [low, high] = std::minmax_element(begin, privateSamples.end());
        memoryPlateau = *high - *low <= 16ULL * 1024ULL * 1024ULL;
    }
    const bool noResidualHandles = after.handles <= before.handles;
    const bool pass = completed == cycles && dexedPeak > 1.0e-7F && vitalPeak > 1.0e-7F &&
                      memoryPlateau && noResidualHandles;
    std::ostringstream json;
    json << "{\"suite\":\"vst-transport-no-unload\",\"pass\":" << (pass ? "true" : "false")
         << ",\"attempted\":" << cycles << ",\"completed\":" << completed
         << ",\"dexedPeak\":" << dexedPeak << ",\"vitalPeak\":" << vitalPeak
         << ",\"memoryBefore\":" << metricJson(before)
         << ",\"memoryLoadedBeforeCycles\":" << metricJson(loadedBefore)
         << ",\"memoryLoadedAfterCycles\":" << metricJson(loadedAfter)
         << ",\"memoryAfter\":" << metricJson(after)
         << ",\"memoryPlateau\":" << (memoryPlateau ? "true" : "false")
         << ",\"noResidualHandles\":" << (noResidualHandles ? "true" : "false")
         << ",\"privateByteSamples\":[";
    for (std::size_t i = 0; i < privateSamples.size(); ++i) {
        if (i) json << ','; json << privateSamples[i];
    }
    json << "],\"handleSamples\":[";
    for (std::size_t i = 0; i < handleSamples.size(); ++i) {
        if (i) json << ','; json << handleSamples[i];
    }
    json << "],\"error\":\"" << jsonEscape(error) << "\"}";
    writeResult(dir, "plugin-transport-stress-results.json", json.str());
    return pass ? 0 : 4;
}

bool renderSinglePlugin(const fs::path& plugin, std::uint8_t note, std::vector<float>& audio,
                        std::string& error) {
    AudioGraph::TrackConfig one {std::make_unique<PluginInstance>(plugin), 0.7F,
                                 makeFixedSequence(kDefaultSampleRate, note)};
    AudioGraph::TrackConfig two {std::make_unique<DeterministicSynth>(), 0.0F, {}};
    AudioGraph graph(kDefaultSampleRate, kTargetBlockSize, std::move(one), std::move(two), true);
    if (!prepareStart(graph, error)) return false;
    Transport transport(kDefaultSampleRate); transport.play();
    return renderOffline(graph, transport, kDefaultSampleRate * 2ULL, audio, error);
}

int pluginDeterminism(const Arguments& args) {
    const std::array<fs::path, 2> paths {args.get("--dexed"), args.get("--vital")};
    const std::array<const char*, 2> names {"Dexed", "Vital"};
    const auto dir = artifactDirectory(args) / "plugin-determinism";
    bool executionPass = true;
    std::ostringstream details;
    details << '[';
    for (std::size_t p = 0; p < paths.size(); ++p) {
        std::vector<float> reference;
        std::vector<std::uint64_t> hashes;
        bool exact = true;
        float outputPeak = 0.0F;
        std::string error;
        for (int iteration = 0; iteration < 10; ++iteration) {
            std::vector<float> audio;
            if (!renderSinglePlugin(paths[p], p == 0 ? 60 : 48, audio, error)) {
                executionPass = false; exact = false; break;
            }
            hashes.push_back(pcmHash(audio));
            outputPeak = std::max(outputPeak, peak(audio));
            if (iteration == 0) reference = audio;
            else exact &= audio.size() == reference.size() &&
                          std::equal(audio.begin(), audio.end(), reference.begin());
            writeFloat32Wav(dir / (std::string(names[p]) + "-" + std::to_string(iteration + 1) + ".wav"),
                            audio, kDefaultSampleRate, 2, error);
        }
        if (outputPeak <= 1.0e-7F) executionPass = false;
        if (p) details << ',';
        details << "{\"plugin\":\"" << names[p] << "\",\"exports\":" << hashes.size()
                << ",\"exact\":" << (exact ? "true" : "false")
                << ",\"peak\":" << outputPeak << ",\"interpretation\":\""
                << (exact ? "repeatable in fresh instances" :
                    "difference may be plugin state/randomness; deterministic engine control remains authoritative")
                << "\",\"hashes\":[";
        for (std::size_t h = 0; h < hashes.size(); ++h) { if (h) details << ','; details << hashes[h]; }
        details << "],\"error\":\"" << jsonEscape(error) << "\"}";
    }
    details << ']';
    std::ostringstream json;
    json << "{\"suite\":\"real-plugin-determinism-characterization\",\"pass\":"
         << (executionPass ? "true" : "false") << ",\"plugins\":" << details.str() << '}';
    writeResult(dir, "plugin-determinism-results.json", json.str());
    return executionPass ? 0 : 5;
}

int pluginOffline(const Arguments& args) {
    const auto dir = artifactDirectory(args) / "plugin-offline";
    const fs::path dexed = args.get("--dexed");
    const fs::path vital = args.get("--vital");
    std::string error;
    auto graph = pluginGraph(dexed, vital, kDefaultSampleRate, kTargetBlockSize, true);
    bool ok = prepareStart(*graph, error);
    std::vector<float> audio;
    if (ok) {
        Transport transport(kDefaultSampleRate); transport.play();
        ok = renderOffline(*graph, transport, kDefaultSampleRate * 2ULL, audio, error);
    }
    if (ok) ok = writeFloat32Wav(dir / "dexed-vital-offline.wav", audio,
                                 kDefaultSampleRate, 2, error);
    const bool pass = ok && peak(audio) > 1.0e-7F && PortAudioDevice::activeStreamCount() == 0;
    std::ostringstream json;
    json << "{\"suite\":\"real-plugin-offline\",\"pass\":" << (pass ? "true" : "false")
         << ",\"frames\":" << audio.size() / 2 << ",\"peak\":" << peak(audio)
         << ",\"pcmHash\":" << pcmHash(audio)
         << ",\"portAudioStreams\":" << PortAudioDevice::activeStreamCount()
         << ",\"error\":\"" << jsonEscape(error) << "\"}";
    writeResult(dir, "plugin-offline-results.json", json.str());
    return pass ? 0 : 6;
}

int deviceCompare(const Arguments& args, bool realPlugins) {
    const auto dir = artifactDirectory(args) /
                     (realPlugins ? "plugin-realtime-vs-offline" : "device-compare");
    std::string error;
    AudioEngine engine(kDefaultSampleRate);
    PortAudioDevice device(engine);
    bool ok = device.open(kDefaultSampleRate, kTargetBlockSize, error);
    bool secondOwnerRejected = false;
    if (ok) {
        PortAudioDevice second(engine);
        std::string secondError;
        secondOwnerRejected = !second.open(kDefaultSampleRate, kTargetBlockSize, secondError);
    }
    const auto rate = static_cast<std::uint32_t>(engine.sampleRate());
    std::unique_ptr<AudioGraph> realtimeGraph;
    if (ok) {
        realtimeGraph = realPlugins
            ? pluginGraph(args.get("--dexed"), args.get("--vital"), rate, kMaxBlockSize, false)
            : deterministicGraph(rate, kMaxBlockSize, false,
                                 makeFixedSequence(rate, 60), makeFixedSequence(rate, 48));
        ok = prepareStart(*realtimeGraph, error);
    }
    const std::uint64_t targetFrames = rate * 2ULL;
    if (ok) {
        engine.publishGraph(std::move(realtimeGraph));
        engine.enableCapture(targetFrames);
        engine.transport().goToStart(); engine.transport().play();
        ok = device.start(error);
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(12);
    while (ok && !engine.captureComplete() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    if (ok && !engine.captureComplete()) { ok = false; error = "WASAPI capture timeout"; }
    device.stop();
    engine.transport().stop();
    auto realtime = engine.takeCapture();
    const auto trace = device.trace();
    device.close();

    std::vector<float> offline;
    if (ok) {
        auto graph = realPlugins
            ? pluginGraph(args.get("--dexed"), args.get("--vital"), rate, kTargetBlockSize, true)
            : deterministicGraph(rate, kTargetBlockSize, true,
                                 makeFixedSequence(rate, 60), makeFixedSequence(rate, 48));
        ok = prepareStart(*graph, error);
        if (ok) {
            Transport transport(rate); transport.play();
            ok = renderOffline(*graph, transport, targetFrames, offline, error);
        }
    }
    writeFloat32Wav(dir / "realtime-captured.wav", realtime, rate, 2, error);
    writeFloat32Wav(dir / "offline.wav", offline, rate, 2, error);

    const bool sameLength = realtime.size() == offline.size() && !realtime.empty();
    const bool exact = sameLength && std::equal(realtime.begin(), realtime.end(), offline.begin());
    const auto realtimePeak = peak(realtime), offlinePeak = peak(offline);
    const auto realtimeRms = rms(realtime), offlineRms = rms(offline);
    const auto realtimeOnset = firstAudibleFrame(realtime), offlineOnset = firstAudibleFrame(offline);
    const auto onsetDifference = realtimeOnset > offlineOnset ? realtimeOnset - offlineOnset
                                                              : offlineOnset - realtimeOnset;
    const double rmsRatio = offlineRms > 0.0 ? realtimeRms / offlineRms : 0.0;
    const bool audioComparable = sameLength && realtimePeak > 1.0e-7F && offlinePeak > 1.0e-7F &&
                                 onsetDifference <= kTargetBlockSize && rmsRatio > 0.25 && rmsRatio < 4.0;
    const bool pass = ok && secondOwnerRejected && trace.activeStreamsAtClose == 0 &&
                      (realPlugins ? audioComparable : exact);
    const auto stats = engine.realtimeStats();
    std::ostringstream json;
    json << "{\"suite\":\"" << (realPlugins ? "real-plugin-realtime-vs-offline" : "deterministic-realtime-vs-offline")
         << "\",\"pass\":" << (pass ? "true" : "false")
         << ",\"sameLength\":" << (sameLength ? "true" : "false")
         << ",\"exact\":" << (exact ? "true" : "false")
         << ",\"frames\":" << realtime.size() / 2
         << ",\"realtimePeak\":" << realtimePeak << ",\"offlinePeak\":" << offlinePeak
         << ",\"realtimeRms\":" << realtimeRms << ",\"offlineRms\":" << offlineRms
         << ",\"onsetDifferenceSamples\":" << onsetDifference
         << ",\"singleOwnerRejectedSecond\":" << (secondOwnerRejected ? "true" : "false")
         << ",\"device\":\"" << jsonEscape(trace.deviceName) << "\""
         << ",\"requestedSampleRate\":" << trace.requestedSampleRate
         << ",\"actualSampleRate\":" << trace.actualSampleRate
         << ",\"requestedFrames\":" << trace.requestedFrames
         << ",\"maximumObservedFrames\":" << stats.maximumCallbackFrames
         << ",\"callbacks\":" << stats.callbacks
         << ",\"callbackFailures\":" << stats.processFailures
         << ",\"activeStreamsAfterClose\":" << PortAudioDevice::activeStreamCount()
         << ",\"error\":\"" << jsonEscape(error) << "\"}";
    writeResult(dir, realPlugins ? "plugin-realtime-vs-offline-results.json" : "device-results.json",
                json.str());
    return pass ? 0 : 7;
}

void printHelp() {
    std::cout << "MiniHub Engine 2 prototype\n"
              << "  self-test --artifacts DIR\n"
              << "  plugin-stress --dexed PATH --vital PATH --cycles 100 --artifacts DIR\n"
              << "  plugin-transport-stress --dexed PATH --vital PATH --cycles 100\n"
              << "  plugin-determinism --dexed PATH --vital PATH\n"
              << "  plugin-offline --dexed PATH --vital PATH\n"
              << "  device-compare\n"
              << "  plugin-device-compare --dexed PATH --vital PATH\n";
}

} // namespace

int main(int argc, char** argv) {
    HeapSetInformation(nullptr, HeapEnableTerminationOnCorruption, nullptr, 0);
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    try {
        const Arguments args(argc, argv);
        if (args.command() == "self-test") return selfTest(args);
        if (args.command() == "plugin-stress") return pluginStress(args);
        if (args.command() == "plugin-transport-stress") return pluginTransportStress(args);
        if (args.command() == "plugin-determinism") return pluginDeterminism(args);
        if (args.command() == "plugin-offline") return pluginOffline(args);
        if (args.command() == "device-compare") return deviceCompare(args, false);
        if (args.command() == "plugin-device-compare") return deviceCompare(args, true);
        if (args.command() == "versions") {
            std::cout << "Engine2=" << ENGINE2_VERSION << " VST3=" << VST3_SDK_REVISION
                      << " PortAudio=" << PORTAUDIO_REVISION << '\n';
            return 0;
        }
        printHelp();
        return args.command() == "help" ? 0 : 1;
    } catch (const std::exception& error) {
        std::cerr << "fatal: " << error.what() << '\n';
        return 10;
    } catch (...) {
        std::cerr << "fatal: unknown native exception\n";
        return 11;
    }
}
