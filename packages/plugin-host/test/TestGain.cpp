// A tiny VST3 effect for the end-to-end test of the plugin host: halves the volume (gain 0.5, a parameter) and
// reports a latency of 64 samples, so the test can check processing, state and latency.
#include <juce_audio_processors/juce_audio_processors.h>

class TestGain : public juce::AudioProcessor
{
public:
    TestGain() : juce::AudioProcessor (BusesProperties().withInput ("In", juce::AudioChannelSet::stereo()).withOutput ("Out", juce::AudioChannelSet::stereo()))
    {
        addParameter (gain = new juce::AudioParameterFloat ({ "gain", 1 }, "Gain", 0.0f, 1.0f, 0.5f));
        setLatencySamples (64);
    }
    const juce::String getName() const override { return "AMS Test Gain"; }
    void prepareToPlay (double, int) override {}
    void releaseResources() override {}
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override { b.applyGain (gain->get()); }
    juce::AudioProcessorEditor* createEditor() override { return new juce::GenericAudioProcessorEditor (*this); }
    bool hasEditor() const override { return true; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock& d) override { juce::MemoryOutputStream (d, false).writeFloat (gain->get()); }
    void setStateInformation (const void* d, int n) override { if (n >= 4) *gain = juce::MemoryInputStream (d, (size_t) n, false).readFloat(); }
private:
    juce::AudioParameterFloat* gain;
};

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new TestGain(); }
