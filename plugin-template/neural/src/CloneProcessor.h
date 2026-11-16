#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "CloneModel.h"
#include "NeuralEngine.h"
#include "RateAdapter.h"

#include <array>
#include <vector>

/** Universal clone: a recurrent network conditioned on the controls (trained by dsp/neural/train.py). */
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
    /** control values follow parameter changes with this time constant (no zipper noise) */
    static constexpr double smoothingSeconds = 0.02;
    static constexpr int chunkSize = 32;

    std::vector<juce::RangedAudioParameter*> parameters;
    double currentSampleRate = 48000.0;
    bool initialised = false;

    std::array<float, (size_t) std::max (vch::C, 1)> knobs {};     // current (smoothed) values
    std::array<float, (size_t) std::max (vch::C, 1)> computed {};  // values the conditions belong to
    vch::NeuralConditions conditions;
    std::array<vch::NeuralChannel, 2> channelState {};
    /** the host runs at another rate than the network was trained at: the network computes at its own rate */
    bool resample = false;
    std::array<vch::RateAdapter, 2> adapters;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CloneProcessor)
};
