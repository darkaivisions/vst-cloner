#pragma once

// Plugin control → model values: tables measured at the sweep points of each control, interpolated with PCHIP
// and combined additively (see tableAt() / predictParams() in clone/src/dynamics/fit.ts).

#include <algorithm>
#include <cmath>

namespace vch
{

/** Model values (packed, `stride` per point) at the sweep points of one plugin parameter. */
struct ParamTable
{
    int param;                 // clone parameter index
    bool discrete;
    int numPoints;
    const double* values;      // normalised plugin values, ascending
    const double* packed;      // numPoints × stride
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
inline void tableAt (const ParamTable& t, int stride, double value, double* out)
{
    if (t.discrete || t.numPoints == 1)
    {
        int best = 0;
        for (int k = 1; k < t.numPoints; ++k)
            if (std::abs (t.values[k] - value) < std::abs (t.values[best] - value))
                best = k;
        std::copy (t.packed + best * stride, t.packed + (best + 1) * stride, out);
        return;
    }
    for (int i = 0; i < stride; ++i)
        out[i] = pchip (t.values, t.packed + i, stride, t.numPoints, value);
}

/** Base model plus the change each plugin parameter causes on its own (stride ≤ 64). */
template <typename ValueOf>
void predictPacked (const double* basePacked, int stride, const ParamTable* tables, int numTables, ValueOf valueOf, double* out)
{
    double at[64], ref[64];
    std::copy (basePacked, basePacked + stride, out);
    for (int t = 0; t < numTables; ++t)
    {
        tableAt (tables[t], stride, valueOf (tables[t].param), at);
        tableAt (tables[t], stride, tables[t].baseValue, ref);
        for (int i = 0; i < stride; ++i)
            out[i] += at[i] - ref[i];
    }
}

} // namespace vch
