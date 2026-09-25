import { isTextEditingTarget } from './historyKeys.js';

/**
 * Space starts the transport, and stops it -- on every page of the shell, as
 * in every workstation. Asked by the author on 2026-09-25.
 *
 * It is the header's Play and Stop, not its Play and Pause: a Stop also ends a
 * take and stops the One Rings, and the arrangement stays where it stopped
 * either way (`SequencerController._halt`), so pressed twice it plays on from
 * there.
 *
 * WHAT IT LEAVES ALONE
 * --------------------
 * A caret: a space typed in a name is a space. A `<select>`: Space opens its
 * list, which is how the keyboard reaches one. And a keystroke a control has
 * already taken (`defaultPrevented`) -- the faceplate's drawn selects open on
 * Space the way the native ones do.
 *
 * A focused button is NOT left alone, and that is the point: after a click on
 * Play the focus sits on Play, and Space would press it a second time on top
 * of this. The browser presses a button on the key's RELEASE, so the release
 * that follows a Space taken here is swallowed.
 */

/** Is this keystroke the transport's Space? */
export function isTransportSpace(event) {
  if (!event || event.defaultPrevented) return false;
  if (event.key !== ' ' && event.code !== 'Space') return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return false;
  const target = event.target;
  if (isTextEditingTarget(target)) return false;
  if (String(target?.tagName || '').toLowerCase() === 'select') return false;
  return true;
}

export function installTransportKeys(hub, { target = globalThis.window } = {}) {
  if (!target?.addEventListener) return () => {};
  let swallowRelease = false;
  const onKeyDown = (event) => {
    if (!isTransportSpace(event)) return;
    const seq = hub.sequencer;
    if (!seq) return;
    event.preventDefault();
    swallowRelease = true;
    if (seq.playing || seq.recording || seq.preCounting) seq.stopTransport();
    else seq.playTransport();
  };
  const onKeyUp = (event) => {
    if (!swallowRelease || (event.key !== ' ' && event.code !== 'Space')) return;
    swallowRelease = false;
    event.preventDefault();
  };
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp, true);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp, true);
  };
}
