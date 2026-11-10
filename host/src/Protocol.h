#pragma once

#include <juce_core/juce_core.h>

namespace vch
{

/** Writes one line of compact JSON to the protocol channel (the original stdout). */
void emit (const juce::var& message);

/** Redirects stdout to stderr so that output printed by plugins cannot corrupt the JSON protocol. */
void initialiseProtocolChannel();

/** {"key": value, ...} */
juce::var makeObject (std::initializer_list<std::pair<const char*, juce::var>> props);

/** The given plugin path plus equivalent spellings: on many Linux systems /usr/lib64 links to /usr/lib, and the
    LV2 library registers each bundle under only one of the two names. */
juce::StringArray pluginPathCandidates (const juce::String& path);

} // namespace vch
