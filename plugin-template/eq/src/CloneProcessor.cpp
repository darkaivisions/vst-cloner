#include "CloneProcessor.h"

#include <cmath>

namespace
{
    using clonemodel::ParamInfo;

    /** Same interpolation as tableValue() in clone/src/eq/mapping.ts. */
    float tableValue (const ParamInfo& info, float norm)
    {
        const auto* p = info.points;
        const int n = info.numPoints;

        if (norm <= p[0].norm) return p[0].value;
        if (norm >= p[n - 1].norm) return p[n - 1].value;

        int i = 1;
        while (p[i].norm < norm) ++i;

        const double t = (norm - p[i - 1].norm) / (p[i].norm - p[i - 1].norm);

        if (info.log)
            return (float) std::exp (std::log (p[i - 1].value) + t * (std::log (p[i].value) - std::log (p[i - 1].value)));

        return (float) (p[i - 1].value + t * (p[i].value - p[i - 1].value));
    }

    /** Same as tableNorm() in clone/src/eq/mapping.ts. */
    float tableNorm (const ParamInfo& info, float value)
    {
        const auto* p = info.points;
        const int n = info.numPoints;
        const bool increasing = p[n - 1].value >= p[0].value;
        auto f = [&] (double v) { return info.log ? std::log (std::max (v, 1e-30)) : v; };
        const double target = f (value);

        for (int i = 1; i < n; ++i)
        {
            const double a = f (p[i - 1].value);
            const double b = f (p[i].value);
            const bool inside = increasing ? (target >= a && target <= b) : (target <= a && target >= b);

            if (inside)
            {
                const double span = b - a;
                return (float) (p[i - 1].norm + (span != 0.0 ? (target - a) / span : 0.0) * (p[i].norm - p[i - 1].norm));
            }
        }

        const bool lowEnd = increasing ? target < f (p[0].value) : target > f (p[0].value);
        return lowEnd ? p[0].norm : p[n - 1].norm;
    }

    juce::String formatValue (float value, const char* unit)
    {
        const auto magnitude = std::abs (value);
        const int decimals = magnitude < 10.0f ? 3 : magnitude < 100.0f ? 2 : magnitude < 1000.0f ? 1 : 0;
        auto text = juce::String (value, decimals);

        if (juce::String (unit) == "dB" && value > 0.0f)
            text = "+" + text;

        return juce::String (unit).isEmpty() ? text : text + " " + unit;
    }

    std::unique_ptr<juce::RangedAudioParameter> makeParameter (const ParamInfo& info)
    {
        const juce::ParameterID id { info.id, 1 };

        switch (info.kind)
        {
            case clonemodel::ParamKind::toggle:
                return std::make_unique<juce::AudioParameterBool> (id, info.name, info.defaultValue > 0.5f);

            case clonemodel::ParamKind::choice:
            {
                juce::StringArray choices;
                for (int i = 0; i < info.numChoices; ++i)
                    choices.add (juce::String::fromUTF8 (info.choices[i]));
                return std::make_unique<juce::AudioParameterChoice> (id, info.name, choices, (int) info.defaultValue);
            }

            case clonemodel::ParamKind::continuous:
            {
                float lo = info.points[0].value, hi = info.points[0].value;
                for (int i = 1; i < info.numPoints; ++i)
                {
                    lo = std::min (lo, info.points[i].value);
                    hi = std::max (hi, info.points[i].value);
                }

                const ParamInfo* p = &info;
                juce::NormalisableRange<float> range (
                    lo, hi,
                    [p] (float, float, float norm) { return tableValue (*p, norm); },
                    [p] (float, float, float value) { return tableNorm (*p, value); });

                const char* unit = info.unit;
                auto attributes = juce::AudioParameterFloatAttributes()
                                      .withLabel (unit)
                                      .withStringFromValueFunction ([unit] (float v, int) { return formatValue (v, unit); })
                                      .withValueFromStringFunction ([] (const juce::String& text) { return text.getFloatValue(); });

                return std::make_unique<juce::AudioParameterFloat> (id, info.name, range, info.defaultValue, attributes);
            }
        }

        return {};
    }
}

CloneProcessor::CloneProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    for (int i = 0; i < clonemodel::numParams; ++i)
    {
        auto parameter = makeParameter (clonemodel::params[i]);
        parameters.push_back (parameter.get());
        addParameter (parameter.release());
    }

    bands.resize ((size_t) clonemodel::numBands);
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

    for (auto& band : bands)
    {
        band.initialised = false;
        for (auto& channel : band.filters)
            for (auto& f : channel)
                f.reset();
    }
}

float CloneProcessor::valueOf (int paramIndex) const
{
    auto* p = parameters[(size_t) paramIndex];

    if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (p))
        return (float) choice->getIndex();

    if (auto* toggle = dynamic_cast<juce::AudioParameterBool*> (p))
        return toggle->get() ? 1.0f : 0.0f;

    return p->convertFrom0to1 (p->getValue());
}

void CloneProcessor::updateBand (size_t index)
{
    const auto& info = clonemodel::bands[index];
    auto& band = bands[index];

    const std::array<int, 6> roles { info.enable, info.frequency, info.gain, info.q, info.shape, info.slope };
    std::array<float, 6> current {};
    for (size_t r = 0; r < roles.size(); ++r)
        current[r] = roles[r] >= 0 ? valueOf (roles[r]) : 0.0f;

    if (band.initialised && current == band.last)
        return;

    band.last = current;
    band.initialised = true;
    band.active = info.enable < 0 || current[0] > 0.5f;

    vch::BandSettings settings;
    if (info.frequency >= 0) settings.frequency = current[1];
    if (info.gain >= 0)      settings.gainDb = current[2];
    settings.q = info.q >= 0 ? current[3] : clonemodel::defaultQ;
    settings.order = info.slope >= 0 ? clonemodel::slopeOrders[juce::jlimit (0, clonemodel::numSlopes - 1, (int) current[5])] : 2;

    const int shape = info.shape >= 0 ? juce::jlimit (0, clonemodel::numShapes - 1, (int) current[4]) : 0;
    const int previous = band.count;
    band.count = vch::designBand (settings, clonemodel::shapes[shape], currentSampleRate, band.coeffs);

    // sections that just came into use start from silence
    for (int s = previous; s < band.count; ++s)
        for (auto& channel : band.filters)
            channel[(size_t) s].reset();
}

void CloneProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    for (size_t b = 0; b < bands.size(); ++b)
        updateBand (b);

    const float outputGain = clonemodel::outputGainParam >= 0 ? juce::Decibels::decibelsToGain (valueOf (clonemodel::outputGainParam), -1000.0f) : 1.0f;
    const int channels = std::min (buffer.getNumChannels(), 2);
    const int samples = buffer.getNumSamples();

    for (int ch = 0; ch < channels; ++ch)
    {
        auto* data = buffer.getWritePointer (ch);

        for (int i = 0; i < samples; ++i)
        {
            double x = data[i];

            for (auto& band : bands)
            {
                if (! band.active)
                    continue;

                auto& filters = band.filters[(size_t) ch];
                for (int s = 0; s < band.count; ++s)
                    x = filters[(size_t) s].process (band.coeffs[(size_t) s], x);
            }

            data[i] = (float) (x * outputGain);
        }
    }

    for (int ch = channels; ch < buffer.getNumChannels(); ++ch)
        buffer.clear (ch, 0, samples);
}

juce::AudioProcessorEditor* CloneProcessor::createEditor()
{
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
