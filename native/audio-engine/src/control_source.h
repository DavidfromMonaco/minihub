#pragma once

#include <pluginterfaces/base/funknown.h>

#include <cstdint>

namespace mlh::control {

// A plugin that commands MiniHub's modules -- One Ring is the first -- exposes
// this interface on its audio processor. Nothing in it names a module: the host
// hands the plugin a JSON list of what is cabled to its node's CTRL OUT, and the
// plugin hands back fixed-size packets naming a target, a command and a value.
// A plugin without it is an ordinary audio/MIDI plugin and never learns this
// file exists.
//
// The interface ids and the packet layout are an ABI shared with binaries built
// outside this repository. Editing any of them does not fail loudly: an
// installed plugin simply answers kNoInterface, and its cables go quiet. A
// change is a new id and a new version, never an edit of these.
inline const Steinberg::FUID interfaceId(0x62CF73AD, 0x36C34A31, 0xB8247EB3, 0xFBD906E1);
constexpr std::uint32_t version = 1;

struct Packet {
    std::uint32_t version = control::version;
    // 0 no value, 1 boolean (0 or 1 in `number`), 2 integer, 3 float, 4 choice id.
    std::uint32_t valueType = 0;
    std::uint64_t sequence = 0;
    // The registry the plugin was using when it produced the packet.
    std::uint64_t registryRevision = 0;
    double beat = 0;
    double number = 0;
    char target[256]{};
    char command[128]{};
};

// The layout above is read from memory written by another compiler run.
static_assert(sizeof(Packet) == 424, "control::Packet is a shared ABI");

class IControlSource : public Steinberg::FUnknown {
public:
    virtual Steinberg::tresult PLUGIN_API setRegistry(const char* json, std::uint32_t bytes) = 0;
    virtual Steinberg::tresult PLUGIN_API popEvent(Packet*) = 0;
    virtual Steinberg::tresult PLUGIN_API submit(const Packet*) = 0;
};

// Optional: why the host refused a command, shown in the plugin's own window. A
// separate identity keeps the v1 source interface unchanged for plugins that do
// not implement it.
inline const Steinberg::FUID feedbackInterfaceId(0x7A3D1972, 0x52B84FA0, 0xA19D920E, 0x396B24C1);

class IControlFeedback : public Steinberg::FUnknown {
public:
    virtual Steinberg::tresult PLUGIN_API setControlStatus(const char* utf8, std::uint32_t bytes) = 0;
};

// Optional: requests the host forwards to the plugin -- an agent reading and
// programming what the plugin keeps in its own state, which no parameter shows.
// A JSON object in, a JSON object out, in the plugin's own vocabulary. `request`
// runs one and keeps its reply, reporting the reply's size; `readReply` copies
// that reply, without a terminator, into a buffer at least that large. A request
// the plugin refuses still answers kResultOk, with `"ok": false` in the reply.
inline const Steinberg::FUID requestsInterfaceId(0x580593A8, 0x17D4E4F0, 0x73201D50, 0x05F593E8);

class IControlRequests : public Steinberg::FUnknown {
public:
    virtual Steinberg::tresult PLUGIN_API request(const char* json, std::uint32_t bytes, std::uint32_t* replyBytes) = 0;
    virtual Steinberg::tresult PLUGIN_API readReply(char* buffer, std::uint32_t capacity) = 0;
};

} // namespace mlh::control
