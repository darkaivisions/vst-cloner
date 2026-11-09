#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

namespace vch
{

struct WavData
{
    double sampleRate = 0.0;
    juce::AudioBuffer<float> buffer;
};

/** Reads PCM (16/24/32 bit) and IEEE float (32/64 bit) WAV files. Throws std::runtime_error. */
WavData readWav (const juce::File& file);

/** Writes a 32-bit IEEE float WAV file. Throws std::runtime_error. */
void writeWavFloat32 (const juce::File& file, const juce::AudioBuffer<float>& buffer, int numSamples, double sampleRate);

} // namespace vch
