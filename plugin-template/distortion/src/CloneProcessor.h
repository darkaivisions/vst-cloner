#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "CloneModel.h"
#include "DistortionEngine.h"

#include <array>
#include <vector>

/** Distortion clone: model values from the measured tables, Wiener–Hammerstein engine. */
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

    // interface used by the rebuilt editor (plugin-template/common/CloneEditor.cpp)
    juce::RangedAudioParameter* parameter (int index) const { return index >= 0 && index < (int) parameters.size() ? parameters[(size_t) index] : nullptr; }
    float physicalValue (int index) const
    {
        auto* p = parameter (index);
        if (p == nullptr) return 0.0f;
        if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (p)) return (float) choice->getIndex();
        if (auto* toggle = dynamic_cast<juce::AudioParameterBool*> (p)) return toggle->get() ? 1.0f : 0.0f;
        return p->convertFrom0to1 (p->getValue());
    }

private:
    /** model values follow parameter changes with this time constant (no zipper noise) */
    static constexpr double smoothingSeconds = 0.02;
    static constexpr int chunkSize = 32;

    void design();

    std::vector<juce::RangedAudioParameter*> parameters;
    double currentSampleRate = 48000.0;
    bool initialised = false;

    double packed[vch::numPacked] {};   // current (smoothed) model values
    double designed[vch::numPacked] {}; // values the coefficients belong to
    vch::DistortionParams params;
    std::array<vch::Coeffs, 4> pre {}, post {};
    std::array<std::array<vch::Biquad, 4>, 2> preState {}, postState {};
    /** delay of the original (scaled to the current sample rate), per channel */
    std::array<std::vector<float>, 2> delayLine;
    int delayLength = 0, delayPosition = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CloneProcessor)
};
