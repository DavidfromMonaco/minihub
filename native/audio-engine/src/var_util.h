#pragma once

#include <juce_core/juce_core.h>

namespace mlh {

/** Create a new empty JSON object var. */
inline juce::var makeObject()
{
    return juce::var(new juce::DynamicObject());
}

/** Set a property on a var object (creating the object if needed). */
inline void setProp(juce::var& obj, const char* name, const juce::var& value)
{
    if (obj.getDynamicObject() == nullptr)
        obj = makeObject();
    obj.getDynamicObject()->setProperty(juce::Identifier(name), value);
}

} // namespace mlh
