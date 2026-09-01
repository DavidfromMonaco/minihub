const SNAP_STEPS = Object.freeze({
  '1 bar': 4,
  '1/2': 2,
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
  '1/32': 0.125
});

export const TICKS_PER_QUARTER = 960;
export const QUANTIZE_GRIDS = Object.freeze({
  '1/4': TICKS_PER_QUARTER,
  '1/8': TICKS_PER_QUARTER / 2,
  '1/16': TICKS_PER_QUARTER / 4,
  '1/32': TICKS_PER_QUARTER / 8,
  '1/8 triplet': TICKS_PER_QUARTER / 3,
  '1/16 triplet': TICKS_PER_QUARTER / 6
});

const MIN_NOTE_PPQ = 0.03125;
const MIN_NOTE_TICKS = Math.round(MIN_NOTE_PPQ * TICKS_PER_QUARTER);
const MIN_CLIP_PPQ = 0.125;

export const SEQUENCER_LIMITS = Object.freeze({ tracks: 64, clipsPerTrack: 2048, notesPerClip: 65536 });

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));
const uid = (prefix) => globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function snapStep(value) {
  return SNAP_STEPS[value] || SNAP_STEPS['1/16'];
}

export function snapPpq(value, division = '1/16') {
  const step = snapStep(division);
  return Math.max(0, Math.round(finite(value) / step) * step);
}

export function ppqToTicks(value) {
  return Math.max(0, Math.round(finite(value) * TICKS_PER_QUARTER));
}

export function ticksToPpq(value) {
  return Math.max(0, Math.round(finite(value)) / TICKS_PER_QUARTER);
}

export function defaultSequencerState() {
  return {
    version: 1,
    tracks: [],
    loop: { enabled: false, startPpq: 0, endPpq: 16 },
    snap: '1/16',
    zoom: 72,
    scrollPpq: 0,
    selectedClipId: null,
    selectedClipIds: [],
    selectionAnchorClipId: null,
    focusedTrackId: null
  };
}

function normalizeNote(note, sourceLength) {
  const startPpq = clamp(note?.startPpq, 0, Math.max(0, sourceLength));
  return {
    id: typeof note?.id === 'string' && note.id ? note.id : uid('note'),
    pitch: Math.round(clamp(note?.pitch, 0, 127)),
    startPpq,
    durationPpq: clamp(note?.durationPpq, MIN_NOTE_PPQ, Math.max(MIN_NOTE_PPQ, sourceLength - startPpq)),
    velocity: Math.round(clamp(note?.velocity, 1, 127)),
    channel: Math.round(clamp(note?.channel, 1, 16))
  };
}

function normalizeClip(clip, type) {
  const startPpq = Math.max(0, finite(clip?.startPpq));
  const lengthPpq = Math.max(MIN_CLIP_PPQ, finite(clip?.lengthPpq, 4));
  const base = {
    id: typeof clip?.id === 'string' && clip.id ? clip.id : uid('clip'),
    name: String(clip?.name || (type === 'midi' ? 'MIDI Clip' : 'Audio Clip')).slice(0, 160),
    startPpq,
    lengthPpq,
    gain: clamp(finite(clip?.gain, 1), 0, 2)
  };
  if (type === 'midi') {
    base.sourceOffsetPpq = clamp(clip?.sourceOffsetPpq, 0, Math.max(0, finite(clip?.sourceLengthPpq, lengthPpq) - lengthPpq));
    base.sourceLengthPpq = Math.max(base.sourceOffsetPpq + lengthPpq, finite(clip?.sourceLengthPpq, lengthPpq));
    base.notes = Array.isArray(clip?.notes)
      ? clip.notes.slice(0, SEQUENCER_LIMITS.notesPerClip).map((note) => normalizeNote(note, base.sourceLengthPpq)).sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch)
      : [];
  } else {
    base.filePath = typeof clip?.filePath === 'string' ? clip.filePath : '';
    base.trimStartSeconds = Math.max(0, finite(clip?.trimStartSeconds));
    const fallbackEnd = base.trimStartSeconds + Math.max(0.001, finite(clip?.durationSeconds, 1));
    base.trimEndSeconds = Math.max(base.trimStartSeconds + 0.001, finite(clip?.trimEndSeconds, fallbackEnd));
    base.durationSeconds = Math.max(0.001, finite(clip?.durationSeconds, base.trimEndSeconds));
    base.peaks = Array.isArray(clip?.peaks) ? clip.peaks.slice(0, 512).map((p) => clamp(p, 0, 1)) : [];
  }
  return base;
}

function normalizeTrack(track, index) {
  const type = track?.type === 'audio' ? 'audio' : 'midi';
  return {
    id: typeof track?.id === 'string' && track.id ? track.id : uid('track'),
    type,
    name: String(track?.name || `${type === 'midi' ? 'MIDI' : 'Audio'} ${index + 1}`).slice(0, 120),
    armed: track?.armed === true,
    monitored: track?.monitored === true,
    muted: track?.muted === true,
    volume: clamp(finite(track?.volume, 1), 0, 2),
    inputId: typeof track?.inputId === 'string' ? track.inputId : '',
    outputId: typeof track?.outputId === 'string' ? track.outputId : '',
    clips: Array.isArray(track?.clips) ? track.clips.slice(0, SEQUENCER_LIMITS.clipsPerTrack).map((clip) => normalizeClip(clip, type)) : []
  };
}

export function normalizeSequencerState(value) {
  const base = defaultSequencerState();
  const loopStart = Math.max(0, finite(value?.loop?.startPpq));
  const loopEnd = Math.max(loopStart + 0.125, finite(value?.loop?.endPpq, 16));
  const tracks = Array.isArray(value?.tracks) ? value.tracks.slice(0, SEQUENCER_LIMITS.tracks).map(normalizeTrack) : [];
  const clipIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const requestedSelection = Array.isArray(value?.selectedClipIds)
    ? value.selectedClipIds
    : (typeof value?.selectedClipId === 'string' ? [value.selectedClipId] : []);
  const selectedClipIds = [...new Set(requestedSelection.filter((id) => typeof id === 'string' && clipIds.has(id)))];
  const requestedPrimary = typeof value?.selectedClipId === 'string' ? value.selectedClipId : '';
  const selectedClipId = selectedClipIds.includes(requestedPrimary)
    ? requestedPrimary : (selectedClipIds.at(-1) || null);
  const trackIds = new Set(tracks.map((track) => track.id));
  return {
    version: 1,
    tracks,
    loop: { enabled: value?.loop?.enabled === true, startPpq: loopStart, endPpq: loopEnd },
    snap: Object.hasOwn(SNAP_STEPS, value?.snap) ? value.snap : base.snap,
    zoom: clamp(value?.zoom, 24, 240),
    scrollPpq: Math.max(0, finite(value?.scrollPpq)),
    selectedClipId,
    selectedClipIds,
    selectionAnchorClipId: clipIds.has(value?.selectionAnchorClipId)
      ? value.selectionAnchorClipId : selectedClipId,
    focusedTrackId: trackIds.has(value?.focusedTrackId) ? value.focusedTrackId : null
  };
}

export class SequencerModel {
  constructor(state) {
    this.state = normalizeSequencerState(state);
  }

  _track(trackId) { return this.state.tracks.find((track) => track.id === trackId) || null; }
  _clip(clipId) {
    for (const track of this.state.tracks) {
      const clip = track.clips.find((item) => item.id === clipId);
      if (clip) return { track, clip };
    }
    return null;
  }

  _orderedClipIds() {
    return this.state.tracks.flatMap((track) => [...track.clips]
      .sort((a, b) => a.startPpq - b.startPpq || a.id.localeCompare(b.id))
      .map((clip) => clip.id));
  }

  selectedClipIds() {
    return this.state.selectedClipIds.filter((id) => this._clip(id));
  }

  isClipSelected(clipId) {
    return this.state.selectedClipIds.includes(clipId);
  }

  selectClip(clipId, { toggle = false, range = false, additive = false } = {}) {
    if (clipId === null) {
      this.state.selectedClipId = null;
      this.state.selectedClipIds = [];
      this.state.selectionAnchorClipId = null;
      return true;
    }
    if (!this._clip(clipId)) return false;
    const selected = new Set(this.selectedClipIds());
    if (range && this.state.selectionAnchorClipId && this._clip(this.state.selectionAnchorClipId)) {
      const ordered = this._orderedClipIds();
      const from = ordered.indexOf(this.state.selectionAnchorClipId);
      const to = ordered.indexOf(clipId);
      if (!additive) selected.clear();
      for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) selected.add(ordered[index]);
    } else if (toggle) {
      if (selected.has(clipId)) selected.delete(clipId);
      else selected.add(clipId);
      this.state.selectionAnchorClipId = clipId;
    } else {
      selected.clear();
      selected.add(clipId);
      this.state.selectionAnchorClipId = clipId;
    }
    this.state.selectedClipIds = [...selected];
    this.state.selectedClipId = selected.has(clipId) ? clipId : (this.state.selectedClipIds.at(-1) || null);
    return true;
  }

  focusTrack(trackId, { preserveArmed = false } = {}) {
    const track = this._track(trackId);
    if (!track) return null;
    this.state.focusedTrackId = track.id;
    if (track.type === 'midi' && !preserveArmed) {
      for (const item of this.state.tracks) if (item.type === 'midi') item.armed = item.id === track.id;
    }
    return track;
  }

  setTrackArmed(trackId, armed, { additive = false } = {}) {
    const track = this._track(trackId);
    if (!track) return null;
    if (track.type === 'midi' && armed === true && !additive) {
      for (const item of this.state.tracks) if (item.type === 'midi') item.armed = item.id === track.id;
    } else {
      track.armed = armed === true;
    }
    if (track.armed) this.state.focusedTrackId = track.id;
    return track;
  }

  addTrack(type = 'midi') {
    if (this.state.tracks.length >= SEQUENCER_LIMITS.tracks) return null;
    const normalizedType = type === 'audio' ? 'audio' : 'midi';
    const family = this.state.tracks.filter((track) => track.type === normalizedType).length + 1;
    const track = normalizeTrack({ id: uid('track'), type: normalizedType, name: `${normalizedType === 'midi' ? 'MIDI' : 'Audio'} ${family}`, volume: 1 }, this.state.tracks.length);
    this.state.tracks.push(track);
    return track;
  }

  removeTrack(trackId) {
    const index = this.state.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) return false;
    const removed = this.state.tracks[index];
    this.state.tracks.splice(index, 1);
    const removedIds = new Set(removed.clips.map((clip) => clip.id));
    this.state.selectedClipIds = this.state.selectedClipIds.filter((id) => !removedIds.has(id));
    if (removedIds.has(this.state.selectedClipId)) this.state.selectedClipId = this.state.selectedClipIds.at(-1) || null;
    if (removedIds.has(this.state.selectionAnchorClipId)) this.state.selectionAnchorClipId = this.state.selectedClipId;
    if (this.state.focusedTrackId === trackId) this.state.focusedTrackId = null;
    return true;
  }

  updateTrack(trackId, changes = {}) {
    const track = this._track(trackId);
    if (!track) return null;
    if ('name' in changes) track.name = String(changes.name || track.name).slice(0, 120);
    if ('armed' in changes) track.armed = changes.armed === true;
    if ('monitored' in changes) track.monitored = changes.monitored === true;
    if ('muted' in changes) track.muted = changes.muted === true;
    if ('volume' in changes) track.volume = clamp(changes.volume, 0, 2);
    if ('inputId' in changes) track.inputId = String(changes.inputId || '');
    if ('outputId' in changes) track.outputId = String(changes.outputId || '');
    return track;
  }

  addMidiClip(trackId, startPpq = 0, lengthPpq = 4, notes = []) {
    const track = this._track(trackId);
    if (!track || track.type !== 'midi' || track.clips.length >= SEQUENCER_LIMITS.clipsPerTrack) return null;
    const clip = normalizeClip({ id: uid('clip'), startPpq: snapPpq(startPpq, this.state.snap), lengthPpq, notes }, 'midi');
    track.clips.push(clip);
    this.selectClip(clip.id);
    return clip;
  }

  addAudioClip(trackId, clipData = {}) {
    const track = this._track(trackId);
    if (!track || track.type !== 'audio' || track.clips.length >= SEQUENCER_LIMITS.clipsPerTrack) return null;
    const clip = normalizeClip({ id: uid('clip'), ...clipData, startPpq: snapPpq(clipData.startPpq || 0, this.state.snap) }, 'audio');
    track.clips.push(clip);
    this.selectClip(clip.id);
    return clip;
  }

  moveClip(clipId, startPpq, targetTrackId = null) {
    const found = this._clip(clipId);
    if (!found) return false;
    if (targetTrackId && targetTrackId !== found.track.id) {
      const target = this._track(targetTrackId);
      if (!target || target.type !== found.track.type || target.clips.length >= SEQUENCER_LIMITS.clipsPerTrack) return false;
      found.track.clips.splice(found.track.clips.indexOf(found.clip), 1);
      target.clips.push(found.clip);
      found.track = target;
    }
    found.clip.startPpq = snapPpq(startPpq, this.state.snap);
    return true;
  }

  clipPlacements(clipIds = this.selectedClipIds()) {
    const wanted = new Set(Array.isArray(clipIds) ? clipIds : []);
    return this.state.tracks.flatMap((track, trackIndex) => track.clips
      .filter((clip) => wanted.has(clip.id))
      .map((clip) => ({
        clipId: clip.id,
        trackId: track.id,
        trackIndex,
        type: track.type,
        startPpq: clip.startPpq,
        clip: structuredClone(clip)
      })));
  }

  moveClips(clipIds, deltaPpq, targetTrackId = null, { anchorClipId = null, origins = null } = {}) {
    const ids = [...new Set(Array.isArray(clipIds) ? clipIds : [])];
    if (!ids.length) return false;
    const source = Array.isArray(origins) && origins.length ? origins : this.clipPlacements(ids);
    if (source.length !== ids.length) return false;
    const anchor = source.find((item) => item.clipId === anchorClipId) || source[0];
    const anchorTarget = targetTrackId ? this._track(targetTrackId) : this._track(anchor.trackId);
    if (!anchorTarget || anchorTarget.type !== anchor.type) return false;
    const targetAnchorIndex = this.state.tracks.indexOf(anchorTarget);
    const verticalDelta = targetAnchorIndex - anchor.trackIndex;
    const desiredAnchorStart = snapPpq(anchor.startPpq + finite(deltaPpq), this.state.snap);
    const minimumStart = Math.min(...source.map((item) => item.startPpq));
    const commonDelta = Math.max(-minimumStart, desiredAnchorStart - anchor.startPpq);
    const moves = [];
    for (const item of source) {
      const found = this._clip(item.clipId);
      const target = this.state.tracks[item.trackIndex + verticalDelta];
      if (!found || !target || target.type !== item.type) return false;
      moves.push({ found, target, startPpq: item.startPpq + commonDelta });
    }
    const selected = new Set(ids);
    for (const target of this.state.tracks) {
      const staying = target.clips.filter((clip) => !selected.has(clip.id)).length;
      const incoming = moves.filter((move) => move.target === target).length;
      if (staying + incoming > SEQUENCER_LIMITS.clipsPerTrack) return false;
    }
    const before = JSON.stringify(moves.map(({ found }) => [found.track.id, found.clip.startPpq]));
    for (const { found } of moves) found.track.clips.splice(found.track.clips.indexOf(found.clip), 1);
    for (const { found, target, startPpq } of moves) {
      found.clip.startPpq = startPpq;
      target.clips.push(found.clip);
      found.track = target;
    }
    return before !== JSON.stringify(moves.map(({ found }) => [found.track.id, found.clip.startPpq]));
  }

  restoreClipPlacements(origins = []) {
    if (!Array.isArray(origins) || !origins.length) return false;
    const restored = [];
    for (const origin of origins) {
      const found = this._clip(origin.clipId);
      const target = this._track(origin.trackId);
      if (!found || !target || target.type !== origin.type) return false;
      restored.push({ found, target, origin });
    }
    for (const { found } of restored) found.track.clips.splice(found.track.clips.indexOf(found.clip), 1);
    for (const { found, target, origin } of restored) {
      Object.assign(found.clip, structuredClone(origin.clip));
      target.clips.push(found.clip);
    }
    return true;
  }

  resizeClip(clipId, valuePpq, edge = 'end', { bpm = 120 } = {}) {
    const found = this._clip(clipId);
    if (!found) return false;
    const step = snapStep(this.state.snap);
    const tempo = clamp(bpm, 20, 300);
    if (edge === 'start') {
      const oldEnd = found.clip.startPpq + found.clip.lengthPpq;
      let nextStart = Math.max(0, Math.min(oldEnd - step, snapPpq(valuePpq, this.state.snap)));
      const delta = nextStart - found.clip.startPpq;
      if (found.track.type === 'midi') {
        const nextOffset = found.clip.sourceOffsetPpq + delta;
        if (nextOffset < 0) nextStart += -nextOffset;
        found.clip.sourceOffsetPpq = Math.max(0, found.clip.sourceOffsetPpq + (nextStart - found.clip.startPpq));
      } else {
        const secondsDelta = delta * 60 / tempo;
        const nextTrim = found.clip.trimStartSeconds + secondsDelta;
        if (nextTrim < 0) nextStart += -nextTrim * tempo / 60;
        if (nextTrim >= found.clip.trimEndSeconds - 0.001) nextStart -= (nextTrim - (found.clip.trimEndSeconds - 0.001)) * tempo / 60;
        found.clip.trimStartSeconds = clamp(
          found.clip.trimStartSeconds + (nextStart - found.clip.startPpq) * 60 / tempo,
          0,
          Math.max(0, found.clip.trimEndSeconds - 0.001)
        );
      }
      found.clip.startPpq = nextStart;
      found.clip.lengthPpq = oldEnd - nextStart;
    } else {
      let snapped = Math.max(step, snapPpq(valuePpq, this.state.snap));
      if (found.track.type === 'midi') {
        found.clip.sourceLengthPpq = Math.max(found.clip.sourceLengthPpq, found.clip.sourceOffsetPpq + snapped);
      } else {
        const availablePpq = Math.max(step, (found.clip.durationSeconds - found.clip.trimStartSeconds) * tempo / 60);
        snapped = Math.min(snapped, availablePpq);
        found.clip.trimEndSeconds = Math.min(found.clip.durationSeconds, found.clip.trimStartSeconds + snapped * 60 / tempo);
      }
      found.clip.lengthPpq = snapped;
    }
    return true;
  }

  addMidiNote(clipId, note = {}) {
    const found = this._clip(clipId);
    if (!found || found.track.type !== 'midi' || found.clip.notes.length >= SEQUENCER_LIMITS.notesPerClip) return null;
    const startBound = found.clip.sourceOffsetPpq;
    const endBound = startBound + found.clip.lengthPpq;
    const startPpq = clamp(note.startPpq, startBound, Math.max(startBound, endBound - MIN_NOTE_PPQ));
    const normalized = normalizeNote({ ...note, id: uid('note'), startPpq }, endBound);
    normalized.durationPpq = clamp(note.durationPpq, MIN_NOTE_PPQ, Math.max(MIN_NOTE_PPQ, endBound - startPpq));
    found.clip.notes.push(normalized);
    found.clip.notes.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
    return normalized;
  }

  updateMidiNote(clipId, noteId, changes = {}) {
    const found = this._clip(clipId);
    if (!found || found.track.type !== 'midi' || !changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
    const note = found.clip.notes.find((item) => item.id === noteId);
    if (!note) return null;
    const startBound = found.clip.sourceOffsetPpq;
    const endBound = startBound + found.clip.lengthPpq;
    if ('startPpq' in changes) note.startPpq = clamp(changes.startPpq, startBound, Math.max(startBound, endBound - MIN_NOTE_PPQ));
    if ('durationPpq' in changes) note.durationPpq = clamp(changes.durationPpq, MIN_NOTE_PPQ, Math.max(MIN_NOTE_PPQ, endBound - note.startPpq));
    if ('pitch' in changes) note.pitch = Math.round(clamp(changes.pitch, 0, 127));
    if ('velocity' in changes) note.velocity = Math.round(clamp(changes.velocity, 1, 127));
    if ('channel' in changes) note.channel = Math.round(clamp(changes.channel, 1, 16));
    found.clip.notes.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
    return note;
  }

  removeMidiNotes(clipId, noteIds = []) {
    const found = this._clip(clipId);
    if (!found || found.track.type !== 'midi' || !Array.isArray(noteIds)) return 0;
    const ids = new Set(noteIds.filter((id) => typeof id === 'string'));
    const before = found.clip.notes.length;
    found.clip.notes = found.clip.notes.filter((note) => !ids.has(note.id));
    return before - found.clip.notes.length;
  }

  updateAudioClip(clipId, changes = {}, { bpm = 120 } = {}) {
    const found = this._clip(clipId);
    if (!found || found.track.type !== 'audio' || !changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
    const duration = Math.max(0.001, finite(found.clip.durationSeconds, 0.001));
    if ('trimStartSeconds' in changes) {
      found.clip.trimStartSeconds = clamp(changes.trimStartSeconds, 0, Math.max(0, found.clip.trimEndSeconds - 0.001));
    }
    if ('trimEndSeconds' in changes) {
      found.clip.trimEndSeconds = clamp(changes.trimEndSeconds, found.clip.trimStartSeconds + 0.001, duration);
    }
    if ('gain' in changes) found.clip.gain = clamp(changes.gain, 0, 2);
    const tempo = clamp(bpm, 20, 300);
    found.clip.lengthPpq = Math.max(MIN_CLIP_PPQ, (found.clip.trimEndSeconds - found.clip.trimStartSeconds) * tempo / 60);
    return found.clip;
  }

  quantizeMidiClip(clipId, {
    grid = '1/16', strength = 100, scope = 'entire', selectedNoteIds = [], timing = 'starts'
  } = {}) {
    const found = this._clip(clipId);
    const gridTicks = QUANTIZE_GRIDS[grid];
    if (!found || found.track.type !== 'midi' || !gridTicks) return 0;
    const amount = Math.round(clamp(strength, 0, 100));
    const lower = ppqToTicks(found.clip.sourceOffsetPpq);
    const upper = ppqToTicks(found.clip.sourceOffsetPpq + found.clip.lengthPpq);
    const selected = new Set(Array.isArray(selectedNoteIds) ? selectedNoteIds : []);
    const notes = found.clip.notes.filter((note) => {
      const noteStart = ppqToTicks(note.startPpq);
      const noteEnd = noteStart + Math.max(MIN_NOTE_TICKS, ppqToTicks(note.durationPpq));
      const isVisible = noteEnd > lower && noteStart < upper;
      const hasEditableEndpoint = timing === 'starts+ends'
        ? ((noteStart >= lower && noteStart < upper) || (noteEnd > lower && noteEnd <= upper))
        : (noteStart >= lower && noteStart < upper);
      return isVisible && hasEditableEndpoint && (scope !== 'selected' || selected.has(note.id));
    });
    if (!notes.length) return 0;
    if (amount === 0) return 0;
    const interpolate = (original, target) => Math.round(original + (target - original) * amount / 100);
    // Notes are stored in the clip's non-destructive source domain. Quantize
    // relative to the visible clip boundary so a trimmed clip's beat zero
    // remains the Piano Roll grid origin.
    const quantized = (tick) => lower + Math.round((tick - lower) / gridTicks) * gridTicks;
    for (const note of notes) {
      const originalStart = ppqToTicks(note.startPpq);
      const originalDurationPpq = note.durationPpq;
      const originalDuration = Math.max(MIN_NOTE_TICKS, ppqToTicks(note.durationPpq));
      const originalEnd = originalStart + originalDuration;
      const startVisible = originalStart >= lower && originalStart < upper;
      const endVisible = originalEnd > lower && originalEnd <= upper;
      const sourceUpper = ppqToTicks(found.clip.sourceLengthPpq);
      let nextStart = originalStart;
      if (startVisible) {
        nextStart = interpolate(originalStart, quantized(originalStart));
        nextStart = clamp(nextStart, lower, Math.min(upper - MIN_NOTE_TICKS, sourceUpper - originalDuration));
      }
      if (timing === 'starts+ends') {
        let nextEnd = originalEnd;
        if (endVisible) nextEnd = interpolate(originalEnd, quantized(originalEnd));
        if (startVisible) nextStart = clamp(nextStart, lower, nextEnd - MIN_NOTE_TICKS);
        if (endVisible) nextEnd = clamp(nextEnd, nextStart + MIN_NOTE_TICKS, upper);
        note.startPpq = ticksToPpq(nextStart);
        note.durationPpq = ticksToPpq(nextEnd - nextStart);
      } else {
        note.startPpq = ticksToPpq(nextStart);
        // Starts-only is explicitly duration preserving. Retain the exact
        // canonical duration. Trimming is only a playback window and therefore
        // never makes a hidden source tail destructive or illegal.
        note.durationPpq = originalDurationPpq;
      }
    }
    found.clip.notes.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
    return notes.length;
  }

  duplicateClip(clipId) {
    return this.duplicateClips([clipId])?.[0] || null;
  }

  copyClips(clipIds = this.selectedClipIds()) {
    const placements = this.clipPlacements(clipIds);
    if (!placements.length) return null;
    return {
      version: 1,
      originStartPpq: Math.min(...placements.map((item) => item.startPpq)),
      originEndPpq: Math.max(...placements.map((item) => item.startPpq + item.clip.lengthPpq)),
      clips: placements.map((item) => ({
        trackId: item.trackId,
        trackIndex: item.trackIndex,
        type: item.type,
        startPpq: item.startPpq,
        clip: structuredClone(item.clip)
      }))
    };
  }

  pasteClips(payload, startPpq = 0) {
    if (!payload || !Array.isArray(payload.clips) || !payload.clips.length) return [];
    const originStart = finite(payload.originStartPpq,
      Math.min(...payload.clips.map((item) => finite(item.startPpq))));
    const delta = snapPpq(startPpq, this.state.snap) - originStart;
    const pending = [];
    for (const item of payload.clips) {
      let track = this._track(item.trackId);
      if (!track || track.type !== item.type) {
        track = this.state.tracks[item.trackIndex]?.type === item.type
          ? this.state.tracks[item.trackIndex]
          : this.state.tracks.find((candidate) => candidate.type === item.type);
      }
      if (!track) return [];
      pending.push({ track, item });
    }
    for (const track of new Set(pending.map((item) => item.track))) {
      if (track.clips.length + pending.filter((item) => item.track === track).length > SEQUENCER_LIMITS.clipsPerTrack) return [];
    }
    const copies = [];
    for (const { track, item } of pending) {
      const copy = normalizeClip({ ...structuredClone(item.clip), startPpq: Math.max(0, item.startPpq + delta) }, track.type);
      copy.id = uid('clip');
      copy.name = `${item.clip.name} Copy`;
      if (copy.notes) copy.notes = copy.notes.map((note) => ({ ...note, id: uid('note') }));
      track.clips.push(copy);
      copies.push(copy);
    }
    this.state.selectedClipIds = copies.map((clip) => clip.id);
    this.state.selectedClipId = this.state.selectedClipIds.at(-1) || null;
    this.state.selectionAnchorClipId = this.state.selectedClipIds[0] || null;
    return copies;
  }

  duplicateClips(clipIds = this.selectedClipIds()) {
    const payload = this.copyClips(clipIds);
    if (!payload) return [];
    const span = Math.max(snapStep(this.state.snap), payload.originEndPpq - payload.originStartPpq);
    return this.pasteClips(payload, payload.originStartPpq + span);
  }

  removeClip(clipId) {
    const found = this._clip(clipId);
    if (!found) return false;
    found.track.clips.splice(found.track.clips.indexOf(found.clip), 1);
    this.state.selectedClipIds = this.state.selectedClipIds.filter((id) => id !== clipId);
    if (this.state.selectedClipId === clipId) this.state.selectedClipId = this.state.selectedClipIds.at(-1) || null;
    if (this.state.selectionAnchorClipId === clipId) this.state.selectionAnchorClipId = this.state.selectedClipId;
    return true;
  }

  removeClips(clipIds = this.selectedClipIds()) {
    const ids = [...new Set(Array.isArray(clipIds) ? clipIds : [])];
    let removed = 0;
    for (const id of ids) if (this.removeClip(id)) removed += 1;
    return removed;
  }

  setLoop(changes = {}) {
    const next = { ...this.state.loop, ...changes };
    next.startPpq = snapPpq(next.startPpq, this.state.snap);
    next.endPpq = Math.max(next.startPpq + snapStep(this.state.snap), snapPpq(next.endPpq, this.state.snap));
    next.enabled = next.enabled === true;
    this.state.loop = next;
    return next;
  }

  compositionEndPpq() {
    return Math.max(4, ...this.state.tracks.flatMap((track) => track.clips.map((clip) => clip.startPpq + clip.lengthPpq)));
  }

  arrangementEndPpq() {
    return Math.max(0, ...this.state.tracks.flatMap((track) => track.clips.map((clip) => clip.startPpq + clip.lengthPpq)));
  }

  snapshot() { return normalizeSequencerState(structuredClone(this.state)); }
}

export { SNAP_STEPS };
