#pragma once

// Wiener–Hammerstein distortion engine driven by a fitted model (see clone/src/distortion/model.ts and fit.ts).
// IMPORTANT: every step must stay identical to the TypeScript reference implementation.

#include "EqEngine.h"
#include "ParamTables.h"

#include <array>
#include <cmath>

namespace vch
{

/** packed model values – order of packDistortion() in clone/src/distortion/fit.ts */
constexpr int numPacked = 21;
constexpr double railHardness = 8.0;

struct DistortionParams
{
    double inputDb = 0, preHp = 20, preBellFreq = 1000, preBellDb = 0, preBellQ = 0.7, preLp = 20000;
    double clipPos = 1, clipNeg = 1, hardness = 3;
    double preBell2Freq = 200, preBell2Db = 0, preBell2Q = 0.7, railPos = 8, railNeg = 8;
    double postBellFreq = 1000, postBellDb = 0, postBellQ = 0.7, shelfFreq = 3000, shelfDb = 0, postLp = 20000, postHp = 20;
    double outputDb = 0;
};

/** unpackDistortion() in fit.ts (the positive clipping limit is fixed at 1) */
inline DistortionParams unpack (const double* x)
{
    DistortionParams p;
    p.inputDb = x[0]; p.preHp = std::exp (x[1]); p.preBellFreq = std::exp (x[2]); p.preBellDb = x[3]; p.preBellQ = std::exp (x[4]); p.preLp = std::exp (x[5]);
    p.clipPos = 1.0; p.clipNeg = std::exp (x[6]); p.hardness = std::exp (x[7]);
    p.preBell2Freq = std::exp (x[8]); p.preBell2Db = x[9]; p.preBell2Q = std::exp (x[10]); p.railPos = std::exp (x[11]); p.railNeg = std::exp (x[12]);
    p.postBellFreq = std::exp (x[13]); p.postBellDb = x[14]; p.postBellQ = std::exp (x[15]); p.shelfFreq = std::exp (x[16]); p.shelfDb = x[17];
    p.postLp = std::exp (x[18]); p.postHp = std::exp (x[19]); p.outputDb = x[20];
    return p;
}

namespace dist
{
    inline double clampFreq (double f, double sampleRate) { return std::min (std::max (f, 5.0), sampleRate * 0.49); }

    // prototypes of clone/src/dsp/biquad.ts
    inline detail::Analog bell (double f, double g, double q)
    {
        const double A = std::pow (10.0, g / 40.0);
        return { 1, A / q, 1, 1, 1 / (A * q), 1, f };
    }
    inline detail::Analog highShelf (double f, double g, double q)
    {
        const double A = std::pow (10.0, g / 40.0), s = std::sqrt (A) / q;
        return { A, A * s, A * A, A, s, 1, f };
    }
    inline detail::Analog lowPass1 (double f) { return { 1, 0, 0, 1, 1, 0, f }; }
    inline detail::Analog highPass1 (double f) { return { 0, 1, 0, 1, 1, 0, f }; }
    inline detail::Analog lowPass2 (double f, double q) { return { 1, 0, 0, 1, 1 / q, 1, f }; }

    inline double softLimit (double v, double positive, double negative, double hardness)
    {
        const double limit = v >= 0 ? positive : negative;
        const double k = std::max (hardness, 0.5);
        return v / std::pow (1.0 + std::pow (std::abs (v / limit), k), 1.0 / k);
    }
}

/** preSections() / postSections() in model.ts (matched design) */
inline void designDistortion (const DistortionParams& p, double sr, std::array<Coeffs, 4>& pre, std::array<Coeffs, 4>& post)
{
    using namespace dist;
    pre[0] = detail::matched (highPass1 (clampFreq (p.preHp, sr)), sr);
    pre[1] = detail::matched (bell (clampFreq (p.preBellFreq, sr), p.preBellDb, std::max (p.preBellQ, 0.1)), sr);
    pre[2] = detail::matched (bell (clampFreq (p.preBell2Freq, sr), p.preBell2Db, std::max (p.preBell2Q, 0.1)), sr);
    pre[3] = detail::matched (lowPass1 (clampFreq (p.preLp, sr)), sr);
    post[0] = detail::matched (bell (clampFreq (p.postBellFreq, sr), p.postBellDb, std::max (p.postBellQ, 0.1)), sr);
    post[1] = detail::matched (highShelf (clampFreq (p.shelfFreq, sr), p.shelfDb, 0.70710678118654752), sr);
    post[2] = detail::matched (lowPass2 (clampFreq (p.postLp, sr), 0.70710678118654752), sr);
    post[3] = detail::matched (highPass1 (clampFreq (p.postHp, sr)), sr);
}

/** clip() in model.ts: clipping stage, then the supply rails */
inline double clip (double v, const DistortionParams& p)
{
    return dist::softLimit (dist::softLimit (v, p.clipPos, p.clipNeg, p.hardness), p.railPos, p.railNeg, railHardness);
}

} // namespace vch
