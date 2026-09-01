/**
 * Home card vector pictograms.
 *
 * Lightweight inline-SVG illustrations for the four Home project tiles. They
 * share one visual language: thick rounded strokes, off-white main ink (via
 * `currentColor`), and a single accent color per scene (via the `--hp-accent`
 * CSS variable set by the tile). Each scene is a self-contained SVG string, so
 * no external image assets or graphics library are needed and the artwork stays
 * crisp at any size.
 */

const VIEWBOX = '0 0 200 130';

function svg(inner) {
  return `<svg class="home-pictogram" viewBox="${VIEWBOX}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/**
 * NEW — a long-neck dinosaur turning its head toward a giant incoming meteor.
 * Accent: orange.
 */
export function newPictogram() {
  return svg(`
    <g class="hp-line">
      <path d="M12 118 H168"/>
      <path d="M42 117 C45 110 46 104 45 96 C34 84 32 67 36 52 C39 40 47 29 57 27 C65 26 71 30 72 35 C73 40 69 44 63 44 C58 43 55 46 54 52 C52 60 55 67 61 70 C66 73 72 68 82 67 C101 65 115 75 126 88 C137 101 148 109 162 112 C169 114 171 118 163 118 H132"/>
      <path d="M61 70 C74 74 84 84 92 96"/>
      <path d="M51 93 L50 117 H67 L71 93"/>
      <path d="M91 96 L91 117 H109 L108 82"/>
      <circle cx="63" cy="34" r="1.8" fill="currentColor" stroke="none"/>
    </g>
    <g class="hp-accent">
      <path d="M133 20 C143 13 157 15 165 24 C174 34 173 49 164 58 C155 67 140 68 130 60 C119 52 117 38 124 28 C126 25 129 22 133 20 Z"/>
      <path d="M151 17 L190 3 L163 29"/>
      <path d="M168 32 L192 20 L170 45"/>
      <path d="M138 31 C141 28 146 30 146 34 C146 38 141 40 138 37"/>
      <circle cx="156" cy="48" r="5"/>
      <circle cx="135" cy="52" r="3"/>
      <path d="M84 37 V49 M84 57 V58"/>
    </g>
  `);
}

/**
 * LAST / RECENT PROJECT — several stored projects lined up, with the most recent
 * one highlighted and a mechanical picker lifting it. Accent: blue.
 */
export function recentPictogram() {
  return svg(`
    <g class="hp-line">
      <path d="M8 118 H192"/>
      <path d="M12 76 H29 L38 85 V116 H12 Z M29 76 V85 H38"/>
      <path d="M18 91 H30 M18 99 H28"/>
      <path d="M45 76 H62 L71 85 V116 H45 Z M62 76 V85 H71"/>
      <path d="M51 91 H63 M51 99 H61"/>
      <path d="M78 76 H95 L104 85 V116 H78 Z M95 76 V85 H104"/>
      <path d="M84 91 H96 M84 99 H94"/>
      <path d="M111 76 H128 L137 85 V116 H111 Z M128 76 V85 H137"/>
      <path d="M117 91 H129 M117 99 H127"/>
      <path d="M8 118 V124 H192 V118"/>
      <circle cx="24" cy="121" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="57" cy="121" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="90" cy="121" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="123" cy="121" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="172" cy="121" r="1.5" fill="currentColor" stroke="none"/>
      <path d="M158 5 V32 M174 5 V32"/>
      <rect x="153" y="30" width="26" height="17" rx="5"/>
      <circle cx="166" cy="38.5" r="3"/>
      <path d="M161 47 L151 57 L155 72"/>
      <path d="M171 47 L181 57 L177 72"/>
      <path d="M155 72 L160 76 M177 72 L172 76"/>
    </g>
    <g class="hp-accent">
      <path d="M148 76 H169 L180 87 V116 H148 Z M169 76 V87 H180"/>
      <path d="M155 93 H170 M155 102 H166"/>
      <rect x="160" y="108" width="8" height="8" rx="1"/>
    </g>
  `);
}

/**
 * LOAD — a modern automated warehouse robot retrieving a storage box from a
 * rack. The retrieved box is orange. Accent: orange.
 */
export function loadPictogram() {
  return svg(`
    <g class="hp-line">
      <path d="M8 122 H192"/>
      <path d="M126 13 V118 M190 13 V118 M126 13 H190 M126 48 H190 M126 83 H190 M126 118 H190"/>
      <path d="M132 23 H153 V43 H132 Z M139 23 V29 H146 V23"/>
      <path d="M161 23 H183 V43 H161 Z M168 23 V29 H176 V23"/>
      <path d="M161 58 H183 V78 H161 Z M168 58 V64 H176 V58"/>
      <path d="M132 93 H153 V113 H132 Z M139 93 V99 H146 V93"/>
      <path d="M161 93 H183 V113 H161 Z M168 93 V99 H176 V93"/>
      <path d="M13 101 H61 C66 101 70 105 70 110 V117 H13 Z"/>
      <circle cx="27" cy="117" r="7"/>
      <circle cx="56" cy="117" r="7"/>
      <path d="M37 101 V86"/>
      <circle cx="37" cy="82" r="7"/>
      <path d="M41 76 L64 48"/>
      <path d="M49 82 L71 56"/>
      <circle cx="68" cy="52" r="7"/>
      <path d="M74 50 L93 59"/>
      <path d="M71 58 L91 67"/>
      <path d="M91 59 L97 63 M91 67 L97 67"/>
      <path d="M97 60 L93 55 M97 70 L93 75"/>
    </g>
    <g class="hp-accent">
      <path d="M98 55 H121 V76 H98 Z M106 55 V62 H114 V55"/>
    </g>
  `);
}

/**
 * TEMPLATES — an industrial press feeding a conveyor that turns out identical
 * produced objects in series (assembly-line / mass-production). Accent: purple.
 */
export function templatePictogram() {
  return svg(`
    <g class="hp-line">
      <path d="M22 84 V41 L59 25 M178 84 V41 L141 25"/>
      <path d="M22 41 H48 M152 41 H178"/>
      <rect x="58" y="12" width="84" height="30" rx="5"/>
      <circle cx="67" cy="21" r="2" fill="currentColor" stroke="none"/>
      <circle cx="133" cy="21" r="2" fill="currentColor" stroke="none"/>
      <path d="M65 42 V49 H135 V42"/>
      <path d="M92 49 V61 C92 66 95 69 100 69 C105 69 108 66 108 61 V49"/>
      <path d="M96 69 V76 M104 69 V76"/>
      <path d="M89 76 H111 V83 H89 Z"/>
      <rect x="8" y="91" width="184" height="22" rx="11"/>
      <circle cx="21" cy="102" r="5"/>
      <circle cx="42" cy="102" r="5"/>
      <circle cx="63" cy="102" r="5"/>
      <circle cx="84" cy="102" r="5"/>
      <circle cx="105" cy="102" r="5"/>
      <circle cx="126" cy="102" r="5"/>
      <circle cx="147" cy="102" r="5"/>
      <circle cx="168" cy="102" r="5"/>
      <circle cx="181" cy="102" r="5"/>
      <path d="M24 113 V121 H78 V113 M122 113 V121 H176 V113"/>
      <path d="M78 121 H122"/>
    </g>
    <g class="hp-accent">
      <path d="M25 70 H49 V90 H25 Z M33 70 V77 H41 V70"/>
      <path d="M88 70 H112 V90 H88 Z M96 70 V77 H104 V70"/>
      <path d="M151 70 H175 V90 H151 Z M159 70 V77 H167 V70"/>
    </g>
  `);
}
