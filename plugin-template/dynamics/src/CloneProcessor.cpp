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
    reset();
}

void CloneProcessor::reset()
{
    computer.reset();
    position = 0;
    sumSquares = peak = 0.0;
    fromDb = toDb = 0.0;
    initialised = false;
}

void CloneProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    // model parameters from the current plugin parameters (normalised values of the original)
    const auto params = vch::predict (clonemodel::basePacked, clonemodel::tables, clonemodel::numTables,
                                      [this] (int index) { return vch::originalValue (clonemodel::params[index], *parameters[(size_t) index]); });
    computer.setParams (params, currentSampleRate);
    if (! initialised)
    {
        makeupDb = params.makeupDb;
        initialised = true;
    }
    const double makeupStep = 1.0 - std::exp (-vch::dynamicsBlock / (makeupSeconds * currentSampleRate));

    const int channels = std::min (buffer.getNumChannels(), 2);
    const int samples = buffer.getNumSamples();
    constexpr double ln10over20 = 0.11512925464970229;

    for (int i = 0; i < samples; ++i)
    {
        // renderModel() in model.ts: gain reduction ramp → saturation → makeup
        const double t = (position + 1) / (double) vch::dynamicsBlock;
        const double reduction = std::exp ((fromDb + (toDb - fromDb) * t) * ln10over20);
        const double makeup = std::exp (makeupDb * ln10over20);

        for (int ch = 0; ch < channels; ++ch)
        {
            auto* data = buffer.getWritePointer (ch);
            const double x = data[i];
            sumSquares += x * x;
            peak = std::max (peak, std::abs (x));
            data[i] = (float) (vch::shape (x * reduction, params.drive) * makeup);
        }

        if (++position == vch::dynamicsBlock)
        {
            // blockLevels() in model.ts: RMS + 3.01 dB (sine peak scale) or peak, in dBFS
            const double level = clonemodel::detector == vch::Detector::peak
                                     ? 20.0 * std::log10 (peak + 1e-12)
                                     : 10.0 * std::log10 (sumSquares / (vch::dynamicsBlock * std::max (channels, 1)) + 1e-24) + 3.0103;
            fromDb = toDb;
            toDb = computer.step (level, clonemodel::topology);
            gainReduction.store ((float) -toDb);
            if ((float) peak > inputPeak.load())
                inputPeak.store ((float) peak);
            makeupDb += makeupStep * (params.makeupDb - makeupDb);
            position = 0;
            sumSquares = peak = 0.0;
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
