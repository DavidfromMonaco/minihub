# Tasks in progress

Only work that has started and is not finished. **When a task is finished,
delete its entry**, in the same commit. Nothing else belongs here: what was
done lives in git and [ROADMAP.md](ROADMAP.md), and so does what has never been
started.

## Started, not finished

**An agent drives MiniHub from outside — in test, not pushed** — works end to
end (patches, plugins, notes, save, export, Splice's web page, quit). Its
commits stay local while the author tests it.
Plan: [plans/done/agent-channel.md](plans/done/agent-channel.md) (standby while
the author tests).
- Not seen yet: a Codex session starting from the session rules and the first
  session note in `../minihub-agent/` (applied 2026-09-13).
- Unexplained: Splice's Expression reads 0.85 through `parameters` while the
  saved plugin state holds 1.0.
- Not seen yet: Splice keeping its login across a restart, now that MiniHub
  launches outside Codex.
- Optional: an MCP wrapper, so Codex calls requests as tools.
- Gap: `set-binding` plugs no cable (Learn does, since 2026-09-14) and does not
  redraw an open bindings bar.

**Learning a knob in one window: the bindings bar docked under the plugin
editor** — 7 of 8 steps. The bar opens under every plugin window, follows it,
and arms Learn on any knob, cabled or not: the capture plugs the cable in the
Patch Bay, Clear unplugs it. A bound knob or fader shows where its parameter
stands and moves it under the mouse. Since 2026-09-15 it is the only place a
knob is learned: the VST node's page has no bindings panel any more. Seen with
Dexed. Left: the documents.
- Not seen yet: a capture from the bar, and the cable it plugs (it needs a
  gesture in the plugin).
- Not seen yet: the drawn knob following the plugin's own knob, or the MiniLab's.
- Found, not fixed: every Ctrl+Z empties the bindings of every VST node (their
  cables stay), and undoing a VST node's deletion brings its plugins back under
  new ids with no bindings. The restore copies a node's content the way
  Duplicate does.
- Found, not fixed: a binding whose plugin failed to load is drawn as mapped, as
  if it worked.
Plan: [plans/active/bindings-bar-docked.md](plans/active/bindings-bar-docked.md).

**The Patch Bay's context menus** — still hand-built in `routingModule.js`;
`ui/contextMenu.js` exists and only the sequencer uses it.
