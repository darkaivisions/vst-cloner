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

void CloneProcessor::prepareToPlay (double sampleRate, int)
{
    currentSampleRate = sampleRate;
    for (auto& line : lines)
        line.prepare (sampleRate);
    reset();
}

void CloneProcessor::reset()
{
    for (auto& line : lines)
        line.reset();
    initialised = false;
}

void CloneProcessor::design()
{
    coeffs.design (vch::unpack (packed), clonemodel::structure, currentSampleRate);
    std::copy (std::begin (packed), std::end (packed), std::begin (designed));
}

void CloneProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    // model values of the current plugin parameters (normalised values of the original)
    double target[vch::numPacked];
    vch::predictPacked (clonemodel::basePacked, vch::numPacked, clonemodel::tables, clonemodel::numTables,
                        [this] (int index) { return vch::originalValue (clonemodel::params[index], *parameters[(size_t) index]); }, target);
    if (! initialised)
    {
        // first block after reset: no smoothing (offline renders must match the settings exactly)
        std::copy (std::begin (target), std::end (target), std::begin (packed));
        design();
        initialised = true;
    }

    const int channels = std::min (buffer.getNumChannels(), 2);
    const int samples = buffer.getNumSamples();

    for (int start = 0; start < samples; start += chunkSize)
    {
        const int n = std::min (chunkSize, samples - start);
        // a changed delay time glides (like a tape machine) instead of jumping
        const double k = 1.0 - std::exp (-n / (smoothingSeconds * currentSampleRate));
        bool moved = false;
        for (int i = 0; i < vch::numPacked; ++i)
        {
            packed[i] += k * (target[i] - packed[i]);
            if (std::abs (target[i] - packed[i]) < 1e-6) packed[i] = target[i];
            moved = moved || std::abs (packed[i] - designed[i]) > 1e-9;
        }
        if (moved)
            design();

        for (int ch = 0; ch < channels; ++ch)
        {
            auto* data = buffer.getWritePointer (ch) + start;
            auto& line = lines[(size_t) ch];
            for (int i = 0; i < n; ++i)
                data[i] = (float) line.process (data[i], coeffs);
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
