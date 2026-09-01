#include "vst3_scanner.h"

#include <iostream>
#if defined(_WIN32)
#include <process.h>
#else
#include <unistd.h>
#endif

namespace mlh {

namespace {

/** A single plugin gets this long to report its metadata before the scanner
 *  kills the child process and moves on. Without it, one hanging plugin froze
 *  the whole scan indefinitely. */
constexpr size_t kMaxScanChildOutputBytes = 8u * 1024u * 1024u;
constexpr juce::int64 kMaxScanResultBytes = 8 * 1024 * 1024;
constexpr const char* kScanResultProtocol = "minihub-vst3-scan-result";
constexpr int kScanResultVersion = 1;

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

juce::var makeObject()
{
    return juce::var(new juce::DynamicObject());
}

void setProperty(juce::var& object, const char* name, const juce::var& value)
{
    object.getDynamicObject()->setProperty(juce::Identifier(name), value);
}

juce::var serializeRecord(const PluginRecord& rec)
{
    juce::var value = makeObject();
    if (auto xml = rec.description.createXml())
        setProperty(value, "descriptionXml", xml->toString());
    setProperty(value, "pluginId", rec.pluginId);
    setProperty(value, "name", rec.name);
    setProperty(value, "manufacturer", rec.manufacturer);
    setProperty(value, "category", rec.category);
    setProperty(value, "path", rec.path);
    setProperty(value, "isInstrument", rec.isInstrument);
    setProperty(value, "numInputChannels", rec.numInputChannels);
    setProperty(value, "numOutputChannels", rec.numOutputChannels);
    setProperty(value, "role", rec.role);
    return value;
}

bool deserializeRecord(const juce::var& value, PluginRecord& rec)
{
    if (!value.isObject())
        return false;

    rec.pluginId = value["pluginId"].toString();
    rec.name = value["name"].toString();
    rec.manufacturer = value["manufacturer"].toString();
    rec.category = value["category"].toString();
    rec.path = value["path"].toString();
    rec.isInstrument = value["isInstrument"].isBool()
                           ? static_cast<bool>(value["isInstrument"])
                           : false;
    rec.numInputChannels = value["numInputChannels"].isInt()
                               ? static_cast<int>(value["numInputChannels"])
                               : 0;
    rec.numOutputChannels = value["numOutputChannels"].isInt()
                                ? static_cast<int>(value["numOutputChannels"])
                                : 0;
    rec.role = value["role"].toString();

    const auto xmlText = value["descriptionXml"].toString();
    auto xml = juce::XmlDocument::parse(xmlText);
    return rec.pluginId.isNotEmpty()
        && xml != nullptr
        && rec.description.loadFromXml(*xml);
}

} // namespace

juce::String Vst3Scanner::serializeScanResult(
    const std::vector<PluginRecord>& records)
{
    juce::Array<juce::var> plugins;
    for (const auto& record : records)
        plugins.add(serializeRecord(record));

    juce::var root = makeObject();
    setProperty(root, "protocol", kScanResultProtocol);
    setProperty(root, "version", kScanResultVersion);
    setProperty(root, "plugins", plugins);
    return juce::JSON::toString(root, true);
}

bool Vst3Scanner::deserializeScanResult(
    const juce::String& json,
    std::vector<PluginRecord>& records)
{
    records.clear();
    const auto root = juce::JSON::parse(json);
    if (!root.isObject()
        || root["protocol"].toString() != kScanResultProtocol
        || !root["version"].isInt()
        || static_cast<int>(root["version"]) != kScanResultVersion)
        return false;

    const auto* plugins = root["plugins"].getArray();
    if (plugins == nullptr)
        return false;

    for (const auto& value : *plugins)
    {
        PluginRecord record;
        if (deserializeRecord(value, record))
            records.push_back(std::move(record));
    }
    return true;
}

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

std::vector<PluginRecord> Vst3Scanner::scanFileIsolated(
    const juce::String& path,
    const std::atomic<bool>* cancelled,
    const juce::uint32 timeoutMs)
{
    if (path.isEmpty()
        || (cancelled != nullptr && cancelled->load(std::memory_order_acquire)))
        return {};

    const juce::File currentExe = juce::File::getSpecialLocation(
        juce::File::currentExecutableFile);
    const juce::File exe = currentExe.getSiblingFile("mlh-vst3-scanner.exe");
    if (!exe.existsAsFile())
    {
        std::cerr << "[scan] dedicated helper is missing: "
                  << exe.getFullPathName() << std::endl;
        return {};
    }
    juce::TemporaryFile resultFile(".minihub-vst3-scan.json");
    juce::ChildProcess child;
    juce::StringArray args;
    args.add(exe.getFullPathName());
    args.add("--scan-file");
    args.add(path);
    args.add("--scan-result");
    args.add(resultFile.getFile().getFullPathName());
    args.add("--parent-pid");
#if defined(_WIN32)
    args.add(juce::String(static_cast<juce::int64>(_getpid())));
#else
    args.add(juce::String(static_cast<juce::int64>(getpid())));
#endif
    args.add("--created-at");
    args.add(juce::Time::getCurrentTime().toISO8601(true));

    if (!child.start(args, juce::ChildProcess::wantStdOut))
    {
        std::cerr << "[scan] child start failed: " << path << std::endl;
        return {};
    }

    const auto started = juce::Time::getMillisecondCounter();
    bool cancelledOrTimedOut = false;
    while (child.isRunning())
    {
        const bool wasCancelled = cancelled != nullptr
            && cancelled->load(std::memory_order_acquire);
        const bool timedOut = juce::Time::getMillisecondCounter() - started
            >= timeoutMs;
        if (wasCancelled || timedOut)
        {
            cancelledOrTimedOut = true;
            if (timedOut)
                std::cerr << "[scan] timeout, killing child for: " << path << std::endl;
            child.kill();
            break;
        }

        // JUCE's Windows readProcessOutput() waits until its requested buffer
        // is full or the child exits. Calling it here made the timeout above
        // unreachable for a helper that emitted a short diagnostic and hung.
        child.waitForProcessToFinish(5);
    }

    child.waitForProcessToFinish(1000);
    if (cancelledOrTimedOut)
        return {};
    if (child.isRunning())
    {
        std::cerr << "[scan] child did not terminate for: " << path << std::endl;
        return {};
    }

    const auto exitCode = child.getExitCode();
    if (exitCode != 0)
    {
        std::cerr << "[scan] child exited with code " << exitCode
                  << " for: " << path << std::endl;
        return {};
    }

    // The metadata is in the private result file. Drain plugin-controlled
    // stdout only after a normal child exit, when JUCE's read cannot block.
    size_t capturedOutputBytes = 0;
    char buffer[4096];
    int count = 0;
    while ((count = child.readProcessOutput(buffer, sizeof(buffer))) > 0)
    {
        const auto bytes = static_cast<size_t>(count);
        if (capturedOutputBytes > kMaxScanChildOutputBytes
            || bytes > kMaxScanChildOutputBytes - capturedOutputBytes)
        {
            std::cerr << "[scan] output limit exceeded for: " << path << std::endl;
            return {};
        }
        capturedOutputBytes += bytes;
    }

    const auto& file = resultFile.getFile();
    if (!file.existsAsFile() || file.getSize() > kMaxScanResultBytes)
    {
        std::cerr << "[scan] missing or oversized helper result for: "
                  << path << std::endl;
        return {};
    }

    std::vector<PluginRecord> records;
    if (!deserializeScanResult(file.loadFileAsString(), records))
    {
        std::cerr << "[scan] invalid helper result for: " << path << std::endl;
        return {};
    }
    return records;
}

void Vst3Scanner::setRecords(std::vector<PluginRecord> records)
{
    records_ = std::move(records);
    index_.clear();
    for (size_t i = 0; i < records_.size(); ++i)
        index_[records_[i].pluginId] = i;
}

std::vector<PluginRecord> Vst3Scanner::scanAll(const std::atomic<bool>* cancelled)
{
    std::vector<PluginRecord> records;
    std::map<juce::String, size_t> seen;

    juce::VST3PluginFormat format;
    const auto paths = format.getDefaultLocationsToSearch();
    const auto files = findVst3Files(paths);

    for (const auto& file : files)
    {
        if (cancelled != nullptr && cancelled->load(std::memory_order_acquire))
            break;
        auto found = scanFileIsolated(file, cancelled);
        for (auto& rec : found)
        {
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
