#pragma once

// Reverb engine driven by a fitted model (see clone/src/reverb/model.ts and fit.ts).
// IMPORTANT: every step must stay identical to the TypeScript reference implementation.

#include "ParamTables.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace vch
{

/** packed model values: pre-delay (s), dry (dB), band gains (dB: lows, mids, highs), ln of the decay times (s)
    – see packReverb() in clone/src/reverb/model.ts */
constexpr int numPacked = 8;

constexpr double reverbOffDb = -100.0, maxPredelaySeconds = 1.0, minRt = 0.05, maxRt = 30.0;
constexpr int reverbLineCount = 8;
/** REVERB_LINES, REVERB_SIGNS, REVERB_SPLITS in model.ts */
constexpr int reverbLines[reverbLineCount] = { 149, 311, 557, 809, 1049, 1361, 1657, 1973 };
constexpr double reverbSigns[2][reverbLineCount] = { { 1, -1, 1, -1, 1, -1, 1, -1 }, { 1, 1, -1, -1, 1, 1, -1, -1 } };
constexpr double reverbSplits[2] = { 400.0, 3000.0 };

struct ReverbParams
{
    double predelaySeconds = 0, dryDb = 0;
    double gainDb[3] = { reverbOffDb, reverbOffDb, reverbOffDb };
    double rt[3] = { 1, 1, 1 };
};

/** unpackReverb() in model.ts */
inline ReverbParams unpack (const double* x)
{
    ReverbParams p;
    p.predelaySeconds = std::clamp (x[0], 0.0, maxPredelaySeconds);
    p.dryDb = std::clamp (x[1], reverbOffDb, 24.0);
    for (int b = 0; b < 3; ++b)
    {
        p.gainDb[b] = std::clamp (x[2 + b], reverbOffDb, 40.0);
        p.rt[b] = std::clamp (std::exp (std::min (x[5 + b], 10.0)), minRt, maxRt);
    }
    return p;
}

/** gainOf() in model.ts */
inline double reverbGain (double db) { return db <= reverbOffDb + 0.5 ? 0.0 : std::pow (10.0, db / 20.0); }

/** processReverb() in model.ts: one network (fed with the mono sum), two decorrelated outputs. */
class ReverbNetwork
{
public:
    void prepare (double sampleRateToUse)
    {
        sampleRate = sampleRateToUse;
        for (int i = 0; i < reverbLineCount; ++i)
        {
            lengths[(size_t) i] = std::max (1, (int) std::lround (reverbLines[i] * sampleRate / 48000.0));
            lines[(size_t) i].assign ((size_t) lengths[(size_t) i], 0.0);
        }
        wait.assign ((size_t) std::ceil (maxPredelaySeconds * sampleRate) + 2, 0.0);
        aLow = std::exp (-2.0 * 3.14159265358979323846 * reverbSplits[0] / sampleRate);
        aHigh = std::exp (-2.0 * 3.14159265358979323846 * reverbSplits[1] / sampleRate);
        reset();
    }

    void reset()
    {
        for (auto& line : lines) std::fill (line.begin(), line.end(), 0.0);
        std::fill (wait.begin(), wait.end(), 0.0);
        position.fill (0);
        low.fill (0.0);
        high.fill (0.0);
        outLow[0] = outLow[1] = outHigh[0] = outHigh[1] = 0.0;
        waitAt = 0;
    }

    void setParams (const ReverbParams& p, double drySign)
    {
        for (int i = 0; i < reverbLineCount; ++i)
            for (int b = 0; b < 3; ++b)
                absorb[(size_t) i][(size_t) b] = std::pow (10.0, -3.0 * lengths[(size_t) i] / (sampleRate * p.rt[b]));
        for (int b = 0; b < 3; ++b)
            gains[b] = reverbGain (p.gainDb[b]);
        dry = drySign * reverbGain (p.dryDb);
        predelay = (int) std::lround (std::clamp (p.predelaySeconds, 0.0, maxPredelaySeconds) * sampleRate);
    }

    /** One sample: `x` is the input of the network (mono sum); the tails of both channels are written to `wet`. */
    void process (double x, double* wet)
    {
        // pre-delay: the sample written `predelay` steps ago
        const int size = (int) wait.size();
        wait[(size_t) waitAt] = x;
        int read = waitAt - predelay;
        if (read < 0) read += size;
        const double d = wait[(size_t) read];
        waitAt = waitAt + 1 == size ? 0 : waitAt + 1;

        double sum = 0, raw[2] = { 0, 0 };
        for (int i = 0; i < reverbLineCount; ++i)
        {
            const double o = lines[(size_t) i][(size_t) position[(size_t) i]];
            tap[(size_t) i] = o;
            sum += o;
            raw[0] += reverbSigns[0][i] * o;
            raw[1] += reverbSigns[1][i] * o;
        }
        const double mix = (2.0 / reverbLineCount) * sum;
        for (int i = 0; i < reverbLineCount; ++i)
        {
            const auto k = (size_t) i;
            const double f = tap[k] - mix;
            low[k] += (1.0 - aLow) * (f - low[k]);
            high[k] += (1.0 - aHigh) * (f - high[k]);
            const auto& g = absorb[k];
            lines[k][(size_t) position[k]] = d + g[0] * low[k] + g[1] * (high[k] - low[k]) + g[2] * (f - high[k]);
            position[k] = position[k] + 1 == lengths[k] ? 0 : position[k] + 1;
        }
        for (int ch = 0; ch < 2; ++ch)
        {
            outLow[ch] += (1.0 - aLow) * (raw[ch] - outLow[ch]);
            outHigh[ch] += (1.0 - aHigh) * (raw[ch] - outHigh[ch]);
            wet[ch] = gains[0] * outLow[ch] + gains[1] * (outHigh[ch] - outLow[ch]) + gains[2] * (raw[ch] - outHigh[ch]);
        }
    }

    double dryGain() const { return dry; }

private:
    double sampleRate = 48000.0, aLow = 0, aHigh = 0, dry = 1;
    double gains[3] = { 0, 0, 0 };
    int predelay = 0, waitAt = 0;
    std::array<int, reverbLineCount> lengths {}, position {};
    std::array<std::vector<double>, reverbLineCount> lines;
    std::array<std::array<double, 3>, reverbLineCount> absorb {};
    std::array<double, reverbLineCount> low {}, high {}, tap {};
    std::vector<double> wait;
    double outLow[2] = { 0, 0 }, outHigh[2] = { 0, 0 };
};

} // namespace vch
