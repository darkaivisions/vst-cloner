#include "CloneProcessor.h"
#include "CloneEditor.h"
#include "CloneParameters.h"

#include <cmath>

CloneProcessor::CloneProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    for (int i = 0; i < clonemodel::numParams; ++i)
    {
        auto parameter = vch::makeParameter (clonemodel::params[i]);
        parameters.push_back (parameter.get());
        addParameter (parameter.release());
    }
}

bool CloneProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;
    return layouts.getMainInputChannelSet() == out;
}

void CloneProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    currentSampleRate = sampleRate;
    resample = std::abs (sampleRate - clonemodel::trainedSampleRate) > 0.5;
    for (auto& adapter : adapters)
        adapter.prepare (sampleRate, clonemodel::trainedSampleRate, std::max (samplesPerBlock, chunkSize));
    setLatencySamples (resample ? adapters[0].latency() : 0);
    reset();
}

void CloneProcessor::reset()
{
    for (auto& channel : channelState)
        channel.reset();
    for (auto& adapter : adapters)
        adapter.reset();
    initialised = false;
}

void CloneProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    // normalised values of the original's controls the network is conditioned on
    std::array<float, (size_t) std::max (vch::C, 1)> target {};
    for (int c = 0; c < vch::C; ++c)
    {
        const int index = clonemodel::conditionParams[c];
        target[(size_t) c] = clonemodel::snapCondition (c, (float) vch::originalValue (clonemodel::params[index], *parameters[(size_t) index]));
    }
    if (! initialised)
    {
        // first block after reset: no smoothing (offline renders must match the settings exactly)
        knobs = target;
        computed = target;
        vch::computeConditions (knobs.data(), conditions);
        initialised = true;
    }

    const int channels = std::min (buffer.getNumChannels(), 2);
    const int samples = buffer.getNumSamples();

    for (int start = 0; start < samples; start += chunkSize)
    {
        const int n = std::min (chunkSize, samples - start);
        const float k = (float) (1.0 - std::exp (-n / (smoothingSeconds * currentSampleRate)));
        bool moved = false;
        for (int c = 0; c < vch::C; ++c)
        {
            auto& v = knobs[(size_t) c];
            v += k * (target[(size_t) c] - v);
            if (std::abs (target[(size_t) c] - v) < 1e-5f) v = target[(size_t) c];
            moved = moved || std::abs (v - computed[(size_t) c]) > 1e-7f;
        }
        if (moved)
        {
            computed = knobs;
            vch::computeConditions (knobs.data(), conditions);
        }

        for (int ch = 0; ch < channels; ++ch)
        {
            auto* data = buffer.getWritePointer (ch) + start;
            auto& state = channelState[(size_t) ch];
            if (resample)
                adapters[(size_t) ch].process (data, n, [&] (float x) { return state.process (x, conditions); });
            else
                for (int i = 0; i < n; ++i)
                    data[i] = state.process (data[i], conditions);
        }
    }

    for (int ch = channels; ch < buffer.getNumChannels(); ++ch)
        buffer.clear (ch, 0, samples);
}

juce::AudioProcessorEditor* CloneProcessor::createEditor()
{
    if (clonegui::present)
        return new CloneEditor (*this);
    return new juce::GenericAudioProcessorEditor (*this);
}

void CloneProcessor::getStateInformation (juce::MemoryBlock& destination)
{
    juce::XmlElement xml ("VCH_CLONE");
    for (int i = 0; i < clonemodel::numParams; ++i)
        xml.setAttribute (clonemodel::params[i].id, (double) parameters[(size_t) i]->getValue());
    copyXmlToBinary (xml, destination);
}

void CloneProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto xml = getXmlFromBinary (data, sizeInBytes);
    if (xml == nullptr || ! xml->hasTagName ("VCH_CLONE"))
        return;
    for (int i = 0; i < clonemodel::numParams; ++i)
        if (xml->hasAttribute (clonemodel::params[i].id))
            parameters[(size_t) i]->setValueNotifyingHost ((float) xml->getDoubleAttribute (clonemodel::params[i].id));
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new CloneProcessor();
}
