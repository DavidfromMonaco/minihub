export function selectNoteIds(current, noteId, { additive = false, toggle = true } = {}) {
  const next = additive ? new Set(current) : new Set();
  if (toggle && next.has(noteId)) next.delete(noteId);
  else next.add(noteId);
  return next;
}
