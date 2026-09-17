/**
 * Home line icons.
 *
 * One glyph per Home card, plus the arrow that says a link leaves MiniHub.
 * They share one language:
 * a 24-unit box, round caps, a single stroke weight, and `var(--home-accent)`
 * for the ink -- the card sets that variable, so a card's colour is decided in
 * one place (`base.css`) rather than inside the drawing.
 *
 * Inline SVG rather than image files: these are four shapes of a few hundred
 * bytes that must follow the accent colour and stay crisp at any zoom, which is
 * exactly what an <img> cannot do.
 */

const icon = (inner) =>
  `<svg class="home-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;

/** NEW -- a fresh page, with the plus sitting clear of its corner. */
export function newIcon() {
  return icon(`<g class="home-icon-ink">
    <path d="M5.5 3.5 H13.2 L17.5 7.8 V12.5"/>
    <path d="M5.5 3.5 V20.5 H12"/>
    <path d="M12.9 3.7 V8.1 H17.3"/>
    <path d="M17.2 15 V21.4 M14 18.2 H20.4"/>
  </g>`);
}

/** CURRENT PROJECT -- a page already written on. */
export function currentIcon() {
  return icon(`<g class="home-icon-ink">
    <path d="M5.5 3.5 H13.2 L18.5 8.8 V20.5 H5.5 Z"/>
    <path d="M12.9 3.7 V9 H18.3"/>
    <path d="M8.6 12.6 H15.4 M8.6 15.6 H15.4 M8.6 18.4 H13"/>
  </g>`);
}

/** LOAD -- an archive box, lid on, waiting to be opened. */
export function loadIcon() {
  return icon(`<g class="home-icon-ink">
    <path d="M3.6 5.6 H20.4 V10 H3.6 Z"/>
    <path d="M5.2 10 V19.6 H18.8 V10"/>
    <path d="M10 13.6 H14"/>
  </g>`);
}

/** TEMPLATES -- four identical cells, which is what a template is. */
export function templatesIcon() {
  return icon(`<g class="home-icon-ink">
    <rect x="3.7" y="3.7" width="7" height="7" rx="1.4"/>
    <rect x="13.3" y="3.7" width="7" height="7" rx="1.4"/>
    <rect x="3.7" y="13.3" width="7" height="7" rx="1.4"/>
    <rect x="13.3" y="13.3" width="7" height="7" rx="1.4"/>
  </g>`);
}

/**
 * The arrow on a button that opens the browser. It is drawn rather than written
 * as a character because the label already carries the host name, and a glyph
 * that changed with the system font would make that row ragged.
 */
export function departureArrow() {
  return `<svg class="home-departure" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M8 16 L16 8 M10 8 H16 V14"/>
  </svg>`;
}
