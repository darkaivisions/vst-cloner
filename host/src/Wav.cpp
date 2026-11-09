#include "Wav.h"

#include <cstring>
#include <stdexcept>

namespace vch
{

namespace
{
    constexpr uint16_t formatPcm = 1;
    constexpr uint16_t formatFloat = 3;
    constexpr uint16_t formatExtensible = 0xfffe;

    uint16_t readU16 (const uint8_t* p) { return (uint16_t) (p[0] | (p[1] << 8)); }
    uint32_t readU32 (const uint8_t* p) { return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24); }

    [[noreturn]] void fail (const juce::File& file, const juce::String& message)
    {
        throw std::runtime_error ((file.getFullPathName() + ": " + message).toStdString());
    }

    float decodeSample (const uint8_t* p, uint16_t format, uint16_t bits)
    {
        if (format == formatFloat)
        {
            if (bits == 32)
            {
                float f;
                uint32_t u = readU32 (p);
                std::memcpy (&f, &u, 4);
                return f;
            }

            uint64_t u = (uint64_t) readU32 (p) | ((uint64_t) readU32 (p + 4) << 32);
            double d;
            std::memcpy (&d, &u, 8);
            return (float) d;
        }

        switch (bits)
        {
            case 16: return (float) (int16_t) readU16 (p) / 32768.0f;
            case 24:
            {
                int32_t v = (int32_t) ((uint32_t) p[0] << 8 | (uint32_t) p[1] << 16 | (uint32_t) p[2] << 24) >> 8;
                return (float) v / 8388608.0f;
            }
            case 32: return (float) ((double) (int32_t) readU32 (p) / 2147483648.0);
            default: return 0.0f;
        }
    }

    void writeU16 (juce::OutputStream& out, uint16_t v) { out.writeShort ((short) v); }
    void writeU32 (juce::OutputStream& out, uint32_t v) { out.writeInt ((int) v); }
}

WavData readWav (const juce::File& file)
{
    juce::MemoryBlock block;

    if (! file.loadFileAsData (block))
        fail (file, "cannot read file");

    auto* data = static_cast<const uint8_t*> (block.getData());
    auto size = block.getSize();

    if (size < 12 || std::memcmp (data, "RIFF", 4) != 0 || std::memcmp (data + 8, "WAVE", 4) != 0)
        fail (file, "not a RIFF/WAVE file");

    uint16_t format = 0, channels = 0, bits = 0, blockAlign = 0;
    uint32_t sampleRate = 0;
    const uint8_t* sampleData = nullptr;
    size_t sampleBytes = 0;

    for (size_t pos = 12; pos + 8 <= size;)
    {
        auto chunkSize = (size_t) readU32 (data + pos + 4);
        auto* body = data + pos + 8;
        auto available = std::min (chunkSize, size - pos - 8);

        if (std::memcmp (data + pos, "fmt ", 4) == 0 && available >= 16)
        {
            format = readU16 (body);
            channels = readU16 (body + 2);
            sampleRate = readU32 (body + 4);
            blockAlign = readU16 (body + 12);
            bits = readU16 (body + 14);

            if (format == formatExtensible && available >= 26)
                format = readU16 (body + 24);
        }
        else if (std::memcmp (data + pos, "data", 4) == 0)
        {
            sampleData = body;
            sampleBytes = available;
        }

        pos += 8 + chunkSize + (chunkSize & 1);
    }

    if (sampleData == nullptr || channels == 0 || sampleRate == 0)
        fail (file, "missing fmt or data chunk");

    bool supported = (format == formatPcm && (bits == 16 || bits == 24 || bits == 32))
                  || (format == formatFloat && (bits == 32 || bits == 64));

    if (! supported || blockAlign != channels * (bits / 8))
        fail (file, "unsupported sample format (format " + juce::String (format) + ", " + juce::String (bits) + " bit)");

    auto numFrames = (int) (sampleBytes / blockAlign);
    WavData result;
    result.sampleRate = (double) sampleRate;
    result.buffer.setSize ((int) channels, numFrames);

    for (int frame = 0; frame < numFrames; ++frame)
        for (int ch = 0; ch < (int) channels; ++ch)
            result.buffer.setSample (ch, frame, decodeSample (sampleData + (size_t) frame * blockAlign + (size_t) ch * (bits / 8), format, bits));

    return result;
}

void writeWavFloat32 (const juce::File& file, const juce::AudioBuffer<float>& buffer, int numSamples, double sampleRate)
{
    file.getParentDirectory().createDirectory();
    file.deleteFile();

    juce::FileOutputStream out (file);

    if (! out.openedOk())
        fail (file, "cannot open for writing");

    auto channels = (uint16_t) buffer.getNumChannels();
    auto dataBytes = (uint32_t) numSamples * channels * 4u;

    out.write ("RIFF", 4);
    writeU32 (out, 36 + dataBytes);
    out.write ("WAVE", 4);
    out.write ("fmt ", 4);
    writeU32 (out, 16);
    writeU16 (out, formatFloat);
    writeU16 (out, channels);
    writeU32 (out, (uint32_t) sampleRate);
    writeU32 (out, (uint32_t) sampleRate * channels * 4u);
    writeU16 (out, (uint16_t) (channels * 4));
    writeU16 (out, 32);
    out.write ("data", 4);
    writeU32 (out, dataBytes);

    for (int frame = 0; frame < numSamples; ++frame)
        for (int ch = 0; ch < channels; ++ch)
            out.writeFloat (buffer.getSample (ch, frame));

    out.flush();

    if (out.getStatus().failed())
        fail (file, out.getStatus().getErrorMessage());
}

} // namespace vch
