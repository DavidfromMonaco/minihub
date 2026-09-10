export function selectNoteIds(current, noteId, { additive = false, toggle = true } = {}) {
  const next = additive ? new Set(current) : new Set();
  if (toggle && next.has(noteId)) next.delete(noteId);
  else next.add(noteId);
  return next;
}

/**
 * Which notes a rubber band covers.
 *
 * Musical coordinates, not pixels: the same question at any zoom, and
 * testable without a DOM. Any overlap counts, and the band may be drawn in
 * either direction -- the caller passes the two corners it has, not a
 * normalised rectangle.
 *
 * The pitch bounds are inclusive because a pitch is a row, not a coordinate:
 * a band that touches the C4 row has selected the C4 row.
 */
export function notesInBox(notes, { startPpq = 0, endPpq = 0, fromPitch = 0, toPitch = 0 } = {}) {
  const left = Math.min(startPpq, endPpq);
  const right = Math.max(startPpq, endPpq);
  const low = Math.min(fromPitch, toPitch);
  const high = Math.max(fromPitch, toPitch);
  return (Array.isArray(notes) ? notes : [])
    .filter((note) => note
      && note.pitch >= low && note.pitch <= high
      && note.startPpq + note.durationPpq > left && note.startPpq < right)
    .map((note) => note.id);
}
