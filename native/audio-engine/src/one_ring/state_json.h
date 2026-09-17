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

// A node's material, as its content keeps it (part two): `{ origin, current,
// generation, frozen }`, each list `{ length, notes: [{ pitch, velocity,
// channel, start, duration }] }` in ticks, `current` null until feedback made
// one. Throws std::invalid_argument naming what it cannot read.
Material readMaterial(const juce::var& material);
juce::var writeMaterial(const Material& material);
// A note list as the content keeps it: `{ length, notes }`, in ticks.
juce::var writeNotes(const NoteList& list);
// A scene's four voices, as the content keeps them.
juce::var writeVoices(const std::array<VoiceRules, voiceCount>& voices);

// What a node's CTRL OUT is cabled to, as CommandBus publishes it:
// `{ version: 1, revision, modules: [{ id, label, commands: [...] }] }`.
// Throws std::invalid_argument on a malformed list, as the VST refuses one.
CommandRegistry readRegistry(const juce::var& registry);

} // namespace mlh::one_ring
