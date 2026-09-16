#include "commands.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <utility>

namespace mlh::one_ring {

Validation validate(const CommandDescriptor& command, const Value& value) noexcept
{
    if (value.index() != static_cast<std::size_t>(command.type))
        return Validation::WrongType;
    if (const auto* number = std::get_if<double>(&value)) {
        if (!std::isfinite(*number)) return Validation::NonFinite;
        return *number >= command.minimum && *number <= command.maximum
            ? Validation::Ok : Validation::OutOfRange;
    }
    if (const auto* integer = std::get_if<std::int32_t>(&value))
        return *integer >= command.minimum && *integer <= command.maximum
            ? Validation::Ok : Validation::OutOfRange;
    if (const auto* choice = std::get_if<EnumValue>(&value))
        return std::any_of(command.choices.begin(), command.choices.end(),
            [&](const Choice& item) { return item.value == *choice; })
            ? Validation::Ok : Validation::UnknownChoice;
    return Validation::Ok;
}

void CommandRegistry::registerModule(ModuleDescriptor module)
{
    if (module.id.empty() || module.label.empty())
        throw std::invalid_argument("A module needs a stable ID and a label");
    if (std::any_of(modules_.begin(), modules_.end(), [&](const auto& item) {
            return item.id == module.id;
        })) throw std::invalid_argument("Module ID already registered: " + module.id);

    std::vector<std::string> ids;
    for (const auto& command : module.commands) {
        if (command.id.empty() || command.label.empty()
            || std::find(ids.begin(), ids.end(), command.id) != ids.end())
            throw std::invalid_argument("Missing or duplicate command ID/label");
        ids.push_back(command.id);
        if (command.type == ValueType::Integer || command.type == ValueType::Float) {
            if (!std::isfinite(command.minimum) || !std::isfinite(command.maximum)
                || command.minimum > command.maximum)
                throw std::invalid_argument("Invalid numeric command range");
            if (command.type == ValueType::Integer
                && (std::floor(command.minimum) != command.minimum
                    || std::floor(command.maximum) != command.maximum
                    || command.minimum < std::numeric_limits<std::int32_t>::min()
                    || command.maximum > std::numeric_limits<std::int32_t>::max()))
                throw std::invalid_argument("Invalid integer command range");
        }
        if (command.type == ValueType::Enumeration) {
            if (command.choices.empty()) throw std::invalid_argument("Empty enumeration");
            std::vector<std::int32_t> choices;
            for (const auto& choice : command.choices) {
                if (choice.label.empty()
                    || std::find(choices.begin(), choices.end(), choice.value.id) != choices.end())
                    throw std::invalid_argument("Missing or duplicate enumeration choice");
                choices.push_back(choice.value.id);
            }
        }
    }
    for (const auto& command : module.commands) {
        if (!command.releaseCommand) continue;
        const auto release = std::find_if(module.commands.begin(), module.commands.end(),
            [&](const auto& candidate) { return candidate.id == *command.releaseCommand; });
        if (release == module.commands.end()
            || one_ring::validate(*release, command.releaseValue) != Validation::Ok)
            throw std::invalid_argument("Invalid declared legato release");
    }
    modules_.push_back(std::move(module));
    ++revision_;
}

bool CommandRegistry::unregisterModule(const std::string& id)
{
    const auto found = std::find_if(modules_.begin(), modules_.end(),
                                    [&](const auto& item) { return item.id == id; });
    if (found == modules_.end()) return false;
    modules_.erase(found);
    ++revision_;
    return true;
}

const CommandDescriptor* CommandRegistry::find(const std::string& module,
                                               const std::string& command) const noexcept
{
    for (const auto& item : modules_) {
        if (item.id != module) continue;
        for (const auto& candidate : item.commands)
            if (candidate.id == command) return &candidate;
        return nullptr;
    }
    return nullptr;
}

Validation CommandRegistry::validate(const std::string& module, const std::string& command,
                                     const Value& value) const noexcept
{
    if (const auto* descriptor = find(module, command))
        return one_ring::validate(*descriptor, value);
    return std::any_of(modules_.begin(), modules_.end(), [&](const auto& item) {
        return item.id == module;
    }) ? Validation::UnknownCommand : Validation::UnknownModule;
}

} // namespace mlh::one_ring
