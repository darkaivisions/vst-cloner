// vch-gui: opens a plugin editor, changes parameters step by step and captures the editor after each step.
// Run under Xvfb on Linux so that nothing appears on the desktop.

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>

#include "Protocol.h"
#include "ScreenCapture.h"

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <stdexcept>

namespace
{
    constexpr auto usage = R"(vch-gui — capture plugin editors for vst-cloner

Usage:
  vch-gui snapshot <job.json>
  vch-gui --version

Job: { "plugin", "identifier"?, "state"?, "output", "settleMs", "stepMs", "dismissKeys"? (e.g. ["Escape"], default none),
       "clicks"? [ { "dx", "dy" } ] (left clicks relative to the editor centre, e.g. to close a trial notice),
       "steps": [ { "id", "params": [ { "index", "value" } ], "png"? } ] }
Each step starts from the plugin's initial parameter values. Results are JSON lines on stdout.
)";

    struct Holder final : public juce::Component
    {
        explicit Holder (juce::AudioProcessorEditor& e) : editor (e)
        {
            setOpaque (true);
            addAndMakeVisible (editor);
            setSize (editor.getWidth(), editor.getHeight());
        }

        void paint (juce::Graphics& g) override { g.fillAll (juce::Colours::black); }
        void childBoundsChanged (juce::Component*) override { setSize (editor.getWidth(), editor.getHeight()); }

        juce::AudioProcessorEditor& editor;
    };

    void pump (int milliseconds)
    {
        juce::MessageManager::getInstance()->runDispatchLoopUntil (milliseconds);
    }

    juce::File resolve (const juce::File& base, const juce::String& path)
    {
        return juce::File::isAbsolutePath (path) ? juce::File (path) : base.getChildFile (path);
    }

    void writePng (const juce::File& file, const std::vector<uint8_t>& rgba, int width, int height)
    {
        juce::Image image (juce::Image::ARGB, width, height, false);
        juce::Image::BitmapData data (image, juce::Image::BitmapData::writeOnly);

        for (int y = 0; y < height; ++y)
            for (int x = 0; x < width; ++x)
            {
                const auto* p = &rgba[((size_t) y * (size_t) width + (size_t) x) * 4];
                data.setPixelColour (x, y, juce::Colour (p[0], p[1], p[2]));
            }

        file.deleteFile();
        juce::FileOutputStream out (file);
        juce::PNGImageFormat png;
        if (! out.openedOk() || ! png.writeImageToStream (image, out))
            throw std::runtime_error (("cannot write " + file.getFullPathName()).toStdString());
    }

    int runSnapshot (const juce::String& jobPath)
    {
        auto jobFile = juce::File::getCurrentWorkingDirectory().getChildFile (jobPath);
        juce::var job;
        auto parsed = juce::JSON::parse (jobFile.loadFileAsString(), job);
        if (parsed.failed())
            throw std::runtime_error (parsed.getErrorMessage().toStdString());

        auto base = jobFile.getParentDirectory();
        auto output = resolve (base, job["output"].toString());
        output.createDirectory();
        const int settleMs = (int) job.getProperty ("settleMs", 2500);
        const int stepMs = (int) job.getProperty ("stepMs", 300);

        juce::AudioPluginFormatManager formats;
        juce::addDefaultFormatsToManager (formats);

        juce::OwnedArray<juce::PluginDescription> types;
        const auto pluginPath = job["plugin"].toString();
        for (auto* format : formats.getFormats())
            if (format->fileMightContainThisPluginType (pluginPath))
                format->findAllTypesForFile (types, pluginPath);

        if (types.isEmpty())
            throw std::runtime_error (("no supported plugin found in " + pluginPath).toStdString());

        const juce::PluginDescription* chosen = types.getFirst();
        const auto identifier = job["identifier"].toString();
        for (auto* type : types)
            if (identifier.isNotEmpty() && type->createIdentifierString() == identifier)
                chosen = type;

        juce::String error;
        auto plugin = formats.createPluginInstance (*chosen, 48000.0, 512, error);
        if (plugin == nullptr)
            throw std::runtime_error (("failed to instantiate plugin: " + error).toStdString());

        plugin->enableAllBuses();
        plugin->prepareToPlay (48000.0, 512);

        if (auto state = job["state"].toString(); state.isNotEmpty())
        {
            juce::MemoryBlock block;
            if (block.fromBase64Encoding (state))
                plugin->setStateInformation (block.getData(), (int) block.getSize());
        }

        if (! plugin->hasEditor())
            throw std::runtime_error ("plugin has no editor");

        // plugins may install their own X error handler while loading – ours must win
        vch::installXErrorHandler();
        std::unique_ptr<juce::AudioProcessorEditor> editor (plugin->createEditorAndMakeActive());
        if (editor == nullptr)
            throw std::runtime_error ("plugin did not create an editor");

        auto holder = std::make_unique<Holder> (*editor);
        holder->addToDesktop (0);
        holder->setTopLeftPosition (0, 0);
        holder->setVisible (true);
        holder->toFront (true);
        pump (settleMs);

        // close dialogs drawn inside the editor (welcome / evaluation notices) with a neutral key
        juce::StringArray dismissKeys;
        if (auto* keys = job["dismissKeys"].getArray())
        {
            dismissKeys.clear();
            for (auto& key : *keys)
                dismissKeys.add (key.toString());
        }
        for (auto& key : dismissKeys)
        {
            if (vch::pressKey ((unsigned long) (juce::pointer_sized_uint) holder->getWindowHandle(), key.toRawUTF8()))
                pump (std::max (stepMs, 500));
        }

        if (auto* clicks = job["clicks"].getArray())
        {
            for (auto& click : *clicks)
            {
                const int cx = holder->getWidth() / 2 + (int) click["dx"], cy = holder->getHeight() / 2 + (int) click["dy"];
                if (vch::clickAt ((unsigned long) (juce::pointer_sized_uint) holder->getWindowHandle(), cx, cy))
                {
                    vch::emit (vch::makeObject ({ { "type", "click" }, { "x", cx }, { "y", cy } }));
                    pump (std::max (stepMs, 800));
                }
            }
        }

        auto parameters = plugin->getParameters();
        std::vector<float> initial;
        for (auto* p : parameters)
            initial.push_back (p->getValue());

        vch::emit (vch::makeObject ({ { "type", "window" }, { "width", holder->getWidth() }, { "height", holder->getHeight() },
                                 { "plugin", chosen->name }, { "parameters", parameters.size() } }));

        auto* steps = job["steps"].getArray();
        if (steps == nullptr)
            throw std::runtime_error ("job has no 'steps' array");

        std::vector<int> touched;

        for (auto& step : *steps)
        {
            for (auto index : touched)
                parameters[index]->setValueNotifyingHost (initial[(size_t) index]);
            touched.clear();

            if (auto* list = step["params"].getArray())
            {
                for (auto& entry : *list)
                {
                    const int index = (int) entry["index"];
                    if (! juce::isPositiveAndBelow (index, parameters.size()))
                        throw std::runtime_error (("parameter index out of range: " + juce::String (index)).toStdString());
                    parameters[index]->setValueNotifyingHost ((float) (double) entry["value"]);
                    touched.push_back (index);
                }
            }

            pump (stepMs);

            const auto bounds = holder->getScreenBounds();
            const double scale = juce::Desktop::getInstance().getDisplays().getDisplayForRect (bounds) != nullptr
                                     ? juce::Desktop::getInstance().getDisplays().getDisplayForRect (bounds)->scale
                                     : 1.0;
            const int x = juce::roundToInt (bounds.getX() * scale), y = juce::roundToInt (bounds.getY() * scale);
            const int w = juce::roundToInt (bounds.getWidth() * scale), h = juce::roundToInt (bounds.getHeight() * scale);

            // dialogs opened by the plugin (licence nag, welcome screen …) must not cover the editor
            for (const auto& title : vch::moveOtherWindowsAway ((unsigned long) (juce::pointer_sized_uint) holder->getWindowHandle(), x, y, w, h))
            {
                vch::emit (vch::makeObject ({ { "type", "dialog" }, { "title", juce::String::fromUTF8 (title.c_str()) } }));
                pump (stepMs);
            }

            std::vector<uint8_t> rgba;
            std::string captureError;
            if (! vch::captureScreen (x, y, w, h, rgba, captureError))
                throw std::runtime_error (captureError);

            const auto id = step["id"].toString();
            auto raw = output.getChildFile (id + ".rgba");
            raw.replaceWithData (rgba.data(), rgba.size());

            juce::String pngPath;
            if ((bool) step.getProperty ("png", false))
            {
                auto png = output.getChildFile (id + ".png");
                writePng (png, rgba, w, h);
                pngPath = png.getFullPathName();
            }

            vch::emit (vch::makeObject ({ { "type", "shot" }, { "id", id }, { "file", raw.getFullPathName() },
                                     { "png", pngPath }, { "width", w }, { "height", h } }));
        }

        // Report success first: some plugins crash while their editor is torn down on a bare X server.
        // Exiting directly is safe – the OS closes all resources (also bridged plugin hosts).
        vch::emit (vch::makeObject ({ { "type", "done" }, { "steps", steps->size() } }));
        std::fflush (stdout);
        std::fflush (stderr);
        std::_Exit (0);
    }
}

int main (int argc, char* argv[])
{
    juce::StringArray args;
    for (int i = 1; i < argc; ++i)
        args.add (juce::String::fromUTF8 (argv[i]));

    if (args.isEmpty() || args[0] == "--help")
    {
        std::cout << usage;
        return args.isEmpty() ? 1 : 0;
    }

    if (args[0] == "--version")
    {
        std::cout << VCH_HOST_VERSION << "\n";
        return 0;
    }

    vch::initialiseProtocolChannel();
    vch::prepareDisplay();
    juce::ScopedJuceInitialiser_GUI juceInit;
    int result = 1;

    try
    {
        if (args[0] == "snapshot" && args.size() > 1)
            result = runSnapshot (args[1]);
        else
            throw std::runtime_error ("usage: vch-gui snapshot <job.json>");
    }
    catch (const std::exception& e)
    {
        vch::emit (vch::makeObject ({ { "type", "error" }, { "message", juce::String::fromUTF8 (e.what()) } }));
    }

    return result;
}
