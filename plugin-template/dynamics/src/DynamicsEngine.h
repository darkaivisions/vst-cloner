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
/** compressor: reduction above the threshold; expander: below it (downward expander, gate); ducker: an inverted
    gate that closes above the threshold */
enum class Curve { compressor, expander, ducker };

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

/** staticReduction() in model.ts */
inline double staticReduction (double levelDb, const CompressorParams& p, Curve curve = Curve::compressor)
{
    const double half = p.kneeDb / 2.0;
    if (curve != Curve::compressor)
    {
        // (ratio − 1) dB per dB beyond the threshold (expander: below, ducker: above), at most the range (slowKneeDb)
        const double under = curve == Curve::expander ? p.thresholdDb - levelDb : levelDb - p.thresholdDb;
        const double steep = std::max (p.ratio, 1.0) - 1.0;
        if (under <= -half) return 0.0;
        if (under >= half || p.kneeDb <= 0.0) return std::min (p.slowKneeDb, steep * under);
        return std::min (p.slowKneeDb, steep * (under + half) * (under + half) / (2.0 * p.kneeDb));
    }
    const double over = levelDb - p.thresholdDb;
    const double slope = 1.0 - 1.0 / std::max (p.ratio, 1.0);
    if (over <= -half) return 0.0;
    if (over >= half || p.kneeDb <= 0.0) return slope * over;
    return slope * (over + half) * (over + half) / (2.0 * p.kneeDb);
}

/** Interaction in fit.ts: automatic makeup = autoMakeup × static reduction at referenceDb. */
struct Interaction
{
    double autoMakeup = 0, referenceDb = 0;
};

/** latent vector (see toLatent() in fit.ts): the packed parameters with threshold before input gain, knee in dB and
    makeup without input gain and automatic makeup, followed by the input gain (dB) */
constexpr int numLatent = numPacked + 1;

/** predictParams() in fit.ts: base model plus the change each parameter causes on its own (latent domain),
    then fromLatent(). */
template <typename ValueOf>
CompressorParams predict (const double* baseLatent, const ParamTable* tables, int numTables, const Interaction& interaction, ValueOf valueOf)
{
    double latent[numLatent];
    predictPacked (baseLatent, numLatent, tables, numTables, valueOf, latent);
    const double preGainDb = latent[numPacked];
    latent[2] = std::log (std::max (latent[2], 0.0) + 0.1); // the knee is added up in dB
    // as in fromLatent(): the automatic makeup follows the threshold before the input gain
    latent[3] += preGainDb + interaction.autoMakeup * staticReduction (interaction.referenceDb, unpack (latent));
    latent[0] -= preGainDb;
    return unpack (latent);
}

/** One model: the main one (switchParam −1) or the model for one position of a switch (see DynamicsVariant in
    fit.ts), which applies while from ≤ value of the switch < to. */
struct DynamicsModelData
{
    int switchParam;
    double from, to;
    Detector detector;
    Topology topology;
    Curve curve;
    const double* baseLatent;
    const ParamTable* tables;
    int numTables;
    Interaction interaction;
};

/** Gain computer of simulateGain() in model.ts, one block at a time. */
class GainComputer
{
public:
    void setParams (const CompressorParams& p, double sampleRate, Curve curveToUse = Curve::compressor)
    {
        params = p;
        curve = curveToUse;
        const auto coefficient = [sampleRate] (double seconds) { return seconds > 0 ? std::exp (-dynamicsBlock / (seconds * sampleRate)) : 0.0; };
        attack = coefficient (p.attack);
        release = coefficient (p.release);
        charge = coefficient (p.charge);
        slowStep = p.slow * dynamicsBlock / sampleRate;
        smoothing = coefficient (p.detectorTime);
        rippleSmoothing = coefficient (p.rippleTime);
        kneeEdge = std::pow (10.0, (p.thresholdDb + (curve == Curve::expander ? p.kneeDb / 2.0 : -p.kneeDb / 2.0)) / 10.0);
    }

    void reset() { fast = slow = reduction = energy = rippleEnergy = 0.0; }

    /** One block: `levelDb` is the detector level of the block (input level for both topologies). Returns the gain (dB, ≤ 0). */
    double step (double levelDb, Topology topology)
    {
        // detector averaging in the energy domain (simulateGain() in model.ts)
        const double e = std::pow (10.0, levelDb / 10.0);
        const bool expander = curve != Curve::compressor;
        const double raw = topology == Topology::feedback && ! expander && reduction > 0 ? e * std::pow (10.0, -reduction / 10.0) : e;
        // expander: the detector follows a falling level with its own (slower) time constant
        energy = expander && raw < energy ? charge * energy + (1 - charge) * raw : smoothing * energy + (1 - smoothing) * raw;
        rippleEnergy = rippleSmoothing * rippleEnergy + (1 - rippleSmoothing) * raw;
        const double target = curveAt (energy);
        fast = target > fast ? attack * fast + (1 - attack) * target : release * fast + (1 - release) * target;
        if (params.charge > 0 && ! expander)
        {
            if (fast > slow) slow = charge * slow + (1 - charge) * fast;
            else slow = std::max (fast, slow - (slowStep * slow) / std::max (slow + params.slowKneeDb, 1e-9));
        }
        reduction = std::max (fast, slow);
        double applied = reduction;
        if (params.ripple > 0)
        {
            applied += params.ripple * (curveAt (rippleEnergy) - target);
        }
        return -applied;
    }

    const CompressorParams& current() const { return params; }

private:
    /** outside the knee edge the curve is 0 (compressor: below it, expander: above it) */
    double curveAt (double e) const
    {
        const bool outside = curve == Curve::expander ? e >= kneeEdge : e <= kneeEdge;
        return outside ? 0.0 : staticReduction (10.0 * std::log10 (e + 1e-24), params, curve);
    }

    CompressorParams params;
    Curve curve = Curve::compressor;
    double attack = 0, release = 0, charge = 0, slowStep = 0, smoothing = 0, rippleSmoothing = 0, kneeEdge = 0;
    double fast = 0, slow = 0, reduction = 0, energy = 0, rippleEnergy = 0;
};

/** shape() in model.ts: odd-order saturation with unity small-signal gain */
inline double shape (double v, double drive)
{
    return drive > 1e-4 ? std::tanh (drive * v) / drive : v;
}

} // namespace vch
