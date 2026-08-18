#include "vst3_scanner.h"

#include <iostream>

namespace mlh {

namespace {

/** A single plugin gets this long to report its metadata before the scanner
 *  kills the child process and moves on. Without it, one hanging plugin froze
 *  the whole scan indefinitely. */
constexpr juce::uint32 kScanChildTimeoutMs = 30000;

/** Map real plugin capability to our role model. Falls back to 'unknown'. */
juce::String classifyRole(const juce::PluginDescription& d)
{
    if (d.isInstrument)
        return "instrument";
    if (d.numInputChannels > 0)
        return "audio-effect";
    return "unknown";
}

PluginRecord recordFromDescription(const juce::PluginDescription& d)
{
    PluginRecord rec;
    rec.pluginId = d.fileOrIdentifier;
    rec.name = d.name;
    rec.manufacturer = d.manufacturerName;
    rec.category = d.category;
    rec.path = d.fileOrIdentifier;
    rec.isInstrument = d.isInstrument;
    rec.numInputChannels = d.numInputChannels;
    rec.numOutputChannels = d.numOutputChannels;
    rec.role = classifyRole(d);
    rec.description = d;
    return rec;
}

} // namespace

juce::StringArray Vst3Scanner::findVst3Files(const juce::FileSearchPath& paths)
{
    juce::StringArray out;
    for (int i = 0; i < paths.getNumPaths(); ++i)
    {
        const juce::File dir = paths[i];
        if (!dir.isDirectory())
            continue;

        juce::RangedDirectoryIterator it(dir, true, "*.vst3",
                                        juce::File::findFilesAndDirectories);
        for (auto& entry : it)
            out.add(entry.getFile().getFullPathName());
    }
    return out;
}

std::vector<PluginRecord> Vst3Scanner::scanFile(const juce::String& path)
{
    std::vector<PluginRecord> out;
    juce::VST3PluginFormat format;
    juce::OwnedArray<juce::PluginDescription> found;
    try
    {
        format.findAllTypesForFile(found, path);
    }
    catch (...)
    {
        return out;
    }

    for (const auto* d : found)
    {
        if (d == nullptr)
            continue;
        out.push_back(recordFromDescription(*d));
    }
    return out;
}

void Vst3Scanner::setRecords(std::vector<PluginRecord> records)
{
    records_ = std::move(records);
    index_.clear();
    for (size_t i = 0; i < records_.size(); ++i)
        index_[records_[i].pluginId] = i;
}

std::vector<PluginRecord> Vst3Scanner::scanAll()
{
    std::vector<PluginRecord> records;
    std::map<juce::String, size_t> seen;

    juce::VST3PluginFormat format;
    const auto paths = format.getDefaultLocationsToSearch();
    const auto files = findVst3Files(paths);

    const juce::File exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);

    for (const auto& file : files)
    {
        juce::ChildProcess child;
        juce::StringArray args;
        args.add(exe.getFullPathName());
        args.add("--scan-file");
        args.add(file);

        if (!child.start(args, juce::ChildProcess::wantStdOut))
        {
            std::cerr << "[scan] child start failed: " << file << std::endl;
            continue;
        }

        // Read the child's stdout until the process exits. Plugin noise on
        // stdout is captured here (never on the engine's IPC channel) and only
        // valid JSON lines are parsed.
        juce::MemoryBlock block;
        char buf[4096];
        const auto deadline = juce::Time::getMillisecondCounter() + kScanChildTimeoutMs;
        while (child.isRunning())
        {
            const int n = child.readProcessOutput(buf, sizeof(buf));
            if (n > 0)
                block.append(buf, n);
            else
                juce::Thread::sleep(5);

            // A plugin that hangs during scanning must never hang the scan.
            // Kill the child and move on; the plugin is simply not discovered.
            if (juce::Time::getMillisecondCounter() > deadline)
            {
                std::cerr << "[scan] timeout, killing child for: " << file << std::endl;
                child.kill();
                break;
            }
        }
        child.waitForProcessToFinish(kScanChildTimeoutMs);
        int n;
        while ((n = child.readProcessOutput(buf, sizeof(buf))) > 0)
            block.append(buf, n);

        const juce::String output = block.toString();
        juce::StringArray lines;
        lines.addLines(output);
        for (auto& line : lines)
        {
            line = line.trim();
            if (line.isEmpty())
                continue;

            const auto parsed = juce::JSON::parse(line);
            if (!parsed.isObject())
                continue;

            PluginRecord rec;
            rec.pluginId = parsed["pluginId"].toString();
            rec.name = parsed["name"].toString();
            rec.manufacturer = parsed["manufacturer"].toString();
            rec.category = parsed["category"].toString();
            rec.path = parsed["path"].toString();
            rec.isInstrument = parsed["isInstrument"].isBool()
                                   ? static_cast<bool>(parsed["isInstrument"])
                                   : false;
            rec.numInputChannels = parsed["numInputChannels"].isInt()
                                       ? static_cast<int>(parsed["numInputChannels"])
                                       : 0;
            rec.numOutputChannels = parsed["numOutputChannels"].isInt()
                                        ? static_cast<int>(parsed["numOutputChannels"])
                                        : 0;
            rec.role = parsed["role"].toString();

            // Reconstruct the full plugin description (incl. uniqueId) from the
            // XML the child serialized, so we can instantiate the plugin later.
            const juce::String xml = parsed["descriptionXml"].toString();
            if (xml.isNotEmpty())
            {
                auto element = juce::XmlDocument::parse(xml);
                if (element != nullptr)
                    rec.description.loadFromXml(*element);
            }

            if (rec.pluginId.isEmpty())
                continue;

            if (seen.count(rec.pluginId) == 0)
            {
                seen[rec.pluginId] = records.size();
                records.push_back(std::move(rec));
            }
        }
    }

    return records;
}

const PluginRecord* Vst3Scanner::find(const juce::String& pluginId) const
{
    const auto it = index_.find(pluginId);
    if (it == index_.end())
        return nullptr;
    return &records_[it->second];
}

} // namespace mlh
