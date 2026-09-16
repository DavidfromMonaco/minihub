#pragma once

// One Ring's command vocabulary: what a target accepts and how a value is
// checked against it. Ported from One Ring 0.4's core with its behaviour
// unchanged (plans/active/one-ring-native.md); the VST it came from still
// builds from its own copy.

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace mlh::one_ring {

// Enumeration identity survives changes to the order of a target's menu.
struct EnumValue {
    std::int32_t id = 0;
    bool operator==(EnumValue other) const noexcept { return id == other.id; }
    bool operator!=(EnumValue other) const noexcept { return id != other.id; }
};

// The variant's index is the value type the control packets carry: 0 none,
// 1 boolean, 2 integer, 3 float, 4 choice id. Reordering it changes the wire.
using Value = std::variant<std::monostate, bool, std::int32_t, double, EnumValue>;
enum class ValueType { None, Boolean, Integer, Float, Enumeration };
enum class ExecutionDomain { Audio, Control };

struct Choice {
    EnumValue value;
    std::string label;
};

struct CommandDescriptor {
    std::string id;
    std::string label;
    ValueType type = ValueType::None;
    double minimum = 0.0;
    double maximum = 1.0;
    std::vector<Choice> choices;
    ExecutionDomain domain = ExecutionDomain::Control;
    // A target declares its release operation. The scheduler cannot infer that
    // STOP is the inverse of PLAY, or that RECORD_OFF should stop transport.
    std::optional<std::string> releaseCommand;
    Value releaseValue;
};

struct ModuleDescriptor {
    std::string id;
    std::string label;
    std::vector<CommandDescriptor> commands;
};

enum class Validation { Ok, UnknownModule, UnknownCommand, WrongType, OutOfRange,
                        UnknownChoice, NonFinite };

Validation validate(const CommandDescriptor&, const Value&) noexcept;

// Registry construction belongs to the control thread. Audio plans resolve
// stable strings into immutable handles before entering the callback.
class CommandRegistry {
public:
    void registerModule(ModuleDescriptor);
    bool unregisterModule(const std::string& id);
    const CommandDescriptor* find(const std::string& module,
                                  const std::string& command) const noexcept;
    Validation validate(const std::string& module, const std::string& command,
                        const Value&) const noexcept;
    const std::vector<ModuleDescriptor>& modules() const noexcept { return modules_; }
    std::uint64_t revision() const noexcept { return revision_; }

private:
    std::vector<ModuleDescriptor> modules_;
    std::uint64_t revision_ = 0;
};

} // namespace mlh::one_ring
