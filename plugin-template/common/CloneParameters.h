#pragma once

// Plugin parameters of a clone, shared by all plugin templates: same names, ranges and value texts as the
// original (normalised ↔ physical through the measured display table, see clone/src/eq/mapping.ts).

#include <juce_audio_processors/juce_audio_processors.h>

#include "CloneModel.h"

#include <cmath>
#include <memory>

namespace vch
{
    using clonemodel::ParamInfo;

    /** Same interpolation as tableValue() in clone/src/eq/mapping.ts. */
    inline float tableValue (const ParamInfo& info, float norm)
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
    inline float tableNorm (const ParamInfo& info, float value)
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

    inline juce::String formatValue (float value, const char* unit, int fixedDecimals = -1)
    {
        const auto magnitude = std::abs (value);
        const int decimals = fixedDecimals >= 0 ? fixedDecimals : magnitude < 10.0f ? 3 : magnitude < 100.0f ? 2 : magnitude < 1000.0f ? 1 : 0;
        auto text = juce::String (value, decimals);

        if (juce::String (unit) == "dB" && value > 0.0f)
            text = "+" + text;

        return juce::String (unit).isEmpty() ? text : text + " " + unit;
    }

    inline std::unique_ptr<juce::RangedAudioParameter> makeParameter (const ParamInfo& info)
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
                const int decimals = info.decimals;
                auto attributes = juce::AudioParameterFloatAttributes()
                                      .withLabel (unit)
                                      .withStringFromValueFunction ([unit, decimals] (float v, int) { return formatValue (v, unit, decimals); })
                                      .withValueFromStringFunction ([] (const juce::String& text) { return text.getFloatValue(); });

                return std::make_unique<juce::AudioParameterFloat> (id, info.name, range, info.defaultValue, attributes);
            }
        }

        return {};
    }
}
