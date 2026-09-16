#pragma once

// One Ring's sequence and targets as they arrive from the renderer.

#include "model.h"

#include <juce_core/juce_core.h>

namespace mlh::one_ring {

// A sequence as the renderer keeps it: One Ring 0.4's saved state, version 1.
// A channel's 64 cells come either whole, as the VST writes them, or as only the
// cells that differ from the channel's `blank`, each carrying its `index` -- a
// whole state is about 700 KB, too much for every edit. Throws
// std::invalid_argument naming what it cannot read.
Project readProject(const juce::var& state);

// What a node's CTRL OUT is cabled to, as CommandBus publishes it:
// `{ version: 1, revision, modules: [{ id, label, commands: [...] }] }`.
// Throws std::invalid_argument on a malformed list, as the VST refuses one.
CommandRegistry readRegistry(const juce::var& registry);

} // namespace mlh::one_ring
