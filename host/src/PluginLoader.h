#pragma once

#include <juce_audio_processors_headless/juce_audio_processors_headless.h>

namespace vch
{

struct LoadedPlugin
{
    juce::PluginDescription description;
    std::unique_ptr<juce::AudioPluginInstance> instance;
};

class PluginLoader
{
public:
    PluginLoader();

    /** Lists all plugin types contained in a file/bundle (a VST3 bundle can contain several). */
    juce::OwnedArray<juce::PluginDescription> findTypes (const juce::String& fileOrIdentifier);

    /** Loads a plugin. If the file contains several types, `identifier` (PluginDescription::createIdentifierString)
        or the plugin name selects one; otherwise the first type is used. Throws std::runtime_error. */
    LoadedPlugin load (const juce::String& fileOrIdentifier, const juce::String& identifier,
                       double sampleRate, int blockSize);

private:
    juce::AudioPluginFormatManager formatManager;
};

} // namespace vch
