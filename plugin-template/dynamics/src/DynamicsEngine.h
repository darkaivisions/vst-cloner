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
    ln charge, ln slow, ln(slowKnee + 0.01), ln(detectorTime + 1e-4) – see pack() in clone/src/dynamics/fit.ts */
constexpr int numPacked = 10;

struct CompressorParams
{
    double thresholdDb = 0, ratio = 1, kneeDb = 0, makeupDb = 0;
    double attack = 0.01, release = 0.1, charge = 0, slow = 0, slowKneeDb = 0;
    double detectorTime = 0;
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
    p.detectorTime = std::max (0.0, std::exp (x[9]) - 1e-4);
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

/** pchip() in fit.ts: monotone cubic interpolation (Fritsch–Carlson) of one component, constant outside. */
inline double pchip (const double* xs, const double* ys, int stride, int n, double x)
{
    const auto y = [&] (int i) { return ys[i * stride]; };
    if (x <= xs[0]) return y (0);
    if (x >= xs[n - 1]) return y (n - 1);
    int k = 0;
    while (xs[k + 1] < x) ++k;
    const auto h = [&] (int i) { return xs[i + 1] - xs[i]; };
    const auto d = [&] (int i) { return (y (i + 1) - y (i)) / h (i); };
    const auto slope = [&] (int i)
    {
        if (i == 0) return d (0);
        if (i == n - 1) return d (n - 2);
        const double a = d (i - 1), b = d (i);
        if (a * b <= 0) return 0.0;
        const double w1 = 2 * h (i) + h (i - 1), w2 = h (i) + 2 * h (i - 1);
        return (w1 + w2) / (w1 / a + w2 / b);
    };
    const double hk = h (k), t = (x - xs[k]) / hk, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y (k) + (t3 - 2 * t2 + t) * hk * slope (k)
         + (-2 * t3 + 3 * t2) * y (k + 1) + (t3 - t2) * hk * slope (k + 1);
}

/** tableAt() in fit.ts: nearest point for discrete parameters, PCHIP otherwise */
inline void tableAt (const ParamTable& t, double value, double* out)
{
    if (t.discrete || t.numPoints == 1)
    {
        int best = 0;
        for (int k = 1; k < t.numPoints; ++k)
            if (std::abs (t.values[k] - value) < std::abs (t.values[best] - value))
                best = k;
        std::copy (t.packed + best * numPacked, t.packed + (best + 1) * numPacked, out);
        return;
    }
    for (int i = 0; i < numPacked; ++i)
        out[i] = pchip (t.values, t.packed + i, numPacked, t.numPoints, value);
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
        smoothing = coefficient (p.detectorTime);
        kneeStart = std::pow (10.0, (p.thresholdDb - p.kneeDb / 2.0) / 10.0);
    }

    void reset() { fast = slow = reduction = energy = 0.0; }

    /** One block: `levelDb` is the detector level of the block (input level for both topologies). Returns the gain (dB, ≤ 0). */
    double step (double levelDb, Topology topology)
    {
        // detector averaging in the energy domain (simulateGain() in model.ts)
        const double e = std::pow (10.0, levelDb / 10.0);
        const double raw = topology == Topology::feedback && reduction > 0 ? e * std::pow (10.0, -reduction / 10.0) : e;
        energy = smoothing * energy + (1 - smoothing) * raw;
        const double target = energy <= kneeStart ? 0.0 : staticReduction (10.0 * std::log10 (energy + 1e-24), params);
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
    double attack = 0, release = 0, charge = 0, slowStep = 0, smoothing = 0, kneeStart = 0;
    double fast = 0, slow = 0, reduction = 0, energy = 0;
};

} // namespace vch
