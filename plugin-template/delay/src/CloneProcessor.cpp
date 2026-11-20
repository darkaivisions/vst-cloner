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

void CloneProcessor::design (Channel& channel)
{
    channel.coeffs.design (vch::unpack (channel.packed), channel.structure, currentSampleRate);
    std::copy (std::begin (channel.packed), std::end (channel.packed), std::begin (channel.designed));
}

const vch::DelayModelData& CloneProcessor::targetOf (const vch::DelayModelData* models, int numModels, double* target) const
{
    // model values of the current plugin parameters (normalised values of the original)
    const auto valueOf = [this] (int index) { return vch::originalValue (clonemodel::params[index], *parameters[(size_t) index]); };
    // predictDelayModel() in fit.ts: the model for the current switch position where there is one
    const vch::DelayModelData* model = &models[0];
    for (int m = 1; m < numModels; ++m)
    {
        const auto& candidate = models[m];
        const double value = valueOf (candidate.switchParam);
        if (value >= candidate.from && value < candidate.to)
        {
            model = &candidate;
            break;
        }
    }
    vch::predictPacked (model->basePacked, vch::numPacked, model->tables, model->numTables, valueOf, target);
    if (model->timeSum)
    {
        // combine() in fit.ts
        double at[vch::numPacked], ref[vch::numPacked];
        double seconds = std::exp (model->basePacked[0]);
        for (int t = 0; t < model->numTables; ++t)
        {
            vch::tableAt (model->tables[t], vch::numPacked, valueOf (model->tables[t].param), at);
            vch::tableAt (model->tables[t], vch::numPacked, model->tables[t].baseValue, ref);
            seconds += std::exp (at[0]) - std::exp (ref[0]);
        }
        target[0] = std::log (std::max (seconds, 1e-4));
    }
    return *model;
}

void CloneProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    const int channels = std::min (buffer.getNumChannels(), 2);
    const int samples = buffer.getNumSamples();
    double targets[2][vch::numPacked];
    bool polarityChanged[2] = { false, false };
    for (int ch = 0; ch < 2; ++ch)
    {
        // the right channel has its own model where the original answered differently on it (stereo)
        const bool own = ch == 1 && clonemodel::numModelsRight > 0;
        const auto& model = own ? targetOf (clonemodel::modelsRight, clonemodel::numModelsRight, targets[ch])
                                : targetOf (clonemodel::models, clonemodel::numModels, targets[ch]);
        auto& c = state[(size_t) ch];
        polarityChanged[ch] = c.structure.drySign != model.structure.drySign || c.structure.wetSign != model.structure.wetSign
                              || c.structure.feedbackSign != model.structure.feedbackSign;
        c.structure = model.structure;
    }
    if (! initialised)
    {
        // first block after reset: no smoothing (offline renders must match the settings exactly)
        for (int ch = 0; ch < 2; ++ch)
        {
            std::copy (std::begin (targets[ch]), std::end (targets[ch]), std::begin (state[(size_t) ch].packed));
            design (state[(size_t) ch]);
        }
        initialised = true;
    }

    for (int start = 0; start < samples; start += chunkSize)
    {
        const int n = std::min (chunkSize, samples - start);
        // a changed delay time glides (like a tape machine) instead of jumping
        const double k = 1.0 - std::exp (-n / (smoothingSeconds * currentSampleRate));
        for (int ch = 0; ch < 2; ++ch)
        {
            auto& c = state[(size_t) ch];
            bool moved = false;
            for (int i = 0; i < vch::numPacked; ++i)
            {
                c.packed[i] += k * (targets[ch][i] - c.packed[i]);
                if (std::abs (targets[ch][i] - c.packed[i]) < 1e-6) c.packed[i] = targets[ch][i];
                moved = moved || std::abs (c.packed[i] - c.designed[i]) > 1e-9;
            }
            if (moved || (polarityChanged[ch] && start == 0))
                design (c);
        }

        for (int ch = 0; ch < channels; ++ch)
        {
            auto* data = buffer.getWritePointer (ch) + start;
            auto& line = lines[(size_t) ch];
            const auto& coeffs = state[(size_t) ch].coeffs;
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
