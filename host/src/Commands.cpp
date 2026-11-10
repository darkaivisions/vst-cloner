#include "Commands.h"

#include "PluginLoader.h"
#include "Wav.h"

#include "Protocol.h"

#include <stdexcept>

namespace vch
{

namespace
{
    using Object = juce::DynamicObject;

    juce::String optionValue (const juce::StringArray& args, const juce::String& name, const juce::String& fallback = {})
    {
        auto index = args.indexOf (name);
        return index >= 0 && index + 1 < args.size() ? args[index + 1] : fallback;
    }

    /** Returns the positional arguments, skipping options and their values. */
    juce::StringArray positional (const juce::StringArray& args)
    {
        juce::StringArray result;

        for (int i = 0; i < args.size(); ++i)
        {
            if (args[i].startsWith ("--"))
                ++i;
            else
                result.add (args[i]);
        }

        return result;
    }

    juce::var describe (const juce::PluginDescription& d)
    {
        return makeObject ({
            { "name", d.name },
            { "descriptiveName", d.descriptiveName },
            { "manufacturer", d.manufacturerName },
            { "version", d.version },
            { "format", d.pluginFormatName },
            { "category", d.category },
            { "identifier", d.createIdentifierString() },
            { "fileOrIdentifier", d.fileOrIdentifier },
            { "uniqueId", d.uniqueId },
            { "isInstrument", d.isInstrument },
            { "numInputChannels", d.numInputChannels },
            { "numOutputChannels", d.numOutputChannels },
        });
    }

    juce::String parameterId (juce::AudioProcessorParameter& p)
    {
        if (auto* hosted = dynamic_cast<juce::HostedAudioProcessorParameter*> (&p))
            return hosted->getParameterID();

        return juce::String (p.getParameterIndex());
    }

    juce::var describeParameter (juce::AudioProcessorParameter& p)
    {
        juce::Array<juce::var> texts;
        auto steps = p.getNumSteps();
        bool listAllSteps = p.isDiscrete() && steps >= 2 && steps <= 128;
        int count = listAllSteps ? steps : 11;

        for (int i = 0; i < count; ++i)
        {
            auto value = (float) i / (float) (count - 1);
            texts.add (makeObject ({ { "value", value }, { "text", p.getText (value, 64) } }));
        }

        return makeObject ({
            { "index", p.getParameterIndex() },
            { "id", parameterId (p) },
            { "name", p.getName (128) },
            { "label", p.getLabel() },
            { "default", p.getDefaultValue() },
            { "value", p.getValue() },
            { "numSteps", steps },
            { "discrete", p.isDiscrete() },
            { "boolean", p.isBoolean() },
            { "automatable", p.isAutomatable() },
            { "meta", p.isMetaParameter() },
            { "category", (int) p.getCategory() },
            { "texts", texts },
        });
    }

    /** Main buses get the requested channel count. Auxiliary buses (side chains) stay enabled and receive
        silence: some bridges (e.g. yabridge) crash when a VST3 bus is deactivated. */
    void configureBuses (juce::AudioPluginInstance& plugin, int channels)
    {
        plugin.enableAllBuses();

        auto set = juce::AudioChannelSet::canonicalChannelSet (channels);
        auto layout = plugin.getBusesLayout();

        if (! layout.inputBuses.isEmpty())
            layout.inputBuses.getReference (0) = set;

        if (! layout.outputBuses.isEmpty())
            layout.outputBuses.getReference (0) = set;

        if (plugin.checkBusesLayoutSupported (layout))
            plugin.setBusesLayout (layout);
    }

    juce::var describeBuses (juce::AudioPluginInstance& plugin)
    {
        auto list = [&] (bool isInput)
        {
            juce::Array<juce::var> buses;

            for (int i = 0; i < plugin.getBusCount (isInput); ++i)
                if (auto* bus = plugin.getBus (isInput, i))
                    buses.add (makeObject ({ { "name", bus->getName() },
                                             { "enabled", bus->isEnabled() },
                                             { "channels", bus->getNumberOfChannels() } }));

            return buses;
        };

        return makeObject ({ { "inputs", list (true) }, { "outputs", list (false) },
                             { "totalInputChannels", plugin.getTotalNumInputChannels() },
                             { "totalOutputChannels", plugin.getTotalNumOutputChannels() } });
    }

    int mainBusChannels (juce::AudioPluginInstance& plugin, bool isInput)
    {
        auto* bus = plugin.getBus (isInput, 0);
        return bus != nullptr && bus->isEnabled() ? bus->getNumberOfChannels() : 0;
    }

    class Renderer
    {
    public:
        Renderer (juce::AudioPluginInstance& p, int block) : plugin (p), blockSize (block)
        {
            inputChannels = mainBusChannels (plugin, true);
            outputChannels = mainBusChannels (plugin, false);
            work.setSize (juce::jmax (1, plugin.getTotalNumInputChannels(), plugin.getTotalNumOutputChannels()), blockSize);
        }

        int getOutputChannels() const { return outputChannels; }

        /** Processes `numSamples` of `source` (or silence if nullptr), starting at `sourceOffset`.
            Output is written to `dest` at `destOffset` when given. */
        void process (const juce::AudioBuffer<float>* source, int sourceOffset, int numSamples,
                      juce::AudioBuffer<float>* dest, int destOffset)
        {
            juce::ScopedNoDenormals noDenormals;

            for (int done = 0; done < numSamples;)
            {
                auto n = juce::jmin (blockSize, numSamples - done);
                work.clear();

                if (source != nullptr)
                {
                    for (int ch = 0; ch < inputChannels; ++ch)
                    {
                        auto srcCh = juce::jmin (ch, source->getNumChannels() - 1);
                        auto available = juce::jlimit (0, n, source->getNumSamples() - (sourceOffset + done));

                        if (available > 0)
                            work.copyFrom (ch, 0, *source, srcCh, sourceOffset + done, available);
                    }
                }

                juce::AudioBuffer<float> view (work.getArrayOfWritePointers(), work.getNumChannels(), n);
                midi.clear();
                plugin.processBlock (view, midi);

                if (dest != nullptr)
                    for (int ch = 0; ch < dest->getNumChannels(); ++ch)
                        dest->copyFrom (ch, destOffset + done, view, juce::jmin (ch, juce::jmax (0, outputChannels - 1)), 0, n);

                done += n;
            }
        }

    private:
        juce::AudioPluginInstance& plugin;
        int blockSize;
        int inputChannels = 0, outputChannels = 0;
        juce::AudioBuffer<float> work;
        juce::MidiBuffer midi;
    };

    juce::var readJsonFile (const juce::File& file)
    {
        juce::var parsed;
        auto result = juce::JSON::parse (file.loadFileAsString(), parsed);

        if (result.failed())
            throw std::runtime_error ((file.getFullPathName() + ": " + result.getErrorMessage()).toStdString());

        return parsed;
    }

    juce::File resolve (const juce::File& base, const juce::String& path)
    {
        return juce::File::isAbsolutePath (path) ? juce::File (path) : base.getChildFile (path);
    }

    void applyState (juce::AudioPluginInstance& plugin, const juce::String& base64)
    {
        if (base64.isEmpty())
            return;

        juce::MemoryBlock state;

        if (! state.fromBase64Encoding (base64))
            throw std::runtime_error ("invalid base64 plugin state");

        plugin.setStateInformation (state.getData(), (int) state.getSize());
    }
}

int runList (const juce::StringArray& args)
{
    auto pos = positional (args);

    if (pos.isEmpty())
        throw std::runtime_error ("usage: vch-host list <plugin-file-or-uri>");

    PluginLoader loader;
    auto types = loader.findTypes (pos[0]);
    juce::Array<juce::var> list;

    for (auto* type : types)
        list.add (describe (*type));

    emit (makeObject ({ { "type", "list" }, { "plugins", list } }));
    return 0;
}

int runInfo (const juce::StringArray& args)
{
    auto pos = positional (args);

    if (pos.isEmpty())
        throw std::runtime_error ("usage: vch-host info <plugin> [--id <identifier>] [--sample-rate <hz>] [--channels <n>]");

    auto sampleRate = optionValue (args, "--sample-rate", "48000").getDoubleValue();
    auto channels = optionValue (args, "--channels", "2").getIntValue();
    auto blockSize = 512;

    PluginLoader loader;
    auto loaded = loader.load (pos[0], optionValue (args, "--id"), sampleRate, blockSize);
    auto& plugin = *loaded.instance;

    configureBuses (plugin, channels);
    plugin.setNonRealtime (true);
    plugin.prepareToPlay (sampleRate, blockSize);

    juce::Array<juce::var> params;

    for (auto* p : plugin.getParameters())
        params.add (describeParameter (*p));

    juce::MemoryBlock state;
    plugin.getStateInformation (state);

    emit (makeObject ({
        { "type", "info" },
        { "plugin", describe (loaded.description) },
        { "mainInputChannels", mainBusChannels (plugin, true) },
        { "mainOutputChannels", mainBusChannels (plugin, false) },
        { "latencySamples", plugin.getLatencySamples() },
        { "tailSeconds", plugin.getTailLengthSeconds() },
        { "stateBytes", (int) state.getSize() },
        { "buses", describeBuses (plugin) },
        { "parameters", params },
    }));

    plugin.releaseResources();
    return 0;
}

int runRender (const juce::StringArray& args)
{
    auto pos = positional (args);

    if (pos.isEmpty())
        throw std::runtime_error ("usage: vch-host render <job.json>");

    auto jobFile = juce::File::getCurrentWorkingDirectory().getChildFile (pos[0]);
    auto job = readJsonFile (jobFile);
    auto base = jobFile.getParentDirectory();

    auto sampleRate = (double) job.getProperty ("sampleRate", 48000.0);
    auto blockSize = (int) job.getProperty ("blockSize", 512);
    auto channels = (int) job.getProperty ("channels", 2);
    auto prerollSamples = (int) ((double) job.getProperty ("prerollSeconds", 0.5) * sampleRate);
    auto tailSamples = (int) ((double) job.getProperty ("tailSeconds", 1.0) * sampleRate);

    auto input = readWav (resolve (base, job["input"].toString()));

    if (! juce::approximatelyEqual (input.sampleRate, sampleRate))
        throw std::runtime_error ("input sample rate does not match job sample rate");

    PluginLoader loader;
    auto loaded = loader.load (job["plugin"].toString(), job["identifier"].toString(), sampleRate, blockSize);
    auto& plugin = *loaded.instance;

    configureBuses (plugin, channels);
    plugin.setNonRealtime (true);
    plugin.prepareToPlay (sampleRate, blockSize);
    applyState (plugin, job["state"].toString());

    auto parameters = plugin.getParameters();
    std::vector<float> baseValues;

    for (auto* p : parameters)
        baseValues.push_back (p->getValue());

    Renderer renderer (plugin, blockSize);
    auto* renders = job["renders"].getArray();

    if (renders == nullptr)
        throw std::runtime_error ("job has no 'renders' array");

    emit (makeObject ({
        { "type", "start" },
        { "plugin", describe (loaded.description) },
        { "renders", renders->size() },
        { "outputChannels", renderer.getOutputChannels() },
        { "buses", describeBuses (plugin) },
    }));

    int index = 0;

    for (auto& render : *renders)
    {
        auto started = juce::Time::getMillisecondCounterHiRes();

        for (int i = 0; i < parameters.size(); ++i)
            parameters[i]->setValueNotifyingHost (baseValues[(size_t) i]);

        juce::Array<juce::var> applied;

        if (auto* list = render["params"].getArray())
        {
            for (auto& entry : *list)
            {
                auto paramIndex = (int) entry["index"];

                if (! juce::isPositiveAndBelow (paramIndex, parameters.size()))
                    throw std::runtime_error (("parameter index out of range: " + juce::String (paramIndex)).toStdString());

                auto* p = parameters[paramIndex];
                p->setValueNotifyingHost ((float) (double) entry["value"]);
                applied.add (makeObject ({ { "index", paramIndex }, { "value", p->getValue() }, { "text", p->getCurrentValueAsText() } }));
            }
        }

        // Deliver parameter changes, clear internal state, then let smoothing settle.
        renderer.process (nullptr, 0, blockSize, nullptr, 0);
        plugin.reset();
        renderer.process (nullptr, 0, prerollSamples, nullptr, 0);

        auto latency = plugin.getLatencySamples();
        auto keep = input.buffer.getNumSamples() + tailSamples;
        juce::AudioBuffer<float> output (juce::jmax (1, renderer.getOutputChannels()), latency + keep);
        output.clear();
        renderer.process (&input.buffer, 0, latency + keep, &output, 0);

        juce::AudioBuffer<float> trimmed (output.getNumChannels(), keep);

        for (int ch = 0; ch < output.getNumChannels(); ++ch)
            trimmed.copyFrom (ch, 0, output, ch, latency, keep);

        auto outFile = resolve (base, render["output"].toString());
        writeWavFloat32 (outFile, trimmed, keep, sampleRate);

        float peak = 0.0f;

        for (int ch = 0; ch < trimmed.getNumChannels(); ++ch)
            peak = juce::jmax (peak, trimmed.getMagnitude (ch, 0, keep));

        emit (makeObject ({
            { "type", "render" },
            { "id", render["id"] },
            { "index", index++ },
            { "output", outFile.getFullPathName() },
            { "latencySamples", latency },
            { "peak", peak },
            { "params", applied },
            { "milliseconds", juce::Time::getMillisecondCounterHiRes() - started },
        }));
    }

    plugin.releaseResources();
    emit (makeObject ({ { "type", "done" }, { "renders", index } }));
    return 0;
}

} // namespace vch
