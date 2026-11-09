#pragma once

#include <juce_core/juce_core.h>

namespace vch
{

/** Writes one line of compact JSON to the protocol channel (the original stdout). */
void emit (const juce::var& message);

/** Redirects stdout to stderr so that output printed by plugins cannot corrupt the JSON protocol. */
void initialiseProtocolChannel();

int runList (const juce::StringArray& args);
int runInfo (const juce::StringArray& args);
int runRender (const juce::StringArray& args);

} // namespace vch
