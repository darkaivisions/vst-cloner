#pragma once

// Universal clone: the network trained by dsp/neural/train.py, computed sample by sample.
//
//   gates(t) = Wx·x(t) + Wc·knobs + b + U·h(t−1)          (order i, f, g, o – as in PyTorch; lstmU holds the
//                                                          column of every h component: lstmU[k·4H + j] = U[j][k])
//   c(t) = σ(f)·c(t−1) + σ(i)·tanh(g),  h(t) = σ(o)·tanh(c(t))
//   gamma, beta, dry = film(knobs) = W2·tanh(W1·knobs + b1) + b2
//   y(t) = dense·(gamma ⊙ h(t) + beta) + denseB + dry·x(t)
//
// The knobs change only when a control moves, so their part of the gates, film() and the folded output weights
// (dense ⊙ gamma, dense·beta + denseB) are computed per block in computeConditions(), not per sample.

#include "CloneModel.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace vch
{
    constexpr int H = clonemodel::hidden;
    constexpr int C = clonemodel::numConditions;
    constexpr int F = clonemodel::filmHidden;

    struct NeuralConditions
    {
        std::array<float, 4 * H> gateBias {}; // Wc·knobs + b
        std::array<float, H> outWeight {};    // dense ⊙ gamma
        float outBias = 0.0f;                 // dense·beta + denseB
        float dry = 1.0f;
    };

    /**
     * tanh as a rational function (Padé 7/6, clamped): about 10× cheaper than std::tanh, error below 1e-4 – far
     * below what the network itself gets wrong. Branch-free, so the loops over the hidden state vectorise.
     */
    inline float fastTanh (float v)
    {
        const float x = std::clamp (v, -4.97f, 4.97f);
        const float x2 = x * x;
        const float num = x * (135135.0f + x2 * (17325.0f + x2 * (378.0f + x2)));
        const float den = 135135.0f + x2 * (62370.0f + x2 * (3150.0f + x2 * 28.0f));
        return num / den;
    }

    inline float fastSigmoid (float v) { return 0.5f * fastTanh (0.5f * v) + 0.5f; }

    /** knobs: normalised values of the conditioning controls, in the order of the model */
    inline void computeConditions (const float* knobs, NeuralConditions& out)
    {
        using namespace clonemodel;
        for (int j = 0; j < 4 * H; ++j)
        {
            float sum = lstmB[j];
            for (int c = 0; c < C; ++c)
                sum += lstmWc[c * 4 * H + j] * knobs[c];
            out.gateBias[(size_t) j] = sum;
        }

        // film: a model without controls was trained with a single zero input
        constexpr int filmInputs = C > 0 ? C : 1;
        std::array<float, F> hiddenFilm {};
        for (int k = 0; k < F; ++k)
        {
            float sum = filmB1[k];
            for (int c = 0; c < filmInputs; ++c)
                sum += filmW1[k * filmInputs + c] * (C > 0 ? knobs[c] : 0.0f);
            hiddenFilm[(size_t) k] = std::tanh (sum);
        }
        auto film = [&] (int row)
        {
            float sum = filmB2[row];
            for (int k = 0; k < F; ++k)
                sum += filmW2[row * F + k] * hiddenFilm[(size_t) k];
            return sum;
        };
        float bias = denseB;
        for (int k = 0; k < H; ++k)
        {
            const float gamma = film (k), beta = film (H + k);
            out.outWeight[(size_t) k] = denseW[k] * gamma;
            bias += denseW[k] * beta;
        }
        out.outBias = bias;
        out.dry = film (2 * H);
    }

    /** State of one channel. */
    struct NeuralChannel
    {
        std::array<float, H> h {}, c {};
        std::array<float, 4 * H> gates {};

        void reset()
        {
            h.fill (0.0f);
            c.fill (0.0f);
        }

        float process (float x, const NeuralConditions& k)
        {
            using namespace clonemodel;
            float* g = gates.data();
            for (int j = 0; j < 4 * H; ++j)
                g[j] = k.gateBias[(size_t) j] + lstmWx[j] * x;
            // gates += U·h as a sum of columns: every inner loop runs over contiguous gate rows and vectorises
            // (a dot product per gate would not – the compiler may not reorder its additions)
            for (int i = 0; i < H; ++i)
            {
                const float hi = h[(size_t) i];
                const float* u = lstmU + i * 4 * H;
                for (int j = 0; j < 4 * H; ++j)
                    g[j] += u[j] * hi;
            }
            float y = k.outBias + k.dry * x;
            for (int i = 0; i < H; ++i)
            {
                const float in = fastSigmoid (g[i]);
                const float forget = fastSigmoid (g[H + i]);
                const float cell = fastTanh (g[2 * H + i]);
                const float out = fastSigmoid (g[3 * H + i]);
                c[(size_t) i] = forget * c[(size_t) i] + in * cell;
                h[(size_t) i] = out * fastTanh (c[(size_t) i]);
                y += k.outWeight[(size_t) i] * h[(size_t) i];
            }
            return y;
        }
    };
} // namespace vch
