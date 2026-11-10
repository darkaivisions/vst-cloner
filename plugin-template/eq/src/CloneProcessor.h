#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "CloneModel.h"
#include "EqEngine.h"

#include <array>
#include <vector>

class CloneProcessor final : public juce::AudioProcessor
{
public:
    CloneProcessor();

    const juce::String getName() const override { return clonemodel::pluginName; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    /** Magnitude response (dB) of all active bands at `frequency`, for the editor's curve display. */
    double responseDb (double frequency);

    juce::RangedAudioParameter* parameter (int index) const { return index >= 0 && index < (int) parameters.size() ? parameters[(size_t) index] : nullptr; }
    float physicalValue (int index) const { return valueOf (index); }

private:
    struct BandState
    {
        std::array<vch::Coeffs, vch::maxSections> coeffs {};
        std::array<std::array<vch::Biquad, vch::maxSections>, 2> filters {};
        std::array<float, 6> last {};
        int count = 0;
        bool active = true;
        bool initialised = false;
    };

    float valueOf (int paramIndex) const;
    void updateBand (size_t band);

    std::vector<juce::RangedAudioParameter*> parameters;
    std::vector<BandState> bands;
    double currentSampleRate = 48000.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CloneProcessor)
};
