#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "CloneGui.h"

#include <memory>
#include <vector>

class CloneProcessor;

/** Editor that draws the measured layout of the original plugin (clone/src/gui/model.ts). */
class CloneEditor final : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit CloneEditor (CloneProcessor&);
    ~CloneEditor() override;

    void resized() override;

private:
    class Content;
    void timerCallback() override;

    CloneProcessor& processor;
    std::unique_ptr<Content> content;
    std::vector<float> lastValues;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CloneEditor)
};
