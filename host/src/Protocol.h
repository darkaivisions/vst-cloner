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

} // namespace vch
