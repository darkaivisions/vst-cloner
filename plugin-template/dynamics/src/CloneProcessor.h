#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "CloneModel.h"
#include "DynamicsEngine.h"

#include <atomic>
#include <vector>

/** Compressor clone: model parameters from the measured tables, gain computer at control rate. */
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
    /** Clears the detector; the next block starts from silence with the current parameters. */
    void reset() override;
    void releaseResources() override {}
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    /** Current gain reduction (dB, ≥ 0), for meters. */
    float getGainReduction() const { return gainReduction.load(); }

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
    /** makeup changes are smoothed (the gain computer itself is smooth by nature) */
    static constexpr double makeupSeconds = 0.02;

    std::vector<juce::RangedAudioParameter*> parameters;
    vch::GainComputer computer;
    double currentSampleRate = 48000.0;

    // state of the running block (see sampleGains() in clone/src/dynamics/model.ts)
    int position = 0;
    double sumSquares = 0.0, peak = 0.0;
    double fromDb = 0.0, toDb = 0.0;
    double makeupDb = 0.0;
    bool initialised = false;
    std::atomic<float> gainReduction { 0.0f };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CloneProcessor)
};
