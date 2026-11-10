#pragma once

// Compressor engine driven by a fitted model (see clone/src/dynamics/model.ts and fit.ts).
// IMPORTANT: every step must stay identical to the TypeScript reference implementation.

#include "ParamTables.h"

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
    ln charge, ln slow, ln(slowKnee + 0.01), ln(detectorTime + 1e-4), drive, ln(rippleTime + 1e-5), ln(ripple + 1e-3)
    – see pack() in clone/src/dynamics/fit.ts */
constexpr int numPacked = 13;

struct CompressorParams
{
    double thresholdDb = 0, ratio = 1, kneeDb = 0, makeupDb = 0;
    double attack = 0.01, release = 0.1, charge = 0, slow = 0, slowKneeDb = 0;
    double detectorTime = 0;
    double drive = 0, rippleTime = 0, ripple = 0;
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
    p.drive = std::max (0.0, x[10]);
    p.rippleTime = std::max (0.0, std::exp (x[11]) - 1e-5);
    p.ripple = std::max (0.0, std::exp (x[12]) - 1e-3);
    return p;
}

/** predictParams() in fit.ts: base model plus the change each parameter causes on its own. */
template <typename ValueOf>
CompressorParams predict (const double* basePacked, const ParamTable* tables, int numTables, ValueOf valueOf)
{
    double packed[numPacked];
    predictPacked (basePacked, numPacked, tables, numTables, valueOf, packed);
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
        rippleSmoothing = coefficient (p.rippleTime);
        kneeStart = std::pow (10.0, (p.thresholdDb - p.kneeDb / 2.0) / 10.0);
    }

    void reset() { fast = slow = reduction = energy = rippleEnergy = 0.0; }

    /** One block: `levelDb` is the detector level of the block (input level for both topologies). Returns the gain (dB, ≤ 0). */
    double step (double levelDb, Topology topology)
    {
        // detector averaging in the energy domain (simulateGain() in model.ts)
        const double e = std::pow (10.0, levelDb / 10.0);
        const double raw = topology == Topology::feedback && reduction > 0 ? e * std::pow (10.0, -reduction / 10.0) : e;
        energy = smoothing * energy + (1 - smoothing) * raw;
        rippleEnergy = rippleSmoothing * rippleEnergy + (1 - rippleSmoothing) * raw;
        const double target = energy <= kneeStart ? 0.0 : staticReduction (10.0 * std::log10 (energy + 1e-24), params);
        fast = target > fast ? attack * fast + (1 - attack) * target : release * fast + (1 - release) * target;
        if (params.charge > 0)
        {
            if (fast > slow) slow = charge * slow + (1 - charge) * fast;
            else slow = std::max (fast, slow - (slowStep * slow) / std::max (slow + params.slowKneeDb, 1e-9));
        }
        reduction = std::max (fast, slow);
        double applied = reduction;
        if (params.ripple > 0)
        {
            const double rippleTarget = rippleEnergy <= kneeStart ? 0.0 : staticReduction (10.0 * std::log10 (rippleEnergy + 1e-24), params);
            applied += params.ripple * (rippleTarget - target);
        }
        return -applied;
    }

    const CompressorParams& current() const { return params; }

private:
    CompressorParams params;
    double attack = 0, release = 0, charge = 0, slowStep = 0, smoothing = 0, rippleSmoothing = 0, kneeStart = 0;
    double fast = 0, slow = 0, reduction = 0, energy = 0, rippleEnergy = 0;
};

/** shape() in model.ts: odd-order saturation with unity small-signal gain */
inline double shape (double v, double drive)
{
    return drive > 1e-4 ? std::tanh (drive * v) / drive : v;
}

} // namespace vch
