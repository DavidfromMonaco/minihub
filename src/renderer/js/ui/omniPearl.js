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
import { clamp } from '../core/clamp.js';

// Knob geometry. 270 degrees of travel starting bottom-left, like the hardware.
const KNOB_CENTER = 29;
const KNOB_RADIUS = 26.5;
const KNOB_SWEEP = 270;
const KNOB_START_ANGLE = -135;
const KNOB_CIRCUMFERENCE = 2 * Math.PI * KNOB_RADIUS;
const KNOB_ARC_LENGTH = (KNOB_CIRCUMFERENCE * KNOB_SWEEP) / 360;

const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const clamp01 = (value) => clamp(Number(value) || 0, 0, 1);

/** Fraction of a value inside an ordered option list (single option -> 0). */
export function knobFraction(index, count) {
  return count > 1 ? clamp01(index / (count - 1)) : 0;
}

function knobArcDash(fraction) {
  return `${round(KNOB_ARC_LENGTH * clamp01(fraction))} ${round(KNOB_CIRCUMFERENCE)}`;
}

function knobPointerTransform(fraction) {
  return `rotate(${round(KNOB_START_ANGLE + KNOB_SWEEP * clamp01(fraction))} ${KNOB_CENTER} ${KNOB_CENTER})`;
}

/**
 * A rotary control face. Purely presentational: the value is changed by the
 * native control the caller stacks over it (see `pearlKnobMount`).
 */
function pearlKnob({ fraction = 0, display = '', small = false } = {}) {
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

// ---------- sequencer hardware (omni-pearl.css section 5) ----------

/** An LED: a dot, lit or not. */
export function pearlLed(on = false, attrs = '') {
  return `<span class="op-led${on ? ' is-on' : ''}" ${attrs}></span>`;
}

/**
 * A rubber key cap. `size` is one or more of 'lg', 'sq', 'sm', 'num', 'tall',
 * 'tab', 'word'; `state` is the look: 'lit' (orange), 'white' (the selected
 * one), 'pending', 'armed', 'dim' or ''. `led` puts an LED before the label, lit
 * when true, with `ledAttrs` on it for a page that lights it in place. `label`
 * is text and is escaped; `svg` is trusted markup.
 */
export function pearlKeycap({
  label = '', svg = '', size = '', state = '', led = null, ledAttrs = '', attrs = '', title = '', disabled = false,
  pressed = null
} = {}) {
  const sizes = String(size).split(/\s+/).filter(Boolean).map((name) => `op-keycap--${name}`);
  const classes = ['op-keycap', ...sizes, state ? `is-${state}` : ''].filter(Boolean).join(' ');
  const aria = pressed === null ? '' : ` aria-pressed="${pressed ? 'true' : 'false'}"`;
  const hint = title ? ` title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"` : '';
  return `<button type="button" class="${classes}"${hint}${aria}${disabled ? ' disabled' : ''} ${attrs}>${led === null ? '' : pearlLed(led, ledAttrs)}${svg}${escapeHtml(label)}</button>`;
}

/** A printed legend. With `attrs` it is a button: a position of a lever you can click. */
export function pearlLegend(text, { state = '', attrs = '', disabled = false } = {}) {
  const cls = `op-legend${state ? ` is-${state}` : ''}`;
  if (!attrs) return `<span class="${cls}">${escapeHtml(text)}</span>`;
  return `<button type="button" class="${cls}"${disabled ? ' disabled' : ''} ${attrs}>${escapeHtml(text)}</button>`;
}

/** An LCD readout, or an LCD field to type into when `input` is set. */
export function pearlLcd({ value = '', input = false, size = '', attrs = '', ariaLabel = '', dim = false, invalid = false, disabled = false } = {}) {
  const cls = ['op-lcd', size ? `op-lcd--${size}` : '', dim ? 'is-dim' : '', invalid ? 'is-invalid' : ''].filter(Boolean).join(' ');
  if (!input) return `<span class="${cls}" ${attrs}>${escapeHtml(value)}</span>`;
  return `<input type="text" class="${cls}" value="${escapeHtml(value)}" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(ariaLabel)}"${invalid ? ' aria-invalid="true"' : ''}${disabled ? ' disabled' : ''} ${attrs}>`;
}

/**
 * A scribble strip: what a channel is aimed at. `accent` is shown after the
 * text in the accent colour -- a value.
 */
export function pearlScribble(text, { empty = false, missing = false, accent = '', attrs = '', title = '' } = {}) {
  const cls = ['op-scribble', empty ? 'is-empty' : '', missing ? 'is-missing' : ''].filter(Boolean).join(' ');
  const hint = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="${cls}"${hint} ${attrs}><span class="op-scribble-text">${escapeHtml(text)}</span>${accent ? `<b>${escapeHtml(accent)}</b>` : ''}</span>`;
}

// A selector's positions sit on an arc round a 44 px knob.
const SELECTOR_CENTER = [58, 48];

/**
 * A rotary selector: a knob with its positions printed round it. A printed
 * position is clicked (`optionAttr` names the data attribute carrying its
 * value); the knob itself is a native `<select>`, for the keyboard and for a
 * list. `attrs` goes on that select.
 */
export function pearlSelector({ options, value, attrs = '', optionAttr, ariaLabel = '', disabled = false } = {}) {
  const [cx, cy] = SELECTOR_CENTER;
  const sweep = options.length > 5 ? 250 : 220;
  const angle = (i) => (options.length > 1 ? -sweep / 2 + (sweep * i) / (options.length - 1) : 0);
  const polar = (deg, radius) => [
    round(cx + radius * Math.sin((deg * Math.PI) / 180)),
    round(cy - radius * Math.cos((deg * Math.PI) / 180))
  ];
  const selected = Math.max(0, options.findIndex((option) => String(option.value) === String(value)));
  const marks = options.map((option, i) => {
    const a = angle(i);
    const [x1, y1] = polar(a, 25);
    const [x2, y2] = polar(a, 29);
    const [tx, ty] = polar(a, 38);
    const anchor = a < -25 ? 'end' : a > 25 ? 'start' : 'middle';
    const hitX = anchor === 'end' ? tx - 26 : anchor === 'start' ? tx - 2 : tx - 14;
    const on = i === selected ? ' is-on' : '';
    const hit = disabled ? '' : `<rect class="hit" x="${round(hitX)}" y="${round(ty - 7)}" width="28" height="15" ${optionAttr}="${escapeHtml(option.value)}"></rect>`;
    return `<line class="tick${on}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>${hit}
      <text class="${on.trim()}" x="${tx}" y="${round(ty + 3.2)}" text-anchor="${anchor}">${escapeHtml(option.label)}</text>`;
  }).join('');
  const [px, py] = polar(angle(selected), 15);
  const [qx, qy] = polar(angle(selected), 8);
  return `<span class="op-selector">
      <span class="op-knob"><span class="op-knob-body"></span></span>
      <svg class="op-selector-svg" viewBox="0 0 116 84" aria-hidden="true" focusable="false">${marks}
        <line class="pointer" x1="${qx}" y1="${qy}" x2="${px}" y2="${py}"></line></svg>
      ${nativeSelect(options, value, `${disabled ? 'disabled ' : ''}${attrs}`, ariaLabel, 'op-native')}
    </span>`;
}

/**
 * A knob turned by dragging up and down, or by the arrow keys: a `slider` role
 * on the knob itself, since a native range input drags sideways. `bipolar`
 * draws its arc from the top, for a value that goes both ways from zero.
 */
export function pearlDragKnob({ value, min, max, bipolar = false, attrs = '', ariaLabel = '', text = '' } = {}) {
  const fraction = max > min ? clamp01((value - min) / (max - min)) : 0;
  return `<span class="op-knob op-dragknob" role="slider" tabindex="0" aria-label="${escapeHtml(ariaLabel)}"
      aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}" aria-valuetext="${escapeHtml(text)}" ${attrs}>
      <span class="op-knob-body"></span>
      <svg class="op-knob-svg" viewBox="0 0 58 58" aria-hidden="true" focusable="false">
        <circle class="op-knob-arc-track" cx="${KNOB_CENTER}" cy="${KNOB_CENTER}" r="${KNOB_RADIUS}"
          transform="rotate(135 ${KNOB_CENTER} ${KNOB_CENTER})" stroke-dasharray="${knobArcDash(1)}"></circle>
        <circle class="op-knob-arc" data-op-knob-arc cx="${KNOB_CENTER}" cy="${KNOB_CENTER}" r="${KNOB_RADIUS}"
          ${knobArcAttributes(fraction, bipolar)}></circle>
        <g class="op-knob-pointer" data-op-knob-pointer transform="${knobPointerTransform(fraction)}">
          <line x1="${KNOB_CENTER}" y1="13.5" x2="${KNOB_CENTER}" y2="20.5"></line>
        </g>
      </svg>
    </span>`;
}

// A unipolar arc starts at the knob's minimum; a bipolar one at its top, and
// goes whichever way the value does. Nothing is drawn at zero: a dash of
// length zero still paints its round cap.
function knobArcAttributes(fraction, bipolar) {
  if (!bipolar) {
    const dash = fraction > 0 ? knobArcDash(fraction) : `0 ${round(KNOB_CIRCUMFERENCE)}`;
    return `transform="rotate(135 ${KNOB_CENTER} ${KNOB_CENTER})" stroke-dasharray="${dash}" visibility="${fraction > 0 ? 'visible' : 'hidden'}"`;
  }
  const span = Math.abs(fraction - 0.5);
  const start = fraction >= 0.5 ? 270 : 270 - KNOB_SWEEP * span;
  return `transform="rotate(${round(start)} ${KNOB_CENTER} ${KNOB_CENTER})" stroke-dasharray="${knobArcDash(span)}" visibility="${span > 0 ? 'visible' : 'hidden'}"`;
}

/** A drag knob moved in place: arc, pointer and what it says it holds. */
export function syncDragKnob(knob, { value, min, max, bipolar = false, text = '' } = {}) {
  if (!knob) return false;
  const fraction = max > min ? clamp01((value - min) / (max - min)) : 0;
  const arc = knob.querySelector('[data-op-knob-arc]');
  if (arc) {
    for (const [, name, attr] of knobArcAttributes(fraction, bipolar).matchAll(/([\w-]+)="([^"]*)"/g)) {
      arc.setAttribute(name, attr);
    }
  }
  knob.querySelector('[data-op-knob-pointer]')?.setAttribute('transform', knobPointerTransform(fraction));
  knob.setAttribute('aria-valuenow', String(value));
  knob.setAttribute('aria-valuetext', text);
  return true;
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

/**
 * The list a `<select>` opens, drawn by the page.
 *
 * WHY NOT THE ONE THE BROWSER DRAWS
 * ---------------------------------
 * A select's list is not part of the page: Chromium draws it in a window of its
 * own, and on Windows (Electron 43) that window is white whatever the page's
 * `color-scheme` says and whatever theme the application declares -- both were
 * tried. Over the graphite faceplate every menu opened as a white slab with
 * grey text. So the page draws the list itself.
 *
 * The `<select>` stays the control: it holds the value, keeps the keyboard it
 * always had, carries the module's `data-*` hooks and fires `change` as before.
 * Only its list is ours, built from its own options each time it opens, so a
 * module that renders a select renders nothing new.
 *
 * It covers the faceplate alone -- every select under `.omni-pearl`, whether it
 * sits in a pearl box, under a rotary selector or behind a knob -- and is bound
 * once, for the whole shell (app.js).
 */
export function bindPearlLists(root) {
  if (!root?.addEventListener) return () => {};
  const doc = root.ownerDocument ?? globalThis.document ?? root;
  let open = null;

  /** The faceplate select a press or a key is on, and the control it hangs from. */
  const selectAt = (target) => {
    const select = target?.closest?.('select');
    if (!select || !select.closest('.omni-pearl')) return null;
    return root.contains?.(select) === false ? null : select;
  };
  const anchorOf = (select) => select.closest('.op-select, .op-selector, .op-knob-mount');

  const close = () => {
    if (!open) return;
    open.box.classList.remove('is-open');
    open.list.remove();
    open = null;
  };

  const rowsOf = (list) => [...list.querySelectorAll('.op-list-row:not([disabled])')];

  const highlight = (row) => {
    if (!open || !row) return;
    for (const other of rowsOf(open.list)) other.classList.toggle('is-active', other === row);
    row.scrollIntoView?.({ block: 'nearest' });
  };

  const apply = (row) => {
    if (!open || !row) return;
    const { select } = open;
    const index = Number(row.dataset.opListIndex);
    close();
    if (!Number.isInteger(index) || select.selectedIndex === index) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /** The select's own options, groups and all, as rows of the page. */
  const build = (select) => {
    const list = doc.createElement('div');
    list.className = 'op-list';
    list.setAttribute('role', 'listbox');
    const add = (option) => {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'op-list-row';
      row.setAttribute('role', 'option');
      row.dataset.opListIndex = String(option.index);
      const chosen = option.index === select.selectedIndex;
      row.setAttribute('aria-selected', chosen ? 'true' : 'false');
      if (chosen) row.classList.add('is-selected');
      if (option.disabled) row.disabled = true;
      row.textContent = option.textContent;
      list.append(row);
    };
    for (const child of select.children) {
      if (child.tagName === 'OPTGROUP') {
        const label = doc.createElement('span');
        label.className = 'op-list-group';
        label.textContent = child.label;
        list.append(label);
        for (const option of child.children) add(option);
      } else if (child.tagName === 'OPTION') {
        add(child);
      }
    }
    return list;
  };

  const show = (select) => {
    const box = anchorOf(select);
    if (!box || select.disabled) return;
    if (open?.select === select) {
      close();
      return;
    }
    close();
    const list = build(select);
    box.append(list);
    box.classList.add('is-open');
    open = { select, box, list };
    highlight(list.querySelector('.op-list-row.is-selected') ?? rowsOf(list)[0]);
    select.focus?.({ preventScroll: true });
  };

  // A select opens the browser's list on a press and on some keys; the page
  // takes both and opens its own.
  const onPointerDown = (event) => {
    const select = selectAt(event.target);
    if (select) {
      event.preventDefault();
      show(select);
      return;
    }
    if (open && !event.target?.closest?.('.op-list')) close();
  };

  const onClick = (event) => {
    const row = event.target?.closest?.('.op-list-row');
    if (row && open?.list.contains(row)) {
      event.preventDefault();
      apply(row);
    }
  };

  const onKeyDown = (event) => {
    const select = selectAt(event.target);
    if (!select) return;
    const opening = event.key === 'Enter' || event.key === ' ' || event.key === 'F4'
      || (event.key === 'ArrowDown' && event.altKey);
    if (!open || open.select !== select) {
      if (!opening) return;
      event.preventDefault();
      show(select);
      return;
    }
    const rows = rowsOf(open.list);
    const at = rows.indexOf(open.list.querySelector('.op-list-row.is-active'));
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      apply(rows[at] ?? null);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      highlight(event.key === 'Home' ? rows[0] : rows.at(-1));
    }
  };

  // A redraw takes the open list with it; nothing is left pointing at it.
  const onFocusOut = () => {
    if (open && !open.select.isConnected) close();
  };

  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('click', onClick, true);
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('focusout', onFocusOut);
  return () => {
    close();
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('focusout', onFocusOut);
  };
}
