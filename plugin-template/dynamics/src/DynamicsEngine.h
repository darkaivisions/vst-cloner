#pragma once

// Compressor engine driven by a fitted model (see clone/src/dynamics/model.ts and fit.ts).
// IMPORTANT: every step must stay identical to the TypeScript reference implementation.

#include <algorithm>
#include <array>
#include <cmath>

namespace vch
{

enum class Detector { peak, rms };
enum class Topology { feedforward, feedback };

/** control rate: one gain computer step per block of this many samples */
constexpr int dynamicsBlock = 32;
/** packed model parameters: threshold, ln(ratio − 1), ln(knee + 0.1), makeup, ln attack, ln release,
    ln charge, ln slow, ln(slowKnee + 0.01) – see pack() in clone/src/dynamics/fit.ts */
constexpr int numPacked = 9;

struct CompressorParams
{
    double thresholdDb = 0, ratio = 1, kneeDb = 0, makeupDb = 0;
    double attack = 0.01, release = 0.1, charge = 0, slow = 0, slowKneeDb = 0;
};

inline CompressorParams unpack (const double* x)
{
    CompressorParams p;
    p.thresholdDb = x[0];
    p.ratio = 1.0 + std::exp (x[1]);
    p.kneeDb = std::max (0.0, std::exp (x[2]) - 0.1);
    p.makeupDb = x[3];
    p.attack = std::exp (x[4]);
    p.release = std::exp (x[5]);
    p.charge = std::exp (x[6]);
    p.slow = std::exp (x[7]);
    p.slowKneeDb = std::max (0.0, std::exp (x[8]) - 0.01);
    return p;
}

/** Model parameters at the sweep points of one plugin parameter (see ParamTable in fit.ts). */
struct ParamTable
{
    int param;                 // clone parameter index
    bool discrete;
    int numPoints;
    const double* values;      // normalised plugin values, ascending
    const double* packed;      // numPoints × numPacked
    double baseValue;          // value in the initial state
};

/** tableAt() in fit.ts: piecewise linear between the points, constant outside, nearest point if discrete */
inline void tableAt (const ParamTable& t, double value, double* out)
{
    const auto copy = [&] (int k) { std::copy (t.packed + k * numPacked, t.packed + (k + 1) * numPacked, out); };

    if (t.discrete || t.numPoints == 1)
    {
        int best = 0;
        for (int k = 1; k < t.numPoints; ++k)
            if (std::abs (t.values[k] - value) < std::abs (t.values[best] - value))
                best = k;
        copy (best);
        return;
    }
    if (value <= t.values[0]) { copy (0); return; }
    if (value >= t.values[t.numPoints - 1]) { copy (t.numPoints - 1); return; }

    int k = 1;
    while (t.values[k] < value) ++k;
    const double f = (value - t.values[k - 1]) / (t.values[k] - t.values[k - 1]);
    for (int i = 0; i < numPacked; ++i)
    {
        const double a = t.packed[(k - 1) * numPacked + i], b = t.packed[k * numPacked + i];
        out[i] = a + (b - a) * f;
    }
}

/** predictParams() in fit.ts: base model plus the change each parameter causes on its own. */
template <typename ValueOf>
CompressorParams predict (const double* basePacked, const ParamTable* tables, int numTables, ValueOf valueOf)
{
    double packed[numPacked], at[numPacked], ref[numPacked];
    std::copy (basePacked, basePacked + numPacked, packed);
    for (int t = 0; t < numTables; ++t)
    {
        tableAt (tables[t], valueOf (tables[t].param), at);
        tableAt (tables[t], tables[t].baseValue, ref);
        for (int i = 0; i < numPacked; ++i)
            packed[i] += at[i] - ref[i];
    }
    return unpack (packed);
}

/** staticReduction() in model.ts */
inline double staticReduction (double levelDb, const CompressorParams& p)
{
    const double over = levelDb - p.thresholdDb;
    const double slope = 1.0 - 1.0 / std::max (p.ratio, 1.0);
    const double half = p.kneeDb / 2.0;
    if (over <= -half) return 0.0;
    if (over >= half || p.kneeDb <= 0.0) return slope * over;
    return slope * (over + half) * (over + half) / (2.0 * p.kneeDb);
}

/** Gain computer of simulateGain() in model.ts, one block at a time. */
class GainComputer
{
public:
    void setParams (const CompressorParams& p, double sampleRate)
    {
        params = p;
        const auto coefficient = [sampleRate] (double seconds) { return seconds > 0 ? std::exp (-dynamicsBlock / (seconds * sampleRate)) : 0.0; };
        attack = coefficient (p.attack);
        release = coefficient (p.release);
        charge = coefficient (p.charge);
        slowStep = p.slow * dynamicsBlock / sampleRate;
    }

    void reset() { fast = slow = reduction = 0.0; }

    /** One block: `levelDb` is the detector level of the block (input level for both topologies). Returns the gain (dB, ≤ 0). */
    double step (double levelDb, Topology topology)
    {
        const double level = topology == Topology::feedback ? levelDb - reduction : levelDb;
        const double target = staticReduction (level, params);
        fast = target > fast ? attack * fast + (1 - attack) * target : release * fast + (1 - release) * target;
        if (params.charge > 0)
        {
            if (fast > slow) slow = charge * slow + (1 - charge) * fast;
            else slow = std::max (fast, slow - (slowStep * slow) / std::max (slow + params.slowKneeDb, 1e-9));
        }
        reduction = std::max (fast, slow);
        return -reduction;
    }

    const CompressorParams& current() const { return params; }

private:
    CompressorParams params;
    double attack = 0, release = 0, charge = 0, slowStep = 0;
    double fast = 0, slow = 0, reduction = 0;
};

} // namespace vch
