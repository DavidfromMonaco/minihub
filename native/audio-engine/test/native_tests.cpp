#include "gesture_learn_state.h"
#include "transport.h"
#include "audio_take_writer.h"
#include "audio_graph.h"
#include "master_output.h"
#include "midi_graph.h"
#include "plugin_host.h"
#include "sequencer.h"
#include "var_util.h"
#include "vst3_scanner.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <iostream>
#include <limits>
#if JUCE_WINDOWS
#ifndef NOMINMAX
#define NOMINMAX 1
#endif
#include <windows.h>
#endif

namespace {

int failures = 0;
int checks = 0;
constexpr const char* kNoisyScanHelperPath = "minihub-test://landr-noisy-helper";
constexpr const char* kHungScanHelperPath = "minihub-test://landr-noisy-hung-helper";
constexpr const char* kCrashingScanHelperPath = "minihub-test://landr-noisy-crashing-helper";

void expect(bool condition, const char* message)
{
    ++checks;
    if (condition)
        return;
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
}

void expect(bool condition, const juce::String& message)
{
    expect(condition, message.toRawUTF8());
}

mlh::PluginRecord noisyScanHelperRecord()
{
    mlh::PluginRecord record;
    record.pluginId = kNoisyScanHelperPath;
    record.name = "LANDR Mastering Pro";
    record.manufacturer = "LANDR";
    record.category = "Fx|Mastering";
    record.path = record.pluginId;
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
    return record;
}

void testNoisyPluginHelperResultIsolation()
{
    const auto records = mlh::Vst3Scanner::scanFileIsolated(kNoisyScanHelperPath);
    expect(records.size() == 1,
           "LANDR-like stdout noise cannot hide the helper metadata result");
    expect(!records.empty()
               && records[0].name == "LANDR Mastering Pro"
               && records[0].manufacturer == "LANDR"
               && records[0].numInputChannels == 2
               && records[0].description.fileOrIdentifier == kNoisyScanHelperPath,
           "noisy helper preserves the complete validated plugin description");

    const auto hungStarted = juce::Time::getMillisecondCounter();
    const auto hung = mlh::Vst3Scanner::scanFileIsolated(
        kHungScanHelperPath, nullptr, 100);
    const auto hungElapsed = juce::Time::getMillisecondCounter() - hungStarted;
    expect(hung.empty() && hungElapsed < 2000,
           "short plugin output cannot block the helper timeout or the global scan");

    const auto crashed = mlh::Vst3Scanner::scanFileIsolated(kCrashingScanHelperPath);
    expect(crashed.empty(),
           "LANDR-like access violation is contained to the disposable helper");

    const auto afterHung = mlh::Vst3Scanner::scanFileIsolated(kNoisyScanHelperPath);
    expect(afterHung.size() == 1,
           "a timed-out or crashing plugin does not compromise the next valid plugin");
}

int runNoisyScanHelper(int argc, char** argv)
{
    const juce::String requestedPath = argc > 2 ? argv[2] : "";
    juce::String resultPath;
    for (int i = 1; i + 1 < argc; ++i)
        if (juce::String(argv[i]) == "--scan-result")
            resultPath = argv[i + 1];

    // Reproduce LANDR's behaviour: plugin-owned diagnostics contaminate
    // stdout before MiniHub can publish the scan result.
    std::cout << "SPLICE:: Validity...........: UNKNOWN_ERROR\n"
              << "SPLICE:: Format.............: 0\n"
              << "SPLICE:: Product............:\n";
    std::cerr << "Wmi error: Error executing query: WBEM_E_ACCESS_DENIED\n";

    if (requestedPath == kHungScanHelperPath)
    {
        juce::Thread::sleep(5000);
        return 3;
    }

    if (requestedPath == kCrashingScanHelperPath)
    {
        std::cout.flush();
        std::cerr.flush();
#if JUCE_WINDOWS
        ::TerminateProcess(::GetCurrentProcess(), 0xc0000005u);
#endif
        return 5;
    }

    const std::vector<mlh::PluginRecord> records { noisyScanHelperRecord() };
    const bool written = resultPath.isNotEmpty()
        && juce::File(resultPath).replaceWithText(
            mlh::Vst3Scanner::serializeScanResult(records), false, false, "\n");
    return written ? 0 : 2;
}

void testGestureRequired()
{
    mlh::GestureLearnState state;
    state.reset(3);
    expect(!state.valueChanged(1, 0.25f), "arbitrary value change is not a touch");
    expect(!state.consume().has_value(), "arbitrary change creates no pending touch");
    state.gestureChanged(1, true);
    expect(state.valueChanged(1, 0.25f), "value inside gesture is recorded");
    state.gestureChanged(1, false);
    const auto touch = state.consume();
    expect(touch.has_value(), "gesture touch is consumable");
    expect(touch && touch->parameterIndex == 1, "parameter index is preserved for ParamID lookup");
    expect(touch && std::abs(touch->normalizedValue - 0.25f) < 0.0001f,
           "normalized value is preserved");
}

void testLearnArmCancelAndAutoDisarm()
{
    mlh::GestureLearnState state;
    state.reset(2);
    state.setArmed(true);
    state.setArmed(false);
    state.gestureChanged(0, true);
    state.valueChanged(0, 0.4f);
    auto touch = state.consume();
    expect(touch && !touch->capturedByLearn, "cancelled Learn does not capture");

    state.setArmed(true);
    state.valueChanged(0, 0.6f);
    touch = state.consume();
    expect(touch && touch->capturedByLearn, "armed Learn captures next gesture value");
    expect(!state.isArmed(), "Learn automatically disarms after capture");
}

void testLearnCapturesOnlyPostArmAndFirstDistinctParameter()
{
    mlh::GestureLearnState state;
    state.reset(3);
    state.gestureChanged(0, true);
    state.valueChanged(0, 0.2f); // queued before Learn
    state.setArmed(true);
    expect(!state.consume().has_value(), "pre-arm touch is not captured by a later Learn click");

    state.gestureChanged(1, true);
    state.gestureChanged(2, true);
    expect(state.valueChanged(1, 0.4f), "first armed parameter is accepted");
    expect(!state.valueChanged(2, 0.9f), "second distinct armed parameter cannot replace the first");
    expect(state.valueChanged(1, 0.6f), "later value from the first parameter is retained");
    const auto touch = state.consume();
    expect(touch && touch->capturedByLearn, "post-arm touch is marked captured at record time");
    expect(touch && touch->parameterIndex == 1, "Learn keeps the first distinct parameter");
    expect(touch && std::abs(touch->normalizedValue - 0.6f) < 0.0001f,
           "Learn reports the latest value of the captured parameter");
}

void testResetDropsPendingAndArmedState()
{
    mlh::GestureLearnState state;
    state.reset(1);
    state.setArmed(true);
    state.gestureChanged(0, true);
    state.valueChanged(0, 0.8f);
    state.reset(0);
    expect(!state.consume().has_value(), "destruction/reset drops stale pending touch");
    expect(!state.isArmed(), "destruction/reset cancels Learn");
}

void testUtf8HostChromeAndMetronomeEvents()
{
    const juce::String hostTitle = mlh::pluginEditorWindowTitle("Plugin");
    const juce::String untouched = mlh::pluginEditorUntouchedText();
    const juce::String learnArmed = mlh::pluginEditorLearnArmedText();
    expect(hostTitle.length() == 16 && hostTitle[8] == juce::juce_wchar(0x00b7),
           "native MiniHub host title decodes its UTF-8 middle-dot as one Unicode code point");
    expect(untouched.length() == 15 && untouched[14] == juce::juce_wchar(0x2014),
           "native MiniHub host footer decodes its UTF-8 em-dash as one Unicode code point");
    expect(learnArmed.containsChar(juce::juce_wchar(0x2014)),
           "native Learn status cannot regress to mojibake");

    mlh::MetronomeTickQueue queue;
    for (int i = 0; i < 3; ++i)
    {
        mlh::MetronomeTick tick;
        tick.timeInSamples = 100 + i * 24000;
        tick.beat = i;
        tick.beatInBar = i;
        tick.accent = i == 0;
        expect(queue.push(tick), "audio-thread metronome tick enters the lock-free queue");
    }
    mlh::MetronomeTick tick;
    for (int64_t sequence = 1; sequence <= 3; ++sequence)
    {
        expect(queue.pop(tick) && tick.sequence == sequence,
               "metronome tick order and producer sequence survive the thread boundary");
    }
    expect(!queue.pop(tick), "drained metronome queue is empty");

    int64_t beat = -1;
    const double qps = 120.0 / (60.0 * 48000.0);
    expect(mlh::metronomeBeatAtSample(qps * 0.49, qps, beat) && beat == 0,
           "nearest sample is selected for a metronome beat boundary");
    expect(!mlh::metronomeBeatAtSample(qps * 0.75, qps, beat),
           "non-boundary samples cannot fabricate metronome UI events");

    expect(mlh::metronomePreCountSamples(qps, 4) == 96000,
           "four-beat pre-count duration is derived from the authoritative tempo and sample rate");
    for (int expectedBeat = 0; expectedBeat < 4; ++expectedBeat)
    {
        const auto sample = static_cast<int64_t>(expectedBeat * 24000);
        expect(mlh::metronomePreCountBeatAtSample(sample, qps, 4, beat)
                   && beat == expectedBeat,
               "native pre-count produces one real sample-clocked beat event");
    }
    expect(!mlh::metronomePreCountBeatAtSample(96000, qps, 4, beat),
           "record downbeat is not duplicated as a fifth pre-count click");
}

void testTransportTimingAndFreeze()
{
    mlh::Transport transport;
    transport.setSampleRate(48000.0);
    expect(!transport.playing(), "transport starts stopped");
    transport.advance(48000);
    expect(transport.samplePosition() == 0, "stopped transport freezes samples");
    transport.setPlaying(true);
    transport.beginBlock();
    transport.advance(48000);
    expect(transport.samplePosition() == 48000, "playing transport advances samples");
    expect(std::abs(transport.ppqPosition() - 2.0) < 0.000001, "120 BPM advances two quarter notes per second");
    transport.setBpm(60.0);
    transport.beginBlock();
    transport.advance(48000);
    expect(std::abs(transport.ppqPosition() - 3.0) < 0.000001, "BPM change preserves PPQ continuity");
    transport.setPlaying(false);
    transport.beginBlock();
    transport.advance(512);
    expect(transport.samplePosition() == 96000, "stop freezes the resumed position");
    transport.setBpm(500.0);
    transport.beginBlock();
    expect(transport.bpm() == 300.0, "BPM clamps to upper bound");
    const auto position=transport.getPosition();
    expect(position && position->getBpm() && *position->getBpm()==300.0,"PositionInfo exposes current BPM");
    expect(position && position->getTimeSignature()->numerator==4,"PositionInfo exposes time signature");
    expect(position && position->getTimeInSeconds(),"PositionInfo exposes derived seconds");
}

void testTransportSeekAndLoop()
{
    mlh::Transport transport;transport.setSampleRate(48000);transport.setBpm(120);transport.seekPpq(7.75);transport.setLoop(true,4,8);transport.setPlaying(true);transport.beginBlock();transport.advance(12000);
    expect(std::abs(transport.ppqPosition()-4.25)<.000001,"sample-clock transport wraps exactly inside its loop range");
    expect(transport.loopEnabled()&&transport.loopStart()==4&&transport.loopEnd()==8,"loop range is globally visible to plugins");
    transport.seekPpq(3.5);expect(std::abs(transport.ppqPosition()-3.5)<.000001,"seek replaces PPQ without UI timing");
    const auto position=transport.getPosition();expect(position&&position->getIsLooping(),"PositionInfo exposes global loop state");
}

void testMetronomePreCountPitchFamily()
{
    const float normal=mlh::metronomeClickPhaseIncrement(false,false),accent=mlh::metronomeClickPhaseIncrement(true,false);
    const float pre=mlh::metronomeClickPhaseIncrement(false,true),preAccent=mlh::metronomeClickPhaseIncrement(true,true);
    expect(std::abs(pre/normal-1.25f)<.0001f,"pre-count normal beat is moderately higher pitched");
    expect(std::abs(preAccent/accent-1.25f)<.0001f,"pre-count accent is moderately higher pitched");
    expect(accent>normal&&preAccent>pre,"beat-one accent pitch relationship is preserved within both click families");
}

void testLatePluginInheritsChainPlayHead()
{
    mlh::Transport transport;mlh::Chain chain("vst-test");chain.setPlayHead(&transport);
    auto plugin=std::make_unique<mlh::PluginInstance>();plugin->setInstanceId("plugin-1");auto* raw=plugin.get();
    expect(chain.insertPlugin(0,std::move(plugin)),"late plugin inserts into chain");
    expect(raw->assignedPlayHeadForTesting()==&transport,"late async plugin inherits live transport playhead");
}

mlh::AudioGraphNodeSpec graphNode(const char* id, mlh::AudioNodeKind kind)
{
    mlh::AudioGraphNodeSpec n; n.id=id; n.kind=kind; return n;
}

void testAudioDagCompileAndCycles()
{
    mlh::AudioGraphSpec spec;
    auto a=graphNode("source-a",mlh::AudioNodeKind::mixer);
    auto b=graphNode("source-b",mlh::AudioNodeKind::mixer);
    auto mix=graphNode("mixer-001",mlh::AudioNodeKind::mixer);
    mix.inputs={{"audio-in-1","source-a","audio-out",1,false},{"audio-in-2","source-b","audio-out",1,false}};
    auto out=graphNode("audio-output",mlh::AudioNodeKind::output);
    out.inputs={{"audio-in","mixer-001","audio-out",1,false}};
    spec.nodes={out,mix,b,a}; std::string error;
    auto plan=mlh::AudioExecutionPlan::compile(spec,[](const std::string&){return (mlh::Chain*)nullptr;},nullptr,512,error);
    expect(plan!=nullptr,"valid Mixer DAG compiles");
    expect(plan && plan->nodes().back().id=="audio-output","topological output is deterministic and last");

    spec.nodes[3].inputs={{"audio-in-1","audio-output","audio-out",1,false}};
    auto rejected=mlh::AudioExecutionPlan::compile(spec,[](const std::string&){return (mlh::Chain*)nullptr;},nullptr,512,error);
    expect(!rejected && error.find("source")!=std::string::npos,"Audio Output source/cycle is rejected");
}

void testPdcSourceDelayAcrossBlocks()
{
    constexpr int blockSize = 4;
    constexpr int latencySamples = 5;
    mlh::AudioExecutionPlan::SourceDelay compensated;
    compensated.prepare(latencySamples, blockSize);

    juce::AudioBuffer<float> first(2, blockSize);
    first.clear();
    first.setSample(0, 0, 1.0f);
    first.setSample(1, 0, -1.0f);
    const auto& firstOutput = compensated.process(first, blockSize);
    expect(firstOutput.getMagnitude(0, 0, blockSize) == 0.0f
               && firstOutput.getMagnitude(1, 0, blockSize) == 0.0f,
           "PDC holds an early source for the required latency across a block boundary");

    juce::AudioBuffer<float> second(2, blockSize);
    second.clear();
    const auto& secondOutput = compensated.process(second, blockSize);
    expect(secondOutput.getSample(0, 1) == 1.0f
               && secondOutput.getSample(1, 1) == -1.0f
               && secondOutput.getMagnitude(0, 0, 1) == 0.0f
               && secondOutput.getMagnitude(0, 2, 2) == 0.0f,
           "PDC emits the early source at the exact cumulative-latency sample");

    mlh::AudioExecutionPlan::SourceDelay unity;
    unity.prepare(0, blockSize);
    const auto& unityOutput = unity.process(first, blockSize);
    expect(&unityOutput == &first,
           "PDC zero-latency paths remain an allocation-free direct reference");
}

void testAudioStageMeasurements()
{
    mlh::AudioGraphSpec spec;
    auto input=graphNode("audio-input",mlh::AudioNodeKind::input);
    auto mix=graphNode("mixer-stage",mlh::AudioNodeKind::mixer);
    mix.inputs={{"audio-in-1","audio-input","audio-out",2.0f,false}};
    auto out=graphNode("audio-output",mlh::AudioNodeKind::output);
    out.inputs={{"audio-in","mixer-stage","audio-out",1.0f,false}};
    spec.nodes={out,mix,input};std::string error;
    auto plan=mlh::AudioExecutionPlan::compile(spec,[](const std::string&){return (mlh::Chain*)nullptr;},nullptr,64,error);
    expect(plan!=nullptr,"diagnostic Audio Input -> gain -> mix -> Audio Output graph compiles");
    if(!plan)return;
    juce::AudioBuffer<float> hardwareInput(2,64);hardwareInput.clear();
    for(int channel=0;channel<2;++channel)for(int sample=0;sample<64;++sample)
        hardwareInput.setSample(channel,sample,channel==0?.8f:.4f);
    float left[64]{},right[64]{};float* hardwareOutput[]={left,right};
    mlh::Transport transport;transport.setSampleRate(48000);transport.beginBlock();juce::MidiBuffer midi;
    plan->process(hardwareOutput,2,64,transport,midi,&hardwareInput);
    const auto& nodes=plan->nodes();
    const auto find=[&](mlh::AudioNodeKind kind)->const mlh::AudioExecutionPlan::Node*{
        const auto found=std::find_if(nodes.begin(),nodes.end(),[kind](const auto& node){return node.kind==kind;});
        return found==nodes.end()?nullptr:&*found;
    };
    const auto* source=find(mlh::AudioNodeKind::input);
    const auto* mixer=find(mlh::AudioNodeKind::mixer);
    const auto* output=find(mlh::AudioNodeKind::output);
    const auto sourceStats=source?mlh::measureAudioBlock(source->output,64):mlh::AudioBlockStatistics{};
    const auto mixStats=mixer?mlh::measureAudioBlock(mixer->output,64):mlh::AudioBlockStatistics{};
    const auto outputStats=output?mlh::measureAudioBlock(output->output,64):mlh::AudioBlockStatistics{};
    expect(std::abs(sourceStats.absolutePeak-.8f)<.0001f&&sourceStats.overRangeSamples==0,
           "diagnostic source/VST-equivalent stage is nominal before individual gain");
    expect(std::abs(mixStats.absolutePeak-1.6f)<.0001f&&mixStats.overRangeSamples==64,
           "Mixer preserves its completed floating-point sum above 0 dBFS");
    expect(std::abs(outputStats.absolutePeak-1.6f)<.0001f&&outputStats.overRangeSamples==64,
           "Audio Output receives the unchanged over-range Mixer branch");
    expect(std::abs(juce::FloatVectorOperations::findMaximum(left,64)-1.6f)<.0001f,
           "standalone graph output is an unclamped pre-Master float sum");
    const auto mixMeter=mixer&&mixer->signalMeter?mixer->signalMeter->takeTelemetrySnapshot():mlh::AudioSignalTelemetry{};
    expect(std::abs(mixMeter.inputPeak-1.6f)<.0001f
               &&std::abs(mixMeter.outputPeak-1.6f)<.0001f,
           "passive Mixer telemetry observes overload without changing it");
}

void testMorpherStepperMath()
{
    mlh::AudioExecutionPlan::Node n; n.kind=mlh::AudioNodeKind::morpher;n.stepCount=4;
    n.setStep(0,0.0f);n.setStep(1,1.0f);n.setStep(2,0.0f);n.setStep(3,1.0f);
    expect(std::abs(mlh::AudioExecutionPlan::morpherPosition(n,0.0)-0.0f)<0.0001f,"stepper starts at step one");
    expect(std::abs(mlh::AudioExecutionPlan::morpherPosition(n,0.5)-0.5f)<0.0001f,"stepper interpolates within step");
    expect(std::abs(mlh::AudioExecutionPlan::morpherPosition(n,3.5)-0.5f)<0.0001f,"last step interpolates to first");
    for(int count:{4,8,16,32}){n.stepCount=count;expect(mlh::AudioExecutionPlan::morpherPosition(n,4.0)==n.step(0),"pattern wraps after one bar");}
}

void testMixerAndMorpherNumerics()
{
    const float values[]={1.0f,0.5f},levels[]={1.0f,0.5f};const bool on[]={false,false},mute[]={false,true};
    expect(std::abs(mlh::AudioExecutionPlan::mixScalar(values,levels,on,2,1)-1.25f)<0.0001f,"Mixer sums sources with levels");
    expect(std::abs(mlh::AudioExecutionPlan::mixScalar(values,levels,mute,2,.5f)-.5f)<0.0001f,"Mixer mute and master gain");
    expect(mlh::AudioExecutionPlan::mixScalar(values,levels,on,0,1)==0,"Mixer zero input is silent");
    auto first=mlh::AudioExecutionPlan::equalPowerGains(0),mid=mlh::AudioExecutionPlan::equalPowerGains(.5f),last=mlh::AudioExecutionPlan::equalPowerGains(1);
    expect(std::abs(first.first-1)<.0001f&&std::abs(first.second)<.0001f,"Morpher exact first boundary");
    expect(std::abs(mid.first-std::sqrt(.5f))<.0001f&&std::abs(mid.second-std::sqrt(.5f))<.0001f,"Morpher equal-power midpoint");
    expect(std::abs(last.first)<.0001f&&std::abs(last.second-1)<.0001f,"Morpher exact last boundary");
}

void testLinearFloatSummationAndMasterMetering()
{
    constexpr int blockSize = 256;
    constexpr float sourceLevel = 0.4f;

    struct RenderResult {
        float sourcePeak = 0.0f;
        float mixPeak = 0.0f;
        float outputPeak = 0.0f;
        float firstGain = 0.0f;
    };
    const auto renderCopies = [blockSize](int sourceCount, float level) {
        mlh::AudioGraphSpec spec;
        auto input = graphNode("audio-input", mlh::AudioNodeKind::input);
        auto mix = graphNode("mixer-linear", mlh::AudioNodeKind::mixer);
        for (int i = 0; i < sourceCount; ++i)
            mix.inputs.push_back({ "audio-in-" + std::to_string(i + 1),
                                   "audio-input", "audio-out", 1.0f, false });
        auto output = graphNode("audio-output", mlh::AudioNodeKind::output);
        output.inputs = {{ "audio-in", "mixer-linear", "audio-out", 1.0f, false }};
        spec.nodes = { output, mix, input };
        std::string error;
        auto plan = mlh::AudioExecutionPlan::compile(spec,
            [](const std::string&) { return static_cast<mlh::Chain*>(nullptr); },
            nullptr, blockSize, error);
        RenderResult result;
        if (!plan) return result;
        juce::AudioBuffer<float> hardwareInput(2, blockSize);
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < blockSize; ++sample)
                hardwareInput.setSample(channel, sample, level);
        std::array<float, 256> left {}, right {};
        float* hardware[] = { left.data(), right.data() };
        mlh::Transport transport; transport.setSampleRate(48000.0); transport.beginBlock();
        juce::MidiBuffer midi;
        plan->process(hardware, 2, blockSize, transport, midi, &hardwareInput);
        for (const auto& node : plan->nodes())
        {
            const float peak = mlh::measureAudioBlock(node.output, blockSize).absolutePeak;
            if (node.kind == mlh::AudioNodeKind::input) result.sourcePeak = peak;
            if (node.kind == mlh::AudioNodeKind::mixer)
            {
                result.mixPeak = peak;
                result.firstGain = node.sources.empty() ? 0.0f : node.level(0) * node.masterLevel();
            }
            if (node.kind == mlh::AudioNodeKind::output) result.outputPeak = peak;
        }
        return result;
    };

    // A — unity: one track at gain 1.0 is bit-stable and has no slow envelope.
    const auto unity = renderCopies(1, sourceLevel);
    expect(std::abs(unity.sourcePeak-sourceLevel)<1.0e-7f
               &&std::abs(unity.mixPeak-sourceLevel)<1.0e-7f
               &&std::abs(unity.outputPeak-sourceLevel)<1.0e-7f,
           "Test A: unity track output equals its input exactly");
    mlh::AudioSignalMeter passive;
    juce::AudioBuffer<float> held(2, blockSize);
    for(int channel=0;channel<2;++channel)for(int sample=0;sample<blockSize;++sample)
        held.setSample(channel,sample,sourceLevel);
    for(int block=0;block<3750;++block)
        passive.observe(held,blockSize,mlh::AudioSignalBoundary::output); // 20 s at 48 kHz
    expect(std::abs(held.getSample(0,blockSize-1)-sourceLevel)<1.0e-7f,
           "Test A: 20 seconds of passive diagnostics cannot modulate a held signal");

    // B/C — adding a second correlated source changes only the sum (+6.0206 dB).
    const auto two = renderCopies(2, sourceLevel);
    expect(std::abs(two.sourcePeak-unity.sourcePeak)<1.0e-7f
               &&std::abs(two.firstGain-unity.firstGain)<1.0e-7f,
           "Test B: Track 1 buffer and gain remain identical when Track 2 is added");
    expect(std::abs(two.mixPeak-sourceLevel*2.0f)<1.0e-7f
               &&std::abs(juce::Decibels::gainToDecibels(two.mixPeak/unity.mixPeak)-6.0206f)<.001f,
           "Test C: two correlated unity sources sum linearly at +6.0206 dB");

    // D — an existing silent VST track is a pure zero addend.
    mlh::Chain silentChain("silent-vst");
    mlh::AudioGraphSpec silenceSpec;
    auto input=graphNode("audio-input",mlh::AudioNodeKind::input);
    auto silent=graphNode("silent-vst",mlh::AudioNodeKind::vst);
    auto mix=graphNode("mixer-silence",mlh::AudioNodeKind::mixer);
    mix.inputs={{"audio-in-1","audio-input","audio-out",1.0f,false},
                {"audio-in-2","silent-vst","audio-out",1.0f,false}};
    auto output=graphNode("audio-output",mlh::AudioNodeKind::output);
    output.inputs={{"audio-in","mixer-silence","audio-out",1.0f,false}};
    silenceSpec.nodes={output,mix,silent,input};std::string silenceError;
    auto silencePlan=mlh::AudioExecutionPlan::compile(silenceSpec,
        [&](const std::string& id){return id=="silent-vst"?&silentChain:nullptr;},
        nullptr,blockSize,silenceError);
    juce::AudioBuffer<float> silenceInput(2,blockSize);
    for(int channel=0;channel<2;++channel)for(int sample=0;sample<blockSize;++sample)
        silenceInput.setSample(channel,sample,sourceLevel);
    float silentLeft[blockSize]{},silentRight[blockSize]{};float* silentOutput[]={silentLeft,silentRight};
    mlh::Transport silenceTransport;silenceTransport.setSampleRate(48000);silenceTransport.beginBlock();juce::MidiBuffer silenceMidi;
    if(silencePlan)silencePlan->process(silentOutput,2,blockSize,silenceTransport,silenceMidi,&silenceInput);
    expect(silencePlan&&std::abs(juce::FloatVectorOperations::findMaximum(silentLeft,blockSize)-unity.outputPeak)<1.0e-7f,
           "Test D: a present but silent Track 2 cannot change Track 1 level");

    // E — source count never introduces division or compensation.
    for(const int count:{1,2,4,8})
    {
        const auto rendered=renderCopies(count,sourceLevel);
        expect(std::abs(rendered.mixPeak-sourceLevel*count)<1.0e-6f
                   &&std::abs(rendered.firstGain-1.0f)<1.0e-7f,
               "Test E: 1/2/4/8 tracks preserve unity coefficients and direct sums");
    }

    // Master is static gain + meter + CLIP. Over-range floats are not reduced.
    juce::AudioBuffer<float> deliberateOverload(2,64);
    for(int channel=0;channel<2;++channel)for(int sample=0;sample<64;++sample)
        deliberateOverload.setSample(channel,sample,1.25f);
    float* overloadChannels[]={deliberateOverload.getWritePointer(0),deliberateOverload.getWritePointer(1)};
    mlh::MasterOutput unityMaster;unityMaster.prepare(48000);unityMaster.process(overloadChannels,2,64);
    const auto overloadMeter=unityMaster.takeMeterSnapshot();
    expect(std::abs(deliberateOverload.getSample(0,0)-1.25f)<1.0e-7f
               &&overloadMeter.clipLatched&&overloadMeter.overRangeSamples==128,
           "Master unity passes over-range floats unchanged and latches CLIP");
    unityMaster.resetClip();
    expect(!unityMaster.takeMeterSnapshot().clipLatched,
           "persistent Master CLIP resets only on explicit request");

    juce::AudioBuffer<float> positiveGainSignal(2,64);
    for(int channel=0;channel<2;++channel)for(int sample=0;sample<64;++sample)
        positiveGainSignal.setSample(channel,sample,1.25f);
    mlh::MasterOutput positiveMaster;positiveMaster.setGainDb(6.0f);positiveMaster.prepare(48000);
    float* positiveChannels[]={positiveGainSignal.getWritePointer(0),positiveGainSignal.getWritePointer(1)};
    positiveMaster.process(positiveChannels,2,64);
    expect(std::abs(positiveGainSignal.getSample(0,0)
               -1.25f*juce::Decibels::decibelsToGain(6.0f))<1.0e-6f,
           "positive Master gain multiplies the over-range float without reserved-headroom reduction");

    // Only explicit fader movement is smoothed, over a short 20 ms ramp.
    juce::AudioBuffer<float> quiet(2,2048);
    for(int channel=0;channel<2;++channel)for(int sample=0;sample<quiet.getNumSamples();++sample)
        quiet.setSample(channel,sample,channel==0?.25f:-.125f);
    float* quietChannels[]={quiet.getWritePointer(0),quiet.getWritePointer(1)};
    mlh::MasterOutput ramped;ramped.prepare(48000);ramped.setGainDb(-12.0f);
    ramped.process(quietChannels,2,quiet.getNumSamples());
    expect(std::abs(quiet.getSample(0,1500)-.25f*juce::Decibels::decibelsToGain(-12.0f))<1.0e-5f,
           "Master fader reaches and holds its target after the 20 ms anti-click ramp");

    juce::AudioBuffer<float> invalid(2,4);invalid.clear();
    invalid.setSample(0,0,std::numeric_limits<float>::quiet_NaN());
    invalid.setSample(1,1,std::numeric_limits<float>::infinity());
    float* invalidChannels[]={invalid.getWritePointer(0),invalid.getWritePointer(1)};
    mlh::MasterOutput finalBoundary;finalBoundary.prepare(48000);finalBoundary.process(invalidChannels,2,4);
    expect(mlh::measureAudioBlock(invalid,invalid.getNumSamples()).finite,
           "final Master/device boundary substitutes non-finite samples only");
}

void testArpeggiatorMusicAndTiming()
{
    expect(mlh::ArpeggiatorRuntime::degreeToMidi(0, 1, 1, 0) == 60, "C major degree 1 is C4");
    expect(mlh::ArpeggiatorRuntime::degreeToMidi(0, 1, 8, 0) == 72, "degree 8 crosses a scale octave");
    expect(mlh::ArpeggiatorRuntime::degreeToMidi(5, 4, 3, 0) == 68, "F Dorian degree 3 is Ab4");
    expect(mlh::ArpeggiatorRuntime::degreeToMidi(0, 2, 1, -1) == 48, "octave offset transposes by twelve");
    expect(mlh::ArpeggiatorRuntime::semitoneOffsetToMidi(0, 6) == 66, "Custom accepts chromatic F sharp outside C minor");
    expect(mlh::ArpeggiatorRuntime::semitoneOffsetToMidi(2, 6) == 68, "changing Root transposes the Custom offset");
    expect(std::abs(mlh::ArpeggiatorRuntime::stepQuarterNotes(0)-1.0)<.0001, "quarter rate timing");
    expect(std::abs(mlh::ArpeggiatorRuntime::stepQuarterNotes(3)-.125)<.0001, "thirty-second rate timing");

    mlh::ArpConfig config; config.mode=0; config.rate=2; config.patternLength=16;
    mlh::ArpeggiatorRuntime arp(config); mlh::Chain destination("test"); destination.setMidiEnabled(true);
    std::vector<mlh::MidiDestination> outputs{{mlh::MidiDestinationKind::chain,&destination}}; mlh::Transport transport; transport.setSampleRate(48000); transport.beginBlock();
    arp.pushInput(juce::MidiMessage::noteOn(1,60,(juce::uint8)91));
    arp.pushInput(juce::MidiMessage::noteOn(1,64,(juce::uint8)92));
    arp.pushInput(juce::MidiMessage::noteOn(1,67,(juce::uint8)93));
    arp.process(512,transport,outputs);
    expect(arp.heldCountForTesting()==3 && arp.holdsNoteForTesting(60)
        && arp.holdsNoteForTesting(64) && arp.holdsNoteForTesting(67),
        "native Arpeggiator receives the physical C-E-G held state");
    juce::MidiBuffer midi; destination.pullMidi(midi,512);
    expect(midi.isEmpty(),"stopped transport holds notes but does not schedule output");

    arp.pushInput(juce::MidiMessage::noteOff(1,64)); arp.process(512,transport,outputs);
    expect(arp.heldCountForTesting()==2 && arp.holdsNoteForTesting(60)
        && !arp.holdsNoteForTesting(64) && arp.holdsNoteForTesting(67),
        "native held state removes E on physical Note Off");
    arp.pushInput(juce::MidiMessage::noteOn(1,64,(juce::uint8)92)); arp.process(512,transport,outputs);

    transport.setPlaying(true); transport.beginBlock();
    std::vector<int> generated;
    for(int block=0;block<3;++block){
        arp.process(6000,transport,outputs); midi.clear(); destination.pullMidi(midi,6000);
        for(const auto& e:midi)if(e.getMessage().isNoteOn())generated.push_back(e.getMessage().getNoteNumber());
        transport.advance(6000); transport.beginBlock();
    }
    expect(generated==std::vector<int>({60,64,67}),"Up + 1/16 emits deterministic C-E-G into the VST destination buffer");
    transport.advance(6000);transport.setPlaying(false);transport.beginBlock();arp.process(512,transport,outputs);midi.clear();destination.pullMidi(midi,512);
    bool sawCleanup=false;for(const auto&e:midi)sawCleanup|=e.getMessage().isNoteOff()||e.getMessage().isAllNotesOff();
    expect(sawCleanup,"transport stop emits note cleanup");

    mlh::ArpConfig custom;custom.mode=5;custom.rate=2;custom.patternLength=4;custom.root=0;custom.scale=2;
    for(auto& step:custom.steps)step.rest=true;
    custom.steps[0].rest=false;custom.steps[0].semitoneOffset=6;custom.steps[0].velocity=77;custom.steps[0].gate=.5f;
    custom.steps[1].tie=true;
    mlh::ArpeggiatorRuntime customArp(custom);mlh::Chain customDestination("custom-test");customDestination.setMidiEnabled(true);
    std::vector<mlh::MidiDestination> customOutputs{{mlh::MidiDestinationKind::chain,&customDestination}};mlh::Transport customTransport;customTransport.setSampleRate(48000);customTransport.setPlaying(true);customTransport.beginBlock();
    customArp.pushInput(juce::MidiMessage::noteOn(1,60,(juce::uint8)100));customArp.process(6000,customTransport,customOutputs);
    midi.clear();customDestination.pullMidi(midi,6000);int customNote=-1,customVelocity=-1;for(const auto& e:midi)if(e.getMessage().isNoteOn()){customNote=e.getMessage().getNoteNumber();customVelocity=e.getMessage().getVelocity();}
    expect(customNote==66&&customVelocity==77,"native Custom schedules the stored chromatic offset and velocity without scale quantization");
    customTransport.advance(6000);customTransport.beginBlock();customArp.process(6000,customTransport,customOutputs);midi.clear();customDestination.pullMidi(midi,6000);
    int tiedNoteOffSample=-1;for(const auto& e:midi)if(e.getMessage().isNoteOff())tiedNoteOffSample=e.samplePosition;
    expect(tiedNoteOffSample>0,"native Tie extends the Custom note past the following step boundary before note-off");
}

void testAudioTakeWriter()
{
    mlh::AudioTakeWriter writer("native-test");writer.prepare(48000,256);expect(writer.begin(),"Sequencer audio-track writer opens a take");
    juce::AudioBuffer<float> input(2,480);for(int i=0;i<480;++i){input.setSample(0,i,float(i)/480.0f);input.setSample(1,i,-float(i)/480.0f);}writer.process(input,480);writer.stop();expect(std::abs(writer.duration()-.01)<.0001,"audio take duration is a native frame count");
    juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(writer.takeFile().createInputStream().release(),true));expect(reader&&reader->sampleRate==48000&&reader->lengthInSamples==480&&reader->bitsPerSample==32,"track capture is a valid 32-bit WAV");reader.reset();writer.takeFile().deleteFile();
}


juce::var makeSequencerProject(const juce::Array<juce::var>& tracks)
{
    juce::var project=mlh::makeObject();mlh::setProp(project,"tracks",tracks);return project;
}

juce::File makeSineWav(int frames=4800)
{
    auto file=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("MiniHub-sequencer-source",".wav");
    std::unique_ptr<juce::OutputStream> stream=file.createOutputStream();juce::WavAudioFormat wav;auto writer=wav.createWriterFor(stream,juce::AudioFormatWriter::Options{}.withSampleRate(48000).withNumChannels(2).withBitsPerSample(32));juce::AudioBuffer<float> audio(2,frames);for(int i=0;i<frames;++i){const float value=.4f*std::sin(float(i)*.05f);audio.setSample(0,i,value);audio.setSample(1,i,value*.5f);}writer->writeFromAudioSampleBuffer(audio,0,frames);writer.reset();return file;
}

juce::var midiTrack(const char* id,const char* destination,bool armed=false)
{
    juce::var track=mlh::makeObject();mlh::setProp(track,"id",id);mlh::setProp(track,"type","midi");mlh::setProp(track,"inputId","in-1");mlh::setProp(track,"outputId",destination);mlh::setProp(track,"armed",armed);mlh::setProp(track,"muted",false);mlh::setProp(track,"volume",1.0);
    juce::var clip=mlh::makeObject();mlh::setProp(clip,"id","clip-midi");mlh::setProp(clip,"startPpq",0.0);mlh::setProp(clip,"lengthPpq",4.0);juce::var note=mlh::makeObject();mlh::setProp(note,"startPpq",0.0);mlh::setProp(note,"durationPpq",.5);mlh::setProp(note,"pitch",64);mlh::setProp(note,"velocity",87);mlh::setProp(note,"channel",3);juce::Array<juce::var> notes;notes.add(note);mlh::setProp(clip,"notes",notes);juce::Array<juce::var> clips;clips.add(clip);mlh::setProp(track,"clips",clips);return track;
}

juce::var midiNote(double start,double duration,int pitch,int velocity=100,int channel=1)
{
    juce::var note=mlh::makeObject();mlh::setProp(note,"startPpq",start);mlh::setProp(note,"durationPpq",duration);mlh::setProp(note,"pitch",pitch);mlh::setProp(note,"velocity",velocity);mlh::setProp(note,"channel",channel);return note;
}

void replaceMidiNotes(juce::var& track,const juce::Array<juce::var>& notes)
{
    auto* clips=track["clips"].getArray();expect(clips&&clips->size()==1,"test MIDI track owns one clip");if(clips&&clips->size())mlh::setProp(clips->getReference(0),"notes",notes);
}

juce::var audioTrack(const char* id,const juce::File& file,bool armed=false,const char* source="audio-input",bool muted=false,const char* output="mixer-001",double volume=.75)
{
    juce::var track=mlh::makeObject();mlh::setProp(track,"id",id);mlh::setProp(track,"type","audio");mlh::setProp(track,"inputId",source);mlh::setProp(track,"outputId",output);mlh::setProp(track,"armed",armed);mlh::setProp(track,"muted",muted);mlh::setProp(track,"volume",volume);
    juce::Array<juce::var> clips;if(file.existsAsFile()){juce::var clip=mlh::makeObject();mlh::setProp(clip,"id",juce::String("clip-")+id);mlh::setProp(clip,"filePath",file.getFullPathName());mlh::setProp(clip,"startPpq",0.0);mlh::setProp(clip,"lengthPpq",4.0);mlh::setProp(clip,"trimStartSeconds",0.0);mlh::setProp(clip,"trimEndSeconds",.1);mlh::setProp(clip,"gain",1.0);clips.add(clip);}mlh::setProp(track,"clips",clips);return track;
}

void testSequencerMidiSchedulingAndRecording()
{
    mlh::SequencerEngine sequencer;sequencer.prepare(48000,12000);mlh::Chain destination("vst-001");destination.setMidiEnabled(true);
    juce::Array<juce::var> tracks;tracks.add(midiTrack("track-midi","vst-001",true));juce::Array<juce::var> info;std::string error;
    expect(sequencer.sync(makeSequencerProject(tracks),[&](const std::string&id){return id=="vst-001"?&destination:nullptr;},48000,12000,info,error),"native MIDI arrangement compiles");
    mlh::Transport transport;transport.setSampleRate(48000);transport.setPlaying(true);transport.beginBlock();sequencer.processMidi(12000,transport);juce::MidiBuffer midi;destination.pullMidi(midi,12000);
    int ons=0;for(const auto& event:midi)if(event.getMessage().isNoteOn()){++ons;expect(event.samplePosition==0&&event.getMessage().getNoteNumber()==64&&event.getMessage().getVelocity()==87&&event.getMessage().getChannel()==3,"MIDI note on retains exact sample, pitch, velocity and channel");}expect(ons==1,"one deterministic note-on is scheduled");
    transport.advance(12000);transport.beginBlock();sequencer.processMidi(12000,transport);midi.clear();destination.pullMidi(midi,12000);bool off=false;for(const auto& event:midi)off|=event.getMessage().isNoteOff()&&event.samplePosition==0;expect(off,"duration schedules note-off at the exact following block boundary");

    transport.seekPpq(1.9);sequencer.beginRecording(transport);transport.seekPpq(2);sequencer.recordMidiInput("in-1",juce::MidiMessage::noteOn(5,72,(juce::uint8)99),-10,transport);transport.seekPpq(2.5);sequencer.recordMidiInput("in-1",juce::MidiMessage::noteOff(5,72),0,transport);const auto recorded=sequencer.finishRecording(transport);
    expect(recorded.size()==1,"armed MIDI track creates one native recording result");if(recorded.size()){const auto* events=recorded[0]["events"].getArray();expect(events&&events->size()==1,"recorded note on/off pair becomes one editable event");if(events&&events->size())expect((int)(*events)[0]["pitch"]==72&&(int)(*events)[0]["velocity"]==99&&(int)(*events)[0]["channel"]==5&&(double)(*events)[0]["durationPpq"]>.5,"recording preserves channel/velocity and applies existing timing compensation");}
    sequencer.panic();destination.pullMidi(midi,512); // panic is delivered by Chain on its next process block in the full engine
}

void testSequencerMidiStressLoopSeekAndStop()
{
    mlh::SequencerEngine sequencer;sequencer.prepare(48000,24001);mlh::Chain destination("vst-stress");destination.setMidiEnabled(true);
    juce::var track=midiTrack("track-stress","vst-stress");mlh::setProp(track,"volume",.5);juce::Array<juce::var> notes;for(int i=0;i<512;++i)notes.add(midiNote(0,.25,127-(i%128),100,1+(i%16)));replaceMidiNotes(track,notes);
    juce::Array<juce::var> tracks;tracks.add(track);juce::Array<juce::var> info;std::string error;expect(sequencer.sync(makeSequencerProject(tracks),[&](const std::string&id){return id=="vst-stress"?&destination:nullptr;},48000,24001,info,error),"large deterministic MIDI arrangement compiles");
    mlh::Transport transport;transport.setSampleRate(48000);transport.setPlaying(true);transport.beginBlock();sequencer.processMidi(6000,transport);juce::MidiBuffer midi;destination.pullMidi(midi,6000);int noteOns=0,lastPitch=-1;for(const auto& event:midi)if(event.getMessage().isNoteOn()){++noteOns;expect(event.getMessage().getVelocity()==100,"track gain preserves authored MIDI velocity and therefore instrument timbre");expect(event.getMessage().getNoteNumber()>=lastPitch,"simultaneous notes are deterministically pitch ordered");lastPitch=event.getMessage().getNoteNumber();}expect(noteOns==512,"large chord schedules every note-on without renderer timing");
    transport.advance(6000);transport.beginBlock();sequencer.processMidi(256,transport);midi.clear();destination.pullMidi(midi,256);int noteOffs=0;for(const auto& event:midi)if(event.getMessage().isNoteOff())++noteOffs;expect(noteOffs==512,"large chord schedules every duration-derived note-off");

    juce::var loopTrack=midiTrack("track-loop","vst-stress");juce::Array<juce::var> loopNotes;loopNotes.add(midiNote(.5,.75,73,110,2));replaceMidiNotes(loopTrack,loopNotes);tracks.clear();tracks.add(loopTrack);expect(sequencer.sync(makeSequencerProject(tracks),[&](const std::string&id){return id=="vst-stress"?&destination:nullptr;},48000,24001,info,error),"loop MIDI arrangement compiles");
    transport.setBpm(120);transport.setLoop(true,0,1);transport.seekPpq(.5);transport.setPlaying(true);transport.beginBlock();sequencer.processMidi(6000,transport);midi.clear();destination.pullMidi(midi,6000);bool loopOn=false;for(const auto& event:midi)loopOn|=event.getMessage().isNoteOn()&&event.getMessage().getNoteNumber()==73&&event.samplePosition==0;expect(loopOn,"loop pass starts its note at the exact sample");
    transport.advance(6000);transport.beginBlock();sequencer.processMidi(6000,transport);midi.clear();destination.pullMidi(midi,6000);bool boundaryOff=false;for(const auto& event:midi)boundaryOff|=event.getMessage().isNoteOff()&&event.getMessage().getNoteNumber()==73&&event.samplePosition==5999;expect(boundaryOff,"note crossing loop end is closed at the exact callback boundary without sticking");
    transport.advance(6000);transport.setLoop(false,0,1);transport.seekPpq(.75);sequencer.panic();transport.beginBlock();sequencer.processMidi(256,transport);midi.clear();destination.pullMidi(midi,256);bool chased=false;for(const auto& event:midi)chased|=event.getMessage().isNoteOn()&&event.getMessage().getNoteNumber()==73&&event.samplePosition==0;expect(chased,"seek into a sustained note performs deterministic note chase");
    sequencer.panic();juce::AudioBuffer<float> silence(2,256);silence.clear();midi.clear();destination.processBlock(silence,midi,256,0);bool cleanup=false;for(const auto& event:midi)cleanup|=event.getMessage().isAllNotesOff()||event.getMessage().isAllSoundOff();expect(cleanup,"Stop/seek panic reaches the VST chain and prevents stuck notes");

    bool repeatedStop=true;for(int pass=0;pass<100;++pass){juce::MidiBuffer note;note.addEvent(juce::MidiMessage::noteOn(1,60+(pass%12),(juce::uint8)100),0);destination.pushMidi(note);midi.clear();silence.clear();destination.processBlock(silence,midi,256,0);destination.panic();midi.clear();destination.processBlock(silence,midi,256,0);bool explicitOff=false,notesAfterStop=false;for(const auto& item:midi){explicitOff|=item.getMessage().isNoteOff();notesAfterStop|=item.getMessage().isNoteOn();}repeatedStop&=explicitOff&&!notesAfterStop;}expect(repeatedStop,"100 Play/Stop-equivalent chain cycles emit explicit Note Off and no post-Stop Note On");
    const auto staleEpoch=destination.midiEpoch();destination.panic();juce::MidiBuffer stale;stale.addEvent(juce::MidiMessage::noteOn(1,99,(juce::uint8)100),0);destination.pushMidi(stale,staleEpoch);midi.clear();destination.processBlock(silence,midi,256,0);bool staleOn=false;for(const auto& item:midi)staleOn|=item.getMessage().isNoteOn()&&item.getMessage().getNoteNumber()==99;expect(!staleOn,"Stop epoch invalidates a Note On produced by an already-running stale callback");
    destination.panic();const auto resumedEpoch=destination.midiEpoch();juce::MidiBuffer resumed;resumed.addEvent(juce::MidiMessage::noteOn(1,88,(juce::uint8)100),0);destination.pushMidi(resumed,resumedEpoch);midi.clear();destination.processBlock(silence,midi,256,0);bool resumedOn=false;for(const auto& item:midi)resumedOn|=item.getMessage().isNoteOn()&&item.getMessage().getNoteNumber()==88;expect(resumedOn,"Play immediately after Stop accepts the new epoch after cleanup");destination.panic();midi.clear();destination.processBlock(silence,midi,256,0);

    auto* trimmedClips=loopTrack["clips"].getArray();if(trimmedClips&&trimmedClips->size()){mlh::setProp(trimmedClips->getReference(0),"sourceOffsetPpq",.25);mlh::setProp(trimmedClips->getReference(0),"lengthPpq",.5);}tracks.clear();tracks.add(loopTrack);expect(sequencer.sync(makeSequencerProject(tracks),[&](const std::string&id){return id=="vst-stress"?&destination:nullptr;},48000,24001,info,error),"non-destructively trimmed MIDI clip compiles");transport.setLoop(false,0,1);transport.seekPpq(.25);transport.setPlaying(true);sequencer.panic();transport.beginBlock();sequencer.processMidi(256,transport);midi.clear();destination.pullMidi(midi,256);bool trimmedOn=false;for(const auto& event:midi)trimmedOn|=event.getMessage().isNoteOn()&&event.getMessage().getNoteNumber()==73&&event.samplePosition==0;expect(trimmedOn,"MIDI source offset keeps stored notes intact while the trimmed playback boundary is exact");

    if(trimmedClips&&trimmedClips->size()){mlh::setProp(trimmedClips->getReference(0),"sourceOffsetPpq",0.0);mlh::setProp(trimmedClips->getReference(0),"lengthPpq",4.0);}tracks.clear();tracks.add(loopTrack);expect(sequencer.sync(makeSequencerProject(tracks),[&](const std::string&id){return id=="vst-stress"?&destination:nullptr;},48000,24001,info,error),"MIDI arrangement restores after trim test");transport.setBpm(60);transport.seekPpq(0);sequencer.panic();transport.beginBlock();sequencer.processMidi(24001,transport);midi.clear();destination.pullMidi(midi,24001);bool bpmExact=false;for(const auto& event:midi)bpmExact|=event.getMessage().isNoteOn()&&event.samplePosition==24000;expect(bpmExact,"BPM changes immediately alter native sample scheduling without moving musical PPQ");
}

class CapturingMidiOutput final : public mlh::MidiOutputSink {
public:
    void sendBlock(const juce::MidiBuffer& buffer,double start,double rate) noexcept override
    {
        ++blocks;lastStartMs=start;lastSampleRate=rate;captured.addEvents(buffer,0,-1,0);
    }
    void panic() noexcept override { ++panics;captured.clear(); }
    juce::MidiBuffer captured;int blocks=0,panics=0;double lastStartMs=0,lastSampleRate=0;
};

void testSequencerPhysicalMidiOutputAndArpeggiatorRoute()
{
    mlh::SequencerEngine sequencer;sequencer.prepare(48000,12000);CapturingMidiOutput hardware;
    auto direct=midiTrack("track-hardware","minilab-3");mlh::setProp(direct,"outputKind","midi-output");juce::Array<juce::var> tracks;tracks.add(direct);juce::Array<juce::var> info;std::string error;
    expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,12000,info,error),"physical MIDI destination compiles without a second MIDI engine");
    mlh::Transport transport;transport.setSampleRate(48000);transport.setPlaying(true);transport.beginBlock();sequencer.processMidi(12000,transport,nullptr,&hardware,4321.0);
    int ons=0;for(const auto& event:hardware.captured)if(event.getMessage().isNoteOn()){++ons;expect(event.samplePosition==0&&event.getMessage().getVelocity()==87&&event.getMessage().getChannel()==3,"hardware MIDI keeps sample offset, velocity and channel");}
    expect(ons==1&&hardware.blocks==1&&hardware.lastStartMs==4321.0&&hardware.lastSampleRate==48000,"hardware MIDI uses the native timestamped block contract");
    transport.advance(12000);transport.beginBlock();hardware.captured.clear();sequencer.processMidi(12000,transport,nullptr,&hardware,4571.0);bool off=false;for(const auto& event:hardware.captured)off|=event.getMessage().isNoteOff()&&event.samplePosition==0;expect(off,"hardware MIDI schedules duration-derived Note Off");
    transport.seekPpq(.25);sequencer.panic();transport.beginBlock();hardware.captured.clear();sequencer.processMidi(256,transport,nullptr,&hardware,5000.0);bool chase=false;for(const auto& event:hardware.captured)chase|=event.getMessage().isNoteOn()&&event.samplePosition==0;expect(chase,"hardware MIDI seek performs native note chase");hardware.panic();expect(hardware.panics==1&&hardware.captured.isEmpty(),"hardware MIDI Stop/panic clears pending notes");

    mlh::Chain destination("vst-arp-route");destination.setMidiEnabled(true);mlh::MidiGraphSpec graphSpec;mlh::MidiGraphNodeSpec arp;arp.id="arp-route";arp.kind="arpeggiator";arp.arp.rate=2;arp.arp.patternLength=16;arp.destinations={"vst-arp-route"};graphSpec.nodes.push_back(arp);auto midiPlan=mlh::MidiExecutionPlan::compile(graphSpec,[&](const std::string&id){return id=="vst-arp-route"?&destination:nullptr;},error);expect(midiPlan!=nullptr,"existing native Arpeggiator graph compiles for a Sequencer source");
    auto arpTrack=midiTrack("track-arp","arp-route");mlh::setProp(arpTrack,"outputKind","arpeggiator");juce::Array<juce::var> arpNotes;arpNotes.add(midiNote(.125,.5,60,100,4));replaceMidiNotes(arpTrack,arpNotes);tracks.clear();tracks.add(arpTrack);expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,12000,info,error),"Sequencer track accepts the existing Arpeggiator node as destination");
    transport.setLoop(false,0,4);transport.seekPpq(0);transport.setPlaying(true);transport.beginBlock();sequencer.processMidi(12000,transport,midiPlan.get());midiPlan->process(12000,transport);juce::MidiBuffer midi;destination.pullMidi(midi,12000);int arpOnSample=-1;for(const auto& event:midi)if(event.getMessage().isNoteOn())arpOnSample=event.samplePosition;expect(arpOnSample==6000,"Sequencer timestamp enters the existing Arpeggiator before its exact next 1/16 step");
}

juce::File deterministicVst3()
{
    auto root=juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory().getParentDirectory();
    juce::Array<juce::File> found;root.findChildFiles(found,juce::File::findFilesAndDirectories,true,"MiniHub Deterministic Test Instrument.vst3");
    for(const auto& file:found)if(file.isDirectory())return file;
    return {};
}

juce::File deterministicEffectVst3()
{
    auto root=juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory().getParentDirectory();
    juce::Array<juce::File> found;root.findChildFiles(found,juce::File::findFilesAndDirectories,true,"MiniHub Deterministic Test Effect.vst3");
    for(const auto& file:found)if(file.isDirectory())return file;
    return {};
}

void logProcessorContract(const char* phase, juce::AudioProcessor& processor)
{
    std::cerr << "[vst3-direct] " << phase
              << " inputBuses=" << processor.getBusCount(true)
              << " outputBuses=" << processor.getBusCount(false)
              << " totalInputs=" << processor.getTotalNumInputChannels()
              << " totalOutputs=" << processor.getTotalNumOutputChannels()
              << " mainInputs=" << processor.getMainBusNumInputChannels()
              << " mainOutputs=" << processor.getMainBusNumOutputChannels()
              << " sampleRate=" << processor.getSampleRate()
              << " blockSize=" << processor.getBlockSize()
              << " precision=" << (processor.getProcessingPrecision()==juce::AudioProcessor::doublePrecision?"double":"single")
              << " acceptsMidi=" << processor.acceptsMidi()
              << " producesMidi=" << processor.producesMidi()
              << " suspended=" << processor.isSuspended() << '\n';
    for (bool input : {true,false}) for (int index=0;index<processor.getBusCount(input);++index)
    {
        auto* bus=processor.getBus(input,index);
        std::cerr << "[vst3-direct] " << phase << ' ' << (input?"input":"output")
                  << "Bus=" << index << " enabled=" << (bus&&bus->isEnabled())
                  << " channels=" << (bus?bus->getNumberOfChannels():-1)
                  << " layout=" << (bus?bus->getCurrentLayout().getDescription():juce::String("missing"))
                  << '\n';
    }
}

bool testDirectJuceVst3(const mlh::PluginRecord& record)
{
    std::cerr << "[vst3-direct] create\n";
    juce::AudioPluginFormatManager formats;formats.addFormat(std::make_unique<juce::VST3PluginFormat>());juce::String error;
    auto processor=formats.createPluginInstance(record.description,48000.0,256,error);
    expect(processor!=nullptr,"JUCE AudioPluginFormatManager creates the test VST3 directly");
    if(!processor){std::cerr << "[vst3-direct] create failed: " << error << '\n';return false;}
    logProcessorContract("created",*processor);
    const auto initialLayout=processor->getBusesLayout();
    expect(processor->checkBusesLayoutSupported(initialLayout),"VST3 accepts its initial bus layout");
    expect(processor->getTotalNumInputChannels()==0&&processor->getTotalNumOutputChannels()==32,"direct VST3 reproduces the problematic 0-in/32-out default contract");
    if(processor->getTotalNumInputChannels()!=0||processor->getTotalNumOutputChannels()!=32)return false;

    processor->setProcessingPrecision(juce::AudioProcessor::singlePrecision);
    processor->setRateAndBufferSizeDetails(48000.0,256);
    processor->prepareToPlay(48000.0,256);
    logProcessorContract("prepared",*processor);
    expect(processor->getSampleRate()==48000.0&&processor->getBlockSize()==256,"direct VST3 retains sample rate and block size after prepare");
    expect(processor->getProcessingPrecision()==juce::AudioProcessor::singlePrecision,"direct VST3 processes single-precision MiniHub buffers");
    const int channels=std::max(processor->getTotalNumInputChannels(),processor->getTotalNumOutputChannels());
    expect(channels==32,"direct processBlock buffer owns max(total inputs,total outputs) channels");
    if(channels<32){processor->releaseResources();return false;}

    juce::AudioBuffer<float> audio(channels,256);juce::MidiBuffer midi;audio.clear();
    std::cerr << "[vst3-direct] process empty midi channels=" << audio.getNumChannels() << " samples=" << audio.getNumSamples() << '\n';
    processor->processBlock(audio,midi);expect(audio.getMagnitude(0,0,256)==0,"direct VST3 empty-MIDI block is valid silence");
    audio.clear();midi.addEvent(juce::MidiMessage::noteOn(1,60,(juce::uint8)100),0);
    std::cerr << "[vst3-direct] process note-on\n";processor->processBlock(audio,midi);expect(audio.getMagnitude(0,0,256)>.1f,"direct VST3 Note On produces real audio");
    audio.clear();midi.clear();midi.addEvent(juce::MidiMessage::noteOff(1,60),0);
    std::cerr << "[vst3-direct] process note-off\n";processor->processBlock(audio,midi);expect(audio.getMagnitude(0,0,256)==0,"direct VST3 Note Off produces immediate silence");
    processor->releaseResources();processor.reset();std::cerr << "[vst3-direct] PASS\n";return true;
}

bool buffersEqual(const juce::AudioBuffer<float>& a,
                  const juce::AudioBuffer<float>& b,
                  int numSamples)
{
    if(a.getNumChannels()!=b.getNumChannels()||a.getNumSamples()<numSamples||b.getNumSamples()<numSamples)return false;
    for(int channel=0;channel<a.getNumChannels();++channel)
        if(std::memcmp(a.getReadPointer(channel),b.getReadPointer(channel),
                       static_cast<size_t>(numSamples)*sizeof(float))!=0)return false;
    return true;
}

void testDirectMiniHubVst3PlanarCapture(const mlh::PluginRecord& instrument,
                                       const mlh::PluginRecord& effect)
{
    constexpr int maximumFrames=256,frames=73;
    juce::String error;
    mlh::PluginInstance large,exact;
    expect(large.create(instrument,48000,maximumFrames,error),"direct planar capture loads an instrument with a 256-frame capacity");
    expect(exact.create(instrument,48000,frames,error),"direct planar capture loads an independent 73-frame reference instance");
    if(!large.isReady()||!exact.isReady())return;

    juce::AudioBuffer<float> largeAudio(2,maximumFrames),exactAudio(2,frames);
    for(int channel=0;channel<2;++channel){largeAudio.clear(channel,0,maximumFrames);largeAudio.applyGain(channel,frames,maximumFrames-frames,0.0f);for(int sample=frames;sample<maximumFrames;++sample)largeAudio.setSample(channel,sample,1234.5f);}
    exactAudio.clear();
    juce::MidiBuffer note;note.addEvent(juce::MidiMessage::noteOn(1,60,(juce::uint8)100),0);
    large.processBlock(largeAudio,note,frames,1);exact.processBlock(exactAudio,note,frames,1);
    expect(buffersEqual(largeAudio,exactAudio,frames),"VST -> planar -> PluginInstance capture is identical when capacity 256 processes exactly 73 frames");
    juce::AudioBuffer<float> firstBlock(2,frames);for(int channel=0;channel<2;++channel)firstBlock.copyFrom(channel,0,largeAudio,channel,0,frames);
    bool tailUntouched=true;for(int channel=0;channel<2;++channel)for(int sample=frames;sample<maximumFrames;++sample)tailUntouched&=largeAudio.getSample(channel,sample)==1234.5f;
    expect(tailUntouched,"the VST bridge never writes the 183 samples beyond the real callback");

    juce::MidiBuffer empty;largeAudio.clear(0,0,frames);largeAudio.clear(1,0,frames);exactAudio.clear();
    large.processBlock(largeAudio,empty,frames,2);exact.processBlock(exactAudio,empty,frames,2);
    expect(buffersEqual(largeAudio,exactAudio,frames),"the second 73-frame block is phase-continuous instead of advancing by maxBlockSize");
    bool finite=true,stereoPlanar=true,varies=false,newBlock=false;
    for(int sample=0;sample<frames;++sample){const float left=largeAudio.getSample(0,sample),right=largeAudio.getSample(1,sample);finite&=std::isfinite(left)&&std::isfinite(right);stereoPlanar&=left==right;if(sample>0)varies|=left!=largeAudio.getSample(0,sample-1);newBlock|=left!=firstBlock.getSample(0,sample);}
    expect(finite&&stereoPlanar&&varies&&newBlock,"direct planar waveform has finite samples, stable L/R planes, no repeated samples and no repeated block");

    const auto largeTrace=large.vst3BufferProcessTrace(),exactTrace=exact.vst3BufferProcessTrace();
    const bool independent=largeTrace.outputLeft!=0&&largeTrace.outputRight!=0
        &&largeTrace.outputLeft!=largeTrace.outputRight
        &&largeTrace.outputLeft!=exactTrace.outputLeft
        &&largeTrace.outputLeft!=exactTrace.outputRight
        &&largeTrace.outputRight!=exactTrace.outputLeft
        &&largeTrace.outputRight!=exactTrace.outputRight;
    expect(independent&&largeTrace.inputOutputDistinct&&exactTrace.inputOutputDistinct,
           "two hosted instruments own disjoint planar channel storage with no input/output alias");
    expect(largeTrace.blockId==2&&largeTrace.processCallInBlock==1&&largeTrace.numSamples==frames
        &&largeTrace.inputBusCount==0&&largeTrace.outputBusCount==16
        &&largeTrace.mainOutputChannels==2&&largeTrace.copiedToPluginInstance,
           "direct bridge trace records one process call, exact frames, exposed buses and the main stereo copy");
    std::cerr<<"[vst3-buffer-addresses] instrument-a inBuses="<<std::dec<<largeTrace.inputBusCount
             <<" outBuses="<<largeTrace.outputBusCount<<" mainInChannels="<<largeTrace.mainInputChannels
             <<" mainOutChannels="<<largeTrace.mainOutputChannels<<" frames="<<largeTrace.numSamples
             <<" call="<<largeTrace.processCallInBlock<<" outL=0x"<<std::hex<<largeTrace.outputLeft
             <<" outR=0x"<<largeTrace.outputRight<<" instrument-b outL=0x"<<exactTrace.outputLeft
             <<" outR=0x"<<exactTrace.outputRight<<std::dec<<"\n";

    mlh::PluginInstance fx;
    expect(fx.create(effect,48000,maximumFrames,error),"direct planar capture loads the deterministic stereo effect");
    if(!fx.isReady())return;
    juce::AudioBuffer<float> fxAudio(2,maximumFrames);
    for(int sample=0;sample<maximumFrames;++sample){fxAudio.setSample(0,sample,sample<91?0.001f*float(sample+1):321.0f);fxAudio.setSample(1,sample,sample<91?-0.002f*float(sample+1):-654.0f);}
    fx.processBlock(fxAudio,empty,91,10);
    bool fxExact=true,fxTailUntouched=true;for(int sample=0;sample<91;++sample){fxExact&=std::abs(fxAudio.getSample(0,sample)-0.75f*0.001f*float(sample+1))<1.0e-7f;fxExact&=std::abs(fxAudio.getSample(1,sample)+0.75f*0.002f*float(sample+1))<1.0e-7f;}for(int sample=91;sample<maximumFrames;++sample)fxTailUntouched&=fxAudio.getSample(0,sample)==321.0f&&fxAudio.getSample(1,sample)==-654.0f;
    const auto fxTrace=fx.vst3BufferProcessTrace();
    expect(fxExact&&fxTailUntouched,"FX input L/R planes are copied, processed and returned once for exactly 91 frames");
    expect(fxTrace.mainInputChannels==2&&fxTrace.mainOutputChannels==2
        &&fxTrace.inputLeft!=0&&fxTrace.inputRight!=0&&fxTrace.outputLeft!=0&&fxTrace.outputRight!=0
        &&fxTrace.inputOutputDistinct&&fxTrace.processCallInBlock==1,
           "FX trace proves distinct stereo input/output storage and one process call");
    std::cerr<<"[vst3-buffer-addresses] effect inBuses="<<std::dec<<fxTrace.inputBusCount
             <<" outBuses="<<fxTrace.outputBusCount<<" mainInChannels="<<fxTrace.mainInputChannels
             <<" mainOutChannels="<<fxTrace.mainOutputChannels<<" frames="<<fxTrace.numSamples
             <<" call="<<fxTrace.processCallInBlock<<" inL=0x"<<std::hex<<fxTrace.inputLeft
             <<" inR=0x"<<fxTrace.inputRight<<" outL=0x"<<fxTrace.outputLeft
             <<" outR=0x"<<fxTrace.outputRight<<std::dec<<"\n";
}

void testVariableFrameGraphBoundary(const mlh::PluginRecord& record)
{
    constexpr int capacity=256,frames=73;
    juce::String error;
    auto largePlugin=std::make_unique<mlh::PluginInstance>();auto exactPlugin=std::make_unique<mlh::PluginInstance>();
    expect(largePlugin->create(record,48000,capacity,error)&&exactPlugin->create(record,48000,frames,error),"variable-frame graph loads independent capacity/reference instruments");
    if(!largePlugin->isReady()||!exactPlugin->isReady())return;
    largePlugin->setInstanceId("large");exactPlugin->setInstanceId("exact");
    mlh::Chain largeChain("large-chain"),exactChain("exact-chain");largeChain.setMidiEnabled(true);exactChain.setMidiEnabled(true);
    expect(largeChain.insertPlugin(0,std::move(largePlugin))&&exactChain.insertPlugin(0,std::move(exactPlugin)),"variable-frame instruments enter independent chains");
    largeChain.prepareToPlay(48000,capacity);exactChain.prepareToPlay(48000,frames);
    mlh::AudioGraphSpec graph;auto vst=graphNode("vst",mlh::AudioNodeKind::vst);auto output=graphNode("audio-output",mlh::AudioNodeKind::output);output.inputs={{"audio-in","vst","audio-out",1,false}};graph.nodes={output,vst};std::string compileError;
    auto largePlan=mlh::AudioExecutionPlan::compile(graph,[&](const std::string&id){return id=="vst"?&largeChain:nullptr;},nullptr,capacity,compileError);
    auto exactPlan=mlh::AudioExecutionPlan::compile(graph,[&](const std::string&id){return id=="vst"?&exactChain:nullptr;},nullptr,frames,compileError);
    expect(largePlan&&exactPlan,"variable-frame VST -> Chain -> Audio Output plans compile");if(!largePlan||!exactPlan)return;
    juce::MidiBuffer note;note.addEvent(juce::MidiMessage::noteOn(1,60,(juce::uint8)100),0);largeChain.pushMidi(note);exactChain.pushMidi(note);
    mlh::Transport largeTransport,exactTransport;largeTransport.setSampleRate(48000);exactTransport.setSampleRate(48000);
    for(int pass=0;pass<2;++pass){float largeLeft[frames]{},largeRight[frames]{},exactLeft[frames]{},exactRight[frames]{};float* largeOut[]={largeLeft,largeRight};float* exactOut[]={exactLeft,exactRight};juce::MidiBuffer scratch;largeTransport.beginBlock();exactTransport.beginBlock();largePlan->process(largeOut,2,frames,largeTransport,scratch);exactPlan->process(exactOut,2,frames,exactTransport,scratch);expect(std::memcmp(largeLeft,exactLeft,sizeof(largeLeft))==0&&std::memcmp(largeRight,exactRight,sizeof(largeRight))==0,"graph capacity does not change the real VST callback frame count or waveform");largeTransport.advance(frames);exactTransport.advance(frames);}
    const auto largeTrace=largeChain.copyPlugins()[0]->vst3BufferProcessTrace();
    expect((largeTrace.blockId&0xffffffffULL)==2&&largeTrace.processCallInBlock==1&&largeTrace.numSamples==frames,"callback block ID maps to exactly one VST process call with 73 real frames");
}

void testRealVst3SequencerPlaybackArpAndMasterExport()
{
    std::cerr << "[vst3-e2e] locate\n";
    const auto vst3=deterministicVst3();expect(vst3.isDirectory(),"deterministic validation VST3 bundle was built");if(!vst3.isDirectory())return;
    std::cerr << "[vst3-e2e] scan\n";
    const auto records=mlh::Vst3Scanner::scanFile(vst3.getFullPathName());expect(records.size()==1&&records[0].isInstrument,"real VST3 scanner discovers deterministic test instrument");if(records.empty())return;
    const auto effectPath=deterministicEffectVst3();expect(effectPath.isDirectory(),"deterministic validation effect VST3 bundle was built");if(!effectPath.isDirectory())return;const auto effectRecords=mlh::Vst3Scanner::scanFile(effectPath.getFullPathName());expect(effectRecords.size()==1&&!effectRecords[0].isInstrument,"real VST3 scanner distinguishes the deterministic effect");if(effectRecords.empty())return;
    testDirectMiniHubVst3PlanarCapture(records[0],effectRecords[0]);
    testVariableFrameGraphBoundary(records[0]);
    if(!testDirectJuceVst3(records[0]))return;
    std::cerr << "[vst3-e2e] load\n";
    auto plugin=std::make_unique<mlh::PluginInstance>();juce::String loadError;expect(plugin->create(records[0],48000,256,loadError),"real MiniHub VST3 host loads deterministic test instrument");if(!plugin->isReady())return;expect(plugin->totalInputChannelsForTesting()==0&&plugin->totalOutputChannelsForTesting()==2,"MiniHub negotiates the 32-output VST3 to its 0-in/2-out graph contract");expect(plugin->enabledOutputBusesForTesting()==1,"MiniHub keeps only the accepted main output bus enabled");plugin->setInstanceId("plugin-1");
    mlh::Chain chain("vst-e2e");chain.setMidiEnabled(true);expect(chain.insertPlugin(0,std::move(plugin)),"real VST3 instance enters the MiniHub chain");chain.prepareToPlay(48000,256);

    auto secondPlugin=std::make_unique<mlh::PluginInstance>();
    expect(secondPlugin->create(records[0],48000,256,loadError),
           "second real VST3 instance loads for the +5.575 dBFS reproduction");
    secondPlugin->setInstanceId("plugin-1");
    mlh::Chain secondChain("vst-e2e-b");secondChain.setMidiEnabled(true);
    expect(secondChain.insertPlugin(0,std::move(secondPlugin)),
           "second real VST3 instance enters an independent node chain");
    secondChain.prepareToPlay(48000,256);

    mlh::AudioGraphSpec overloadGraph;
    auto overloadA=graphNode("vst-e2e",mlh::AudioNodeKind::vst);
    auto overloadB=graphNode("vst-e2e-b",mlh::AudioNodeKind::vst);
    auto overloadMixer=graphNode("mixer-overload",mlh::AudioNodeKind::mixer);
    overloadMixer.inputs={{"audio-in-1","vst-e2e","audio-out",1,false},
                          {"audio-in-2","vst-e2e-b","audio-out",1,false}};
    auto overloadOutput=graphNode("audio-output",mlh::AudioNodeKind::output);
    overloadOutput.inputs={{"audio-in","mixer-overload","audio-out",1,false}};
    overloadGraph.nodes={overloadOutput,overloadMixer,overloadB,overloadA};
    std::string overloadError;auto overloadPlan=mlh::AudioExecutionPlan::compile(overloadGraph,[&](const std::string&id){if(id=="vst-e2e")return &chain;if(id=="vst-e2e-b")return &secondChain;return (mlh::Chain*)nullptr;},nullptr,256,overloadError);
    expect(overloadPlan!=nullptr,"two real VST nodes -> Mixer -> Audio Output compiles");
    if(overloadPlan){juce::MidiBuffer fullVelocity;fullVelocity.addEvent(juce::MidiMessage::noteOn(1,60,(juce::uint8)127),0);chain.pushMidi(fullVelocity);secondChain.pushMidi(fullVelocity);mlh::Transport overloadTransport;overloadTransport.setSampleRate(48000);overloadTransport.beginBlock();float overloadLeft[256]{},overloadRight[256]{};float* overloadHardware[]={overloadLeft,overloadRight};juce::MidiBuffer overloadScratch;overloadPlan->process(overloadHardware,2,256,overloadTransport,overloadScratch);const auto firstTelemetry=chain.copyPlugins()[0]->takeSignalTelemetry();const auto secondTelemetry=secondChain.copyPlugins()[0]->takeSignalTelemetry();const auto mixerNode=std::find_if(overloadPlan->nodes().begin(),overloadPlan->nodes().end(),[](const auto& node){return node.kind==mlh::AudioNodeKind::mixer;});const auto mixerTelemetry=mixerNode!=overloadPlan->nodes().end()&&mixerNode->signalMeter?mixerNode->signalMeter->takeTelemetrySnapshot():mlh::AudioSignalTelemetry{};const float reproducedRawPeak=firstTelemetry.outputPeak+secondTelemetry.outputPeak;expect(firstTelemetry.outputPeak>.94f&&secondTelemetry.outputPeak>.94f&&std::abs(juce::Decibels::gainToDecibels(reproducedRawPeak)-5.575f)<.03f,"two hosted VST processBlock outputs reproduce the real +5.575 dBFS sum");expect(mixerTelemetry.inputPeak>1.89f&&std::abs(mixerTelemetry.outputPeak-mixerTelemetry.inputPeak)<.0001f,"the summing node passes its completed float sum without gain reduction");expect(std::abs(juce::FloatVectorOperations::findMaximum(overloadLeft,256)-reproducedRawPeak)<.0001f,"two real VST outputs reach Audio Output as their exact linear sum");}
    chain.panic();secondChain.panic();

    std::cerr << "[vst3-e2e] loaded\n";mlh::SequencerEngine sequencer;sequencer.prepare(48000,256);auto track=midiTrack("track-vst-e2e","vst-e2e");juce::Array<juce::var> tracks;tracks.add(track);juce::Array<juce::var> info;std::string error;expect(sequencer.sync(makeSequencerProject(tracks),[&](const std::string&id){return id=="vst-e2e"?&chain:nullptr;},48000,256,info,error),"MIDI clip routes into the real VST3 chain");
    auto makePlan=[&](float master,int blockSize=256){mlh::AudioGraphSpec graph;auto vst=graphNode("vst-e2e",mlh::AudioNodeKind::vst);auto mix=graphNode("mixer-e2e",mlh::AudioNodeKind::mixer);mix.masterLevel=master;mix.inputs={{"audio-in-1","vst-e2e","audio-out",1,false}};auto out=graphNode("audio-output",mlh::AudioNodeKind::output);out.inputs={{"audio-in","mixer-e2e","audio-out",1,false}};graph.nodes={out,mix,vst};return mlh::AudioExecutionPlan::compile(graph,[&](const std::string&id){return id=="vst-e2e"?&chain:nullptr;},&sequencer,blockSize,error);};
    std::cerr << "[vst3-e2e] plans\n";auto unity=makePlan(1.0f),half=makePlan(.5f);expect(unity&&half,"VST3 -> Mixer -> Audio Output DAG compiles");if(!unity||!half)return;
    std::cerr << "[vst3-e2e] live\n";mlh::Transport transport;transport.setSampleRate(48000);transport.setBpm(120);transport.setPlaying(true);transport.beginBlock();float liveLeft[256]{},liveRight[256]{};float* live[]={liveLeft,liveRight};juce::MidiBuffer scratch;sequencer.processMidi(256,transport);unity->process(live,2,256,transport,scratch);expect(juce::FloatVectorOperations::findMaximum(liveLeft,256)>.1f,"chain A produces audible VST3 signal at the real Audio Output buffer");const auto& liveNodes=unity->nodes();const auto vstStage=std::find_if(liveNodes.begin(),liveNodes.end(),[](const auto& node){return node.kind==mlh::AudioNodeKind::vst;});const auto mixStage=std::find_if(liveNodes.begin(),liveNodes.end(),[](const auto& node){return node.kind==mlh::AudioNodeKind::mixer;});const auto outputStage=std::find_if(liveNodes.begin(),liveNodes.end(),[](const auto& node){return node.kind==mlh::AudioNodeKind::output;});const auto vstStats=vstStage!=liveNodes.end()?mlh::measureAudioBlock(vstStage->output,256):mlh::AudioBlockStatistics{};const auto mixStats=mixStage!=liveNodes.end()?mlh::measureAudioBlock(mixStage->output,256):mlh::AudioBlockStatistics{};const auto outputStats=outputStage!=liveNodes.end()?mlh::measureAudioBlock(outputStage->output,256):mlh::AudioBlockStatistics{};expect(vstStats.absolutePeak>.1f&&std::abs(vstStats.absolutePeak-mixStats.absolutePeak)<.0001f&&std::abs(mixStats.absolutePeak-outputStats.absolutePeak)<.0001f,"real multi-output VST3 peak is measured identically through unity Mixer and pre-Master Audio Output");chain.panic();

    bool sampleExactStages=vstStage!=liveNodes.end()&&mixStage!=liveNodes.end()&&outputStage!=liveNodes.end();
    if(sampleExactStages)for(int channel=0;channel<2;++channel){sampleExactStages&=std::memcmp(vstStage->output.getReadPointer(channel),mixStage->output.getReadPointer(channel),256*sizeof(float))==0;sampleExactStages&=std::memcmp(mixStage->output.getReadPointer(channel),outputStage->output.getReadPointer(channel),256*sizeof(float))==0;sampleExactStages&=std::memcmp(outputStage->output.getReadPointer(channel),live[channel],256*sizeof(float))==0;}
    expect(sampleExactStages,"PluginInstance -> Chain -> Mixer -> Audio Output samples are bit-identical at unity");
    juce::AudioBuffer<float> mastered(2,256);for(int channel=0;channel<2;++channel)mastered.copyFrom(channel,0,live[channel],256);float* masteredChannels[]={mastered.getWritePointer(0),mastered.getWritePointer(1)};mlh::MasterOutput diagnosticMaster;diagnosticMaster.prepare(48000);diagnosticMaster.process(masteredChannels,2,256);bool masterExact=true;for(int channel=0;channel<2;++channel)masterExact&=std::memcmp(mastered.getReadPointer(channel),live[channel],256*sizeof(float))==0;expect(masterExact,"unity MasterOutput preserves every finite VST sample bit-for-bit");
    const auto liveBridgeTrace=chain.copyPlugins()[0]->vst3BufferProcessTrace();expect(liveBridgeTrace.copiedToPluginInstance&&liveBridgeTrace.processCallInBlock==1&&liveBridgeTrace.numSamples==256,"AudioBusBuffers -> PluginInstance trace is one exact 256-frame copy for the live block");

    std::cerr << "[vst3-e2e] arp in 256-sample callbacks\n";mlh::MidiGraphSpec midiSpec;mlh::MidiGraphNodeSpec arp;arp.id="arp-e2e";arp.kind="arpeggiator";arp.arp.rate=2;arp.arp.patternLength=16;arp.destinations={"vst-e2e"};midiSpec.nodes.push_back(arp);auto midiPlan=mlh::MidiExecutionPlan::compile(midiSpec,[&](const std::string&id){return id=="vst-e2e"?&chain:nullptr;},error);auto arpTrack=midiTrack("track-vst-arp","arp-e2e");mlh::setProp(arpTrack,"outputKind","arpeggiator");juce::Array<juce::var> arpNotes;arpNotes.add(midiNote(.125,.5,60,100,1));replaceMidiNotes(arpTrack,arpNotes);tracks.clear();tracks.add(arpTrack);expect(midiPlan&&sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"chain B routes Sequencer through existing Arpeggiator into real VST3");transport.seekPpq(0);transport.setPlaying(true);juce::AudioBuffer<float> arpRendered(2,12288);arpRendered.clear();for(int block=0;block<48;++block){transport.beginBlock();float left[256]{},right[256]{};float* output[]={left,right};sequencer.processMidi(256,transport,midiPlan.get());midiPlan->process(256,transport);unity->process(output,2,256,transport,scratch);arpRendered.copyFrom(0,block*256,left,256);arpRendered.copyFrom(1,block*256,right,256);transport.advance(256);}expect(arpRendered.getMagnitude(0,0,5900)==0&&arpRendered.getMagnitude(0,6100,5800)>.1f,"chain B is silent before the arp step and audible after its sample-exact trigger");midiPlan->panicAll();chain.panic();

    tracks.clear();tracks.add(track);expect(sequencer.sync(makeSequencerProject(tracks),[&](const std::string&id){return id=="vst-e2e"?&chain:nullptr;},48000,256,info,error),"direct VST3 export route restores");transport.setPlaying(false);transport.seekPpq(0);
    auto renderExport=[&](mlh::AudioExecutionPlan& plan,const juce::String& tag){auto file=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("MiniHub-vst3-e2e-"+tag,".wav");juce::String exportError;std::string snapshotError;expect(sequencer.prepareExportPlan([&](const std::string&id){return id=="vst-e2e"?&chain:nullptr;},snapshotError),"real VST3 export arrangement is cloned");expect(sequencer.startExport(file,24,0,1,0,transport,exportError),"successive real VST3 master export starts");float left[256]{},right[256]{};float* out[]={left,right};auto& offline=sequencer.exportTransport();while(sequencer.exporting()){juce::FloatVectorOperations::clear(left,256);juce::FloatVectorOperations::clear(right,256);offline.beginBlock();sequencer.processMidi(256,offline);plan.process(out,2,256,offline,scratch);sequencer.processMaster(out,2,256,offline);offline.advance(256);}expect(sequencer.consumeExportCleanupRequest(),"real VST3 export requests terminal MIDI cleanup");const auto events=sequencer.serviceEvents();expect(events.size()==1&&events[0]["state"].toString()=="complete","real VST3 master export completes");return file;};
    std::cerr << "[vst3-e2e] exports\n";auto unityFile=renderExport(*unity,"unity"),halfFile=renderExport(*half,"half");expect(sequencer.setTrackControl("track-vst-e2e",.501187f,false),"live MIDI track fader updates the VST return without rebuilding Engine 2");auto trackMinusSixFile=renderExport(*unity,"track-minus-6");expect(sequencer.setTrackControl("track-vst-e2e",1.995262f,false),"+6 dB MIDI track fader updates the VST return");auto trackPlusSixFile=renderExport(*half,"track-plus-6");auto read=[&](const juce::File& file){juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(file.createInputStream().release(),true));expect(reader&&reader->sampleRate==48000&&reader->lengthInSamples==24000&&reader->bitsPerSample==24,"VST3 WAV timing, duration and format are exact");juce::AudioBuffer<float> audio(2,reader?(int)reader->lengthInSamples:1);if(reader)reader->read(&audio,0,audio.getNumSamples(),0,true,true);return audio;};auto unityAudio=read(unityFile),halfAudio=read(halfFile),trackMinusSixAudio=read(trackMinusSixFile),trackPlusSixAudio=read(trackPlusSixFile);const float unityPeak=unityAudio.getMagnitude(0,0,unityAudio.getNumSamples()),halfPeak=halfAudio.getMagnitude(0,0,halfAudio.getNumSamples()),trackMinusSixPeak=trackMinusSixAudio.getMagnitude(0,0,trackMinusSixAudio.getNumSamples()),trackPlusSixPeak=trackPlusSixAudio.getMagnitude(0,0,trackPlusSixAudio.getNumSamples());std::cerr<<"[vst3-e2e] gain peaks unity="<<unityPeak<<" mixerHalf="<<halfPeak<<" trackMinus6="<<trackMinusSixPeak<<" halfThenTrackPlus6="<<trackPlusSixPeak<<"\n";expect(unityPeak>.15f&&std::abs(halfPeak/unityPeak-.5f)<.03f,"Mixer volume is printed into the real VST3 WAV");expect(std::abs(trackMinusSixPeak/unityPeak-.501187f)<.03f&&std::abs(trackPlusSixPeak/halfPeak-1.995262f)<.04f,"VST track 0/-6/+6 dB is applied after the instrument and printed by the shared live/export DSP path");expect(unityAudio.getMagnitude(0,1,11000)>.1f&&unityAudio.getMagnitude(0,12100,unityAudio.getNumSamples()-12100)<.0001f,"VST3 WAV starts on time and is silent after Note Off (no stuck note)");
    auto muted=track;mlh::setProp(muted,"muted",true);tracks.clear();tracks.add(muted);expect(sequencer.sync(makeSequencerProject(tracks),[&](const std::string&id){return id=="vst-e2e"?&chain:nullptr;},48000,256,info,error),"muted VST3 Sequencer route compiles");auto mutedFile=renderExport(*unity,"muted");auto mutedAudio=read(mutedFile);expect(mutedAudio.getMagnitude(0,0,mutedAudio.getNumSamples())<.0001f,"track mute prints deterministic silence through VST3 export");if(const char* keep=std::getenv("MLH_GAIN_STAGING_ARTIFACT");keep&&*keep){juce::File artifact(juce::String::fromUTF8(keep));artifact.deleteFile();expect(unityFile.copyFileTo(artifact),"validated linear-float Master WAV artifact is retained on request");}unityFile.deleteFile();halfFile.deleteFile();trackMinusSixFile.deleteFile();trackPlusSixFile.deleteFile();mutedFile.deleteFile();std::cerr << "[vst3-e2e] complete\n";
}

void testSequencerAudioInputRoutingAuthority()
{
    mlh::SequencerEngine sequencer;sequencer.prepare(48000,256);
    juce::Array<juce::var> tracks;tracks.add(audioTrack("track-physical",juce::File(),true,"audio-input"));
    juce::Array<juce::var> info;std::string error;
    expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"armed physical input track compiles");
    mlh::Transport transport;transport.setSampleRate(48000);transport.setBpm(120);transport.beginBlock();
    juce::AudioBuffer<float> physical(2,256);for(int i=0;i<256;++i){physical.setSample(0,i,.25f);physical.setSample(1,i,-.5f);}
    float left[256]{},right[256]{};float* outputs[]={left,right};juce::MidiBuffer midi;

    mlh::AudioGraphSpec disconnected;auto input=graphNode("audio-input",mlh::AudioNodeKind::input);auto seq=graphNode("sequencer",mlh::AudioNodeKind::sequencer);disconnected.nodes={input,seq};
    auto noCable=mlh::AudioExecutionPlan::compile(disconnected,[](const std::string&){return (mlh::Chain*)nullptr;},&sequencer,256,error);
    expect(noCable!=nullptr,"physical Audio Input and disconnected Sequencer compile as real DAG nodes");
    sequencer.beginRecording(transport);noCable->process(outputs,2,256,transport,midi,&physical);auto noCableTakes=sequencer.finishRecording(transport);
    expect(noCableTakes.isEmpty(),"physical input does not record without Audio Input -> Sequencer cable");

    seq.inputs={{"audio-in","audio-input","audio-out",1,false}};mlh::AudioGraphSpec connected;connected.nodes={seq,input};
    auto withCable=mlh::AudioExecutionPlan::compile(connected,[](const std::string&){return (mlh::Chain*)nullptr;},&sequencer,256,error);
    expect(withCable!=nullptr,"Audio Input -> Sequencer AUDIO IN compiles");
    sequencer.beginRecording(transport);withCable->process(outputs,2,256,transport,midi,&physical);auto cableTakes=sequencer.finishRecording(transport);
    expect(cableTakes.size()==1,"direct visible Audio Input cable captures one physical buffer");
    if(cableTakes.size()){juce::File take(cableTakes[0]["filePath"].toString());juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(take.createInputStream().release(),true));juce::AudioBuffer<float> captured(2,256);if(reader)reader->read(&captured,0,256,0,true,true);expect(reader&&std::abs(captured.getSample(0,0)-.25f)<.001f&&std::abs(captured.getSample(1,0)+.5f)<.001f,"captured take contains the actual hardware input buffer");take.deleteFile();}

    mlh::AudioGraphSpec monitor;auto out=graphNode("audio-output",mlh::AudioNodeKind::output);out.inputs={{"audio-in","audio-input","audio-out",1,false}};monitor.nodes={out,input};
    auto monitored=mlh::AudioExecutionPlan::compile(monitor,[](const std::string&){return (mlh::Chain*)nullptr;},&sequencer,256,error);
    juce::FloatVectorOperations::clear(left,256);juce::FloatVectorOperations::clear(right,256);monitored->process(outputs,2,256,transport,midi,&physical);
    expect(std::abs(left[0]-.25f)<.0001f&&std::abs(right[0]+.5f)<.0001f,"physical Audio Input node publishes the hardware buffer to the DAG");

    tracks.clear();tracks.add(audioTrack("track-hidden",juce::File(),true,"source-a"));
    expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"armed graph-source track compiles");
    mlh::AudioGraphSpec hidden;auto source=graphNode("source-a",mlh::AudioNodeKind::mixer);seq.inputs.clear();hidden.nodes={source,seq};
    auto hiddenPlan=mlh::AudioExecutionPlan::compile(hidden,[](const std::string&){return (mlh::Chain*)nullptr;},&sequencer,256,error);
    sequencer.beginRecording(transport);hiddenPlan->process(outputs,2,256,transport,midi,&physical);auto hiddenTakes=sequencer.finishRecording(transport);
    expect(hiddenTakes.isEmpty(),"nodes outside Sequencer direct upstreams have no hidden recording taps");
}

void testSequencerTrackSumGainAndTrace()
{
    const auto sourceFile=makeSineWav();mlh::SequencerEngine sequencer;sequencer.prepare(48000,1024);juce::Array<juce::var> info;std::string error;
    auto clip=[&](const juce::String& id,double start,double length){juce::var value=mlh::makeObject();mlh::setProp(value,"id",id);mlh::setProp(value,"filePath",sourceFile.getFullPathName());mlh::setProp(value,"startPpq",start);mlh::setProp(value,"lengthPpq",length);mlh::setProp(value,"trimStartSeconds",0.0);mlh::setProp(value,"trimEndSeconds",.1);mlh::setProp(value,"gain",1.0);return value;};
    auto track=[&](std::initializer_list<juce::var> values){auto value=audioTrack("track-correctness",sourceFile,false,"audio-input",false,"mixer-001",1.0);juce::Array<juce::var> clips;for(const auto& item:values)clips.add(item);mlh::setProp(value,"clips",clips);return value;};
    mlh::Transport transport;transport.setSampleRate(48000);transport.setBpm(120);transport.setPlaying(true);
    auto render=[&](const juce::var& value){juce::Array<juce::var> tracks;tracks.add(value);expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,1024,info,error),"correctness arrangement compiles");transport.setLoop(false,0,4);transport.seekPpq(0);transport.beginBlock();juce::AudioBuffer<float> result(2,1024);sequencer.renderAudio(result,1024,transport);return result;};
    const auto a=clip("clip-a",0,4);const auto b=clip("clip-b",0,4);const auto c=clip("clip-c",0,4);auto single=render(track({a}));auto doubled=render(track({a,b}));auto tripled=render(track({a,b,c}));float doubleError=0,tripleError=0;for(int ch=0;ch<2;++ch)for(int sample=0;sample<1024;++sample){doubleError=std::max(doubleError,std::abs(doubled.getSample(ch,sample)-2.0f*single.getSample(ch,sample)));tripleError=std::max(tripleError,std::abs(tripled.getSample(ch,sample)-3.0f*single.getSample(ch,sample)));}const float singlePeak=single.getMagnitude(0,1024),doublePeak=doubled.getMagnitude(0,1024);expect(doubleError<1.0e-6f&&std::abs(doublePeak/singlePeak-2.0f)<1.0e-6f,"two identical aligned clips equal exactly 2A");expect(std::abs(juce::Decibels::gainToDecibels(doublePeak/singlePeak)-6.0206f)<.0002f,"two identical aligned clips measure +6.0206 dB");expect(tripleError<2.0e-6f,"three simultaneous clips equal exactly 3A");
    const double samplePpq=1.0/24000.0;auto firstOnly=render(track({clip("clip-first",0,.03125)}));auto shiftedOnly=render(track({clip("clip-shifted",128*samplePpq,.03125)}));auto partial=render(track({clip("clip-first",0,.03125),clip("clip-shifted",128*samplePpq,.03125)}));float partialError=0;for(int ch=0;ch<2;++ch)for(int sample=0;sample<1024;++sample)partialError=std::max(partialError,std::abs(partial.getSample(ch,sample)-firstOnly.getSample(ch,sample)-shiftedOnly.getSample(ch,sample)));expect(partialError<1.0e-6f,"partial overlap and clips starting/ending inside one block equal the independent buffer sum");
    auto loopTrack=track({clip("clip-loop-a",0,.03125),clip("clip-loop-b",0,.03125)});juce::Array<juce::var> loopTracks;loopTracks.add(loopTrack);expect(sequencer.sync(makeSequencerProject(loopTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,1024,info,error),"loop overlap arrangement compiles");transport.setLoop(true,0,.03125);transport.seekPpq(0);transport.beginBlock();juce::AudioBuffer<float> loopDouble(2,1024);sequencer.renderAudio(loopDouble,1024,transport);auto oneLoopTrack=track({clip("clip-loop-single",0,.03125)});loopTracks.clear();loopTracks.add(oneLoopTrack);expect(sequencer.sync(makeSequencerProject(loopTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,1024,info,error),"single loop arrangement compiles");transport.seekPpq(0);transport.beginBlock();juce::AudioBuffer<float> loopSingle(2,1024);sequencer.renderAudio(loopSingle,1024,transport);float loopError=0;for(int ch=0;ch<2;++ch)for(int sample=0;sample<1024;++sample)loopError=std::max(loopError,std::abs(loopDouble.getSample(ch,sample)-2.0f*loopSingle.getSample(ch,sample)));expect(loopError<1.0e-6f,"two clips remain an exact 2A sum across the loop wrap");
    loopTracks.clear();loopTracks.add(track({a,b}));expect(sequencer.sync(makeSequencerProject(loopTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,1024,info,error),"dynamic track-gain arrangement compiles");transport.setLoop(false,0,4);auto renderControl=[&](float gain,bool muted){expect(sequencer.setTrackControl("track-correctness",gain,muted),"live track control updates without rebuilding the clip plan");transport.seekPpq(0);transport.beginBlock();juce::AudioBuffer<float> result(2,1024);sequencer.renderAudio(result,1024,transport);return result;};auto unity=renderControl(1.0f,false);auto minusSix=renderControl(.501187f,false);auto plusSix=renderControl(1.995262f,false);auto muted=renderControl(1.0f,true);const float unityPeak=unity.getMagnitude(0,1024);expect(std::abs(minusSix.getMagnitude(0,1024)/unityPeak-.501187f)<1.0e-6f,"-6 dB track fader applies 0.501187 after the 2A clip sum");expect(std::abs(plusSix.getMagnitude(0,1024)/unityPeak-1.995262f)<1.0e-6f,"+6 dB track fader applies 1.995262 after the 2A clip sum");expect(muted.getMagnitude(0,1024)==0,"track mute outputs exact zero without stopping transport");auto minusTwelve=renderControl(.251189f,false);auto restored=renderControl(1.0f,false);expect(std::abs(minusTwelve.getMagnitude(0,1024)/unityPeak-.251189f)<1.0e-6f&&std::abs(restored.getMagnitude(0,1024)-unityPeak)<1.0e-6f,"dynamic 0 dB -> -12 dB -> 0 dB reacts on consecutive live blocks");const auto trace=sequencer.trackSignalTrace(&transport);expect(trace.size()==1&&trace[0].activeClips==2&&std::abs(trace[0].peakAfterSum-2.0f*trace[0].peakBeforeSum)<.0001f&&trace[0].gainApplied==1.0f&&std::abs(trace[0].peakAfterGain-trace[0].peakAfterSum)<.0001f&&trace[0].destinationBuffer=="mixer-001:audio-in","instrumentation reports clips -> SUM -> gain -> destination without resetting a clip buffer");sourceFile.deleteFile();
}

void testSequencerAudioRecordingAndMasterExport()
{
    std::cerr << "[export] setup-and-recording\n";
    const auto sourceFile=makeSineWav();mlh::SequencerEngine sequencer;sequencer.prepare(48000,256);const auto primaryTrack=audioTrack("track-audio",sourceFile,true);juce::Array<juce::var> tracks;tracks.add(primaryTrack);juce::Array<juce::var> info;std::string error;
    expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"native audio arrangement loads the real source file");expect(info.size()==1&&(double)info[0]["durationSeconds"]>.09,"native import reports real duration and waveform metadata");
    mlh::Transport transport;transport.setSampleRate(48000);transport.setPlaying(true);transport.beginBlock();juce::AudioBuffer<float> rendered(2,256);sequencer.renderAudio(rendered,256,transport);expect(rendered.getMagnitude(0,0,256)>.1f,"audio clip renders from the sample-clocked playhead");

    juce::AudioBuffer<float> routed(2,256);sequencer.renderAudioForOutput(routed,256,transport,"mixer-001");expect(routed.getMagnitude(0,0,256)>.1f,"audio track renders through its selected Patch Bay destination");sequencer.renderAudioForOutput(routed,256,transport,"mixer-other");expect(routed.getMagnitude(0,0,256)==0,"audio track never bleeds into an unrelated Patch Bay destination");
    juce::Array<juce::var> splitTracks;splitTracks.add(primaryTrack);splitTracks.add(audioTrack("track-other",sourceFile,false,"audio-input",false,"mixer-other"));expect(sequencer.sync(makeSequencerProject(splitTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"multiple audio destinations compile");transport.seekPpq(0);transport.beginBlock();juce::AudioBuffer<float> allTracks(2,256),oneRoute(2,256);sequencer.renderAudio(allTracks,256,transport);sequencer.renderAudioForOutput(oneRoute,256,transport,"mixer-001");expect(allTracks.getMagnitude(0,0,256)>oneRoute.getMagnitude(0,0,256)*1.9f,"per-destination render isolates tracks while the diagnostic all-track render includes both");
    juce::Array<juce::var> mutedTracks;mutedTracks.add(audioTrack("track-audio",sourceFile,true,"audio-input",true));expect(sequencer.sync(makeSequencerProject(mutedTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"muted audio arrangement compiles");transport.seekPpq(0);transport.beginBlock();sequencer.renderAudio(rendered,256,transport);expect(rendered.getMagnitude(0,0,256)==0,"audio track mute is sample-exact silence");
    tracks.clear();tracks.add(primaryTrack);expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"unmuted audio arrangement republishes after edit");
    transport.setLoop(false,0,1);transport.seekPpq(.1);transport.beginBlock();sequencer.renderAudio(rendered,256,transport);const float seekSample=rendered.getSample(0,0);expect(std::abs(seekSample-.4f*std::sin(2400.f*.05f)*.75f)<.002f,"audio seek resolves the exact source sample from native PPQ");
    juce::var trimmed=audioTrack("track-trimmed",sourceFile,false);auto* trimmedClips=trimmed["clips"].getArray();if(trimmedClips&&trimmedClips->size()){mlh::setProp(trimmedClips->getReference(0),"trimStartSeconds",.05);mlh::setProp(trimmedClips->getReference(0),"trimEndSeconds",.1);}juce::Array<juce::var> trimTracks;trimTracks.add(trimmed);expect(sequencer.sync(makeSequencerProject(trimTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"trimmed audio clip compiles");transport.seekPpq(0);transport.beginBlock();sequencer.renderAudio(rendered,256,transport);expect(std::abs(rendered.getSample(0,0)-seekSample)<.002f,"audio trim start maps to the exact source sample");
    expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"audio arrangement restores after trim test");transport.setLoop(true,0,.03125);transport.seekPpq(0);transport.beginBlock();juce::AudioBuffer<float> looped(2,752);sequencer.renderAudio(looped,752,transport);expect(std::abs(looped.getSample(0,700))>.05f&&std::abs(looped.getSample(0,750))<.002f,"audio playback wraps sample-accurately at the global loop boundary");transport.setLoop(false,0,1);transport.seekPpq(0);transport.beginBlock();

    sequencer.beginRecording(transport);juce::AudioBuffer<float> input(2,480);for(int i=0;i<480;++i){input.setSample(0,i,.2f);input.setSample(1,i,-.2f);}sequencer.captureSource("audio-input",input,480,transport);const auto takes=sequencer.finishRecording(transport);expect(takes.size()==1,"armed audio source creates one native take");if(takes.size()){juce::File take(takes[0]["filePath"].toString());juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(take.createInputStream().release(),true));expect(reader&&reader->lengthInSamples==480&&reader->sampleRate==48000,"audio recording writes a valid sample-exact WAV before clip creation");take.deleteFile();}

    mlh::AudioGraphSpec graph;auto seq=graphNode("sequencer",mlh::AudioNodeKind::sequencer);auto mix=graphNode("mixer-001",mlh::AudioNodeKind::mixer);mix.masterLevel=.5f;mix.inputs={{"audio-in-1","sequencer","audio-out",1,false}};auto out=graphNode("audio-output",mlh::AudioNodeKind::output);out.inputs={{"audio-in","mixer-001","audio-out",1,false}};graph.nodes={out,mix,seq};auto plan=mlh::AudioExecutionPlan::compile(graph,[](const std::string&){return (mlh::Chain*)nullptr;},&sequencer,256,error);expect(plan!=nullptr,"Sequencer routes through the real Mixer and AUDIO DAG");
    float singleLeft[256]{},singleRight[256]{};float* singleMaster[]={singleLeft,singleRight};juce::MidiBuffer sumMidi;transport.setLoop(false,0,1);transport.seekPpq(0);transport.setPlaying(true);transport.beginBlock();plan->process(singleMaster,2,256,transport,sumMidi);const float singleMagnitude=juce::FloatVectorOperations::findMaximum(singleLeft,256);
    juce::Array<juce::var> simultaneousTracks;simultaneousTracks.add(audioTrack("track-sum-a",sourceFile,true));simultaneousTracks.add(audioTrack("track-sum-b",sourceFile,false));simultaneousTracks.add(audioTrack("track-sum-c",sourceFile,true));expect(sequencer.sync(makeSequencerProject(simultaneousTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"three simultaneous Master tracks compile regardless of arm state");float sumLeft[256]{},sumRight[256]{};float* summedMaster[]={sumLeft,sumRight};transport.seekPpq(0);transport.beginBlock();plan->process(summedMaster,2,256,transport,sumMidi);expect(juce::FloatVectorOperations::findMaximum(sumLeft,256)>singleMagnitude*2.9f,"three simultaneous tracks are additively summed into one floating-point Master");
    expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"single-track arrangement restores after simultaneous sum proof");
    // Publish a muted arrangement halfway through a real WAV render. The file
    // in progress must retain the arrangement captured by startExport(); only
    // the following export may observe the newly published plan.
    auto frozenFile=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("MiniHub-master-frozen-snapshot",".wav");juce::String frozenError;
    std::cerr << "[export] frozen-snapshot\n";
    transport.setLoop(false,0,1);transport.seekPpq(0);transport.setPlaying(false);
    std::string frozenSnapshotError;expect(sequencer.prepareExportPlan([](const std::string&){return (mlh::Chain*)nullptr;},frozenSnapshotError),"deterministic snapshot arrangement is cloned");expect(sequencer.startExport(frozenFile,24,0,.2,0,transport,frozenError),"deterministic snapshot export starts");
    bool changedDuringExport=false;int renderedFrames=0;juce::MidiBuffer frozenMidi;
    auto& frozenTransport=sequencer.exportTransport();while(sequencer.exporting()){float left[256]{},right[256]{};float* hardware[]={left,right};frozenTransport.beginBlock();plan->process(hardware,2,256,frozenTransport,frozenMidi);sequencer.processMaster(hardware,2,256,frozenTransport);frozenTransport.advance(256);renderedFrames+=256;if(!changedDuringExport&&renderedFrames>=2400){juce::Array<juce::var> nextTracks;nextTracks.add(audioTrack("track-audio",sourceFile,true,"audio-input",true));expect(sequencer.sync(makeSequencerProject(nextTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"arrangement edit publishes while export is active");changedDuringExport=true;}}
    std::cerr << "[export] frozen-terminal\n";expect(sequencer.consumeExportCleanupRequest(),"snapshot export requests terminal cleanup");expect(sequencer.serviceEvents().size()==1,"snapshot export completes after the mid-render edit");
    juce::WavAudioFormat frozenWav;std::unique_ptr<juce::AudioFormatReader> frozenReader(frozenWav.createReaderFor(frozenFile.createInputStream().release(),true));
    if(frozenReader){juce::AudioBuffer<float> frozenAudio(2,(int)frozenReader->lengthInSamples);frozenReader->read(&frozenAudio,0,(int)frozenReader->lengthInSamples,0,true,true);expect(frozenAudio.getMagnitude(0,2500,frozenAudio.getNumSamples()-2500)>.05f,"mid-export arrangement mutation cannot create a hybrid master");}
    frozenReader.reset();frozenFile.deleteFile();
    std::cerr << "[export] next-snapshot\n";auto nextFile=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("MiniHub-master-next-state",".wav");juce::String nextError;std::string nextSnapshotError;expect(sequencer.prepareExportPlan([](const std::string&){return (mlh::Chain*)nullptr;},nextSnapshotError),"next arrangement snapshot is cloned");expect(sequencer.startExport(nextFile,24,0,.2,0,transport,nextError),"next export starts from the newly published arrangement");
    auto& nextOffline=sequencer.exportTransport();while(sequencer.exporting()){float left[256]{},right[256]{};float* hardware[]={left,right};nextOffline.beginBlock();plan->process(hardware,2,256,nextOffline,frozenMidi);sequencer.processMaster(hardware,2,256,nextOffline);nextOffline.advance(256);}sequencer.consumeExportCleanupRequest();sequencer.serviceEvents();
    std::unique_ptr<juce::AudioFormatReader> nextReader(frozenWav.createReaderFor(nextFile.createInputStream().release(),true));if(nextReader){juce::AudioBuffer<float> nextAudio(2,(int)nextReader->lengthInSamples);nextReader->read(&nextAudio,0,(int)nextReader->lengthInSamples,0,true,true);expect(nextAudio.getMagnitude(0,0,nextAudio.getNumSamples())<.0001f,"the next export naturally uses the edited arrangement");}nextReader.reset();nextFile.deleteFile();
    expect(sequencer.sync(makeSequencerProject(tracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"unmuted arrangement restores after snapshot test");
    transport.setLoop(true,2,6);transport.seekPpq(3);transport.setPlaying(false);const auto preservedPpq=transport.ppqPosition();
    struct ExportCase{double start,end,tail;int64_t frames;};const ExportCase cases[]={{0,.2,0,4800},{.1,.2,.05,4800}};
    std::cerr << "[export] repeated-wav\n";
    for(int pass=0;pass<2;++pass){const auto& test=cases[pass];auto destination=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("MiniHub-master-e2e-"+juce::String(pass),".wav");juce::String exportError;std::string snapshotError;expect(sequencer.prepareExportPlan([](const std::string&){return (mlh::Chain*)nullptr;},snapshotError),"repeated master arrangement is cloned");expect(sequencer.startExport(destination,24,test.start,test.end,test.tail,transport,exportError),"master export starts repeatedly");float left[256]{},right[256]{};float* hardware[]={left,right};juce::MidiBuffer midiScratch;auto& offline=sequencer.exportTransport();while(sequencer.exporting()){juce::FloatVectorOperations::clear(left,256);juce::FloatVectorOperations::clear(right,256);offline.beginBlock();plan->process(hardware,2,256,offline,midiScratch);sequencer.processMaster(hardware,2,256,offline);offline.advance(256);}sequencer.consumeExportCleanupRequest();const auto events=sequencer.serviceEvents();expect(events.size()==1&&events[0]["state"].toString()=="complete","master export completes through the native writer");juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(destination.createInputStream().release(),true));expect(reader&&reader->sampleRate==48000&&reader->lengthInSamples==test.frames&&reader->bitsPerSample==24,"end-to-end WAV has exact range, tail, rate, duration and format");if(reader){juce::AudioBuffer<float> check(2,(int)reader->lengthInSamples);reader->read(&check,0,(int)reader->lengthInSamples,0,true,true);expect(check.getMagnitude(0,0,std::min(2400,check.getNumSamples()))>.05f,"master WAV contains routed audio after Mixer gain");if(test.tail>0)expect(check.getMagnitude(0,2400,check.getNumSamples()-2400)<.0001f,"effect-tail range is preserved as exact post-source silence when the graph has no effect tail");}reader.reset();destination.deleteFile();}
    juce::var signatureA=audioTrack("track-signature-a",sourceFile,true);juce::var signatureB=audioTrack("track-signature-b",sourceFile,false);juce::var signatureC=audioTrack("track-signature-c",sourceFile,true);if(auto* clips=signatureB["clips"].getArray())mlh::setProp(clips->getReference(0),"startPpq",.25);if(auto* clips=signatureC["clips"].getArray())mlh::setProp(clips->getReference(0),"startPpq",.5);juce::Array<juce::var> repeatedTracks;repeatedTracks.add(signatureA);repeatedTracks.add(signatureB);repeatedTracks.add(signatureC);expect(sequencer.sync(makeSequencerProject(repeatedTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"three temporally distinct tracks are frozen for every codec export");
    auto retainCodecArtifact=[&](const juce::File& source){const char* directory=std::getenv("MLH_EXPORT_FORMAT_ARTIFACT_DIR");if(!directory||!*directory)return;juce::File targetDirectory(juce::String::fromUTF8(directory));targetDirectory.createDirectory();auto target=targetDirectory.getChildFile("sequencer-export-transport."+source.getFileExtension().trimCharactersAtStart("."));target.deleteFile();expect(source.copyFileTo(target),"validated codec artifact is retained");};
    auto validatePcm=[&](juce::AudioFormatReader* reader,int64_t expectedFrames,const juce::String& codec){expect(reader&&reader->sampleRate==48000&&reader->numChannels==2&&std::abs(reader->lengthInSamples-expectedFrames)<=2304,codec+" decodes as stereo at the expected rate and duration");if(!reader)return;juce::AudioBuffer<float> decoded(2,(int)reader->lengthInSamples);reader->read(&decoded,0,decoded.getNumSamples(),0,true,true);bool finite=true;for(int ch=0;ch<2;++ch)for(int i=0;i<decoded.getNumSamples();++i)finite=finite&&std::isfinite(decoded.getSample(ch,i));expect(finite&&decoded.getMagnitude(0,0,decoded.getNumSamples())>.02f,codec+" contains finite, non-silent Master PCM");const int windows[][2]={{960,3840},{6960,9840},{12960,15840}};for(int index=0;index<3;++index){const int start=std::min(windows[index][0],decoded.getNumSamples());const int count=std::max(0,std::min(windows[index][1],decoded.getNumSamples())-start);expect(count>0&&decoded.getMagnitude(0,start,count)>.02f,codec+" contains temporal signature from Track "+juce::String(index+1));}};
    auto renderCodec=[&](const juce::String& format,int bitrate,int quality){mlh::SequencerEngine::ExportOptions options;options.format=format;options.wavBits=24;options.mp3BitrateKbps=bitrate;options.oggQualityIndex=quality;auto destination=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("MiniHub-master-codec-"+format,"."+format);transport.setLoop(true,2,6);transport.seekPpq(3);transport.setPlaying(true);const auto liveSamples=transport.samplePosition();juce::String exportError;std::string snapshotError;expect(sequencer.prepareExportPlan([](const std::string&){return (mlh::Chain*)nullptr;},snapshotError),format+" arrangement is cloned");expect(sequencer.startExport(destination,0,.8,0,transport,options,exportError),format+" export starts from a frozen arrangement");expect(transport.playing()&&transport.loopEnabled()&&transport.ppqPosition()==3&&transport.samplePosition()==liveSamples,"startExport never mutates live Play, loop or playhead for "+format);auto& offline=sequencer.exportTransport();expect(offline.playing()&&!offline.loopEnabled()&&offline.ppqPosition()==0,"offline "+format+" transport owns its independent zero/range");float left[256]{},right[256]{};float* hardware[]={left,right};juce::MidiBuffer midiScratch;while(sequencer.exporting()){juce::FloatVectorOperations::clear(left,256);juce::FloatVectorOperations::clear(right,256);offline.beginBlock();plan->process(hardware,2,256,offline,midiScratch);sequencer.processMaster(hardware,2,256,offline);offline.advance(256);}sequencer.consumeExportCleanupRequest();const auto events=sequencer.serviceEvents();expect(events.size()==1&&events[0]["state"].toString()=="complete"&&events[0]["format"].toString()==format,format+" export publishes one successful terminal event");expect(transport.playing()&&transport.loopEnabled()&&transport.ppqPosition()==3&&transport.samplePosition()==liveSamples,"completed "+format+" export leaves live transport bit-for-bit unchanged");transport.setPlaying(false);transport.beginBlock();juce::FloatVectorOperations::clear(left,256);juce::FloatVectorOperations::clear(right,256);plan->process(hardware,2,256,transport,midiScratch);expect(left[0]==0&&juce::FloatVectorOperations::findMaximum(left,256)==0,"Stop is immediate with no ghost clip after "+format);transport.setLoop(false,0,4);transport.seekPpq(0);transport.setPlaying(true);transport.beginBlock();plan->process(hardware,2,256,transport,midiScratch);expect(juce::FloatVectorOperations::findMaximum(left,256)>.02f,"Play restarts normally after "+format);transport.setPlaying(false);return destination;};
    std::cerr << "[export] codecs\n";auto wavCodec=renderCodec("wav",320,-1);{juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(wavCodec.createInputStream().release(),true));validatePcm(reader.get(),19200,"WAV");}retainCodecArtifact(wavCodec);wavCodec.deleteFile();
    auto oggCodec=renderCodec("ogg",320,-1);{juce::FileInputStream header(oggCodec);char magic[4]{};header.read(magic,4);expect(std::memcmp(magic,"OggS",4)==0,"OGG file has a real Ogg container signature");juce::OggVorbisAudioFormat ogg;std::unique_ptr<juce::AudioFormatReader> reader(ogg.createReaderFor(oggCodec.createInputStream().release(),true));validatePcm(reader.get(),19200,"OGG Vorbis");}retainCodecArtifact(oggCodec);oggCodec.deleteFile();
    auto mp3Codec=renderCodec("mp3",320,-1);{juce::FileInputStream header(mp3Codec);unsigned char magic[3]{};header.read(magic,3);expect((magic[0]=='I'&&magic[1]=='D'&&magic[2]=='3')||(magic[0]==0xff&&(magic[1]&0xe0)==0xe0),"MP3 file has a real MPEG audio signature");auto decoded=mp3Codec.getSiblingFile("MiniHub-master-codec-mp3-decoded.wav");decoded.deleteFile();juce::ChildProcess decoder;juce::StringArray args;args.add(mlh::SequencerEngine::bundledLameExecutable().getFullPathName());args.add("--decode");args.add("--quiet");args.add(mp3Codec.getFullPathName());args.add(decoded.getFullPathName());const bool started=decoder.start(args);const bool finished=started&&decoder.waitForProcessToFinish(10000);expect(finished&&decoder.getExitCode()==0&&decoded.existsAsFile(),"bundled LAME decodes the generated MP3 without an external codec");juce::WavAudioFormat wav;std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(decoded.createInputStream().release(),true));validatePcm(reader.get(),19200,"MP3");reader.reset();decoded.deleteFile();}retainCodecArtifact(mp3Codec);mp3Codec.deleteFile();
    std::cerr << "[export] cancellation\n";auto cancelledFile=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("MiniHub-master-cancelled",".wav");juce::String cancelledError;
    transport.setLoop(true,7,9);transport.seekPpq(8);transport.setPlaying(true);const auto cancelLiveSamples=transport.samplePosition();
    std::string cancelledSnapshotError;expect(sequencer.prepareExportPlan([](const std::string&){return (mlh::Chain*)nullptr;},cancelledSnapshotError),"cancelled arrangement is cloned");std::cerr << "[export] cancellation-start\n";expect(sequencer.startExport(cancelledFile,24,0,1,0,transport,cancelledError),"project-owned export starts before replacement");
    std::cerr << "[export] cancellation-cancel\n";expect(sequencer.cancelExport(true)&&!sequencer.exporting()&&transport.playing()&&transport.ppqPosition()==8&&transport.samplePosition()==cancelLiveSamples,"Cancel interrupts only the offline export and leaves live playback untouched");
    std::cerr << "[export] cancellation-terminal\n";expect(sequencer.consumeExportCleanupRequest(),"Cancel requests terminal MIDI cleanup");const auto cancelledEvents=sequencer.serviceEvents();expect(cancelledEvents.size()==1&&cancelledEvents[0]["state"].toString()=="cancelled"&&!cancelledFile.existsAsFile(),"cancelled export publishes cancellation and removes its partial WAV");transport.setPlaying(false);std::cerr << "[export] post-cancellation\n";
    juce::var invalidTrack=audioTrack("invalid track id",sourceFile,true);juce::Array<juce::var> invalidTracks;invalidTracks.add(invalidTrack);info.clear();error.clear();
    expect(!sequencer.sync(makeSequencerProject(invalidTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"corrupt Sequencer project is rejected");
    transport.seekPpq(0);transport.beginBlock();rendered.clear();sequencer.renderAudio(rendered,256,transport);
    expect(rendered.getMagnitude(0,0,256)==0,"rejected Sequencer sync publishes fail-closed silence instead of retaining old project");
    // A missing or unreadable asset is a clip-level availability problem, not
    // a reason to retain the previous project's audible execution plan.
    juce::var missingTrack=primaryTrack;auto* missingClips=missingTrack["clips"].getArray();
    if(missingClips&&missingClips->size())mlh::setProp(missingClips->getReference(0),"filePath",sourceFile.getSiblingFile("definitely-missing-sequencer.wav").getFullPathName());
    juce::Array<juce::var> unavailableTracks;unavailableTracks.add(missingTrack);info.clear();error.clear();
    expect(sequencer.sync(makeSequencerProject(unavailableTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"missing WAV publishes a silent replacement plan");
    transport.setLoop(false,0,1);transport.seekPpq(0);transport.beginBlock();rendered.clear();sequencer.renderAudio(rendered,256,transport);
    expect(rendered.getMagnitude(0,0,256)==0,"missing WAV replacement cannot leak audio from the old plan");
    expect(info.size()==1&&!(bool)info[0]["available"]&&info[0]["message"].toString().containsIgnoreCase("missing"),"missing WAV emits a clip diagnostic");

    const auto unsupportedFile=sourceFile.getSiblingFile("MiniHub-unsupported-audio.txt");unsupportedFile.replaceWithText("not audio");
    juce::var unsupportedTrack=audioTrack("track-unsupported",unsupportedFile,false);juce::Array<juce::var> unsupportedTracks;unsupportedTracks.add(unsupportedTrack);info.clear();error.clear();
    expect(sequencer.sync(makeSequencerProject(unsupportedTracks),[](const std::string&){return (mlh::Chain*)nullptr;},48000,256,info,error),"unsupported audio publishes a silent replacement plan");
    transport.seekPpq(0);transport.beginBlock();rendered.clear();sequencer.renderAudio(rendered,256,transport);
    expect(rendered.getMagnitude(0,0,256)==0&&info.size()==1&&info[0]["message"].toString().containsIgnoreCase("unsupported"),"unsupported audio is silent and diagnostic instead of retaining the old plan");
    unsupportedFile.deleteFile();
    transport.setLoop(true,2,6);transport.seekPpq(preservedPpq);transport.setPlaying(false);
    expect(transport.loopEnabled()&&transport.loopStart()==2&&transport.loopEnd()==6&&std::abs(transport.ppqPosition()-preservedPpq)<.0001&&!transport.playing(),"master export restores the unique global transport, loop and playhead");sourceFile.deleteFile();
}

const mlh::AudioExecutionPlan::Node* isolationNode(const mlh::AudioExecutionPlan& plan,
                                                   const std::string& id)
{
    const auto& nodes=plan.nodes();
    const auto found=std::find_if(nodes.begin(),nodes.end(),[&](const auto& node){return node.id==id;});
    return found==nodes.end()?nullptr:&*found;
}

double isolationAmplitude(const juce::AudioBuffer<float>& audio,int begin,int count,double cyclesPerSample)
{
    long double real=0.0,imaginary=0.0;
    const double twoPi=juce::MathConstants<double>::twoPi;
    for(int sample=0;sample<count;++sample){const double phase=twoPi*cyclesPerSample*sample;const double value=audio.getSample(0,begin+sample);real+=value*std::cos(phase);imaginary-=value*std::sin(phase);}
    return 2.0*std::sqrt((double)(real*real+imaginary*imaginary))/count;
}

float isolationDifference(const juce::AudioBuffer<float>& a,const juce::AudioBuffer<float>& b)
{
    float maximum=0.0f;
    for(int channel=0;channel<std::min(a.getNumChannels(),b.getNumChannels());++channel)
        for(int sample=0;sample<std::min(a.getNumSamples(),b.getNumSamples());++sample)
            maximum=std::max(maximum,std::abs(a.getSample(channel,sample)-b.getSample(channel,sample)));
    return maximum;
}

struct IsolationRender {
    juce::AudioBuffer<float> track2Source,track2PostGain,track2MixerInput,mixerOutput,graphOutput,masterOutput;
    const float* track1SourceAddress=nullptr;
    const float* track2SourceAddress=nullptr;
    const float* track1PostGainAddress=nullptr;
    const float* track2PostGainAddress=nullptr;
    const float* track1ScratchAddress=nullptr;
    const float* track2ScratchAddress=nullptr;
    const float* track1MixerInputAddress=nullptr;
    const float* track2MixerInputAddress=nullptr;
    explicit IsolationRender(int samples):track2Source(2,samples),track2PostGain(2,samples),track2MixerInput(2,samples),mixerOutput(2,samples),graphOutput(2,samples),masterOutput(2,samples){}
};

mlh::AudioGraphSpec isolationSineGraph(int64_t track1Start)
{
    constexpr double sampleRate=48000.0;
    auto track1Source=graphNode("track-1-source",mlh::AudioNodeKind::diagnosticSine);
    track1Source.diagnosticCyclesPerSample=440.0/sampleRate;track1Source.diagnosticAmplitude=.2f;
    track1Source.diagnosticStartSample=track1Start;track1Source.diagnosticEndSample=track1Start+96000;track1Source.diagnosticLatencySamples=32;
    auto track2Source=graphNode("track-2-source",mlh::AudioNodeKind::diagnosticSine);
    track2Source.diagnosticCyclesPerSample=880.0/sampleRate;track2Source.diagnosticAmplitude=.25f;
    track2Source.diagnosticStartSample=0;track2Source.diagnosticEndSample=336000;track2Source.diagnosticLatencySamples=0;
    auto track1Gain=graphNode("track-1-post-gain",mlh::AudioNodeKind::mixer);track1Gain.masterLevel=.7f;
    track1Gain.inputs={{"audio-in-1","track-1-source","audio-out",1.0f,false}};
    auto track2Gain=graphNode("track-2-post-gain",mlh::AudioNodeKind::mixer);track2Gain.masterLevel=.8f;
    track2Gain.inputs={{"audio-in-1","track-2-source","audio-out",1.0f,false}};
    auto mixer=graphNode("isolation-mixer",mlh::AudioNodeKind::mixer);
    mixer.inputs={{"audio-in-1","track-1-post-gain","audio-out",1.0f,false},{"audio-in-2","track-2-post-gain","audio-out",1.0f,false}};
    auto output=graphNode("audio-output",mlh::AudioNodeKind::output);
    output.inputs={{"audio-in","isolation-mixer","audio-out",1.0f,false}};
    mlh::AudioGraphSpec graph;graph.nodes={output,mixer,track2Gain,track1Gain,track2Source,track1Source};return graph;
}

IsolationRender renderIsolationSines(mlh::AudioExecutionPlan& plan)
{
    constexpr int blockSize=480,totalSamples=336000;
    IsolationRender result(totalSamples);mlh::Transport transport;transport.setSampleRate(48000);transport.setPlaying(true);
    mlh::MasterOutput master;master.prepare(48000);juce::MidiBuffer midi;
    std::array<float,blockSize> left{},right{};float* hardware[]={left.data(),right.data()};
    for(int offset=0;offset<totalSamples;offset+=blockSize){left.fill(0);right.fill(0);transport.beginBlock();plan.process(hardware,2,blockSize,transport,midi);
        const auto* source1=isolationNode(plan,"track-1-source");const auto* source2=isolationNode(plan,"track-2-source");const auto* gain1=isolationNode(plan,"track-1-post-gain");const auto* gain2=isolationNode(plan,"track-2-post-gain");const auto* mixer=isolationNode(plan,"isolation-mixer");const auto* output=isolationNode(plan,"audio-output");
        if(offset==0&&source1&&source2&&gain1&&gain2&&mixer){result.track1SourceAddress=source1->output.getReadPointer(0);result.track2SourceAddress=source2->output.getReadPointer(0);result.track1PostGainAddress=gain1->output.getReadPointer(0);result.track2PostGainAddress=gain2->output.getReadPointer(0);result.track1ScratchAddress=mixer->sourceDelays[0].output.getNumChannels()?mixer->sourceDelays[0].output.getReadPointer(0):nullptr;result.track2ScratchAddress=mixer->sourceDelays[1].output.getNumChannels()?mixer->sourceDelays[1].output.getReadPointer(0):nullptr;result.track1MixerInputAddress=mixer->processedSources[0]->getReadPointer(0);result.track2MixerInputAddress=mixer->processedSources[1]->getReadPointer(0);}
        for(int channel=0;channel<2;++channel){result.track2Source.copyFrom(channel,offset,source2->output,channel,0,blockSize);result.track2PostGain.copyFrom(channel,offset,gain2->output,channel,0,blockSize);result.track2MixerInput.copyFrom(channel,offset,*mixer->processedSources[1],channel,0,blockSize);result.mixerOutput.copyFrom(channel,offset,mixer->output,channel,0,blockSize);result.graphOutput.copyFrom(channel,offset,output->output,channel,0,blockSize);}
        master.process(hardware,2,blockSize);result.masterOutput.copyFrom(0,offset,left.data(),blockSize);result.masterOutput.copyFrom(1,offset,right.data(),blockSize);transport.advance(blockSize);}
    return result;
}

void testInternalSineCrossTrackIsolation(bool pdcEnabled)
{
    std::string error;auto referenceGraph=isolationSineGraph(400000);auto activeGraph=isolationSineGraph(144000);
    auto reference=mlh::AudioExecutionPlan::compile(referenceGraph,[](const std::string&){return(mlh::Chain*)nullptr;},nullptr,480,error,pdcEnabled);
    auto active=mlh::AudioExecutionPlan::compile(activeGraph,[](const std::string&){return(mlh::Chain*)nullptr;},nullptr,480,error,pdcEnabled);
    expect(reference&&active,pdcEnabled?"crossTrackLevelIsolation sine graph compiles with PDC ON":"crossTrackLevelIsolation sine graph compiles with PDC OFF");if(!reference||!active)return;
    const auto baseline=renderIsolationSines(*reference);const auto measured=renderIsolationSines(*active);
    const float sourceDifference=isolationDifference(baseline.track2Source,measured.track2Source);
    const float postDifference=isolationDifference(baseline.track2PostGain,measured.track2PostGain);
    const float mixerInputDifference=isolationDifference(baseline.track2MixerInput,measured.track2MixerInput);
    const float mixerDifference=isolationDifference(baseline.mixerOutput,measured.mixerOutput);
    expect(sourceDifference<1.0e-6f&&postDifference<1.0e-6f&&mixerInputDifference<1.0e-6f,
           "crossTrackLevelIsolation R == R2 sample-by-sample at Track 2 source/post-gain/Mixer input");
    expect(mixerDifference>.1f,"crossTrackLevelIsolation Master changes when Track 1 activates");
    expect(measured.track1SourceAddress!=measured.track2SourceAddress&&measured.track1PostGainAddress!=measured.track2PostGainAddress&&measured.track1MixerInputAddress!=measured.track2MixerInputAddress,
           "independent sine tracks never alias source, post-gain, or Mixer-input buffers");
    const int window=24000;const std::array<int,3> starts{48000,180000,288000};std::array<double,3> track2{},mixer880{},master880{},master440{};
    for(size_t i=0;i<starts.size();++i){track2[i]=isolationAmplitude(measured.track2MixerInput,starts[i],window,880.0/48000.0);mixer880[i]=isolationAmplitude(measured.mixerOutput,starts[i],window,880.0/48000.0);master880[i]=isolationAmplitude(measured.masterOutput,starts[i],window,880.0/48000.0);master440[i]=isolationAmplitude(measured.masterOutput,starts[i],window,440.0/48000.0);}
    expect(std::abs(track2[0]-track2[1])<1.0e-6&&std::abs(track2[0]-track2[2])<1.0e-6&&std::abs(mixer880[0]-mixer880[1])<1.0e-6&&std::abs(mixer880[0]-mixer880[2])<1.0e-6,
           "880 Hz amplitude is invariant before/during/after the 440 Hz activation");
    expect(master440[0]<1.0e-6&&master440[1]>.13&&master440[2]<1.0e-6,
           "440 Hz appears only while Track 1 is active");
    std::cerr<<"[cross-track][sine][PDC "<<(pdcEnabled?"ON":"OFF")<<"] track2 sourceDiff="<<sourceDifference<<" postGainDiff="<<postDifference<<" mixerInputDiff="<<mixerInputDifference<<" mixerDiff="<<mixerDifference<<" track2(before/during/after)="<<track2[0]<<'/'<<track2[1]<<'/'<<track2[2]<<" mixer880="<<mixer880[0]<<'/'<<mixer880[1]<<'/'<<mixer880[2]<<" master880="<<master880[0]<<'/'<<master880[1]<<'/'<<master880[2]<<" master440="<<master440[0]<<'/'<<master440[1]<<'/'<<master440[2]<<'\n';
    std::cerr<<"[cross-track][buffers][PDC "<<(pdcEnabled?"ON":"OFF")<<"] track1 source="<<(const void*)measured.track1SourceAddress<<" scratch="<<(const void*)measured.track1ScratchAddress<<" postGain="<<(const void*)measured.track1PostGainAddress<<" mixerInput="<<(const void*)measured.track1MixerInputAddress<<"; track2 source="<<(const void*)measured.track2SourceAddress<<" scratch="<<(const void*)measured.track2ScratchAddress<<" postGain="<<(const void*)measured.track2PostGainAddress<<" mixerInput="<<(const void*)measured.track2MixerInputAddress<<'\n';
}

juce::File makeIsolationSineWav(const juce::String& name,double frequency,int frames)
{
    auto file=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile(name,".wav");std::unique_ptr<juce::OutputStream> stream=file.createOutputStream();juce::WavAudioFormat wav;auto writer=wav.createWriterFor(stream,juce::AudioFormatWriter::Options{}.withSampleRate(48000).withNumChannels(2).withBitsPerSample(32));juce::AudioBuffer<float> audio(2,frames);for(int sample=0;sample<frames;++sample){const float value=.25f*std::sin(juce::MathConstants<double>::twoPi*frequency*sample/48000.0);audio.setSample(0,sample,value);audio.setSample(1,sample,value);}writer->writeFromAudioSampleBuffer(audio,0,frames);writer.reset();return file;
}

juce::var isolationAudioTrack(const char* id,const juce::File& file,const char* output,double startPpq,double lengthPpq,double durationSeconds,double gain)
{
    juce::var track=mlh::makeObject();mlh::setProp(track,"id",id);mlh::setProp(track,"type","audio");mlh::setProp(track,"inputId","");mlh::setProp(track,"outputId",output);mlh::setProp(track,"armed",false);mlh::setProp(track,"muted",false);mlh::setProp(track,"volume",gain);juce::var clip=mlh::makeObject();mlh::setProp(clip,"id",juce::String("clip-")+id);mlh::setProp(clip,"filePath",file.getFullPathName());mlh::setProp(clip,"startPpq",startPpq);mlh::setProp(clip,"lengthPpq",lengthPpq);mlh::setProp(clip,"trimStartSeconds",0.0);mlh::setProp(clip,"trimEndSeconds",durationSeconds);mlh::setProp(clip,"gain",1.0);juce::Array<juce::var> clips;clips.add(clip);mlh::setProp(track,"clips",clips);return track;
}

mlh::AudioGraphSpec isolationAudioGraph()
{
    auto sequencer=graphNode("sequencer",mlh::AudioNodeKind::sequencer);auto gain1=graphNode("audio-track-1-post-gain",mlh::AudioNodeKind::mixer);gain1.inputs={{"audio-in-1","sequencer","audio-out",1,false}};auto gain2=graphNode("audio-track-2-post-gain",mlh::AudioNodeKind::mixer);gain2.inputs={{"audio-in-1","sequencer","audio-out",1,false}};auto mixer=graphNode("audio-isolation-mixer",mlh::AudioNodeKind::mixer);mixer.inputs={{"audio-in-1","audio-track-1-post-gain","audio-out",1,false},{"audio-in-2","audio-track-2-post-gain","audio-out",1,false}};auto output=graphNode("audio-output",mlh::AudioNodeKind::output);output.inputs={{"audio-in","audio-isolation-mixer","audio-out",1,false}};mlh::AudioGraphSpec graph;graph.nodes={output,mixer,gain2,gain1,sequencer};return graph;
}

void testAudioClipCrossTrackIsolation()
{
    const auto track1File=makeIsolationSineWav("MiniHub-cross-track-440",440,96001);const auto track2File=makeIsolationSineWav("MiniHub-cross-track-880",880,336001);
    mlh::SequencerEngine referenceSequencer,activeSequencer;referenceSequencer.prepare(48000,480);activeSequencer.prepare(48000,480);juce::Array<juce::var> info;std::string error;const auto track2=isolationAudioTrack("audio-track-2",track2File,"audio-track-2-post-gain",0,14,7,.8);const auto track1=isolationAudioTrack("audio-track-1",track1File,"audio-track-1-post-gain",6,4,2,.7);juce::Array<juce::var> referenceTracks;referenceTracks.add(track2);juce::Array<juce::var> activeTracks;activeTracks.add(track1);activeTracks.add(track2);
    expect(referenceSequencer.sync(makeSequencerProject(referenceTracks),[](const std::string&){return(mlh::Chain*)nullptr;},48000,480,info,error)&&activeSequencer.sync(makeSequencerProject(activeTracks),[](const std::string&){return(mlh::Chain*)nullptr;},48000,480,info,error),"audio/audio isolation arrangements compile");
    auto graph=isolationAudioGraph();auto reference=mlh::AudioExecutionPlan::compile(graph,[](const std::string&){return(mlh::Chain*)nullptr;},&referenceSequencer,480,error);auto active=mlh::AudioExecutionPlan::compile(graph,[](const std::string&){return(mlh::Chain*)nullptr;},&activeSequencer,480,error);expect(reference&&active,"audio/audio isolation graph compiles");if(!reference||!active){track1File.deleteFile();track2File.deleteFile();return;}
    juce::AudioBuffer<float> referenceStem(2,336000),activeStem(2,336000),activeMixer(2,336000);mlh::Transport referenceTransport,activeTransport;for(auto* transport:{&referenceTransport,&activeTransport}){transport->setSampleRate(48000);transport->setBpm(120);transport->setPlaying(true);}juce::MidiBuffer midi;std::array<float,480> refLeft{},refRight{},activeLeft{},activeRight{};float* refOut[]={refLeft.data(),refRight.data()};float* activeOut[]={activeLeft.data(),activeRight.data()};
    for(int offset=0;offset<336000;offset+=480){refLeft.fill(0);refRight.fill(0);activeLeft.fill(0);activeRight.fill(0);referenceTransport.beginBlock();activeTransport.beginBlock();reference->process(refOut,2,480,referenceTransport,midi);active->process(activeOut,2,480,activeTransport,midi);const auto* refTrack2=isolationNode(*reference,"audio-track-2-post-gain");const auto* activeTrack2=isolationNode(*active,"audio-track-2-post-gain");const auto* mixer=isolationNode(*active,"audio-isolation-mixer");for(int channel=0;channel<2;++channel){referenceStem.copyFrom(channel,offset,refTrack2->output,channel,0,480);activeStem.copyFrom(channel,offset,activeTrack2->output,channel,0,480);activeMixer.copyFrom(channel,offset,mixer->output,channel,0,480);}referenceTransport.advance(480);activeTransport.advance(480);}
    const float difference=isolationDifference(referenceStem,activeStem);expect(difference<1.0e-6f,"audio/audio Track 2 stem is sample-identical while Track 1 starts and stops");const std::array<int,3> starts{48000,180000,288000};std::array<double,3> amplitudes{};for(size_t i=0;i<starts.size();++i)amplitudes[i]=isolationAmplitude(activeStem,starts[i],24000,880.0/48000.0);expect(std::abs(amplitudes[0]-amplitudes[1])<1.0e-6&&std::abs(amplitudes[0]-amplitudes[2])<1.0e-6,"audio/audio 880 Hz amplitude is invariant before/during/after Track 1");std::cerr<<"[cross-track][audio/audio] maxStemDifference="<<difference<<" track2(before/during/after)="<<amplitudes[0]<<'/'<<amplitudes[1]<<'/'<<amplitudes[2]<<" mixerPeaks="<<activeMixer.getMagnitude(0,0,144000)<<'/'<<activeMixer.getMagnitude(0,144000,96000)<<'/'<<activeMixer.getMagnitude(0,240000,96000)<<'\n';track1File.deleteFile();track2File.deleteFile();
}

double isolationRms(const juce::AudioBuffer<float>& audio,int begin,int count)
{
    long double sum=0.0;for(int sample=0;sample<count;++sample){const double value=audio.getSample(0,begin+sample);sum+=value*value;}return std::sqrt((double)(sum/count));
}

juce::var isolationMidiTrack(const char* id,const char* output,double clipStart,double clipLength,int pitch,double gain,bool retrigger=false)
{
    juce::var track=mlh::makeObject();mlh::setProp(track,"id",id);mlh::setProp(track,"type","midi");mlh::setProp(track,"inputId","");mlh::setProp(track,"outputId",output);mlh::setProp(track,"armed",false);mlh::setProp(track,"muted",false);mlh::setProp(track,"volume",gain);juce::var clip=mlh::makeObject();mlh::setProp(clip,"id",juce::String("clip-")+id);mlh::setProp(clip,"startPpq",clipStart);mlh::setProp(clip,"lengthPpq",clipLength);juce::Array<juce::var> notes;const double noteLength=retrigger?2.0:clipLength;for(double start=0.0;start<clipLength;start+=noteLength){juce::var note=mlh::makeObject();mlh::setProp(note,"startPpq",start);mlh::setProp(note,"durationPpq",std::min(noteLength,clipLength-start));mlh::setProp(note,"pitch",pitch);mlh::setProp(note,"velocity",127);mlh::setProp(note,"channel",1);notes.add(note);}mlh::setProp(clip,"notes",notes);juce::Array<juce::var> clips;clips.add(clip);mlh::setProp(track,"clips",clips);return track;
}

mlh::AudioGraphSpec isolationVstGraph(const std::string& chainA,const std::string& chainB)
{
    auto a=graphNode(chainA.c_str(),mlh::AudioNodeKind::vst);auto b=graphNode(chainB.c_str(),mlh::AudioNodeKind::vst);auto mixer=graphNode("vst-isolation-mixer",mlh::AudioNodeKind::mixer);mixer.inputs={{"audio-in-1",chainA,"audio-out",1,false},{"audio-in-2",chainB,"audio-out",1,false}};auto output=graphNode("audio-output",mlh::AudioNodeKind::output);output.inputs={{"audio-in","vst-isolation-mixer","audio-out",1,false}};mlh::AudioGraphSpec graph;graph.nodes={output,mixer,b,a};return graph;
}

bool loadIsolationPlugin(const mlh::PluginRecord& record,mlh::Chain& chain,const juce::String& instanceId,mlh::PluginInstance*& raw)
{
    auto plugin=std::make_unique<mlh::PluginInstance>();juce::String error;if(!plugin->create(record,48000,480,error)){std::cerr<<"[cross-track][vst] load failed "<<record.name<<": "<<error<<'\n';expect(false,"cross-track VST instance loads");return false;}plugin->setInstanceId(instanceId);raw=plugin.get();chain.setMidiEnabled(true);if(!chain.insertPlugin(0,std::move(plugin))){expect(false,"cross-track VST enters its independent chain");return false;}chain.prepareToPlay(48000,480);return true;
}

void testHostedVstPairIsolation(const mlh::PluginRecord& recordA,const mlh::PluginRecord& recordB,const std::string& label,bool exact)
{
    auto activeA=std::make_unique<mlh::Chain>("active-a");auto activeB=std::make_unique<mlh::Chain>("active-b");auto referenceA=std::make_unique<mlh::Chain>("reference-a");auto referenceB=std::make_unique<mlh::Chain>("reference-b");mlh::PluginInstance *activeAPlugin=nullptr,*activeBPlugin=nullptr,*referenceAPlugin=nullptr,*referenceBPlugin=nullptr;
    if(!loadIsolationPlugin(recordA,*activeA,"active-a-instance",activeAPlugin)||!loadIsolationPlugin(recordB,*activeB,"active-b-instance",activeBPlugin)||!loadIsolationPlugin(recordA,*referenceA,"reference-a-instance",referenceAPlugin)||!loadIsolationPlugin(recordB,*referenceB,"reference-b-instance",referenceBPlugin))return;
    expect(activeAPlugin!=activeBPlugin&&activeAPlugin!=referenceAPlugin&&activeBPlugin!=referenceBPlugin&&referenceAPlugin!=referenceBPlugin,"Track 1/Track 2/reference PluginInstance pointers are all distinct");
    mlh::SequencerEngine activeSequencer,referenceSequencer;activeSequencer.prepare(48000,480);referenceSequencer.prepare(48000,480);juce::Array<juce::var> activeTracks,referenceTracks;const bool retriggerTrack2=recordB.name.containsIgnoreCase("Dexed");activeTracks.add(isolationMidiTrack("track-1","active-a",6,4,69,.7));activeTracks.add(isolationMidiTrack("track-2","active-b",0,14,81,.8,retriggerTrack2));referenceTracks.add(isolationMidiTrack("track-1","reference-a",20,4,69,.7));referenceTracks.add(isolationMidiTrack("track-2","reference-b",0,14,81,.8,retriggerTrack2));juce::Array<juce::var> info;std::string error;
    const auto activeLookup=[&](const std::string& id){if(id=="active-a")return activeA.get();if(id=="active-b")return activeB.get();return(mlh::Chain*)nullptr;};const auto referenceLookup=[&](const std::string& id){if(id=="reference-a")return referenceA.get();if(id=="reference-b")return referenceB.get();return(mlh::Chain*)nullptr;};expect(activeSequencer.sync(makeSequencerProject(activeTracks),activeLookup,48000,480,info,error)&&referenceSequencer.sync(makeSequencerProject(referenceTracks),referenceLookup,48000,480,info,error),"independent two-track VST Sequencer plans compile");expect(activeSequencer.setTrackControl("track-1",.7f,false)&&activeSequencer.setTrackControl("track-2",.8f,false),"stable track IDs update only their own DSP controls");
    auto activeGraph=isolationVstGraph("active-a","active-b");auto referenceGraph=isolationVstGraph("reference-a","reference-b");auto activePlan=mlh::AudioExecutionPlan::compile(activeGraph,activeLookup,&activeSequencer,480,error);auto referencePlan=mlh::AudioExecutionPlan::compile(referenceGraph,referenceLookup,&referenceSequencer,480,error);expect(activePlan&&referencePlan,"two independent VST paths -> Mixer -> Master compile");if(!activePlan||!referencePlan)return;
    mlh::Transport activeTransport,referenceTransport;for(auto* transport:{&activeTransport,&referenceTransport}){transport->setSampleRate(48000);transport->setBpm(120);transport->setPlaying(true);}activeA->setPlayHead(&activeTransport);activeB->setPlayHead(&activeTransport);referenceA->setPlayHead(&referenceTransport);referenceB->setPlayHead(&referenceTransport);
    juce::AudioBuffer<float> activeStem(2,336000),referenceStem(2,336000),activeMixerInput(2,336000),referenceMixerInput(2,336000),activeMixerOutput(2,336000),activeTrack1(2,336000);std::array<float,480> activeLeft{},activeRight{},referenceLeft{},referenceRight{};float* activeOutput[]={activeLeft.data(),activeRight.data()};float* referenceOutput[]={referenceLeft.data(),referenceRight.data()};juce::MidiBuffer activeMidi,referenceMidi;std::array<float,3> rawTrack2Peaks{},postTrack2Peaks{};std::array<mlh::SequencerEngine::TrackSignalTrace,3> track2Traces{};const float* activeAAddress=nullptr;const float* activeBAddress=nullptr;const float* activeMixerInputAAddress=nullptr;const float* activeMixerInputAddress=nullptr;
    for(int offset=0;offset<336000;offset+=480){activeLeft.fill(0);activeRight.fill(0);referenceLeft.fill(0);referenceRight.fill(0);activeTransport.beginBlock();referenceTransport.beginBlock();activeSequencer.processMidi(480,activeTransport);referenceSequencer.processMidi(480,referenceTransport);activePlan->process(activeOutput,2,480,activeTransport,activeMidi);referencePlan->process(referenceOutput,2,480,referenceTransport,referenceMidi);const auto* activeANode=isolationNode(*activePlan,"active-a");const auto* activeBNode=isolationNode(*activePlan,"active-b");const auto* referenceBNode=isolationNode(*referencePlan,"reference-b");const auto* activeMixer=isolationNode(*activePlan,"vst-isolation-mixer");const auto* referenceMixer=isolationNode(*referencePlan,"vst-isolation-mixer");if(offset==0){activeAAddress=activeANode->output.getReadPointer(0);activeBAddress=activeBNode->output.getReadPointer(0);activeMixerInputAAddress=activeMixer->processedSources[0]->getReadPointer(0);activeMixerInputAddress=activeMixer->processedSources[1]->getReadPointer(0);}for(int channel=0;channel<2;++channel){activeTrack1.copyFrom(channel,offset,activeANode->output,channel,0,480);activeStem.copyFrom(channel,offset,activeBNode->output,channel,0,480);referenceStem.copyFrom(channel,offset,referenceBNode->output,channel,0,480);activeMixerInput.copyFrom(channel,offset,*activeMixer->processedSources[1],channel,0,480);referenceMixerInput.copyFrom(channel,offset,*referenceMixer->processedSources[1],channel,0,480);activeMixerOutput.copyFrom(channel,offset,activeMixer->output,channel,0,480);}const auto blockEnd=offset+480;const size_t period=blockEnd==144000?0:blockEnd==240000?1:blockEnd==336000?2:3;if(period<3){const auto raw=activeBPlugin->takeSignalTelemetry();rawTrack2Peaks[period]=raw.outputPeak;const auto traces=activeSequencer.trackSignalTrace(&activeTransport);const auto found=std::find_if(traces.begin(),traces.end(),[](const auto& trace){return trace.trackId=="track-2";});if(found!=traces.end()){track2Traces[period]=*found;postTrack2Peaks[period]=found->peakAfterGain;}}activeTransport.advance(480);referenceTransport.advance(480);}
    expect(activeAAddress!=activeBAddress&&activeMixerInputAAddress!=activeMixerInputAddress,"separate VST nodes and Mixer inputs never share track storage");const float stemDifference=isolationDifference(activeStem,referenceStem);const float mixerInputDifference=isolationDifference(activeMixerInput,referenceMixerInput);const std::array<int,3> starts{48000,192000,288000};std::array<double,3> activeRms{},referenceRms{},ratios{},track1Rms{},mixerRms{};for(size_t period=0;period<3;++period){activeRms[period]=isolationRms(activeStem,starts[period],24000);referenceRms[period]=isolationRms(referenceStem,starts[period],24000);ratios[period]=referenceRms[period]>1.0e-12?activeRms[period]/referenceRms[period]:0.0;track1Rms[period]=isolationRms(activeTrack1,starts[period],24000);mixerRms[period]=isolationRms(activeMixerOutput,starts[period],24000);}const double ratioSpread=*std::max_element(ratios.begin(),ratios.end())-*std::min_element(ratios.begin(),ratios.end());
    const auto bridgeA=activeAPlugin->vst3BufferProcessTrace();
    const auto bridgeB=activeBPlugin->vst3BufferProcessTrace();
    expect(bridgeA.outputLeft!=0&&bridgeA.outputRight!=0&&bridgeB.outputLeft!=0&&bridgeB.outputRight!=0
               &&bridgeA.outputLeft!=bridgeA.outputRight&&bridgeB.outputLeft!=bridgeB.outputRight
               &&bridgeA.outputLeft!=bridgeB.outputLeft&&bridgeA.outputRight!=bridgeB.outputRight
               &&bridgeA.processCallInBlock==1&&bridgeB.processCallInBlock==1
               &&bridgeA.numSamples==480&&bridgeB.numSamples==480,
           "simultaneous commercial VST instances own disjoint planar buffers and execute once per 480-frame block");
    if(exact)expect(stemDifference<1.0e-6f&&mixerInputDifference<1.0e-6f,"deterministic VST Track 2 R == R2 sample-by-sample through Mixer input");else expect(activeRms[0]>1.0e-5&&activeRms[1]>1.0e-5&&activeRms[2]>1.0e-5&&ratioSpread<.02,"commercial VST Track 2/reference level ratio is invariant across Track 1 activation");expect(track1Rms[0]<1.0e-6&&track1Rms[1]>1.0e-5,"VST Track 1 is silent before its clip and audible during it");expect(std::all_of(track2Traces.begin(),track2Traces.end(),[](const auto& trace){return trace.trackId=="track-2"&&std::abs(trace.gainApplied-.8f)<1.0e-6f&&trace.destinationBuffer=="active-b:audio-in";}),"Track 2 keeps stable trackId/gain/chainId across Track 1 activation");
    std::cerr<<"[cross-track]["<<label<<"] stemDiff="<<stemDifference<<" mixerInputDiff="<<mixerInputDifference<<" track2Rms="<<activeRms[0]<<'/'<<activeRms[1]<<'/'<<activeRms[2]<<" referenceRms="<<referenceRms[0]<<'/'<<referenceRms[1]<<'/'<<referenceRms[2]<<" ratio="<<ratios[0]<<'/'<<ratios[1]<<'/'<<ratios[2]<<" ratioSpread="<<ratioSpread<<" rawVst2Peaks="<<rawTrack2Peaks[0]<<'/'<<rawTrack2Peaks[1]<<'/'<<rawTrack2Peaks[2]<<" postGain2Peaks="<<postTrack2Peaks[0]<<'/'<<postTrack2Peaks[1]<<'/'<<postTrack2Peaks[2]<<" track1Rms="<<track1Rms[0]<<'/'<<track1Rms[1]<<'/'<<track1Rms[2]<<" mixerRms="<<mixerRms[0]<<'/'<<mixerRms[1]<<'/'<<mixerRms[2]<<" instances="<<(const void*)activeAPlugin<<'/'<<(const void*)activeBPlugin<<" graphBuffers="<<(const void*)activeAAddress<<'/'<<(const void*)activeBAddress<<" bridgeA(inL/inR/outL/outR)=0x"<<std::hex<<bridgeA.inputLeft<<"/0x"<<bridgeA.inputRight<<"/0x"<<bridgeA.outputLeft<<"/0x"<<bridgeA.outputRight<<" bridgeB(inL/inR/outL/outR)=0x"<<bridgeB.inputLeft<<"/0x"<<bridgeB.inputRight<<"/0x"<<bridgeB.outputLeft<<"/0x"<<bridgeB.outputRight<<std::dec<<" buses="<<bridgeA.inputBusCount<<'/'<<bridgeA.outputBusCount<<','<<bridgeB.inputBusCount<<'/'<<bridgeB.outputBusCount<<" channels="<<bridgeA.mainInputChannels<<'/'<<bridgeA.mainOutputChannels<<','<<bridgeB.mainInputChannels<<'/'<<bridgeB.mainOutputChannels<<" frames="<<bridgeA.numSamples<<'/'<<bridgeB.numSamples<<" calls="<<bridgeA.processCallInBlock<<'/'<<bridgeB.processCallInBlock<<" mixerInputs="<<(const void*)activeMixerInputAAddress<<'/'<<(const void*)activeMixerInputAddress<<'\n';
    activeA->panic();activeB->panic();referenceA->panic();referenceB->panic();
}

void testDeterministicVstCrossTrackIsolation()
{
    const auto path=deterministicVst3();expect(path.isDirectory(),"cross-track deterministic VST3 exists");if(!path.isDirectory())return;const auto records=mlh::Vst3Scanner::scanFile(path.getFullPathName());expect(records.size()==1&&records[0].isInstrument,"cross-track deterministic VST3 scans as an instrument");if(records.empty())return;testHostedVstPairIsolation(records[0],records[0],"deterministic-vst/deterministic-vst",true);
}

void testDirectCommercialVstBufferBridge(const mlh::PluginRecord& record,
                                         const char* label)
{
    mlh::PluginInstance plugin;
    juce::String error;
    expect(plugin.create(record,48000,480,error),
           std::string(label)+" loads in direct VST3 planar capture");
    if(!plugin.isReady())return;
    plugin.setInstanceId(std::string("direct-")+label);
    juce::AudioBuffer<float> capture(2,480);
    float peak=0.0f;
    bool finite=true;
    for(uint64_t block=1;block<=32;++block)
    {
        capture.clear();
        juce::MidiBuffer midi;
        if(block==1)midi.addEvent(juce::MidiMessage::noteOn(1,69,(juce::uint8)100),0);
        plugin.processBlock(capture,midi,480,0x700000000ULL+block);
        peak=std::max(peak,capture.getMagnitude(0,0,480));
        peak=std::max(peak,capture.getMagnitude(1,0,480));
        for(int channel=0;channel<2;++channel)
            for(int sample=0;sample<480;++sample)
                finite&=std::isfinite(capture.getSample(channel,sample));
    }
    const auto trace=plugin.vst3BufferProcessTrace();
    expect(finite&&peak>1.0e-7f&&trace.outputLeft!=0&&trace.outputRight!=0
               &&trace.outputLeft!=trace.outputRight&&trace.numSamples==480
               &&trace.processCallInBlock==1&&trace.copiedToPluginInstance,
           std::string(label)+" direct AudioBusBuffers capture is finite, audible, planar and single-call");
    std::cerr<<"[vst3-direct-commercial]["<<label<<"] peak="<<peak
             <<" inBuses="<<trace.inputBusCount<<" outBuses="<<trace.outputBusCount
             <<" channels="<<trace.mainInputChannels<<'/'<<trace.mainOutputChannels
             <<" inL=0x"<<std::hex<<trace.inputLeft<<" inR=0x"<<trace.inputRight
             <<" outL=0x"<<trace.outputLeft<<" outR=0x"<<trace.outputRight<<std::dec
             <<" frames="<<trace.numSamples<<" call="<<trace.processCallInBlock<<'\n';
}

void testCommercialVstCrossTrackIsolation()
{
    const juce::File dexed("C:\\Program Files\\Common Files\\VST3\\Dexed.vst3"),vital("C:\\Program Files\\Common Files\\VST3\\Vital.vst3");expect(dexed.exists()&&vital.exists(),"Dexed and Vital VST3 bundles are installed for cross-track isolation");if(!dexed.exists()||!vital.exists())return;const auto dexedRecords=mlh::Vst3Scanner::scanFile(dexed.getFullPathName()),vitalRecords=mlh::Vst3Scanner::scanFile(vital.getFullPathName());expect(!dexedRecords.empty()&&!vitalRecords.empty(),"Dexed and Vital scan for cross-track isolation");if(dexedRecords.empty()||vitalRecords.empty())return;testDirectCommercialVstBufferBridge(dexedRecords[0],"Dexed");testDirectCommercialVstBufferBridge(vitalRecords[0],"Vital");testHostedVstPairIsolation(dexedRecords[0],dexedRecords[0],"Dexed/Dexed",false);testHostedVstPairIsolation(dexedRecords[0],vitalRecords[0],"Dexed/Vital",false);testHostedVstPairIsolation(vitalRecords[0],vitalRecords[0],"Vital/Vital",false);
}

void crossTrackLevelIsolation()
{
    std::cerr<<"[cross-track] crossTrackLevelIsolation\n";testInternalSineCrossTrackIsolation(true);testInternalSineCrossTrackIsolation(false);testAudioClipCrossTrackIsolation();testDeterministicVstCrossTrackIsolation();if(const char* commercial=std::getenv("MLH_RUN_COMMERCIAL_ISOLATION");commercial&&std::string(commercial)=="1")testCommercialVstCrossTrackIsolation();
}

} // namespace

int main(int argc, char** argv)
{
#if JUCE_WINDOWS
    // CI must receive the actual structured-exception exit code. A Windows
    // application-error/JIT dialog otherwise leaves the test process suspended
    // and makes an access violation look like an endless test hang.
    ::SetErrorMode(::SetErrorMode(0) | SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
#endif
    if (argc > 2
        && juce::String(argv[1]) == "--scan-file"
        && (juce::String(argv[2]) == kNoisyScanHelperPath
            || juce::String(argv[2]) == kHungScanHelperPath
            || juce::String(argv[2]) == kCrashingScanHelperPath))
        return runNoisyScanHelper(argc, argv);

    juce::ScopedJuceInitialiser_GUI juceInitialiser;
    const juce::String mode = argc > 1 ? juce::String::fromUTF8(argv[1]) : juce::String("--all");
    const bool runAll = mode == "--all";
    const bool runCore = runAll || mode == "--core";
    const bool runVst3 = runAll || mode == "--vst3-e2e";
    const bool runCrossTrack = runAll || mode == "--cross-track-isolation";
    if (runCore) {
    std::cerr << "[core] noisy-plugin-isolation\n";
    testNoisyPluginHelperResultIsolation();
    std::cerr << "[core] gesture-required\n";
    testGestureRequired();
    std::cerr << "[core] learn-arm-cancel\n";
    testLearnArmCancelAndAutoDisarm();
    std::cerr << "[core] learn-capture\n";
    testLearnCapturesOnlyPostArmAndFirstDistinctParameter();
    std::cerr << "[core] reset\n";
    testResetDropsPendingAndArmedState();
    std::cerr << "[core] utf8-metronome\n";
    testUtf8HostChromeAndMetronomeEvents();
    std::cerr << "[core] transport-freeze\n";
    testTransportTimingAndFreeze();
    std::cerr << "[core] transport-loop\n";
    testTransportSeekAndLoop();
    std::cerr << "[core] metronome-pitch\n";
    testMetronomePreCountPitchFamily();
    std::cerr << "[core] late-plugin-playhead\n";
    testLatePluginInheritsChainPlayHead();
    std::cerr << "[core] audio-dag\n";
    testAudioDagCompileAndCycles();
    std::cerr << "[core] pdc-source-delay\n";
    testPdcSourceDelayAcrossBlocks();
    std::cerr << "[core] audio-measurements\n";
    testAudioStageMeasurements();
    std::cerr << "[core] morpher-math\n";
    testMorpherStepperMath();
    std::cerr << "[core] mixer-morpher\n";
    testMixerAndMorpherNumerics();
    std::cerr << "[core] linear-sum-master\n";
    testLinearFloatSummationAndMasterMetering();
    std::cerr << "[core] arpeggiator\n";
    testArpeggiatorMusicAndTiming();
    std::cerr << "[core] audio-take\n";
    testAudioTakeWriter();
    std::cerr << "[core] sequencer-midi\n";
    testSequencerMidiSchedulingAndRecording();
    std::cerr << "[core] sequencer-midi-stress\n";
    testSequencerMidiStressLoopSeekAndStop();
    std::cerr << "[core] physical-midi-arp\n";
    testSequencerPhysicalMidiOutputAndArpeggiatorRoute();
    std::cerr << "[core] audio-input-routing\n";
    testSequencerAudioInputRoutingAuthority();
    std::cerr << "[core] sequencer-sum-gain\n";
    testSequencerTrackSumGainAndTrace();
    std::cerr << "[core] audio-record-export\n";
    testSequencerAudioRecordingAndMasterExport();
    }
    if (runVst3) testRealVst3SequencerPlaybackArpAndMasterExport();
    if (runCrossTrack) crossTrackLevelIsolation();
    if (failures == 0)
        std::cout << "native engine tests passed (" << checks << " checks, "
                  << mode << ")\n";
    return failures == 0 ? 0 : 1;
}
