#pragma once

// Delay engine driven by a fitted model (see clone/src/delay/model.ts and fit.ts).
// IMPORTANT: every step must stay identical to the TypeScript reference implementation.

#include "ParamTables.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace vch
{

/** packed model values: ln delay (s), dry, wet, feedback (dB), ln of loop low-pass, loop high-pass, wet low-pass,
    wet high-pass (Hz) – see packDelay() in clone/src/delay/model.ts */
constexpr int numPacked = 8;

constexpr double offDb = -80.0, lpOff = 20000.0, hpOff = 20.0, maxDelaySeconds = 10.0, maxFeedbackDb = -0.1;

struct DelayParams
{
    double delaySeconds = 0.25, dryDb = 0, wetDb = offDb, feedbackDb = offDb;
    double loopLp = lpOff, loopHp = hpOff, wetLp = lpOff, wetHp = hpOff;
};

/** polarities (±1) */
struct DelayStructure
{
    double drySign = 1, wetSign = 1, feedbackSign = 1;
};

/** One model: the main one (switchParam −1) or the model for one position of a switch (see DelayVariant in
    fit.ts), which applies while from ≤ value of the switch < to. */
struct DelayModelData
{
    int switchParam;
    double from, to;
    const double* basePacked;
    const ParamTable* tables;
    int numTables;
    DelayStructure structure;
    /** timeRule "sum" in fit.ts: the changes of the delay time add up in seconds instead of multiplying */
    bool timeSum = false;
};

/** unpackDelay() in model.ts */
inline DelayParams unpack (const double* x)
{
    DelayParams p;
    p.delaySeconds = std::clamp (std::exp (x[0]), 1e-4, maxDelaySeconds);
    p.dryDb = std::clamp (x[1], offDb, 24.0);
    p.wetDb = std::clamp (x[2], offDb, 24.0);
    p.feedbackDb = std::clamp (x[3], offDb, maxFeedbackDb);
    p.loopLp = std::clamp (std::exp (x[4]), 20.0, lpOff);
    p.loopHp = std::clamp (std::exp (x[5]), hpOff, 20000.0);
    p.wetLp = std::clamp (std::exp (x[6]), 20.0, lpOff);
    p.wetHp = std::clamp (std::exp (x[7]), hpOff, 20000.0);
    return p;
}

/** delayGain() in model.ts */
inline double delayGain (double db) { return db <= offDb + 0.5 ? 0.0 : std::pow (10.0, db / 20.0); }

/** Coefficients of processDelay() in model.ts for one set of model values. */
struct DelayCoeffs
{
    int whole = 1;
    double frac = 0, dry = 1, wet = 0, feedback = 0;
    double loopLp = -1, loopHp = -1, wetLp = -1, wetHp = -1; // one-pole coefficients, −1 = bypassed

    void design (const DelayParams& p, const DelayStructure& s, double sampleRate)
    {
        const double delay = std::clamp (p.delaySeconds * sampleRate, 1.0, maxDelaySeconds * sampleRate);
        whole = (int) std::floor (delay);
        frac = delay - whole;
        dry = s.drySign * delayGain (p.dryDb);
        wet = s.wetSign * delayGain (p.wetDb);
        feedback = s.feedbackSign * delayGain (p.feedbackDb);
        const auto onePole = [sampleRate] (double frequency) { return std::exp (-2.0 * 3.14159265358979323846 * frequency / sampleRate); };
        loopLp = p.loopLp < lpOff * 0.999 ? onePole (p.loopLp) : -1.0;
        loopHp = p.loopHp > hpOff * 1.001 ? onePole (p.loopHp) : -1.0;
        wetLp = p.wetLp < lpOff * 0.999 ? onePole (p.wetLp) : -1.0;
        wetHp = p.wetHp > hpOff * 1.001 ? onePole (p.wetHp) : -1.0;
    }
};

/** One channel of processDelay() in model.ts. */
class DelayLine
{
public:
    void prepare (double sampleRate)
    {
        line.assign ((size_t) std::ceil (maxDelaySeconds * sampleRate) + 4, 0.0);
        reset();
    }

    void reset()
    {
        std::fill (line.begin(), line.end(), 0.0);
        loopLow = loopHigh = wetLow = wetHigh = 0.0;
        write = 0;
    }

    double process (double x, const DelayCoeffs& c)
    {
        const int size = (int) line.size();
        int read = write - c.whole;
        if (read < 0) read += size;
        const int before = read == 0 ? size - 1 : read - 1;
        // linear interpolation between the samples `whole` and `whole + 1` steps back
        const double tap = line[(size_t) read] * (1.0 - c.frac) + line[(size_t) before] * c.frac;
        double f = tap;
        if (c.loopLp >= 0) { loopLow += (1.0 - c.loopLp) * (f - loopLow); f = loopLow; }
        if (c.loopHp >= 0) { loopHigh += (1.0 - c.loopHp) * (f - loopHigh); f -= loopHigh; }
        line[(size_t) write] = x + c.feedback * f;
        double g = tap;
        if (c.wetLp >= 0) { wetLow += (1.0 - c.wetLp) * (g - wetLow); g = wetLow; }
        if (c.wetHp >= 0) { wetHigh += (1.0 - c.wetHp) * (g - wetHigh); g -= wetHigh; }
        write = write + 1 == size ? 0 : write + 1;
        return c.dry * x + c.wet * g;
    }

private:
    std::vector<double> line;
    double loopLow = 0, loopHigh = 0, wetLow = 0, wetHigh = 0;
    int write = 0;
};

} // namespace vch
