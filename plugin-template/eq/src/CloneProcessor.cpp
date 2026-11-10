#include "CloneProcessor.h"
#include "CloneEditor.h"

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
    reset();
}

void CloneProcessor::reset()
{
    for (auto& band : bands)
    {
        band.initialised = false;
        for (auto& channel : band.filters)
            for (auto& f : channel)
                f.reset();
    }
    outputInitialised = false;
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

void CloneProcessor::readTargets (BandState& band, size_t index)
{
    const auto& info = clonemodel::bands[index];
    if (info.frequency >= 0) band.targetFrequency = std::max (1.0, (double) valueOf (info.frequency));
    if (info.gain >= 0)      band.targetGain = valueOf (info.gain);
    band.targetQ = std::max (1e-3, info.q >= 0 ? (double) valueOf (info.q) : clonemodel::defaultQ);
    band.targetActive = info.enable < 0 || valueOf (info.enable) > 0.5f;
    band.targetOrder = info.slope >= 0 ? clonemodel::slopeOrders[juce::jlimit (0, clonemodel::numSlopes - 1, (int) valueOf (info.slope))] : 2;
    band.targetShape = info.shape >= 0 ? juce::jlimit (0, clonemodel::numShapes - 1, (int) valueOf (info.shape)) : 0;

    if (! band.initialised)
    {
        // first block after prepareToPlay: no smoothing (offline renders must match the settings exactly)
        band.frequency = band.targetFrequency;
        band.gain = band.targetGain;
        band.q = band.targetQ;
        applyStructure (band);
        band.mix = band.mixTarget;
        band.initialised = true;
        return;
    }

    const bool structureChanged = band.targetActive != band.active || band.targetShape != band.shape || band.targetOrder != band.order;
    if (structureChanged && ! band.restructure)
    {
        if (band.mix > 0.0)
        {
            band.restructure = true;  // fade out first, then rebuild (see advance)
            band.mixTarget = 0.0;
        }
        else
        {
            applyStructure (band);
        }
    }
}

void CloneProcessor::design (BandState& band)
{
    vch::BandSettings settings;
    settings.frequency = band.frequency;
    settings.gainDb = band.gain;
    settings.q = band.q;
    settings.order = band.order;

    const int previous = band.count;
    band.count = vch::designBand (settings, clonemodel::shapes[band.shape], currentSampleRate, band.coeffs);
    band.designedFrequency = band.frequency;
    band.designedGain = band.gain;
    band.designedQ = band.q;

    // sections that just came into use start from silence
    for (int s = previous; s < band.count; ++s)
        for (auto& channel : band.filters)
            channel[(size_t) s].reset();
}

void CloneProcessor::applyStructure (BandState& band)
{
    band.active = band.targetActive;
    band.shape = band.targetShape;
    band.order = band.targetOrder;
    band.restructure = false;
    band.count = 0;
    for (auto& channel : band.filters)
        for (auto& f : channel)
            f.reset();
    design (band);
    band.mixTarget = band.active ? 1.0 : 0.0;
}

void CloneProcessor::advance (BandState& band, int samples)
{
    // continuous values: one-pole smoothing (log domain for frequency and Q)
    const double k = 1.0 - std::exp (-samples / (smoothingSeconds * currentSampleRate));
    band.frequency = std::exp (std::log (band.frequency) + k * (std::log (band.targetFrequency) - std::log (band.frequency)));
    band.q = std::exp (std::log (band.q) + k * (std::log (band.targetQ) - std::log (band.q)));
    band.gain += k * (band.targetGain - band.gain);
    if (std::abs (std::log (band.targetFrequency / band.frequency)) < 1e-5) band.frequency = band.targetFrequency;
    if (std::abs (std::log (band.targetQ / band.q)) < 1e-5) band.q = band.targetQ;
    if (std::abs (band.targetGain - band.gain) < 1e-4) band.gain = band.targetGain;

    if (band.active && (std::abs (std::log (band.frequency / band.designedFrequency)) > 1e-6
                        || std::abs (band.gain - band.designedGain) > 1e-6
                        || std::abs (std::log (band.q / band.designedQ)) > 1e-6))
        design (band);

    // fades for structure changes
    const double step = samples / (fadeSeconds * currentSampleRate);
    band.mix = band.mixTarget > band.mix ? std::min (band.mixTarget, band.mix + step) : std::max (band.mixTarget, band.mix - step);
}

void CloneProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    for (size_t b = 0; b < bands.size(); ++b)
        readTargets (bands[b], b);

    const double targetGain = clonemodel::outputGainParam >= 0 ? juce::Decibels::decibelsToGain ((double) valueOf (clonemodel::outputGainParam), -1000.0) : 1.0;
    if (! outputInitialised)
    {
        outputGain = targetGain;
        outputInitialised = true;
    }

    const int channels = std::min (buffer.getNumChannels(), 2);
    const int samples = buffer.getNumSamples();

    for (int start = 0; start < samples; start += chunkSize)
    {
        const int n = std::min (chunkSize, samples - start);
        const double kGain = 1.0 - std::exp (-n / (smoothingSeconds * currentSampleRate));
        const double gainStart = outputGain;
        outputGain += kGain * (targetGain - outputGain);
        if (std::abs (targetGain - outputGain) < 1e-6) outputGain = targetGain;

        for (auto& band : bands)
        {
            const double mixStart = band.mix;
            advance (band, n);
            const double mixEnd = band.mix;

            if (mixStart > 0.0 || mixEnd > 0.0)
            {
                for (int ch = 0; ch < channels; ++ch)
                {
                    auto* data = buffer.getWritePointer (ch) + start;
                    auto& filters = band.filters[(size_t) ch];
                    const bool full = mixStart >= 1.0 && mixEnd >= 1.0;

                    for (int i = 0; i < n; ++i)
                    {
                        double x = data[i];
                        double y = x;
                        for (int s = 0; s < band.count; ++s)
                            y = filters[(size_t) s].process (band.coeffs[(size_t) s], y);
                        if (! full)
                        {
                            const double m = mixStart + (mixEnd - mixStart) * (i + 1) / n;
                            y = x + m * (y - x);
                        }
                        data[i] = (float) y;
                    }
                }
            }

            // faded out completely: switch structure now, filters start from silence
            if (band.restructure && band.mix <= 0.0)
                applyStructure (band);
        }

        for (int ch = 0; ch < channels; ++ch)
        {
            auto* data = buffer.getWritePointer (ch) + start;
            for (int i = 0; i < n; ++i)
                data[i] = (float) (data[i] * (gainStart + (outputGain - gainStart) * (i + 1) / n));
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

double CloneProcessor::responseDb (double frequency)
{
    // computed from the parameters only – never touches the audio thread's filter state
    const double sampleRate = currentSampleRate > 0 ? currentSampleRate : 48000.0;
    const double w = 2.0 * juce::MathConstants<double>::pi * frequency / sampleRate;
    const double c1 = std::cos (w), s1 = std::sin (w), c2 = std::cos (2 * w), s2 = std::sin (2 * w);
    double db = 0.0;

    for (int b = 0; b < clonemodel::numBands; ++b)
    {
        const auto& info = clonemodel::bands[b];
        if (info.enable >= 0 && valueOf (info.enable) < 0.5f)
            continue;

        vch::BandSettings settings;
        if (info.frequency >= 0) settings.frequency = valueOf (info.frequency);
        if (info.gain >= 0)      settings.gainDb = valueOf (info.gain);
        settings.q = info.q >= 0 ? valueOf (info.q) : clonemodel::defaultQ;
        settings.order = info.slope >= 0 ? clonemodel::slopeOrders[juce::jlimit (0, clonemodel::numSlopes - 1, (int) valueOf (info.slope))] : 2;
        const int shape = info.shape >= 0 ? juce::jlimit (0, clonemodel::numShapes - 1, (int) valueOf (info.shape)) : 0;

        std::array<vch::Coeffs, vch::maxSections> coeffs {};
        const int count = vch::designBand (settings, clonemodel::shapes[shape], sampleRate, coeffs);

        for (int i = 0; i < count; ++i)
        {
            const auto& c = coeffs[(size_t) i];
            const double nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
            const double dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
            db += 10.0 * std::log10 (std::max (nr * nr + ni * ni, 1e-30) / std::max (dr * dr + di * di, 1e-30));
        }
    }

    if (clonemodel::outputGainParam >= 0)
        db += valueOf (clonemodel::outputGainParam);

    return db;
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
