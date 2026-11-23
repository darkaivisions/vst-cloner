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
    wet high-pass (Hz), ln LFO depth (s), ln LFO rate (Hz), LFO phase (rad), tremolo depth, ln phaser corner (Hz),
    phaser sweep (octaves), phaser feedback, ducking threshold (dB), ln ducking attack, ln ducking release (s) – see
    packDelay() in clone/src/delay/model.ts */
constexpr int numPacked = 18;
constexpr int maxPhaserStages = 16;

constexpr double offDb = -80.0, lpOff = 20000.0, hpOff = 20.0, maxDelaySeconds = 10.0, maxFeedbackDb = -0.1;
constexpr double modOff = 1e-6, maxModDepthSeconds = 0.05;
constexpr double duckOffDb = 6.0;

struct DelayParams
{
    double delaySeconds = 0.25, dryDb = 0, wetDb = offDb, feedbackDb = offDb;
    double loopLp = lpOff, loopHp = hpOff, wetLp = lpOff, wetHp = hpOff;
    double modDepthSeconds = modOff, modRate = 1, modPhase = 0;
    double tremDepth = 0, phaserCentre = 1000, phaserOctaves = 0, phaserFeedback = 0;
    double duckThresholdDb = duckOffDb, duckAttack = 0.1, duckRelease = 0.1;
};

/** polarities (±1); modLead: samples the LFO ran before its reset point; phaserStages: allpass stages of a phaser
    (0: none); duckSmoothSeconds: time constant of the echo's ducking gain (0: no ducking) – DelayStructure in model.ts */
struct DelayStructure
{
    double drySign = 1, wetSign = 1, feedbackSign = 1, modLead = 0;
    int phaserStages = 0;
    double duckSmoothSeconds = 0;
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
    p.modDepthSeconds = std::clamp (std::exp (x[8]), modOff, maxModDepthSeconds);
    p.modRate = std::clamp (std::exp (x[9]), 0.01, 50.0);
    p.modPhase = x[10];
    p.tremDepth = std::clamp (x[11], 0.0, 1.0);
    p.phaserCentre = std::clamp (std::exp (x[12]), 20.0, 18000.0);
    p.phaserOctaves = std::clamp (x[13], 0.0, 6.0);
    p.phaserFeedback = std::clamp (x[14], -0.95, 0.95);
    p.duckThresholdDb = std::clamp (x[15], -120.0, duckOffDb);
    p.duckAttack = std::clamp (std::exp (x[16]), 1e-4, 10.0);
    p.duckRelease = std::clamp (std::exp (x[17]), 1e-4, 10.0);
    return p;
}

/** delayGain() in model.ts */
inline double delayGain (double db) { return db <= offDb + 0.5 ? 0.0 : std::pow (10.0, db / 20.0); }

/** Coefficients of processDelay() in model.ts for one set of model values. */
struct DelayCoeffs
{
    double centre = 1, depth = 0, omega = 0, phase = 0; // delay (samples) = centre + depth · sin(phase + ω · n)
    double tremDepth = 0, phaserCentre = 1000, phaserOctaves = 0, phaserFeedback = 0, sampleRate = 48000;
    int phaserStages = 0;
    double dry = 1, wet = 0, feedback = 0;
    double loopLp = -1, loopHp = -1, wetLp = -1, wetHp = -1; // one-pole coefficients, −1 = bypassed
    bool ducking = false; // the level detector and the echo's gain of processDelay() in model.ts
    double duckThreshold = 1, peakFall = 0, envRise = 0, duckGlide = 0;

    void design (const DelayParams& p, const DelayStructure& s, double sampleRate)
    {
        constexpr double twoPi = 2.0 * 3.14159265358979323846;
        centre = std::clamp (p.delaySeconds * sampleRate, 1.0, maxDelaySeconds * sampleRate);
        depth = p.modDepthSeconds > modOff * 1.01 ? std::min (p.modDepthSeconds, maxModDepthSeconds) * sampleRate : 0.0;
        omega = twoPi * p.modRate / sampleRate;
        // the phase the LFO has at the reset point (it ran modLead samples before it)
        phase = p.modPhase + omega * s.modLead;
        tremDepth = p.tremDepth;
        phaserStages = std::clamp (s.phaserStages, 0, maxPhaserStages);
        phaserCentre = p.phaserCentre;
        phaserOctaves = p.phaserOctaves;
        phaserFeedback = p.phaserFeedback;
        this->sampleRate = sampleRate;
        dry = s.drySign * delayGain (p.dryDb);
        wet = s.wetSign * delayGain (p.wetDb);
        feedback = s.feedbackSign * delayGain (p.feedbackDb);
        const auto onePole = [sampleRate] (double frequency) { return std::exp (-2.0 * 3.14159265358979323846 * frequency / sampleRate); };
        loopLp = p.loopLp < lpOff * 0.999 ? onePole (p.loopLp) : -1.0;
        loopHp = p.loopHp > hpOff * 1.001 ? onePole (p.loopHp) : -1.0;
        wetLp = p.wetLp < lpOff * 0.999 ? onePole (p.wetLp) : -1.0;
        wetHp = p.wetHp > hpOff * 1.001 ? onePole (p.wetHp) : -1.0;
        ducking = s.duckSmoothSeconds > 0 && p.duckThresholdDb < duckOffDb - 0.01;
        duckThreshold = std::pow (10.0, p.duckThresholdDb / 20.0);
        peakFall = ducking ? std::exp (-1.0 / (p.duckRelease * sampleRate)) : 0.0;
        envRise = ducking ? 1.0 - std::exp (-1.0 / (p.duckAttack * sampleRate)) : 0.0;
        duckGlide = ducking ? 1.0 - std::exp (-1.0 / (s.duckSmoothSeconds * sampleRate)) : 0.0;
    }
};

/** One channel of processDelay() in model.ts. */
class DelayLine
{
public:
    void prepare (double sampleRate)
    {
        line.assign ((size_t) std::ceil ((maxDelaySeconds + maxModDepthSeconds) * sampleRate) + 4, 0.0);
        reset();
    }

    void reset()
    {
        std::fill (line.begin(), line.end(), 0.0);
        loopLow = loopHigh = wetLow = wetHigh = 0.0;
        write = 0;
        lfo = 0.0;
        apOut = 0.0;
        peak = env = 0.0;
        duck = 1.0;
        std::fill (std::begin (apX), std::end (apX), 0.0);
        std::fill (std::begin (apY), std::end (apY), 0.0);
    }

    double process (double x, const DelayCoeffs& c)
    {
        const int size = (int) line.size();
        if (c.ducking)
        {
            peak = std::max (std::abs (x), peak * c.peakFall);
            env += c.envRise * (peak - env);
            duck += c.duckGlide * ((env > c.duckThreshold ? 0.0 : 1.0) - duck);
        }
        // the LFO moves the delay time; `lfo` is ω · (samples since the reset), so a changed rate does not jump
        const double lfoValue = std::sin (c.phase + lfo);
        lfo += c.omega;
        if (lfo > 1e6) lfo = std::fmod (lfo, 2.0 * 3.14159265358979323846);
        // tremolo: the LFO moves the level, from full (LFO at −1) down by its depth (LFO at +1)
        const double level = 1.0 - c.tremDepth * (0.5 + 0.5 * lfoValue);
        if (c.phaserStages > 0)
        {
            // phaser: allpass chain swept by the LFO, its output fed back to its input (processDelay in model.ts)
            const double corner = std::min (c.phaserCentre * std::pow (2.0, c.phaserOctaves * lfoValue), c.sampleRate * 0.49);
            const double t = std::tan (3.14159265358979323846 * corner / c.sampleRate), a = (t - 1.0) / (t + 1.0);
            double v = x + c.phaserFeedback * apOut;
            for (int k = 0; k < c.phaserStages; ++k)
            {
                const double y = a * v + apX[k] - a * apY[k];
                apX[k] = v;
                apY[k] = y;
                v = y;
            }
            apOut = v;
            return (c.dry * x + c.wet * v) * level;
        }
        const double delay = c.depth > 0 ? std::max (1.0, c.centre + c.depth * lfoValue) : c.centre;
        const int whole = (int) std::floor (delay);
        const double frac = delay - whole;
        int read = write - whole;
        if (read < 0) read += size;
        const int before = read == 0 ? size - 1 : read - 1;
        // linear interpolation between the samples `whole` and `whole + 1` steps back
        const double tap = line[(size_t) read] * (1.0 - frac) + line[(size_t) before] * frac;
        double f = tap;
        if (c.loopLp >= 0) { loopLow += (1.0 - c.loopLp) * (f - loopLow); f = loopLow; }
        if (c.loopHp >= 0) { loopHigh += (1.0 - c.loopHp) * (f - loopHigh); f -= loopHigh; }
        line[(size_t) write] = x + c.feedback * f;
        double g = tap;
        if (c.wetLp >= 0) { wetLow += (1.0 - c.wetLp) * (g - wetLow); g = wetLow; }
        if (c.wetHp >= 0) { wetHigh += (1.0 - c.wetHp) * (g - wetHigh); g -= wetHigh; }
        write = write + 1 == size ? 0 : write + 1;
        return (c.dry * x + c.wet * duck * g) * level;
    }

private:
    std::vector<double> line;
    double loopLow = 0, loopHigh = 0, wetLow = 0, wetHigh = 0, lfo = 0, apOut = 0, peak = 0, env = 0, duck = 1;
    double apX[maxPhaserStages] = {}, apY[maxPhaserStages] = {};
    int write = 0;
};

} // namespace vch
