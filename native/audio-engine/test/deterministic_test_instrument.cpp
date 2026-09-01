#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <cmath>

/** Deliberately tiny VST3 used only by MiniHub's host validation. It is a real
 * plugin binary (not linked into the host) and turns incoming MIDI into a
 * deterministic stereo sine wave with immediate note-off cleanup. Like the
 * real instruments that exposed the silence bug, it declares 16 active stereo
 * outputs; MiniHub must negotiate that down to its stereo graph contract. */
class DeterministicTestInstrument final : public juce::AudioProcessor {
public:
    DeterministicTestInstrument()
        : AudioProcessor(makeBuses()) {}

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return true; }
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
    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override
    {
        return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
    }

    void prepareToPlay(double sampleRate, int) override
    {
        sampleRate_ = sampleRate > 0.0 ? sampleRate : 48000.0;
        resetVoices();
    }

    void processBlock(juce::AudioBuffer<float>& audio, juce::MidiBuffer& midi) override
    {
        audio.clear();
        int cursor = 0;
        for (const auto metadata : midi)
        {
            const int position = juce::jlimit(cursor, audio.getNumSamples(), metadata.samplePosition);
            render(audio, cursor, position);
            apply(metadata.getMessage());
            cursor = position;
        }
        render(audio, cursor, audio.getNumSamples());
    }

    void getStateInformation(juce::MemoryBlock& state) override
    {
        const uint32_t marker = 0x4d4c4854u;
        state.append(&marker, sizeof(marker));
    }

    void setStateInformation(const void*, int) override { resetVoices(); }

private:
    static BusesProperties makeBuses()
    {
        BusesProperties buses;
        for (int index = 0; index < 16; ++index)
            buses.addBus(false, "Output " + juce::String(index + 1),
                         juce::AudioChannelSet::stereo(), true);
        return buses;
    }

    struct Voice { bool active=false; double phase=0.0, increment=0.0; float gain=0.0f; };

    void resetVoices() { for (auto& voice : voices_) voice = {}; }

    void apply(const juce::MidiMessage& message)
    {
        if (message.isNoteOn())
        {
            auto& voice = voices_[(size_t)juce::jlimit(0, 127, message.getNoteNumber())];
            voice.active = true;
            voice.phase = 0.0;
            voice.increment = juce::MathConstants<double>::twoPi
                * juce::MidiMessage::getMidiNoteInHertz(message.getNoteNumber()) / sampleRate_;
            // Full velocity intentionally reaches 0.95 so the E2E gauntlet can
            // reproduce two individually sub-full-scale VSTs summing to 1.90
            // (+5.575 dBFS) through the real hosted processBlock path.
            voice.gain = 0.95f * message.getFloatVelocity();
        }
        else if (message.isNoteOff())
            voices_[(size_t)juce::jlimit(0, 127, message.getNoteNumber())].active = false;
        else if (message.isAllNotesOff() || message.isAllSoundOff())
            resetVoices();
    }

    void render(juce::AudioBuffer<float>& audio, int begin, int end)
    {
        for (int sample = begin; sample < end; ++sample)
        {
            float value = 0.0f;
            for (auto& voice : voices_) if (voice.active)
            {
                value += std::sin((float)voice.phase) * voice.gain;
                voice.phase += voice.increment;
                if (voice.phase >= juce::MathConstants<double>::twoPi)
                    voice.phase -= juce::MathConstants<double>::twoPi;
            }
            value = juce::jlimit(-0.95f, 0.95f, value);
            for (int channel = 0; channel < audio.getNumChannels(); ++channel)
                audio.setSample(channel, sample, value);
        }
    }

    double sampleRate_ = 48000.0;
    std::array<Voice, 128> voices_ {};
};

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new DeterministicTestInstrument();
}
