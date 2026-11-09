#pragma once

// Parametric EQ engine driven by a fitted model (see clone/src/eq/model.ts and clone/src/dsp/biquad.ts).
// IMPORTANT: the filter math must stay identical to the TypeScript reference implementation.

#include <algorithm>
#include <array>
#include <cmath>

namespace vch
{

enum class Design { bilinear, matched };
enum class Kind { bell, lowShelf, highShelf, lowCut, highCut, notch, bandPass, tiltShelf, unsupported };
enum class QMode { ignore, scaleAll, scaleLast };

struct ShapeFit
{
    Kind kind;
    bool fitted;
    Design design;
    double freqScale, qScale, qExponent, gainScale;
    QMode qMode;
    int tiltOrder;
};

struct BandSettings
{
    double frequency = 1000.0, gainDb = 0.0, q = 0.70710678118654752;
    int order = 2;
};

struct Coeffs
{
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
};

constexpr int maxSections = 8;
constexpr double bilinearMaxFraction = 0.49;

namespace detail
{
    constexpr double pi = 3.14159265358979323846;

    struct Analog
    {
        double b0, b1, b2, a0, a1, a2, f0;
        bool firstOrder() const { return a2 == 0.0 && b2 == 0.0; }
    };

    inline double analogMag2 (const Analog& s, double w)
    {
        const double w2 = w * w;
        const double num = (s.b0 - s.b2 * w2) * (s.b0 - s.b2 * w2) + (s.b1 * w) * (s.b1 * w);
        const double den = (s.a0 - s.a2 * w2) * (s.a0 - s.a2 * w2) + (s.a1 * w) * (s.a1 * w);
        return num / den;
    }

    inline Coeffs bilinear (Analog s, double sampleRate)
    {
        s.f0 = std::min (s.f0, bilinearMaxFraction * sampleRate);
        const double k = std::tan (pi * s.f0 / sampleRate);

        if (s.firstOrder())
        {
            const double n = s.a1 + s.a0 * k;
            return { (s.b1 + s.b0 * k) / n, (s.b0 * k - s.b1) / n, 0.0, (s.a0 * k - s.a1) / n, 0.0 };
        }

        const double kk = k * k;
        const double n = s.a2 + s.a1 * k + s.a0 * kk;
        return { (s.b2 + s.b1 * k + s.b0 * kk) / n,
                 (2.0 * (s.b0 * kk - s.b2)) / n,
                 (s.b2 - s.b1 * k + s.b0 * kk) / n,
                 (2.0 * (s.a0 * kk - s.a2)) / n,
                 (s.a2 - s.a1 * k + s.a0 * kk) / n };
    }

    inline Coeffs matched (const Analog& s, double sampleRate)
    {
        const double w0T = 2.0 * pi * s.f0 / sampleRate;
        const double nyquistOmega = sampleRate / 2.0 / s.f0;

        if (s.firstOrder())
        {
            const double da1 = -std::exp ((-s.a0 / s.a1) * w0T);
            const double p = std::sqrt (analogMag2 (s, 0.0)) * (1.0 + da1);
            const double q = std::sqrt (analogMag2 (s, nyquistOmega)) * (1.0 - da1);
            return { (p + q) / 2.0, (p - q) / 2.0, 0.0, da1, 0.0 };
        }

        const double disc = s.a1 * s.a1 - 4.0 * s.a2 * s.a0;
        double da1, da2;

        if (disc < 0.0)
        {
            const double alpha = (s.a1 / (2.0 * s.a2)) * w0T;
            const double beta = (std::sqrt (-disc) / (2.0 * s.a2)) * w0T;
            da1 = -2.0 * std::exp (-alpha) * std::cos (beta);
            da2 = std::exp (-2.0 * alpha);
        }
        else
        {
            const double r = std::sqrt (disc);
            const double p1 = ((-s.a1 + r) / (2.0 * s.a2)) * w0T;
            const double p2 = ((-s.a1 - r) / (2.0 * s.a2)) * w0T;
            da1 = -(std::exp (p1) + std::exp (p2));
            da2 = std::exp (p1 + p2);
        }

        const double A0 = (1.0 + da1 + da2) * (1.0 + da1 + da2);
        const double A1 = (1.0 - da1 + da2) * (1.0 - da1 + da2);
        const double A2 = -4.0 * da2;

        const double wm = std::min (w0T, 0.9 * pi);
        const double phi1 = std::sin (wm / 2.0) * std::sin (wm / 2.0);
        const double phi0 = 1.0 - phi1;
        const double phi2 = 4.0 * phi0 * phi1;
        const double denominatorAtWm = A0 * phi0 + A1 * phi1 + A2 * phi2;

        if (s.b0 == 0.0 && s.b1 == 0.0)
        {
            const double b0 = std::sqrt (analogMag2 (s, wm / w0T) * denominatorAtWm) / (4.0 * phi1);
            return { b0, -2.0 * b0, b0, da1, da2 };
        }

        const double B0 = analogMag2 (s, 0.0) * A0;
        const double B1 = analogMag2 (s, nyquistOmega) * A1;
        const double target = analogMag2 (s, wm / w0T) * denominatorAtWm;
        const double B2 = (target - B0 * phi0 - B1 * phi1) / phi2;

        const double sqrtB0 = std::sqrt (std::max (B0, 0.0));
        const double sqrtB1 = std::sqrt (std::max (B1, 0.0));
        const double W = (sqrtB0 + sqrtB1) / 2.0;
        const double b0 = (W + std::sqrt (std::max (W * W + B2, 0.0))) / 2.0;
        const double b1 = (sqrtB0 - sqrtB1) / 2.0;
        const double b2 = b0 > 0.0 ? -B2 / (4.0 * b0) : 0.0;
        return { b0, b1, b2, da1, da2 };
    }

    inline Coeffs digitize (const Analog& s, Design design, double sampleRate)
    {
        return design == Design::matched ? matched (s, sampleRate) : bilinear (s, sampleRate);
    }
}

/** Fills `out` with the sections of one band; returns the number of sections. */
inline int designBand (const BandSettings& settings, const ShapeFit& fit, double sampleRate, std::array<Coeffs, maxSections>& out)
{
    using detail::Analog;

    if (! fit.fitted || fit.kind == Kind::unsupported)
        return 0;

    const double f = settings.frequency * fit.freqScale;
    const double q = std::max (fit.qScale * std::pow (std::max (settings.q, 1e-6), fit.qExponent), 1e-3);
    const double g = settings.gainDb * fit.gainScale;
    const double A = std::pow (10.0, g / 40.0);
    const double sa = std::sqrt (A);

    std::array<Analog, maxSections + 1> analog {};
    int count = 0;

    switch (fit.kind)
    {
        case Kind::bell:      analog[count++] = { 1, A / q, 1, 1, 1 / (A * q), 1, f }; break;
        case Kind::lowShelf:  analog[count++] = { A * A, A * sa / q, A, 1, sa / q, A, f }; break;
        case Kind::highShelf: analog[count++] = { A, A * sa / q, A * A, A, sa / q, 1, f }; break;
        case Kind::notch:     analog[count++] = { 1, 0, 1, 1, 1 / q, 1, f }; break;
        case Kind::bandPass:  analog[count++] = { 0, 1 / q, 0, 1, 1 / q, 1, f }; break;
        case Kind::tiltShelf:
            if (fit.tiltOrder == 1)
            {
                const double gg = std::sqrt (std::pow (10.0, g / 20.0));
                analog[count++] = { 1, gg, 0, gg, 1, 0, f };
            }
            else
            {
                analog[count++] = { 1, sa / q, A, A, sa / q, 1, f };
            }
            break;
        case Kind::lowCut:
        case Kind::highCut:
        {
            const int order = std::clamp (settings.order, 1, 2 * maxSections);
            const bool odd = order % 2 == 1;
            const int biquads = order / 2;
            const double factor = q / 0.70710678118654752;

            for (int k = 0; k < biquads; ++k)
            {
                const double angle = odd ? ((k + 1) * detail::pi) / order : ((2 * k + 1) * detail::pi) / (2 * order);
                double sq = 1.0 / (2.0 * std::cos (angle));

                if (fit.qMode == QMode::scaleAll || (fit.qMode == QMode::scaleLast && k == biquads - 1))
                    sq *= factor;

                sq = std::max (sq, 1e-3);
                analog[count++] = fit.kind == Kind::lowCut ? Analog { 0, 0, 1, 1, 1 / sq, 1, f }
                                                           : Analog { 1, 0, 0, 1, 1 / sq, 1, f };
            }

            if (odd)
                analog[count++] = fit.kind == Kind::lowCut ? Analog { 0, 1, 0, 1, 1, 0, f }
                                                           : Analog { 1, 0, 0, 1, 1, 0, f };
            break;
        }
        case Kind::unsupported: break;
    }

    count = std::min (count, maxSections);

    for (int i = 0; i < count; ++i)
        out[(size_t) i] = detail::digitize (analog[(size_t) i], fit.design, sampleRate);

    return count;
}

/** Transposed direct form II biquad. */
struct Biquad
{
    double z1 = 0, z2 = 0;

    inline double process (const Coeffs& c, double x)
    {
        const double y = c.b0 * x + z1;
        z1 = c.b1 * x - c.a1 * y + z2;
        z2 = c.b2 * x - c.a2 * y;
        return y;
    }

    void reset() { z1 = z2 = 0; }
};

} // namespace vch
