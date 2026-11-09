#include "PluginLoader.h"

#include <stdexcept>

namespace vch
{

PluginLoader::PluginLoader()
{
    juce::addHeadlessDefaultFormatsToManager (formatManager);
}

juce::OwnedArray<juce::PluginDescription> PluginLoader::findTypes (const juce::String& fileOrIdentifier)
{
    juce::OwnedArray<juce::PluginDescription> types;
    auto target = juce::File::isAbsolutePath (fileOrIdentifier)
                    ? juce::File (fileOrIdentifier).getFullPathName()
                    : fileOrIdentifier;

    for (auto* format : formatManager.getFormats())
        if (format->fileMightContainThisPluginType (target))
            format->findAllTypesForFile (types, target);

    return types;
}

LoadedPlugin PluginLoader::load (const juce::String& fileOrIdentifier, const juce::String& identifier,
                                 double sampleRate, int blockSize)
{
    auto types = findTypes (fileOrIdentifier);

    if (types.isEmpty())
        throw std::runtime_error (("no supported plugin found in " + fileOrIdentifier).toStdString());

    const juce::PluginDescription* chosen = types.getFirst();

    if (identifier.isNotEmpty())
    {
        chosen = nullptr;

        for (auto* type : types)
            if (type->createIdentifierString() == identifier || type->name == identifier)
                chosen = type;

        if (chosen == nullptr)
            throw std::runtime_error (("plugin type '" + identifier + "' not found in " + fileOrIdentifier).toStdString());
    }

    juce::String error;
    auto instance = formatManager.createPluginInstance (*chosen, sampleRate, blockSize, error);

    if (instance == nullptr)
        throw std::runtime_error (("failed to instantiate plugin: " + error).toStdString());

    return { *chosen, std::move (instance) };
}

} // namespace vch
