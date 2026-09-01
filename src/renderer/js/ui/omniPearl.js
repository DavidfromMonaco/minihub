/**
 * Omni Pearl controls - the markup half of `styles/omni-pearl.css`.
 *
 * These helpers build hardware-looking controls out of REAL form elements: a
 * pearl surface is drawn around a native `<select>` / `<input>`, never instead
 * of it. Keyboard, screen readers and the existing `change`/`input` handlers
 * keep working exactly as they did with a bare control - only the presentation
 * changes. Modules pass their own data attributes through `attrs`, so nothing
 * here knows about the arpeggiator (or any other module).
 *
 * CSP (`style-src 'self'`) forbids inline styles, so every value-dependent
 * geometry is an SVG attribute: knob arcs use `stroke-dasharray`, the pointer
 * uses `transform="rotate(...)"`. `syncKnob()` updates those same attributes
 * in place, which lets a module refresh a knob without re-rendering (and
 * without stealing focus from the control the user is operating).
 */
import { escapeHtml } from '../core/html.js';

// Knob geometry. 270 degrees of travel starting bottom-left, like the hardware.
const KNOB_CENTER = 29;
const KNOB_RADIUS = 26.5;
const KNOB_SWEEP = 270;
const KNOB_START_ANGLE = -135;
const KNOB_CIRCUMFERENCE = 2 * Math.PI * KNOB_RADIUS;
const KNOB_ARC_LENGTH = (KNOB_CIRCUMFERENCE * KNOB_SWEEP) / 360;

const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/** Fraction of a value inside an ordered option list (single option -> 0). */
export function knobFraction(index, count) {
  return count > 1 ? clamp01(index / (count - 1)) : 0;
}

export function knobArcDash(fraction) {
  return `${round(KNOB_ARC_LENGTH * clamp01(fraction))} ${round(KNOB_CIRCUMFERENCE)}`;
}

export function knobPointerTransform(fraction) {
  return `rotate(${round(KNOB_START_ANGLE + KNOB_SWEEP * clamp01(fraction))} ${KNOB_CENTER} ${KNOB_CENTER})`;
}

/**
 * A rotary control face. Purely presentational: the value is changed by the
 * native control the caller stacks over it (see `pearlKnobMount`).
 */
export function pearlKnob({ fraction = 0, display = '', small = false } = {}) {
  const value = display === '' ? '' : `<span class="op-knob-value" data-op-knob-display>${escapeHtml(display)}</span>`;
  return `<span class="op-knob${small ? ' op-knob--sm' : ''}" data-op-knob>
      <span class="op-knob-body"></span>
      <svg class="op-knob-svg" viewBox="0 0 58 58" aria-hidden="true" focusable="false">
        <circle class="op-knob-arc-track" cx="${KNOB_CENTER}" cy="${KNOB_CENTER}" r="${KNOB_RADIUS}"
          transform="rotate(135 ${KNOB_CENTER} ${KNOB_CENTER})" stroke-dasharray="${knobArcDash(1)}"></circle>
        <circle class="op-knob-arc" data-op-knob-arc cx="${KNOB_CENTER}" cy="${KNOB_CENTER}" r="${KNOB_RADIUS}"
          transform="rotate(135 ${KNOB_CENTER} ${KNOB_CENTER})" stroke-dasharray="${knobArcDash(fraction)}"></circle>
        <g class="op-knob-pointer" data-op-knob-pointer transform="${knobPointerTransform(fraction)}">
          <line x1="${KNOB_CENTER}" y1="13.5" x2="${KNOB_CENTER}" y2="20.5"></line>
        </g>
      </svg>${value}
    </span>`;
}

function optionList(options, value) {
  return options.map((option) => {
    const raw = option && typeof option === 'object' ? option : { value: option, label: option };
    return `<option value="${escapeHtml(raw.value)}"${String(raw.value) === String(value) ? ' selected' : ''}>${escapeHtml(raw.label ?? raw.value)}</option>`;
  }).join('');
}

function nativeSelect(options, value, attrs, ariaLabel, className) {
  return `<select class="${className}" aria-label="${escapeHtml(ariaLabel)}" ${attrs}>${optionList(options, value)}</select>`;
}

/**
 * Pearl selector. `variant: 'inline'` (default) lets the native select render
 * its own selected text inside the pearl box - nothing to keep in sync.
 */
export function pearlSelect({ options, value, attrs = '', ariaLabel = '', extraClass = '' } = {}) {
  return `<span class="op-select ${extraClass}">
      ${nativeSelect(options, value, attrs, ariaLabel, 'op-select-native')}
      <span class="op-select-chevron"></span>
    </span>`;
}

/**
 * Knob + native select mounted as one control: clicking the knob OR the value
 * box opens the real list. The displayed text is ours, so callers refresh it
 * with `syncKnobMount` after a change.
 */
export function pearlKnobMount({ options, value, attrs = '', ariaLabel = '', display = '', valueBox = '', small = false } = {}) {
  const fraction = knobFraction(options.findIndex((option) => String(option?.value ?? option) === String(value)), options.length);
  const box = valueBox === ''
    ? ''
    : `<span class="op-select op-select--value"><span class="op-select-text" data-op-knob-display>${escapeHtml(valueBox)}</span><span class="op-select-chevron"></span></span>`;
  return `<span class="op-knob-mount">
      ${pearlKnob({ fraction, display, small })}${box}
      ${nativeSelect(options, value, attrs, ariaLabel, 'op-native')}
    </span>`;
}

/** Tactile on/off switch wrapping a real checkbox. */
export function pearlSwitch({ checked = false, attrs = '', ariaLabel = '' } = {}) {
  return `<label class="op-switch">
      <input class="op-native" type="checkbox" aria-label="${escapeHtml(ariaLabel)}" ${checked ? 'checked' : ''} ${attrs}>
      <span class="op-switch-track"><span class="op-switch-thumb"></span></span>
    </label>`;
}

export function pearlIconButton({ svg, attrs = '', title = '', disabled = false, active = false } = {}) {
  return `<button type="button" class="op-iconbtn${active ? ' active' : ''}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabled ? ' disabled' : ''} ${attrs}>${svg}</button>`;
}

/**
 * Update a rendered knob in place (arc, pointer, printed value).
 *
 * Re-rendering the whole control strip would blur the `<select>` the user is
 * driving, which breaks arrow-key editing; this only touches attributes.
 */
export function syncKnobMount(mount, { fraction = 0, display = '' } = {}) {
  if (!mount) return false;
  const arc = mount.querySelector('[data-op-knob-arc]');
  if (arc) arc.setAttribute('stroke-dasharray', knobArcDash(fraction));
  const pointer = mount.querySelector('[data-op-knob-pointer]');
  if (pointer) pointer.setAttribute('transform', knobPointerTransform(fraction));
  const label = mount.querySelector('[data-op-knob-display]');
  if (label) label.textContent = display;
  return true;
}
