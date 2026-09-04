#pragma once
#include "chain.h"
#include "midi_output.h"
#include "transport.h"
#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace mlh {

struct ArpStep { int semitoneOffset=0, velocity=100; float gate=.8f; bool rest=false, tie=false; };
struct ArpConfig {
    int root=0, scale=0, mode=0, rate=2, patternLength=8; uint32_t randomSeed=0x5eed1234u;
    std::array<ArpStep,32> steps{};
};
struct MidiNetworkNodeSpec { std::string id, kind; ArpConfig arp; std::vector<std::string> destinations; };
struct MidiNetworkSpec { std::vector<MidiNetworkNodeSpec> nodes; };
enum class MidiDestinationKind { chain, physicalOutput };
struct MidiDestination {
    MidiDestinationKind kind = MidiDestinationKind::chain;
    Chain* chain = nullptr;
    uint32_t blockEpoch = 0; // captured before this callback generates events
};

class ArpeggiatorRuntime {
public:
    explicit ArpeggiatorRuntime(ArpConfig config);
    void pushInput(const juce::MidiMessage&) noexcept;
    void process(int numSamples, Transport&, std::vector<MidiDestination>&,
                 MidiOutputSink* = nullptr, double callbackStartMs = 0,
                 double sampleRate = 48000,
                 const juce::MidiBuffer* scheduledInput = nullptr) noexcept;
    void panic(const std::vector<MidiDestination>&, MidiOutputSink* = nullptr) noexcept;
    static int degreeToMidi(int root, int scale, int degree, int octave, int baseOctave=4) noexcept;
    static int semitoneOffsetToMidi(int root, int semitoneOffset, int baseOctave=4) noexcept;
    static double stepQuarterNotes(int rate) noexcept;
    int heldCountForTesting() const noexcept { return heldCount_; }
    bool holdsNoteForTesting(int note) const noexcept {
        return std::find(held_.begin(), held_.begin() + heldCount_, note) != held_.begin() + heldCount_;
    }
private:
    struct Input { uint8_t bytes[3]{}; int size=0; };
    struct Active { int note=0, channel=1; double endPpq=0; bool on=false; };
    void applyInput(const juce::MidiMessage&) noexcept;
    void emit(const juce::MidiMessage&, int sample) noexcept;
    void flush(const std::vector<MidiDestination>&, MidiOutputSink*,
               double callbackStartMs, double sampleRate) noexcept;
    int presetNote(int64_t step) noexcept;
    int quantize(int note) const noexcept;
    ArpConfig config_; juce::AbstractFifo fifo_{256}; std::array<Input,256> input_{};
    std::array<int,128> held_{}; int heldCount_=0; std::array<Active,64> active_{};
    int64_t lastStep_=std::numeric_limits<int64_t>::min(); bool wasPlaying_=false; uint32_t random_=0;
    juce::MidiBuffer output_;
};

class MidiExecutionPlan {
public:
    struct Node {
        std::string id;
        std::unique_ptr<ArpeggiatorRuntime> arp;
        std::vector<MidiDestination> destinations;
        juce::MidiBuffer scheduledInput;
    };
    static std::unique_ptr<MidiExecutionPlan> compile(const MidiNetworkSpec&, const std::function<Chain*(const std::string&)>&, std::string&);
    void process(int numSamples, Transport&, MidiOutputSink* = nullptr,
                 double callbackStartMs = 0, double sampleRate = 48000) noexcept;
    bool pushInput(const std::string& nodeId, const juce::MidiMessage&) noexcept;
    bool pushInputBuffer(const std::string& nodeId, const juce::MidiBuffer&) noexcept;
    void panicAll(MidiOutputSink* = nullptr) noexcept;
    const std::vector<Node>& nodes() const noexcept { return nodes_; }
private: std::vector<Node> nodes_;
};
}
