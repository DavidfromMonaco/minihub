#include <juce_audio_processors/juce_audio_processors.h>

/** A tiny, state-free stereo effect used only by the packaged offline-bounce
 * gauntlet. Its gain -- 0.75 unless something moves it -- makes cloning and
 * processing deterministic while still exercising a real VST3 effect after
 * each hosted instrument. The gain is a parameter so the host's automation
 * (D-065) has something real to move. */
class DeterministicTestEffect final : public juce::AudioProcessor {
public:
    DeterministicTestEffect()
        : AudioProcessor(BusesProperties()
            .withInput("Input", juce::AudioChannelSet::stereo(), true)
            .withOutput("Output", juce::AudioChannelSet::stereo(), true))
    {
        addParameter(gain_ = new juce::AudioParameterFloat(juce::ParameterID { "gain", 1 }, "Gain",
                                                           juce::NormalisableRange<float>(0.0f, 1.0f), 0.75f));
    }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void prepareToPlay(double, int) override {}
    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override
    {
        return layouts.getMainInputChannelSet() == juce::AudioChannelSet::stereo()
            && layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
    }

    void processBlock(juce::AudioBuffer<float>& audio, juce::MidiBuffer&) override
    {
        audio.applyGain(gain_->get());
    }

    void getStateInformation(juce::MemoryBlock& state) override
    {
        const uint32_t marker = 0x4d4c4846u;
        state.append(&marker, sizeof(marker));
    }

    void setStateInformation(const void*, int) override {}

private:
    juce::AudioParameterFloat* gain_ = nullptr;
};

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new DeterministicTestEffect();
}
