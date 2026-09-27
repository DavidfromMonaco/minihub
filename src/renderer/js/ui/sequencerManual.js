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
 * WHEN A COMMAND CHANGES, THIS FILE CHANGES WITH IT. A manual that says
 * Ctrl+D where the code says something else is worse than no manual.
 */

const k = (...keys) => keys.map((key) => `<kbd>${key}</kbd>`).join('+');

// ---------------------------------------------------------------- diagrams

/** A labelled callout: a dot on the thing, a line, the words. */
const callout = (x, y, tx, ty, text, anchor = 'start') =>
  `<circle class="mn-dot" cx="${x}" cy="${y}" r="3"/><line class="mn-lead" x1="${x}" y1="${y}" x2="${tx}" y2="${ty}"/>` +
  `<text class="mn-note" x="${tx + (anchor === 'end' ? -4 : 4)}" y="${ty + 4}" text-anchor="${anchor}">${text}</text>`;

const DIAGRAM_SCREEN = `<svg class="mn-diagram" viewBox="0 0 760 330" role="img" aria-label="The Sequencer's screen">
  <rect class="mn-frame" x="10" y="10" width="740" height="34" rx="4"/>
  <text class="mn-title" x="22" y="32">Header — transport, tempo, signature, Plays, Export</text>
  <rect class="mn-frame" x="10" y="52" width="740" height="46" rx="4"/>
  <text class="mn-title" x="22" y="72">Toolbar — tracks, metronome, Snap, Zoom, Loop, Record mode</text>
  <text class="mn-small" x="22" y="89">Track inspector: the selected track's Input and Destination · status line</text>
  <rect class="mn-frame" x="10" y="106" width="180" height="26" rx="3"/>
  <text class="mn-small" x="20" y="123">TRACKS</text>
  <rect class="mn-ruler" x="190" y="106" width="560" height="12"/>
  <text class="mn-tiny" x="196" y="115">0:00   clock ruler</text>
  <rect class="mn-ruler" x="190" y="118" width="560" height="14"/>
  <text class="mn-tiny" x="196" y="129">1        2        3     bar ruler</text>
  <rect class="mn-head" x="10" y="132" width="180" height="56"/>
  <rect class="mn-head" x="10" y="188" width="180" height="56"/>
  <rect class="mn-head" x="10" y="244" width="180" height="56"/>
  <text class="mn-small" x="22" y="164">track head</text>
  <rect class="mn-lane" x="190" y="132" width="560" height="168"/>
  <rect class="mn-clip-midi" x="240" y="138" width="150" height="44" rx="3"/>
  <rect class="mn-clip-audio" x="420" y="194" width="210" height="44" rx="3"/>
  <line class="mn-playhead" x1="330" y1="106" x2="330" y2="300"/>
  <rect class="mn-frame" x="190" y="306" width="560" height="16" rx="8"/>
  <rect class="mn-thumb" x="230" y="309" width="200" height="10" rx="5"/>
  ${callout(330, 108, 360, 100, 'playhead — drag its head, or press a ruler')}
  ${callout(300, 160, 420, 160, 'a MIDI clip')}
  ${callout(520, 216, 640, 262, 'an audio clip', 'start')}
  ${callout(330, 314, 460, 290, 'navigation bar')}
</svg>`;

const DIAGRAM_TRACK = `<svg class="mn-diagram" viewBox="0 0 760 150" role="img" aria-label="A track's head">
  <rect class="mn-head" x="20" y="20" width="330" height="80" rx="4"/>
  <rect class="mn-key" x="28" y="28" width="16" height="64" rx="3"/>
  <rect class="mn-key mn-rec" x="52" y="28" width="22" height="20" rx="3"/><text class="mn-keytext" x="63" y="42" text-anchor="middle">R</text>
  <rect class="mn-key" x="78" y="28" width="22" height="20" rx="3"/><text class="mn-keytext" x="89" y="42" text-anchor="middle">I</text>
  <text class="mn-small" x="108" y="43">Track name</text>
  <rect class="mn-key" x="250" y="28" width="22" height="20" rx="3"/><text class="mn-keytext" x="261" y="42" text-anchor="middle">♪</text>
  <rect class="mn-key" x="276" y="28" width="22" height="20" rx="3"/><text class="mn-keytext" x="287" y="42" text-anchor="middle">M</text>
  <rect class="mn-key" x="302" y="28" width="22" height="20" rx="3"/><text class="mn-keytext" x="313" y="42" text-anchor="middle">×</text>
  <line class="mn-slider" x1="52" y1="78" x2="140" y2="78"/><circle class="mn-knob" cx="120" cy="78" r="6"/>
  <text class="mn-tiny" x="146" y="82">+0.0 dB</text>
  <line class="mn-slider" x1="192" y1="78" x2="240" y2="78"/><circle class="mn-knob" cx="216" cy="78" r="6"/>
  <text class="mn-tiny" x="248" y="82">C</text>
  <circle class="mn-route" cx="300" cy="78" r="5"/><circle class="mn-route" cx="314" cy="78" r="5"/>
  ${callout(36, 60, 400, 22, 'select the track (Alt+wheel then grows it)')}
  ${callout(63, 38, 400, 40, 'R — arm for recording (Ctrl/Shift-click: arm several)')}
  ${callout(89, 38, 400, 58, 'I — monitor: hear what is played in, without recording')}
  ${callout(261, 38, 400, 76, '♪ open the plugin the track plays · M mute · × delete')}
  ${callout(96, 78, 400, 94, 'level, −60 to +6 dB · pan (double-click: centre)')}
  ${callout(307, 78, 400, 112, 'IN / OUT route dots — hover for what is wrong')}
  <text class="mn-small" x="20" y="130">Right-click the head: its time signature from the bar under the playhead, and its automation lanes to remove.</text>
</svg>`;

const DIAGRAM_CLIP = `<svg class="mn-diagram" viewBox="0 0 760 170" role="img" aria-label="An audio clip">
  <rect class="mn-clip-audio" x="40" y="30" width="420" height="90" rx="4"/>
  <rect class="mn-edge" x="40" y="30" width="8" height="90"/>
  <rect class="mn-edge" x="452" y="30" width="8" height="90"/>
  <text class="mn-small mn-on-clip" x="54" y="46">Audio 1 Take</text>
  <path class="mn-fade" d="M48 118 Q 70 40 110 32 L48 32 Z"/>
  <path class="mn-fade" d="M380 32 Q 420 40 452 118 L452 32 Z"/>
  <path class="mn-wave" d="M60 80 L80 70 L100 90 L120 64 L140 96 L160 72 L180 88 L200 60 L220 100 L240 70 L260 90 L280 66 L300 94 L320 74 L340 86 L360 70 L380 90 L400 76 L420 84 L440 78"/>
  <rect class="mn-speaker" x="424" y="102" width="16" height="13" rx="2"/>
  ${callout(110, 32, 520, 24, 'top corners: fade in / fade out — drag sideways')}
  ${callout(78, 70, 520, 48, 'inside a fade: drag up or down to bend its curve')}
  ${callout(44, 100, 520, 72, 'left and right edges: resize (the end lands on the grid)')}
  ${callout(432, 108, 520, 96, 'bottom right: active / inactive (layered clips only)')}
  ${callout(250, 118, 520, 120, 'body: drag to move — to another track too')}
  <text class="mn-small" x="40" y="156">Double-click a clip to open it in the Clip Editor. Right-click it for its menu; right-click inside a fade for the fade's.</text>
</svg>`;

const DIAGRAM_OVERDUB = `<svg class="mn-diagram" viewBox="0 0 760 210" role="img" aria-label="Overdub and Replace">
  <text class="mn-title" x="20" y="22">Before the take</text>
  <text class="mn-title" x="270" y="22">Overdub</text>
  <text class="mn-title" x="520" y="22">Replace</text>
  <g>
    <rect class="mn-clip-midi" x="20" y="34" width="220" height="70" rx="3"/>
    <rect class="mn-note-old" x="34" y="50" width="30" height="7"/><rect class="mn-note-old" x="110" y="70" width="30" height="7"/><rect class="mn-note-old" x="190" y="58" width="30" height="7"/>
  </g>
  <g>
    <rect class="mn-clip-midi" x="270" y="34" width="220" height="70" rx="3"/>
    <rect class="mn-note-old" x="284" y="50" width="30" height="7"/><rect class="mn-note-old" x="360" y="70" width="30" height="7"/><rect class="mn-note-old" x="440" y="58" width="30" height="7"/>
    <rect class="mn-note-new" x="330" y="86" width="24" height="7"/><rect class="mn-note-new" x="400" y="44" width="24" height="7"/>
  </g>
  <g>
    <rect class="mn-clip-midi" x="520" y="34" width="220" height="70" rx="3"/>
    <rect class="mn-take" x="585" y="34" width="110" height="70"/>
    <rect class="mn-note-old" x="534" y="50" width="30" height="7"/><rect class="mn-note-old" x="700" y="58" width="30" height="7"/>
    <rect class="mn-note-new" x="590" y="86" width="24" height="7"/><rect class="mn-note-new" x="650" y="44" width="24" height="7"/>
  </g>
  <text class="mn-small" x="20" y="130"><tspan class="mn-legend-old">■</tspan> notes already there   <tspan class="mn-legend-new">■</tspan> notes played during the take   <tspan class="mn-legend-take">■</tspan> what the take went over</text>
  <text class="mn-small" x="20" y="156">Overdub: the new notes go into the clip they were played over. Past its end, the clip stretches to the bar line.</text>
  <text class="mn-small" x="20" y="176">Replace: what the take went over is cleared first. An audio take in Replace cuts out the sound it covers.</text>
  <text class="mn-small" x="20" y="196">An audio take in Overdub is laid over what is there, and both sound (see Layered takes).</text>
</svg>`;

const DIAGRAM_LOOP = `<svg class="mn-diagram" viewBox="0 0 760 170" role="img" aria-label="Recording round a loop">
  <rect class="mn-loop" x="160" y="20" width="440" height="16"/>
  <text class="mn-small" x="166" y="32">loop: bars 5 to 8</text>
  <rect class="mn-clip-midi" x="160" y="44" width="440" height="80" rx="3"/>
  <rect class="mn-pass1" x="180" y="56" width="30" height="8"/><rect class="mn-pass1" x="400" y="56" width="30" height="8"/>
  <rect class="mn-pass2" x="290" y="76" width="30" height="8"/><rect class="mn-pass2" x="510" y="76" width="30" height="8"/>
  <rect class="mn-pass3" x="235" y="96" width="30" height="8"/><rect class="mn-pass3" x="455" y="96" width="30" height="8"/>
  <text class="mn-small" x="620" y="64"><tspan class="mn-legend-p1">■</tspan> 1st time round</text>
  <text class="mn-small" x="620" y="84"><tspan class="mn-legend-p2">■</tspan> 2nd time round</text>
  <text class="mn-small" x="620" y="104"><tspan class="mn-legend-p3">■</tspan> 3rd time round</text>
  <text class="mn-small" x="20" y="146">Every time round lands on the same bars. Overdub keeps them all, the way a drum machine builds a pattern.</text>
  <text class="mn-small" x="20" y="164">Replace keeps the last time round in which you played something — a silent last pass never erases a good one.</text>
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
  ${callout(604, 154, 650, 120, 'click: active / inactive')}
</svg>`;

const DIAGRAM_AUTOMATION = `<svg class="mn-diagram" viewBox="0 0 760 200" role="img" aria-label="Automation: Touch and Latch">
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
  <text class="mn-small" x="20" y="140">The line is the parameter along the song, high where the parameter is high. The shaded band is what the hand touched.</text>
  <text class="mn-small" x="20" y="160">Touch: from the first move of the knob to its last, and the old curve resumes after it.</text>
  <text class="mn-small" x="20" y="180">Latch: from the first move to the end of the take, holding the last value.</text>
</svg>`;

const DIAGRAM_METER = `<svg class="mn-diagram" viewBox="0 0 760 150" role="img" aria-label="Tracks counting different bars">
  <text class="mn-small" x="20" y="36">Project 4/4</text>
  <text class="mn-small" x="20" y="76">Track 7/8</text>
  <text class="mn-small" x="20" y="116">Track 4/4 → 3/4 at bar 3</text>
  <line class="mn-axis" x1="180" y1="20" x2="180" y2="130"/>
  ${[0, 1, 2, 3, 4].map((i) => `<line class="mn-bar" x1="${180 + i * 128}" y1="24" x2="${180 + i * 128}" y2="44"/><text class="mn-tiny" x="${184 + i * 128}" y="36">${i + 1}</text>`).join('')}
  ${[0, 1, 2, 3, 4, 5].map((i) => `<line class="mn-bar" x1="${180 + i * 112}" y1="64" x2="${180 + i * 112}" y2="84"/><text class="mn-tiny" x="${184 + i * 112}" y="76">${i + 1}</text>`).join('')}
  ${[0, 128, 256, 352, 448, 544].map((x, i) => `<line class="mn-bar" x1="${180 + x}" y1="104" x2="${180 + x}" y2="124"/><text class="mn-tiny" x="${184 + x}" y="116">${i + 1}</text>`).join('')}
  <rect class="mn-chip" x="436" y="88" width="30" height="14" rx="3"/><text class="mn-chiptext" x="451" y="98.5" text-anchor="middle">3/4</text>
  <text class="mn-small" x="20" y="146">One tempo, one quarter note: each track draws, snaps and counts in its own bars. A chip marks a change.</text>
</svg>`;

// ---------------------------------------------------------------- sections

export const MANUAL_SECTIONS = Object.freeze([
  {
    id: 'overview', title: 'The Sequencer at a glance',
    html: `<p>The Sequencer is MiniHub's arrangement: tracks of MIDI and audio clips on a timeline, played by the native engine to the sample. Open it from the sidebar, or keep it above every page with <b>View › Interface: Hybrid 1</b> (the bar between the two halves shares the height).</p>
      ${DIAGRAM_SCREEN}
      <p>Everything the Sequencer plays goes through real nodes and cables: a <b>Sequencer</b> node in the Patch Bay, a MIDI track's <b>Destination</b> (usually a VST node), an audio track's destination (the Audio Output, a Mixer, an effect). The status line under the toolbar says what is missing when nothing can be heard or recorded.</p>`
  },
  {
    id: 'transport', title: 'Transport',
    html: `<p>The transport is in the header, on every page.</p>
      <table class="mn-table"><tbody>
        <tr><td>|◀</td><td>Back to the start.</td></tr>
        <tr><td>◀◀ / ▶▶</td><td>Back or forward one bar — of the signature where the playhead is.</td></tr>
        <tr><td>▶ / ❚❚</td><td>Play, and Pause while playing. A pause keeps the One Ring nodes running.</td></tr>
        <tr><td>■</td><td>Stop. It also ends a take and stops the One Rings. Play resumes from where it stopped.</td></tr>
        <tr><td>●</td><td>Record: starts a take on the armed tracks. When it cannot start, it says why.</td></tr>
        <tr><td>▶|</td><td>To the end of the arrangement.</td></tr>
        <tr><td>Bar</td><td>Where the playhead is, bar and beat.</td></tr>
        <tr><td>BPM</td><td>The tempo: type it, or drag up and down on the field with the right mouse button.</td></tr>
        <tr><td>n / d</td><td>The time signature at the playhead: beats in a bar, over the note that makes a beat. Changing it here changes it from the bar under the playhead (see <a data-goto="meter">Time signatures</a>).</td></tr>
        <tr><td>Plays</td><td><b>All</b>, <b>Sequencer</b> (its clips, no Audio Player) or <b>Players</b> (the Audio Players, no clip).</td></tr>
        <tr><td>Export</td><td>Opens the export panel (see <a data-goto="export">Export</a>).</td></tr>
      </tbody></table>
      <p>${k('Space')} plays and stops on every page, except while you type in a field or an open list. The playhead: press the bar ruler or the clock ruler to place it, drag to scrub; the grip on the red line's head drags it too. It lands on the Snap grid; hold ${k('Alt')} to place it off the grid. While playing, the move happens on release. A click in the empty part of a lane also places the playhead.</p>`
  },
  {
    id: 'toolbar', title: 'Toolbar',
    html: `<table class="mn-table"><tbody>
        <tr><td>+ MIDI Track</td><td>An empty MIDI track, or one created with an instrument from your catalogue (its VST node and cable included).</td></tr>
        <tr><td>+ Audio Track</td><td>An audio track.</td></tr>
        <tr><td>Metronome</td><td>The switch turns it on. <b>Rec</b>: it clicks during a take and its count-in only. <b>Play + Rec</b>: whenever the transport runs. The light blinks on the beats, green on the downbeat.</td></tr>
        <tr><td>Snap</td><td>The grid clips, notes and the playhead land on: 1 bar down to 1/32. A 1-bar grid follows each bar's own length.</td></tr>
        <tr><td>Zoom · Fit · Focus</td><td>The zoom slider; <b>Fit</b> frames the whole arrangement; <b>Focus</b> frames the selected clips, or the loop.</td></tr>
        <tr><td>Loop · From · To</td><td>Turns the loop on, from bar <i>From</i> to bar <i>To</i>, both included.</td></tr>
        <tr><td>Record</td><td><b>Overdub</b> or <b>Replace</b>: what a take does to the clips already there (see <a data-goto="recording">Recording</a>).</td></tr>
        <tr><td>Track · Input · Destination</td><td>The selected track's name, where its input comes from, and where it plays.</td></tr>
      </tbody></table>`
  },
  {
    id: 'tracks', title: 'Tracks',
    html: `${DIAGRAM_TRACK}
      <p>A <b>MIDI track</b> plays its clips' notes and controllers into its Destination. Its Input is your controller. An <b>audio track</b> plays its audio clips into its Destination. Its Input is a node cabled into the Sequencer's AUDIO IN — the Audio Input, a VST, an Audio Player. Armed or monitored, it also passes that input on.</p>
      <p><b>Selecting</b> a track (the button on its left edge, or a click in its empty lane) shows it in the toolbar's inspector. The selected track can be made taller with ${k('Alt')}+wheel. It keeps that height, and gets it back each time it is selected again. The others stay at the usual height.</p>`
  },
  {
    id: 'clips', title: 'Clips',
    html: `${DIAGRAM_CLIP}
      <table class="mn-table"><tbody>
        <tr><td>Double-click an empty lane</td><td>A new MIDI clip, one bar long, on a MIDI track; on an audio track, a file to import.</td></tr>
        <tr><td>Click</td><td>Selects the clip. ${k('Ctrl')}-click adds or removes one, ${k('Shift')}-click selects a range, ${k('Ctrl')}+${k('Shift')}-click adds a range.</td></tr>
        <tr><td>Drag in an empty lane</td><td>A band that selects every clip it touches (${k('Ctrl')} or ${k('Shift')}: added to the selection).</td></tr>
        <tr><td>Drag a clip</td><td>Moves the whole selection, on the grid, and to other tracks of the same kind. ${k('Esc')} during the drag puts it back.</td></tr>
        <tr><td>Drag an edge</td><td>Resizes the clip. A MIDI clip shortened keeps its hidden notes; lengthened, it shows them again.</td></tr>
        <tr><td>${k('←')} ${k('→')}</td><td>Moves the selection one Snap step.</td></tr>
        <tr><td>${k('↑')} ${k('↓')}</td><td>Moves the selection to the track above or below.</td></tr>
        <tr><td>${k('S')}</td><td>Splits the selected clips at the playhead.</td></tr>
        <tr><td>${k('Ctrl')}+${k('C')} / ${k('X')} / ${k('V')}</td><td>Copy, cut, paste — at the playhead, or where you right-clicked (<b>Paste here</b>).</td></tr>
        <tr><td>${k('Ctrl')}+${k('D')}</td><td>Duplicates the selection right after itself.</td></tr>
        <tr><td>${k('Ctrl')}+${k('A')}</td><td>Selects every clip.</td></tr>
        <tr><td>${k('Del')}</td><td>Deletes the selection.</td></tr>
      </tbody></table>
      <p>The clip's <b>right-click menu</b>: Open in Clip Editor, Split at playhead, Cut, Copy, Duplicate, Activate / Deactivate, Quantize to the Snap grid (MIDI), the track's time signature from that bar, Delete. The empty lane's: Open Plugin Window, New MIDI clip here / Import audio here, Paste here, time signature, Select all clips.</p>`
  },
  {
    id: 'navigate', title: 'Moving around',
    html: `<table class="mn-table"><tbody>
        <tr><td>Wheel</td><td>Scrolls the tracks up and down — over their heads as over their lanes.</td></tr>
        <tr><td>${k('Shift')}+wheel</td><td>Scrolls along the timeline.</td></tr>
        <tr><td>${k('Ctrl')}+wheel</td><td>Zooms the timeline around the pointer.</td></tr>
        <tr><td>${k('Alt')}+wheel</td><td>Makes the selected track taller or shorter.</td></tr>
        <tr><td>Middle button, drag</td><td>Pans the view in both directions.</td></tr>
        <tr><td>${k('+')} / ${k('-')}</td><td>Zoom in and out (without ${k('Ctrl')}, which is the window's own zoom).</td></tr>
        <tr><td>Navigation bar</td><td>Drag its thumb to travel; drag either end of the thumb to zoom; press the bar to jump there. Its − and + zoom.</td></tr>
      </tbody></table>`
  },
  {
    id: 'meter', title: 'Time signatures',
    html: `<p>The header's signature is the project's at the playhead. The project's signature may change along the song: <b>right-click the bar ruler</b>, <i>Time signature from bar N…</i>. Each change shows as a chip on the ruler. Click it to change it or <b>Remove this change</b>.</p>
      <p>A track may count its own bars (polymetry): right-click its head, its lane or one of its clips, <i>Time signature from bar N…</i>. That track then draws its grid, snaps, and makes its new clips in its own bars; the project's tempo and quarter note stay the same for everyone.</p>
      ${DIAGRAM_METER}
      <p>The menu lists the common signatures; type any other (13/16) in its search field. Numerators go from 1 to 32; denominators are 2, 4, 8 or 16. The metronome, the count-in, the plugins and the Clip Editor follow the signature in force where they are.</p>`
  },
  {
    id: 'recording', title: 'Recording',
    html: `<ol class="mn-steps">
        <li>Choose the track's <b>Input</b> and <b>Destination</b> in the inspector.</li>
        <li><b>Arm</b> it: R. ${k('Ctrl')}- or ${k('Shift')}-click R to arm several tracks for one take.</li>
        <li>Press <b>Record</b> (or Rec on your controller). With the metronome on and the transport stopped, one bar of count-in comes first. Notes you play during it are kept, placed at the start.</li>
        <li>Press <b>Stop</b> (or Space) to end the take. The take is one undo step.</li>
      </ol>
      <p><b>I</b> (monitor) lets you hear a track's input without arming it.</p>
      <h3>Overdub and Replace</h3>
      ${DIAGRAM_OVERDUB}
      <h3>Round a loop</h3>
      ${DIAGRAM_LOOP}
      <h3>What a MIDI take keeps</h3>
      <p>Its notes, and what the wheels, knobs, faders and pedal sent: controllers (CC), pitch bend and pressure. These moves play back at their exact place. On Play, a jump or a loop's return, each controller is set to its last value before that point. On Stop, the sustain pedal is released and the pitch bend goes back to centre. In the clip, they are drawn as an orange stepped line behind the notes.</p>`
  },
  {
    id: 'lanes', title: 'Layered takes',
    html: `<p>Clips that overlap on one track are drawn in <b>lanes</b>, one above the other, so each can be seen, moved, resized and faded. All of them still sound: overlapping is how an overdub layers sound on sound.</p>
      ${DIAGRAM_LANES}
      <p>To keep a take without hearing it, make it <b>inactive</b>: the speaker in its bottom right corner, or <i>Deactivate clip</i> in its right-click menu (for the whole selection). An inactive clip is grey and dashed, and it is left out of playback and of the export. It keeps its speaker even alone, so it can always be made active again.</p>
      <p>Too many lanes to read? Select the track and make it taller with ${k('Alt')}+wheel.</p>`
  },
  {
    id: 'fades', title: 'Fades',
    html: `<p>Audio clips fade in and out as they do in Reaper.</p>
      <ul>
        <li>Over a clip's <b>top left or top right corner</b>, the cursor changes: drag sideways to set the fade's length. Its handle stays where the fade ends, to be dragged again as often as you like.</li>
        <li>Inside a fade, near its curve, drag <b>up or down</b> to bend it.</li>
        <li><b>Right-click inside a fade</b>: its shape — Linear, Fast start, Slow start, their steep versions, S-curve, S-curve steep — and <b>Low pass fade</b>, which closes a filter as the level falls.</li>
        <li>${k('Esc')} during a drag puts the fade back. The two fades may meet, never cross; a cut leaves each half its own fade.</li>
      </ul>`
  },
  {
    id: 'automation', title: 'Automation',
    html: `<p>A controller knob bound to a plugin parameter (with <b>Learn</b>) can be recorded: arm the track that plays that plugin, press Record, and turn the knob. The moves are kept as <b>automation</b> on that track, and play back into the plugin, export included. Its window follows.</p>
      ${DIAGRAM_AUTOMATION}
      <ul>
        <li>During a take, a parameter you turn is yours: its old automation stops playing until the take ends.</li>
        <li>Outside a take, the automation leads.</li>
        <li>Each lane is a yellow line across its track. Right-click the track's head to remove one.</li>
        <li>Moves made with the mouse in a plugin's own window are not recorded — only bound knobs are.</li>
      </ul>`
  },
  {
    id: 'editor', title: 'Clip Editor',
    html: `<p>Double-click a clip, or <i>Open in Clip Editor</i>: it opens in its own window, a piano roll for MIDI and a waveform view for audio. Its transport returns to the start and plays or stops the Sequencer.</p>
      <table class="mn-table"><tbody>
        <tr><td>Double-click the grid</td><td>A new note, one Snap step long, velocity 100.</td></tr>
        <tr><td>Click a note</td><td>Selects it and lets you hear it (${k('Ctrl')}: adds it to the selection). Click a key of the keyboard to hear that pitch.</td></tr>
        <tr><td>Drag a note / its edge</td><td>Moves the selection in time and pitch / changes that note's length.</td></tr>
        <tr><td>Drag on the empty grid</td><td>A lasso that selects notes (${k('Ctrl')} or ${k('Shift')}: added).</td></tr>
        <tr><td>${k('←')} ${k('→')} / ${k('↑')} ${k('↓')}</td><td>Moves the selected notes one Snap step / one semitone.</td></tr>
        <tr><td>${k('Ctrl')}+${k('A')} · ${k('Ctrl')}+${k('D')} · ${k('Del')}</td><td>Select every visible note · duplicate · delete.</td></tr>
        <tr><td>${k('Ctrl')}+wheel · ${k('Ctrl')}+${k('Shift')}+wheel</td><td>Zoom in time · change the rows' height.</td></tr>
        <tr><td>Velocity</td><td>The slider sets the velocity of the selected notes.</td></tr>
        <tr><td>Quantize</td><td>Grid (straight or triplet), Strength, Scope (selected notes or the whole clip), Timing (starts only, or starts and ends), then <b>Apply</b>.</td></tr>
        <tr><td>Fit clip</td><td>Frames the whole clip.</td></tr>
      </tbody></table>
      <p>${k('Ctrl')}+${k('Z')} and ${k('Ctrl')}+${k('Shift')}+${k('Z')} undo and redo from the editor too.</p>`
  },
  {
    id: 'export', title: 'Export',
    html: `<p><b>Export</b> in the header opens the panel: the range — the whole arrangement or the loop — with its length, the format — WAV (bit depth), MP3 (bitrate) or OGG (quality) — and the tail, the seconds kept after the end for reverbs and delays to ring out. The export renders what reaches the Audio Output, faster than real time, and shows its progress.</p>`
  },
  {
    id: 'controller', title: 'Controller transport keys',
    html: `<p>When your controller's profile declares transport keys — on some keyboards, pads pressed with ${k('Shift')} held — they drive the Sequencer:</p>
      <table class="mn-table"><tbody>
        <tr><td>Play</td><td>Plays, and stops what is running — like Space.</td></tr>
        <tr><td>Stop</td><td>Stops.</td></tr>
        <tr><td>Rec</td><td>Starts a take; pressed again, ends it and keeps playing.</td></tr>
        <tr><td>Loop</td><td>Turns the loop on or off.</td></tr>
        <tr><td>Tap</td><td>Taps the tempo.</td></tr>
      </tbody></table>`
  },
  {
    id: 'keys', title: 'Shortcuts',
    html: `<table class="mn-table"><tbody>
        <tr><td>${k('Space')}</td><td>Play / Stop</td></tr>
        <tr><td>${k('Ctrl')}+${k('Z')} · ${k('Ctrl')}+${k('Shift')}+${k('Z')}</td><td>Undo · Redo (zoom, scroll, selection and track heights are not undone)</td></tr>
        <tr><td>${k('Ctrl')}+${k('C')} · ${k('X')} · ${k('V')} · ${k('D')} · ${k('A')}</td><td>Copy · Cut · Paste · Duplicate · Select all</td></tr>
        <tr><td>${k('Del')}</td><td>Delete the selection</td></tr>
        <tr><td>${k('S')}</td><td>Split at the playhead</td></tr>
        <tr><td>${k('←')} ${k('→')} ${k('↑')} ${k('↓')}</td><td>Nudge the selection</td></tr>
        <tr><td>${k('+')} · ${k('-')}</td><td>Zoom in · out</td></tr>
        <tr><td>${k('Esc')}</td><td>Cancel a drag or a selection band</td></tr>
        <tr><td>Wheel · ${k('Shift')}+wheel · ${k('Ctrl')}+wheel · ${k('Alt')}+wheel</td><td>Scroll the tracks · along the timeline · zoom · grow the selected track</td></tr>
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
