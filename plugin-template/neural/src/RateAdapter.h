#pragma once

// The network was trained at one sample rate and its memory is counted in samples: at another rate every filter
// and time constant it learned would move. When the host runs at a different rate, RateAdapter converts the
// signal to the trained rate, lets the network process it there and converts the result back.

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace vch
{
    /**
     * 8th-order Butterworth low-pass (four biquads, RBJ design): keeps what lies above the trained rate's band out
     * of the network (no aliasing when the host runs faster) and removes the images of the way back.
     */
    class AntiAlias
    {
    public:
        void design (double cutoff, double rate)
        {
            static constexpr double qs[4] = { 0.50979558, 0.60134489, 0.89997622, 2.56291545 };
            const double w = 2.0 * juce::MathConstants<double>::pi * cutoff / rate;
            for (int i = 0; i < 4; ++i)
            {
                const double alpha = std::sin (w) / (2.0 * qs[i]), c = std::cos (w), a0 = 1.0 + alpha;
                auto& s = sections[(size_t) i];
                s.b0 = (float) ((1.0 - c) / 2.0 / a0);
                s.b1 = (float) ((1.0 - c) / a0);
                s.b2 = s.b0;
                s.a1 = (float) (-2.0 * c / a0);
                s.a2 = (float) ((1.0 - alpha) / a0);
            }
            reset();
        }

        void reset()
        {
            for (auto& s : sections)
                s.z1 = s.z2 = 0.0f;
        }

        /** delay at low frequencies in samples (group delay at DC: Σ (b1 + 2·b2)/(b0 + b1 + b2) − (a1 + 2·a2)/(1 + a1 + a2)) */
        double delay() const
        {
            double total = 0.0;
            for (const auto& s : sections)
                total += (s.b1 + 2.0 * s.b2) / (s.b0 + s.b1 + s.b2) - (s.a1 + 2.0 * s.a2) / (1.0 + s.a1 + s.a2);
            return total;
        }

        void process (float* data, int n)
        {
            for (auto& s : sections)
                for (int i = 0; i < n; ++i)
                {
                    const float x = data[i];
                    const float y = s.b0 * x + s.z1;
                    s.z1 = s.b1 * x - s.a1 * y + s.z2;
                    s.z2 = s.b2 * x - s.a2 * y;
                    data[i] = y;
                }
        }

    private:
        struct Section { float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0; };
        std::array<Section, 4> sections {};
    };

    class RateAdapter
    {
    public:
        /** model samples kept in reserve, so the way back never runs dry (costs this much latency) */
        static constexpr int reserve = 16;
        /** host samples held back so the forward interpolator never reads past what has arrived */
        static constexpr int margin = 4;

        void prepare (double hostRate, double modelRate, int maxBlock)
        {
            speedUp = hostRate / modelRate;   // host samples per model sample
            speedDown = modelRate / hostRate; // model samples per host sample
            // a faster host has content the network never heard (and the way back leaves images there)
            filtered = hostRate > modelRate * 1.01;
            if (filtered)
            {
                inputFilter.design (0.45 * modelRate, hostRate);
                outputFilter.design (0.45 * modelRate, hostRate);
            }
            const auto capacity = (size_t) (std::ceil (maxBlock * std::max (1.0, speedDown)) + 4 * reserve + 64);
            pending.reserve (capacity);
            processed.reserve (capacity);
            scratch.reserve (capacity);
            reset();
        }

        void reset()
        {
            forward.reset();
            back.reset();
            inputFilter.reset();
            outputFilter.reset();
            pending.clear();
            processed.assign ((size_t) reserve, 0.0f);
        }

        /**
         * delay of the round trip in host samples (reported to the host): the reserve of model samples, plus the
         * anti-alias filters above the trained rate. The held-back host samples add none (they are processed with
         * the next block), and the two interpolators' own delays cancel out – measured: at 44.1 kHz the clone lines
         * up with a 48 kHz original within a sample.
         */
        int latency() const
        {
            return (int) std::lround (reserve * speedUp + (filtered ? inputFilter.delay() + outputFilter.delay() : 0.0));
        }

        /** Replaces data (n host samples) by network(…) computed at the trained rate. */
        template <typename Network>
        void process (float* data, int n, Network&& network)
        {
            if (filtered)
                inputFilter.process (data, n);
            pending.insert (pending.end(), data, data + n);

            // forward: as many model samples as the pending host samples allow
            const int available = (int) pending.size() - margin;
            const int produce = available > 0 ? (int) std::floor (available / speedUp) : 0;
            if (produce > 0)
            {
                scratch.resize ((size_t) produce);
                const int used = forward.process (speedUp, pending.data(), scratch.data(), produce);
                pending.erase (pending.begin(), pending.begin() + std::min (used, (int) pending.size()));
                for (auto& v : scratch)
                    v = network (v);
                processed.insert (processed.end(), scratch.begin(), scratch.end());
            }

            // back: n host samples from the processed model samples (zeros only if the reserve were ever used up)
            const int have = (int) processed.size();
            const int used = back.process (speedDown, processed.data(), data, n, have, 0);
            processed.erase (processed.begin(), processed.begin() + std::min (used, have));
            if (filtered)
                outputFilter.process (data, n);
        }

    private:
        juce::LagrangeInterpolator forward, back;
        AntiAlias inputFilter, outputFilter;
        bool filtered = false;
        double speedUp = 1.0, speedDown = 1.0;
        std::vector<float> pending, processed, scratch;
    };
} // namespace vch
