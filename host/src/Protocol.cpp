#include "Protocol.h"

#include <cstring>
#include <utility>

#include <cstdio>

#if JUCE_WINDOWS
 #include <io.h>
 #define vch_dup _dup
 #define vch_dup2 _dup2
 #define vch_fdopen _fdopen
#else
 #include <unistd.h>
 #define vch_dup dup
 #define vch_dup2 dup2
 #define vch_fdopen fdopen
#endif

namespace vch
{

namespace
{
    FILE* protocolOut = stdout;
}

void initialiseProtocolChannel()
{
    std::fflush (stdout);
    auto fd = vch_dup (1);

    if (fd < 0)
        return;

    if (auto* stream = vch_fdopen (fd, "w"))
    {
        protocolOut = stream;
        vch_dup2 (2, 1);
    }
}

void emit (const juce::var& message)
{
    auto line = juce::JSON::toString (message, true) + "\n";
    std::fputs (line.toRawUTF8(), protocolOut);
    std::fflush (protocolOut);
}

juce::var makeObject (std::initializer_list<std::pair<const char*, juce::var>> props)
{
    auto obj = juce::DynamicObject::Ptr (new juce::DynamicObject());

    for (auto& [key, value] : props)
        obj->setProperty (key, value);

    return juce::var (obj.get());
}

juce::StringArray pluginPathCandidates (const juce::String& path)
{
    juce::StringArray candidates { path };
    const std::pair<const char*, const char*> twins[] = {
        { "/usr/lib64/", "/usr/lib/" }, { "/usr/lib/", "/usr/lib64/" },
        { "/usr/local/lib64/", "/usr/local/lib/" }, { "/usr/local/lib/", "/usr/local/lib64/" },
    };
    for (const auto& [from, to] : twins)
    {
        if (path.startsWith (from))
        {
            const auto other = juce::String (to) + path.substring ((int) std::strlen (from));
            if (juce::File (other).exists())
                candidates.addIfNotAlreadyThere (other);
        }
    }
    return candidates;
}

} // namespace vch
