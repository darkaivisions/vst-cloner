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
    /** Clears the filters; the next block jumps to the parameter values without smoothing. */
    void reset() override;
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
    /** Smoothing: continuous values follow their target with this time constant; structure changes
        (on/off, shape, slope) fade the band out and in. */
    static constexpr double smoothingSeconds = 0.02, fadeSeconds = 0.01;
    static constexpr int chunkSize = 32;

    struct BandState
    {
        std::array<vch::Coeffs, vch::maxSections> coeffs {};
        std::array<std::array<vch::Biquad, vch::maxSections>, 2> filters {};
        int count = 0;
        bool initialised = false;

        // targets read from the parameters once per block
        double targetFrequency = 1000.0, targetGain = 0.0, targetQ = 0.70710678;
        bool targetActive = false;
        int targetShape = 0, targetOrder = 2;

        // state of the running filter
        double frequency = 1000.0, gain = 0.0, q = 0.70710678;
        double designedFrequency = -1.0, designedGain = 0.0, designedQ = 0.0;
        bool active = false;
        int shape = 0, order = 2;
        bool restructure = false;   // waiting for the fade-out before the structure changes
        double mix = 0.0, mixTarget = 0.0;
    };

    float valueOf (int paramIndex) const;
    void readTargets (BandState& band, size_t index);
    void design (BandState& band);
    void applyStructure (BandState& band);
    void advance (BandState& band, int samples);

    std::vector<juce::RangedAudioParameter*> parameters;
    std::vector<BandState> bands;
    double currentSampleRate = 48000.0;
    double outputGain = 1.0;
    bool outputInitialised = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CloneProcessor)
};
