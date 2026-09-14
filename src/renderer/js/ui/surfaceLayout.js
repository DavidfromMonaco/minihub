/**
 * Give the control surface markup its geometry, once it is in the document.
 *
 * The split exists because of the CSP, not for taste: `style-src 'self'` drops
 * an inline `style` attribute without an error anywhere, so a position written
 * into the HTML string would simply not arrive, and the panel would stack every
 * control at the same corner. What CSP does not touch is the CSSOM -- setting
 * `element.style` from a script -- which is why `clipEditor.js` and
 * `sequencerModule.js` already read their own `data-*-pct` attributes back this
 * way. This is the third of them and the pattern is now worth its name.
 *
 * Idempotent, and safe on markup that carries no panel: every caller re-renders
 * by replacing `innerHTML`, so this runs again on each pass.
 *
 * It imports nothing, and that is why it is its own file. The markup comes from
 * `ui/miniLabControlSurface.js`, which reads the loaded profile the moment it is
 * imported; the bindings bar receives that markup already drawn and has no
 * profile to read.
 */
/** Below this a label is ink, not a word. */
const READABLE_PX = 6;

export function applyMiniLabSurfaceLayout(root, view = globalThis.window) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const within = (selector) => [
    ...(root.matches?.(selector) ? [root] : []),
    ...root.querySelectorAll(selector)
  ];
  for (const surface of within('[data-ml-aspect]')) {
    surface.style.aspectRatio = surface.dataset.mlAspect;
  }
  const crowded = [];
  for (const control of within('[data-ml-x-pct]')) {
    control.style.left = `${control.dataset.mlXPct}%`;
    control.style.top = `${control.dataset.mlYPct}%`;
    // Absent where nothing sits close enough to be crowded.
    if (control.dataset.mlMaxPct) crowded.push(control);
  }

  // What does not fit shrinks; what still does not fit at a readable size gives
  // up its text rather than showing a clipped word.
  //
  // `OCT −` cut to `OCT…` loses the half that tells the two octave buttons
  // apart, and a label rendered at 3px is the same loss with more ink. Below the
  // floor the body stays -- a box that is visible, clickable and still carries
  // its `aria-label`, with the toolbar naming whatever is selected. Measured in
  // one pass after the widths are set, since the shrink is proportional to how
  // much was over.
  for (const control of crowded) {
    // Measured BEFORE the width is capped: `text-overflow: ellipsis` makes a
    // clipped label report that it fits, so a panel measured after the cap
    // would find nothing to shrink and quietly show `OCT…` instead.
    const panel = control.closest?.('[data-ml-aspect]');
    const room = panel ? (panel.clientWidth * Number(control.dataset.mlMaxPct)) / 100 : 0;
    const wanted = control.scrollWidth;
    if (room && wanted && wanted > room) {
      const size = parseFloat(view?.getComputedStyle?.(control)?.fontSize) || 8;
      const fitted = (size * room) / wanted;
      if (fitted >= READABLE_PX) control.style.fontSize = `${fitted.toFixed(2)}px`;
      else control.classList?.add('ml-cramped');
    }
    control.style.maxWidth = `${control.dataset.mlMaxPct}%`;
  }
}
