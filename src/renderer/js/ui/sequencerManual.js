/**
 * The Sequencer's manual, opened from Help > Sequencer Manual (F1).
 *
 * Asked by the author on 2026-09-27: every command of the Sequencer, with
 * diagrams where a picture says it better. It is part of the application, not
 * of the site, because it describes the build it ships in -- a manual on the
 * web would describe whichever version the web was last updated for.
 *
 * Everything here is static text written in this file: no external value
 * reaches the markup, so nothing needs escaping (invariant 9). The diagrams
 * are inline SVG coloured by classes, never by a `style` attribute, which the
 * CSP would drop in silence (invariant 10).
 *
 * ONE CONVENTION FOR THE TEXT, kept everywhere because the author found the
 * first draft bold here and plain there: the name of anything on screen --
 * a button, a field, a menu, a menu entry, a node, a mode -- is bold (`ui`);
 * a button that shows a letter or a symbol is drawn as that button (`btn`);
 * a key of the keyboard is a key (`k`). Explanations live in the page, not in
 * the drawings, where they could not follow the convention.
 *
 * WHEN A COMMAND CHANGES, THIS FILE CHANGES WITH IT. A manual that says
 * Ctrl+D where the code says something else is worse than no manual.
 */

/** Keys of the keyboard, one or a chord: k('Ctrl', 'D'). */
const k = (...keys) => keys.map((key) => `<kbd>${key}</kbd>`).join('+');
/** The name of something on screen. */
const ui = (text) => `<b>${text}</b>`;
/** A button that shows a letter or a symbol, drawn as that button. */
const btn = (text) => `<span class="mn-btn">${text}</span>`;

// ---------------------------------------------------------------- diagrams

/**
 * A numbered badge on the thing it names. The words go in a numbered list
 * under the drawing: lines from a dot to a label crossed each other and the
 * controls they pointed at, and nobody could read which was which (the
 * author, 2026-09-27).
 */
const badge = (n, x, y) =>
  `<circle class="mn-badge" cx="${x}" cy="${y}" r="9"/><text class="mn-badge-text" x="${x}" y="${y + 3.5}" text-anchor="middle">${n}</text>`;

/** The words for a drawing's badges, in their order. */
const legend = (...items) => `<ol class="mn-keys">${items.map((item) => `<li>${item}</li>`).join('')}</ol>`;

const DIAGRAM_SCREEN = `<svg class="mn-diagram" viewBox="0 0 760 316" role="img" aria-label="The Sequencer's screen">
  <rect class="mn-frame" x="10" y="10" width="740" height="30" rx="4"/>
  <text class="mn-title" x="40" y="30">Header</text>
  <rect class="mn-frame" x="10" y="48" width="740" height="40" rx="4"/>
  <text class="mn-title" x="40" y="66">Toolbar</text>
  <text class="mn-tiny" x="40" y="80">Track inspector · status line</text>
  <rect class="mn-frame" x="10" y="96" width="180" height="26" rx="3"/>
  <rect class="mn-ruler" x="190" y="96" width="560" height="12"/>
  <rect class="mn-ruler" x="190" y="108" width="560" height="14"/>
  <rect class="mn-head" x="10" y="122" width="180" height="56"/>
  <rect class="mn-head" x="10" y="178" width="180" height="56"/>
  <rect class="mn-head" x="10" y="234" width="180" height="56"/>
  <rect class="mn-lane" x="190" y="122" width="560" height="168"/>
  <rect class="mn-clip-midi" x="240" y="128" width="150" height="44" rx="3"/>
  <rect class="mn-clip-audio" x="440" y="184" width="210" height="44" rx="3"/>
  <line class="mn-playhead" x1="330" y1="96" x2="330" y2="290"/>
  <rect class="mn-frame" x="190" y="296" width="560" height="14" rx="7"/>
  <rect class="mn-thumb" x="230" y="298" width="200" height="10" rx="5"/>
  ${badge(1, 24, 25)}${badge(2, 24, 68)}${badge(3, 100, 150)}${badge(4, 720, 109)}
  ${badge(5, 344, 250)}${badge(6, 315, 150)}${badge(7, 545, 206)}${badge(8, 450, 303)}
</svg>
${legend(
  `${ui('Header')}: the transport, ${ui('BPM')}, the time signature, ${ui('Plays')} and ${ui('Export')}.`,
  `${ui('Toolbar')}: ${ui('+ MIDI Track')}, ${ui('+ Audio Track')}, the ${ui('Metronome')}, ${ui('Snap')}, ${ui('Zoom')}, ${ui('Loop')} and the ${ui('Record')} mode. Under it, the selected track's ${ui('Input')} and ${ui('Destination')}, and the status line, which says what is missing.`,
  `${ui('Track heads')}: one per track.`,
  `${ui('Rulers')}: time above, bars below. Press either to place the playhead.`,
  `${ui('Playhead')}: drag its head to move it.`,
  `${ui('MIDI clip')}`,
  `${ui('Audio clip')}`,
  `${ui('Navigation bar')}: travel and zoom along the timeline.`
)}`;

const DIAGRAM_TRACK = `<svg class="mn-diagram" viewBox="0 0 760 170" role="img" aria-label="A track's head">
  <rect class="mn-head" x="170" y="34" width="420" height="104" rx="5"/>
  <rect class="mn-key" x="180" y="44" width="20" height="84" rx="4"/>
  <rect class="mn-key mn-rec" x="212" y="46" width="28" height="24" rx="4"/><text class="mn-keytext" x="226" y="62" text-anchor="middle">R</text>
  <rect class="mn-key" x="246" y="46" width="28" height="24" rx="4"/><text class="mn-keytext" x="260" y="62" text-anchor="middle">I</text>
  <text class="mn-small" x="284" y="62">Track name</text>
  <rect class="mn-key" x="474" y="46" width="28" height="24" rx="4"/><text class="mn-keytext" x="488" y="62" text-anchor="middle">♪</text>
  <rect class="mn-key" x="508" y="46" width="28" height="24" rx="4"/><text class="mn-keytext" x="522" y="62" text-anchor="middle">M</text>
  <rect class="mn-key" x="542" y="46" width="28" height="24" rx="4"/><text class="mn-keytext" x="556" y="62" text-anchor="middle">×</text>
  <line class="mn-slider" x1="214" y1="110" x2="330" y2="110"/><circle class="mn-knob" cx="300" cy="110" r="7"/>
  <text class="mn-tiny" x="338" y="114">+0.0 dB</text>
  <line class="mn-slider" x1="396" y1="110" x2="456" y2="110"/><circle class="mn-knob" cx="426" cy="110" r="7"/>
  <text class="mn-tiny" x="464" y="114">C</text>
  <circle class="mn-route" cx="530" cy="110" r="6"/><circle class="mn-route" cx="548" cy="110" r="6"/>
  ${badge(1, 150, 86)}
  ${badge(2, 226, 20)}${badge(3, 260, 20)}${badge(4, 320, 20)}
  ${badge(5, 488, 20)}${badge(6, 522, 20)}${badge(7, 556, 20)}
  ${badge(8, 272, 154)}${badge(9, 426, 154)}${badge(10, 539, 154)}
</svg>
${legend(
  `${ui('Select')}: the selected track shows in the toolbar's inspector, and ${k('Alt')}+wheel makes it taller.`,
  `${btn('R')} ${ui('Arm')}: arms the track for recording. ${k('Ctrl')}- or ${k('Shift')}-click it to arm several.`,
  `${btn('I')} ${ui('Monitor')}: you hear what is played into the track, without recording.`,
  `${ui('Name')}: click it to rename the track.`,
  `${btn('♪')} ${ui('Plugin')}: opens the plugin the track plays.`,
  `${btn('M')} ${ui('Mute')}: mutes the track.`,
  `${btn('×')} ${ui('Delete')}: deletes the track.`,
  `${ui('Level')}: from −60 to +6 dB.`,
  `${ui('Pan')}: double-click it to centre it.`,
  `${ui('IN')} and ${ui('OUT')} dots: green when routed. Hover over one to read what is wrong.`
)}
<p>Right-click the head for the track's ${ui('Time signature from bar N…')} and to remove its automation lanes.</p>`;

const DIAGRAM_CLIP = `<svg class="mn-diagram" viewBox="0 0 760 170" role="img" aria-label="An audio clip">
  <rect class="mn-clip-audio" x="170" y="40" width="420" height="90" rx="4"/>
  <rect class="mn-edge" x="170" y="40" width="8" height="90"/>
  <rect class="mn-edge" x="582" y="40" width="8" height="90"/>
  <text class="mn-small mn-on-clip" x="250" y="56">Audio 1 Take</text>
  <path class="mn-fade" d="M178 128 Q 200 50 240 42 L178 42 Z"/>
  <path class="mn-fade" d="M510 42 Q 550 50 582 128 L582 42 Z"/>
  <path class="mn-wave" d="M190 90 L210 80 L230 100 L250 74 L270 106 L290 82 L310 98 L330 70 L350 110 L370 80 L390 100 L410 76 L430 104 L450 84 L470 96 L490 80 L510 100 L530 86 L550 94 L570 88"/>
  <rect class="mn-speaker" x="554" y="112" width="16" height="13" rx="2"/>
  ${badge(1, 178, 22)}${badge(2, 582, 22)}${badge(3, 214, 100)}
  ${badge(4, 150, 85)}${badge(5, 610, 85)}${badge(6, 562, 150)}${badge(7, 380, 150)}
</svg>
${legend(
  `${ui('Fade in')}: drag sideways from the top left corner. Its handle stays where it ends, to be dragged again.`,
  `${ui('Fade out')}: the same, from the top right corner.`,
  `${ui('Curve')}: inside a fade, near its curve, drag up or down to bend it. Right-click inside a fade for its shapes.`,
  `${ui('Left edge')}: drag it to resize the clip from its start.`,
  `${ui('Right edge')}: drag it to resize the clip from its end, which lands on the grid.`,
  `${ui('Active / inactive')}: on clips laid in lanes, and on any inactive clip.`,
  `${ui('Body')}: drag it to move the selection, to another track too. Double-click opens the ${ui('Clip Editor')}; right-click opens the clip's menu.`
)}`;

const DIAGRAM_OVERDUB = `<svg class="mn-diagram" viewBox="0 0 760 140" role="img" aria-label="Overdub and Replace">
  <text class="mn-title" x="20" y="22">Before the take</text>
  <text class="mn-title" x="270" y="22">Overdub</text>
  <text class="mn-title" x="520" y="22">Replace</text>
  <rect class="mn-clip-midi" x="20" y="34" width="220" height="70" rx="3"/>
  <rect class="mn-note-old" x="34" y="50" width="30" height="7"/><rect class="mn-note-old" x="110" y="70" width="30" height="7"/><rect class="mn-note-old" x="190" y="58" width="30" height="7"/>
  <rect class="mn-clip-midi" x="270" y="34" width="220" height="70" rx="3"/>
  <rect class="mn-note-old" x="284" y="50" width="30" height="7"/><rect class="mn-note-old" x="360" y="70" width="30" height="7"/><rect class="mn-note-old" x="440" y="58" width="30" height="7"/>
  <rect class="mn-note-new" x="330" y="86" width="24" height="7"/><rect class="mn-note-new" x="400" y="44" width="24" height="7"/>
  <rect class="mn-clip-midi" x="520" y="34" width="220" height="70" rx="3"/>
  <rect class="mn-take" x="585" y="34" width="110" height="70"/>
  <rect class="mn-note-old" x="534" y="50" width="30" height="7"/><rect class="mn-note-old" x="700" y="58" width="30" height="7"/>
  <rect class="mn-note-new" x="590" y="86" width="24" height="7"/><rect class="mn-note-new" x="650" y="44" width="24" height="7"/>
  <rect class="mn-note-old" x="20" y="122" width="14" height="7"/><text class="mn-small" x="40" y="130">notes already there</text>
  <rect class="mn-note-new" x="190" y="122" width="14" height="7"/><text class="mn-small" x="210" y="130">notes played during the take</text>
  <rect class="mn-take" x="400" y="120" width="14" height="11"/><text class="mn-small" x="420" y="130">what the take went over</text>
</svg>`;

const DIAGRAM_LOOP = `<svg class="mn-diagram" viewBox="0 0 760 136" role="img" aria-label="Recording round a loop">
  <rect class="mn-loop" x="160" y="20" width="440" height="16"/>
  <text class="mn-small" x="166" y="32">Loop: bars 5 to 8</text>
  <rect class="mn-clip-midi" x="160" y="44" width="440" height="80" rx="3"/>
  <rect class="mn-pass1" x="180" y="56" width="30" height="8"/><rect class="mn-pass1" x="400" y="56" width="30" height="8"/>
  <rect class="mn-pass2" x="290" y="76" width="30" height="8"/><rect class="mn-pass2" x="510" y="76" width="30" height="8"/>
  <rect class="mn-pass3" x="235" y="96" width="30" height="8"/><rect class="mn-pass3" x="455" y="96" width="30" height="8"/>
  <rect class="mn-pass1" x="620" y="56" width="14" height="8"/><text class="mn-small" x="640" y="64">1st time round</text>
  <rect class="mn-pass2" x="620" y="76" width="14" height="8"/><text class="mn-small" x="640" y="84">2nd time round</text>
  <rect class="mn-pass3" x="620" y="96" width="14" height="8"/><text class="mn-small" x="640" y="104">3rd time round</text>
</svg>`;

const DIAGRAM_LANES = `<svg class="mn-diagram" viewBox="0 0 760 190" role="img" aria-label="Layered takes in lanes">
  <rect class="mn-head" x="20" y="20" width="120" height="150"/>
  <text class="mn-small" x="30" y="40">Audio 1</text>
  <text class="mn-tiny" x="30" y="158">selected, grown</text>
  <rect class="mn-lane" x="140" y="20" width="600" height="150"/>
  <rect class="mn-clip-audio" x="200" y="24" width="300" height="44" rx="3"/>
  <rect class="mn-clip-audio" x="260" y="72" width="300" height="44" rx="3"/>
  <rect class="mn-clip-off" x="320" y="120" width="300" height="44" rx="3"/>
  <text class="mn-small mn-on-clip" x="208" y="40">Take 1</text>
  <text class="mn-small mn-on-clip" x="268" y="88">Take 2</text>
  <text class="mn-small mn-off-text" x="328" y="136">Take 3 — inactive</text>
  <rect class="mn-speaker" x="476" y="52" width="16" height="12" rx="2"/>
  <rect class="mn-speaker" x="536" y="100" width="16" height="12" rx="2"/>
  <rect class="mn-speaker mn-speaker-off" x="596" y="148" width="16" height="12" rx="2"/>
  ${badge(1, 650, 154)}
</svg>
${legend(`${ui('Active / inactive')}: click the speaker to make the take active or inactive.`)}`;

const DIAGRAM_AUTOMATION = `<svg class="mn-diagram" viewBox="0 0 760 126" role="img" aria-label="Automation: Touch and Latch">
  <text class="mn-title" x="20" y="22">A lane before the take</text>
  <text class="mn-title" x="270" y="22">Overdub = Touch</text>
  <text class="mn-title" x="520" y="22">Replace = Latch</text>
  <rect class="mn-lane" x="20" y="34" width="220" height="80"/>
  <path class="mn-auto" d="M20 90 L240 58"/>
  <rect class="mn-lane" x="270" y="34" width="220" height="80"/>
  <rect class="mn-take" x="330" y="34" width="70" height="80"/>
  <path class="mn-auto" d="M270 90 L330 81 L330 50 L350 44 L370 60 L400 48 L400 69 L490 58"/>
  <rect class="mn-lane" x="520" y="34" width="220" height="80"/>
  <rect class="mn-take" x="580" y="34" width="160" height="80"/>
  <path class="mn-auto" d="M520 90 L580 81 L580 50 L600 44 L620 60 L650 48 L740 48"/>
</svg>`;

const DIAGRAM_METER = `<svg class="mn-diagram" viewBox="0 0 760 136" role="img" aria-label="Tracks counting different bars">
  <text class="mn-small" x="20" y="36">Project 4/4</text>
  <text class="mn-small" x="20" y="76">Track 7/8</text>
  <text class="mn-small" x="20" y="116">Track 4/4 → 3/4 at bar 3</text>
  <line class="mn-axis" x1="180" y1="20" x2="180" y2="130"/>
  ${[0, 1, 2, 3, 4].map((i) => `<line class="mn-bar" x1="${180 + i * 128}" y1="24" x2="${180 + i * 128}" y2="44"/><text class="mn-tiny" x="${184 + i * 128}" y="36">${i + 1}</text>`).join('')}
  ${[0, 1, 2, 3, 4, 5].map((i) => `<line class="mn-bar" x1="${180 + i * 112}" y1="64" x2="${180 + i * 112}" y2="84"/><text class="mn-tiny" x="${184 + i * 112}" y="76">${i + 1}</text>`).join('')}
  ${[0, 128, 256, 352, 448, 544].map((x, i) => `<line class="mn-bar" x1="${180 + x}" y1="104" x2="${180 + x}" y2="124"/><text class="mn-tiny" x="${184 + x}" y="116">${i + 1}</text>`).join('')}
  <rect class="mn-chip" x="436" y="88" width="30" height="14" rx="3"/><text class="mn-chiptext" x="451" y="98.5" text-anchor="middle">3/4</text>
</svg>`;

// ---------------------------------------------------------------- sections

export const MANUAL_SECTIONS = Object.freeze([
  {
    id: 'overview', title: 'The Sequencer at a glance',
    html: `<p>The Sequencer is MiniHub's arrangement: tracks of MIDI and audio clips on a timeline, played by the native engine to the sample. Open it from the sidebar, or keep it above every page with ${ui('View › Interface: Hybrid 1')}; the bar between the two halves shares the height.</p>
      ${DIAGRAM_SCREEN}
      <p>Everything the Sequencer plays goes through real nodes and cables: a ${ui('Sequencer')} node in the ${ui('Patch Bay')}, a MIDI track's ${ui('Destination')} (usually a ${ui('VST')} node), an audio track's ${ui('Destination')} (the ${ui('Audio Output')}, a ${ui('Mixer')}, an effect). When nothing can be heard or recorded, the status line under the toolbar says what is missing.</p>`
  },
  {
    id: 'transport', title: 'Transport',
    html: `<p>The transport is in the header, on every page.</p>
      <table class="mn-table"><tbody>
        <tr><td>${btn('|◀')}</td><td>Back to the start.</td></tr>
        <tr><td>${btn('◀◀')} ${btn('▶▶')}</td><td>Back or forward one bar, in the signature where the playhead is.</td></tr>
        <tr><td>${btn('▶')}</td><td>Play; while playing, ${ui('Pause')}. A pause leaves the ${ui('One Ring')} nodes running.</td></tr>
        <tr><td>${btn('■')}</td><td>${ui('Stop')}. It also ends a take and stops the ${ui('One Ring')} nodes. ${ui('Play')} resumes from where it stopped.</td></tr>
        <tr><td>${btn('●')}</td><td>${ui('Record')}: starts a take on the armed tracks. When it cannot start, it says why.</td></tr>
        <tr><td>${btn('▶|')}</td><td>To the end of the arrangement.</td></tr>
        <tr><td>${ui('Bar')}</td><td>Where the playhead is, bar and beat.</td></tr>
        <tr><td>${ui('BPM')}</td><td>The tempo. Type it, or drag up and down on the field with the right mouse button.</td></tr>
        <tr><td>${ui('n / d')}</td><td>The time signature at the playhead: the beats in a bar, over the note that makes a beat. Changing it here changes it from the bar under the playhead (see <a data-goto="meter">Time signatures</a>).</td></tr>
        <tr><td>${ui('Plays')}</td><td>${ui('All')}, ${ui('Sequencer')} (its clips, no Audio Player) or ${ui('Players')} (the Audio Players, no clip).</td></tr>
        <tr><td>${ui('Export')}</td><td>Opens the export panel (see <a data-goto="export">Export</a>).</td></tr>
      </tbody></table>
      <p>${k('Space')} plays and stops on every page, except while you type in a field or an open list.</p>
      <p>To place the playhead, press the bar ruler or the clock ruler, and drag to scrub. The grip on the red line's head drags it too. It lands on the ${ui('Snap')} grid; hold ${k('Alt')} to place it off the grid. While playing, it moves when you release. A click in the empty part of a lane also places it.</p>`
  },
  {
    id: 'toolbar', title: 'Toolbar',
    html: `<table class="mn-table"><tbody>
        <tr><td>${ui('+ MIDI Track')}</td><td>An empty MIDI track, or one made with an instrument from your catalogue, its ${ui('VST')} node and cable included.</td></tr>
        <tr><td>${ui('+ Audio Track')}</td><td>An audio track.</td></tr>
        <tr><td>${ui('Metronome')}</td><td>The switch turns it on. ${ui('Rec')}: it clicks during a take and its count-in only. ${ui('Play + Rec')}: whenever the transport runs. Its light blinks on the beats, green on the downbeat.</td></tr>
        <tr><td>${ui('Snap')}</td><td>The grid clips, notes and the playhead land on, from ${ui('1 bar')} down to ${ui('1/32')}. A 1-bar grid follows each bar's own length.</td></tr>
        <tr><td>${ui('Zoom')} · ${ui('Fit')} · ${ui('Focus')}</td><td>The zoom slider. ${ui('Fit')} frames the whole arrangement; ${ui('Focus')} frames the selected clips, or the loop.</td></tr>
        <tr><td>${ui('Loop')} · ${ui('From')} · ${ui('To')}</td><td>Turns the loop on, from bar ${ui('From')} to bar ${ui('To')}, both included.</td></tr>
        <tr><td>${ui('Record')}</td><td>${ui('Overdub')} or ${ui('Replace')}: what a take does to the clips already there (see <a data-goto="recording">Recording</a>).</td></tr>
        <tr><td>${ui('Track')} · ${ui('Input')} · ${ui('Destination')}</td><td>The selected track's name, where its input comes from, and where it plays.</td></tr>
      </tbody></table>`
  },
  {
    id: 'tracks', title: 'Tracks',
    html: `${DIAGRAM_TRACK}
      <p>A ${ui('MIDI track')} plays its clips' notes and controllers into its ${ui('Destination')}; its ${ui('Input')} is your controller. An ${ui('audio track')} plays its audio clips into its ${ui('Destination')}; its ${ui('Input')} is a node cabled into the Sequencer's ${ui('AUDIO IN')}: the ${ui('Audio Input')}, a ${ui('VST')}, an ${ui('Audio Player')}. Armed or monitored, an audio track also passes that input on.</p>
      <p>Selecting a track, with its ${ui('select')} button or a click in its empty lane, shows it in the toolbar's inspector. The selected track can be made taller with ${k('Alt')}+wheel. It keeps that height and gets it back each time it is selected again; the other tracks stay at the usual height.</p>`
  },
  {
    id: 'clips', title: 'Clips',
    html: `${DIAGRAM_CLIP}
      <table class="mn-table"><tbody>
        <tr><td>Double-click an empty lane</td><td>A new MIDI clip, one bar long, on a MIDI track; a file to import, on an audio track.</td></tr>
        <tr><td>Click</td><td>Selects the clip. ${k('Ctrl')}-click adds or removes one, ${k('Shift')}-click selects a range, ${k('Ctrl')}+${k('Shift')}-click adds a range.</td></tr>
        <tr><td>Drag in an empty lane</td><td>A band that selects every clip it touches; with ${k('Ctrl')} or ${k('Shift')}, added to the selection.</td></tr>
        <tr><td>Drag a clip</td><td>Moves the whole selection on the grid, and to other tracks of the same kind. ${k('Esc')} during the drag puts it back.</td></tr>
        <tr><td>Drag an edge</td><td>Resizes the clip. A MIDI clip made shorter keeps its hidden notes, and shows them again when made longer.</td></tr>
        <tr><td>${k('←')} ${k('→')}</td><td>Moves the selection one ${ui('Snap')} step.</td></tr>
        <tr><td>${k('↑')} ${k('↓')}</td><td>Moves the selection to the track above or below.</td></tr>
        <tr><td>${k('S')}</td><td>Splits the selected clips at the playhead.</td></tr>
        <tr><td>${k('Ctrl')}+${k('C')} · ${k('Ctrl')}+${k('X')} · ${k('Ctrl')}+${k('V')}</td><td>Copy, cut, paste: at the playhead, or where you right-clicked with ${ui('Paste here')}.</td></tr>
        <tr><td>${k('Ctrl')}+${k('D')}</td><td>Duplicates the selection right after itself.</td></tr>
        <tr><td>${k('Ctrl')}+${k('A')}</td><td>Selects every clip.</td></tr>
        <tr><td>${k('Del')}</td><td>Deletes the selection.</td></tr>
      </tbody></table>
      <p>A clip's right-click menu: ${ui('Open in Clip Editor')}, ${ui('Split at playhead')}, ${ui('Cut')}, ${ui('Copy')}, ${ui('Duplicate')}, ${ui('Activate')} / ${ui('Deactivate')}, ${ui('Quantize')} to the ${ui('Snap')} grid (MIDI), ${ui('Time signature from bar N…')} and ${ui('Delete')}.</p>
      <p>An empty lane's right-click menu: ${ui('Open Plugin Window')}, ${ui('New MIDI clip here')} or ${ui('Import audio here…')}, ${ui('Paste here')}, ${ui('Time signature from bar N…')} and ${ui('Select all clips')}.</p>`
  },
  {
    id: 'navigate', title: 'Moving around',
    html: `<table class="mn-table"><tbody>
        <tr><td>Wheel</td><td>Scrolls the tracks up and down, over their heads as over their lanes.</td></tr>
        <tr><td>${k('Shift')}+wheel</td><td>Scrolls along the timeline.</td></tr>
        <tr><td>${k('Ctrl')}+wheel</td><td>Zooms the timeline around the pointer.</td></tr>
        <tr><td>${k('Alt')}+wheel</td><td>Makes the selected track taller or shorter.</td></tr>
        <tr><td>Middle button, drag</td><td>Pans the view in both directions.</td></tr>
        <tr><td>${k('+')} · ${k('-')}</td><td>Zooms in and out. Without ${k('Ctrl')}: ${k('Ctrl')}+${k('+')} is the window's own zoom.</td></tr>
        <tr><td>${ui('Navigation bar')}</td><td>Drag its thumb to travel; drag either end of the thumb to zoom; press the bar to jump there. Its ${btn('−')} and ${btn('+')} zoom.</td></tr>
      </tbody></table>`
  },
  {
    id: 'meter', title: 'Time signatures',
    html: `<p>The header's signature is the project's, at the playhead. The project's signature can change along the song: right-click the bar ruler and choose ${ui('Time signature from bar N…')}. Each change shows as a chip on the ruler; click the chip to change it or choose ${ui('Remove this change')}.</p>
      <p>A track can also count its own bars (polymetry): right-click its head, its lane or one of its clips and choose ${ui('Time signature from bar N…')}. That track then draws its grid, snaps and makes its new clips in its own bars, while the tempo and the quarter note stay the same for every track.</p>
      ${DIAGRAM_METER}
      <p>One tempo, one quarter note: each track counts in its own bars, and a chip marks a change.</p>
      <p>The menu lists the common signatures; type any other, such as 13/16, in its search field. Numerators go from 1 to 32, denominators are 2, 4, 8 or 16. The metronome, the count-in, the plugins and the ${ui('Clip Editor')} follow the signature in force where they are.</p>`
  },
  {
    id: 'recording', title: 'Recording',
    html: `<ol class="mn-steps">
        <li>Choose the track's ${ui('Input')} and ${ui('Destination')} in the inspector.</li>
        <li>Arm it with ${btn('R')}. ${k('Ctrl')}- or ${k('Shift')}-click ${btn('R')} to arm several tracks for one take.</li>
        <li>Press ${btn('●')} ${ui('Record')}, or ${ui('Rec')} on your controller. With the metronome on and the transport stopped, one bar of count-in comes first; the notes you play during it are kept, placed at the start.</li>
        <li>Press ${btn('■')} ${ui('Stop')}, or ${k('Space')}, to end the take. A take is one undo step.</li>
      </ol>
      <p>${btn('I')} (monitor) lets you hear a track's input without arming it.</p>
      <h3>Overdub and Replace</h3>
      ${DIAGRAM_OVERDUB}
      <ul>
        <li>${ui('Overdub')}: the new notes go into the clip they were played over. Played past its end, the clip stretches to the bar line. An audio take is laid over what is there, and both sound (see <a data-goto="lanes">Layered takes</a>).</li>
        <li>${ui('Replace')}: what the take went over is cleared first. An audio take cuts out the sound it covers.</li>
      </ul>
      <h3>Round a loop</h3>
      ${DIAGRAM_LOOP}
      <ul>
        <li>Every time round lands on the same bars.</li>
        <li>${ui('Overdub')} keeps them all, the way a drum machine builds a pattern.</li>
        <li>${ui('Replace')} keeps the last time round in which you played something, so a silent last pass never erases a good one.</li>
      </ul>
      <h3>What a MIDI take keeps</h3>
      <p>Its notes, and what the wheels, knobs, faders and pedal sent: controllers (CC), pitch bend and pressure. These moves play back at their exact place. On ${ui('Play')}, a jump or a loop's return, each controller is set to its last value before that point. On ${ui('Stop')}, the sustain pedal is released and the pitch bend goes back to centre. In the clip, the moves are drawn as an orange stepped line behind the notes.</p>`
  },
  {
    id: 'lanes', title: 'Layered takes',
    html: `<p>Clips that overlap on one track are drawn in lanes, one above the other, so each one can be seen, moved, resized and faded. All of them still sound: overlapping is how an overdub layers sound on sound.</p>
      ${DIAGRAM_LANES}
      <p>To keep a take without hearing it, make it inactive with its speaker, or with ${ui('Deactivate clip')} in its right-click menu, which acts on the whole selection. An inactive clip is grey and dashed, and it is left out of playback and of the export. It keeps its speaker even when alone, so it can always be made active again.</p>
      <p>Too many lanes to read? Select the track and make it taller with ${k('Alt')}+wheel.</p>`
  },
  {
    id: 'fades', title: 'Fades',
    html: `<p>Audio clips fade in and out as they do in Reaper.</p>
      <ul>
        <li>Over a clip's top left or top right corner, the cursor changes: drag sideways to set the fade's length. Its handle stays where the fade ends, to be dragged again as often as you like.</li>
        <li>Inside a fade, near its curve, drag up or down to bend it.</li>
        <li>Right-click inside a fade for its shape: ${ui('Linear')}, ${ui('Fast start')}, ${ui('Slow start')}, their steep versions, ${ui('S-curve')} and ${ui('S-curve, steep')}; and ${ui('Low pass fade')}, which closes a filter as the level falls.</li>
        <li>${k('Esc')} during a drag puts the fade back. The two fades may meet but never cross, and a cut leaves each half its own fade.</li>
      </ul>`
  },
  {
    id: 'automation', title: 'Automation',
    html: `<p>A controller knob bound to a plugin parameter with ${ui('Learn')} can be recorded: arm the track that plays that plugin, press ${ui('Record')} and turn the knob. The moves are kept as automation on that track and play back into the plugin, export included; the plugin's window follows them.</p>
      ${DIAGRAM_AUTOMATION}
      <ul>
        <li>The yellow line is the parameter along the song, high where it is high; the shaded band is what the hand touched.</li>
        <li>${ui('Overdub')} works as ${ui('Touch')}: from the first move of the knob to its last, and the old curve resumes after it.</li>
        <li>${ui('Replace')} works as ${ui('Latch')}: from the first move to the end of the take, holding the last value.</li>
        <li>During a take, a parameter you turn is yours: its old automation stops playing until the take ends. Outside a take, the automation leads.</li>
        <li>Each lane is a yellow line across its track. Right-click the track's head to remove one.</li>
        <li>Moves made with the mouse in a plugin's own window are not recorded; only bound knobs are.</li>
      </ul>`
  },
  {
    id: 'editor', title: 'Clip Editor',
    html: `<p>Double-click a clip, or choose ${ui('Open in Clip Editor')}: it opens in its own window, a piano roll for MIDI and a waveform view for audio. Its transport returns to the start, and plays or stops the Sequencer.</p>
      <table class="mn-table"><tbody>
        <tr><td>Press the bar ruler</td><td>Places the playhead there, on the ${ui('Snap')} grid; with ${k('Alt')}, off it. The ruler numbers the track's bars, and the transport shows where the playhead is as bar.beat.</td></tr>
        <tr><td>Double-click the grid</td><td>A new note, one ${ui('Snap')} step long, velocity 100.</td></tr>
        <tr><td>Click a note</td><td>Selects it and lets you hear it; with ${k('Ctrl')}, adds it to the selection. Click a key of the keyboard to hear that pitch.</td></tr>
        <tr><td>Drag a note · its edge</td><td>Moves the selection in time and pitch · changes that note's length.</td></tr>
        <tr><td>Drag on the empty grid</td><td>A lasso that selects notes; with ${k('Ctrl')} or ${k('Shift')}, added to the selection.</td></tr>
        <tr><td>${k('←')} ${k('→')} · ${k('↑')} ${k('↓')}</td><td>Moves the selected notes one ${ui('Snap')} step · one semitone.</td></tr>
        <tr><td>${k('Ctrl')}+${k('A')} · ${k('Ctrl')}+${k('D')} · ${k('Del')}</td><td>Selects every visible note · duplicates · deletes.</td></tr>
        <tr><td>${k('Ctrl')}+wheel · ${k('Ctrl')}+${k('Shift')}+wheel</td><td>Zooms in time · changes the rows' height.</td></tr>
        <tr><td>${ui('Velocity')}</td><td>The slider sets the velocity of the selected notes.</td></tr>
        <tr><td>${ui('Quantize')}</td><td>${ui('Grid')} (straight or triplet), ${ui('Strength')}, ${ui('Scope')} (the selected notes or the whole clip), ${ui('Timing')} (starts only, or starts and ends), then ${ui('Apply')}.</td></tr>
        <tr><td>${ui('Fit clip')}</td><td>Frames the whole clip.</td></tr>
      </tbody></table>
      <p>${k('Ctrl')}+${k('Z')} and ${k('Ctrl')}+${k('Shift')}+${k('Z')} undo and redo from the editor too.</p>`
  },
  {
    id: 'export', title: 'Export',
    html: `<p>${ui('Export')} in the header opens the panel. Choose the range, the whole arrangement or the loop, shown with its length; the format, ${ui('WAV')} (bit depth), ${ui('MP3')} (bitrate) or ${ui('OGG')} (quality); and the tail, the seconds kept after the end for reverbs and delays to ring out. The export renders what reaches the ${ui('Audio Output')}, faster than real time, and shows its progress.</p>`
  },
  {
    id: 'controller', title: 'Controller transport keys',
    html: `<p>When your controller's profile declares transport keys (on some keyboards, pads pressed with ${k('Shift')} held), they drive the Sequencer:</p>
      <table class="mn-table"><tbody>
        <tr><td>${ui('Play')}</td><td>Plays, and stops what is running, like ${k('Space')}.</td></tr>
        <tr><td>${ui('Stop')}</td><td>Stops.</td></tr>
        <tr><td>${ui('Rec')}</td><td>Starts a take; pressed again, ends it and keeps playing.</td></tr>
        <tr><td>${ui('Loop')}</td><td>Turns the loop on or off.</td></tr>
        <tr><td>${ui('Tap')}</td><td>Taps the tempo.</td></tr>
      </tbody></table>`
  },
  {
    id: 'keys', title: 'Shortcuts',
    html: `<table class="mn-table"><tbody>
        <tr><td>${k('Space')}</td><td>Play · Stop</td></tr>
        <tr><td>${k('Ctrl')}+${k('Z')} · ${k('Ctrl')}+${k('Shift')}+${k('Z')}</td><td>Undo · Redo. Zoom, scroll, selection and track heights are not undone.</td></tr>
        <tr><td>${k('Ctrl')}+${k('C')} · ${k('X')} · ${k('V')} · ${k('D')} · ${k('A')}</td><td>Copy · Cut · Paste · Duplicate · Select all</td></tr>
        <tr><td>${k('Del')}</td><td>Delete the selection</td></tr>
        <tr><td>${k('S')}</td><td>Split at the playhead</td></tr>
        <tr><td>${k('←')} ${k('→')} ${k('↑')} ${k('↓')}</td><td>Nudge the selection</td></tr>
        <tr><td>${k('+')} · ${k('-')}</td><td>Zoom in · Zoom out</td></tr>
        <tr><td>${k('Esc')}</td><td>Cancel a drag or a selection band</td></tr>
        <tr><td>Wheel · ${k('Shift')}+wheel · ${k('Ctrl')}+wheel · ${k('Alt')}+wheel</td><td>Scroll the tracks · Scroll along the timeline · Zoom · Grow the selected track</td></tr>
        <tr><td>${k('Alt')} while placing the playhead</td><td>Off the grid</td></tr>
        <tr><td>${k('F1')}</td><td>This manual</td></tr>
        <tr><td>${k('Ctrl')}+${k('S')} · ${k('Ctrl')}+${k('O')} · ${k('Ctrl')}+${k('N')}</td><td>Save · Open · New project</td></tr>
      </tbody></table>`
  }
]);

// ---------------------------------------------------------------- the panel

/**
 * The manual's panel over the whole window. While it is open it takes the
 * keyboard: Space scrolls the page rather than starting the transport, the
 * arrows scroll rather than nudging clips, and Esc closes it.
 */
export function installSequencerManual({ root = globalThis.document?.getElementById?.('manual-root'), doc = globalThis.document, win = globalThis.window } = {}) {
  if (!root) return { open() {}, close() {}, get isOpen() { return false; } };
  let open = false;
  let returnFocus = null;

  root.innerHTML = `<div class="manual" role="document">
    <header class="manual-head"><h2>Sequencer Manual</h2><button class="icon-button manual-close" type="button" data-manual-close aria-label="Close the manual" title="Close (Esc)">×</button></header>
    <div class="manual-body">
      <nav class="manual-toc" aria-label="Contents">${MANUAL_SECTIONS.map((section) => `<button type="button" data-goto="${section.id}">${section.title}</button>`).join('')}</nav>
      <div class="manual-content" data-manual-content tabindex="0">${MANUAL_SECTIONS.map((section) => `<section id="manual-${section.id}" data-manual-section="${section.id}"><h2>${section.title}</h2>${section.html}</section>`).join('')}</div>
    </div>
  </div>`;
  const content = root.querySelector('[data-manual-content]');

  const goTo = (id) => {
    const target = root.querySelector(`[data-manual-section="${id}"]`);
    if (!target || !content) return;
    content.scrollTop = target.offsetTop - content.offsetTop;
  };
  root.addEventListener('click', (event) => {
    const link = event.target?.closest?.('[data-goto]');
    if (link) { event.preventDefault(); goTo(link.dataset.goto); return; }
    if (event.target?.closest?.('[data-manual-close]') || event.target === root) close();
  });

  const onKey = (event) => {
    if (!open) return;
    // Nothing behind the manual hears a key while it is open.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  win?.addEventListener?.('keydown', onKey, true);

  function show() {
    if (open) return;
    open = true;
    returnFocus = doc?.activeElement || null;
    root.classList.remove('hidden');
    content?.focus?.();
  }
  function close() {
    if (!open) return;
    open = false;
    root.classList.add('hidden');
    returnFocus?.focus?.();
    returnFocus = null;
  }
  return { open: show, close, goTo, get isOpen() { return open; } };
}
