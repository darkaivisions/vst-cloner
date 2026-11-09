#include "Commands.h"

#include <juce_events/juce_events.h>

#include <iostream>

namespace
{
    constexpr auto usage = R"(vch-host — headless plugin capture host for vst-cloner

Usage:
  vch-host list   <plugin>                       List plugin types in a file/bundle
  vch-host info   <plugin> [--id <identifier>]   Print plugin and parameter info
                  [--sample-rate <hz>] [--channels <n>]
  vch-host render <job.json>                     Render a capture job
  vch-host --version

All results are written to stdout as JSON lines. Errors: {"type":"error",...}, exit code 1.
)";
}

int main (int argc, char* argv[])
{
    juce::StringArray args;

    for (int i = 1; i < argc; ++i)
        args.add (juce::String::fromUTF8 (argv[i]));

    if (args.isEmpty() || args[0] == "--help" || args[0] == "-h")
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

    juce::ScopedJuceInitialiser_GUI juceInit;

    auto command = args[0];
    args.remove (0);
    int result = 1;

    try
    {
        if (command == "list")         result = vch::runList (args);
        else if (command == "info")    result = vch::runInfo (args);
        else if (command == "render")  result = vch::runRender (args);
        else
            throw std::runtime_error (("unknown command: " + command).toStdString());
    }
    catch (const std::exception& e)
    {
        auto obj = juce::DynamicObject::Ptr (new juce::DynamicObject());
        obj->setProperty ("type", "error");
        obj->setProperty ("message", juce::String::fromUTF8 (e.what()));
        vch::emit (juce::var (obj.get()));
        result = 1;
    }

    return result;
}
