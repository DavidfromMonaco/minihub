import { COMMON_TIME, loopBars } from '../core/musicalTime.js';

/**
 * Export, in the header beside the transport (D-056).
 *
 * It lived in the Sequencer's toolbar, which made it look like an export of
 * the arrangement. It never was: the engine renders the Audio Output, so a
 * file played by an Audio Player through a chain of effects is exported with
 * no Sequencer in the patch at all. The author processed a file that way and
 * had to open the Sequencer to find the button -- and got one bar, since the
 * length came from the arrangement alone (`SequencerController.exportSpan`).
 *
 * The button opens a panel under it: what is exported and for how long, the
 * format, the tail, and while it renders, where it is. The choices live on the
 * controller (`exportOptions`), so the next opening remembers them.
 *
 * Built with `createElement` and `textContent` -- a file path and an engine
 * message reach it (invariant 9) -- and placed through the CSSOM, since the
 * CSP drops a `style` attribute (invariant 10). Everything it listens to is
 * removed when it closes.
 */

const FORMATS = [['wav', 'WAV'], ['mp3', 'MP3'], ['ogg', 'OGG Vorbis']];
const WAV_BITS = [16, 24, 32];
const MP3_RATES = [128, 192, 256, 320];

/** "3:48", or "0:04" -- what a length in seconds reads as. */
export function clockText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The line under the buttons: what the last export did, or what this one is doing. */
export function exportStatusText(status, exporting) {
  const stage = String(status?.stage || '').replaceAll('-', ' ');
  if (status?.state === 'complete') return `Saved ${status.filePath || ''}`.trim();
  if (status?.state === 'error') return String(status.message || 'The export failed');
  if (status?.state === 'cancelled') return 'Export cancelled';
  if (status?.state === 'preparing') return `Preparing…${stage ? ` ${stage}` : ''}`;
  if (status?.state === 'finalizing') return 'Finalizing and closing the file…';
  if (!exporting) return '';
  const progress = Number(status?.progress);
  const speed = Number(status?.realtimeSpeed);
  return `Rendering…${Number.isFinite(progress) ? ` ${Math.round(progress * 100)}%` : ''}`
    + `${Number.isFinite(speed) && speed > 0 ? ` · ${speed.toFixed(2)}× realtime` : ''}`;
}

/** What the range selector says of each span: its length, and what it comes from. */
export function spanLabel(range, span, tempo, signature = COMMON_TIME) {
  const seconds = Math.max(0, (Number(span?.endPpq) || 0) - (Number(span?.startPpq) || 0)) * 60 / (Number(tempo) || 120);
  if (range === 'loop') {
    // Read as the loop fields read it, so the two never name different bars.
    const bars = loopBars(span, signature);
    const from = Math.floor(bars.from + 1e-9);
    const to = Math.max(from, Math.ceil(bars.to - 1e-9));
    return `Loop — bars ${from} to ${to}, ${clockText(seconds)}`;
  }
  const from = span?.source === 'players' ? 'the Audio Players'
    : span?.source === 'arrangement' ? 'the arrangement' : 'nothing plays yet';
  return `Whole — ${clockText(seconds)}, ${from}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function option(select, value, label, { selected = false, disabled = false } = {}) {
  const node = el('option', '', label);
  node.value = String(value);
  if (selected) node.selected = true;
  if (disabled) node.disabled = true;
  select.appendChild(node);
  return node;
}

function field(labelText, control) {
  const label = el('label', 'export-field');
  label.appendChild(el('span', 'export-field-label', labelText));
  label.appendChild(control);
  return label;
}

export function installExportPanel(hub, button = globalThis.document?.getElementById?.('transport-export')) {
  if (!button?.addEventListener) return () => {};
  const controller = () => hub.sequencer;
  let status = null;
  let panel = null;

  const renderButton = () => {
    const exporting = controller()?.exporting === true;
    const progress = Number(status?.progress);
    button.textContent = exporting && Number.isFinite(progress) ? `Export ${Math.round(progress * 100)}%` : 'Export';
    button.classList.toggle('busy', exporting);
    button.classList.toggle('failed', !exporting && status?.state === 'error');
  };

  function open() {
    const seq = controller();
    if (!seq || panel) return;
    const options = seq.exportOptions;
    const element = el('div', 'export-panel');
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', 'Export');
    const listeners = [];
    const listen = (target, type, handler, capture) => {
      target?.addEventListener?.(type, handler, capture);
      listeners.push(() => target?.removeEventListener?.(type, handler, capture));
    };

    const head = el('div', 'export-panel-head');
    head.appendChild(el('span', 'export-panel-title', 'Export'));
    head.appendChild(el('span', 'export-panel-note', 'what reaches the Audio Output'));
    element.appendChild(head);

    const range = el('select');
    range.setAttribute('aria-label', 'What to export');
    element.appendChild(field('Range', range));

    const formatRow = el('div', 'export-row');
    const format = el('select');
    format.setAttribute('aria-label', 'Format');
    for (const [value, label] of FORMATS) {
      option(format, value, label, {
        selected: options.format === value,
        disabled: value === 'mp3' && seq.exportCapabilities?.mp3Available === false
      });
    }
    formatRow.appendChild(field('Format', format));
    const quality = el('select');
    const qualityField = field('', quality);
    const qualityCaption = qualityField.children[0];
    formatRow.appendChild(qualityField);
    const tail = el('input');
    tail.setAttribute('type', 'number');
    tail.setAttribute('min', '0');
    tail.setAttribute('max', '30');
    tail.setAttribute('step', '0.5');
    tail.setAttribute('aria-label', 'Tail in seconds');
    tail.value = String(options.tailSeconds);
    formatRow.appendChild(field('Tail (s)', tail));
    element.appendChild(formatRow);

    const actions = el('div', 'export-row export-actions');
    const start = el('button', 'btn primary', 'Export…');
    start.setAttribute('type', 'button');
    const cancel = el('button', 'btn', 'Cancel');
    cancel.setAttribute('type', 'button');
    actions.appendChild(start);
    actions.appendChild(cancel);
    element.appendChild(actions);
    const line = el('div', 'export-status');
    line.setAttribute('role', 'status');
    element.appendChild(line);

    const fillRange = () => {
      const loopOn = seq.model?.state?.loop?.enabled === true;
      if (!loopOn && options.range === 'loop') options.range = 'full';
      range.replaceChildren();
      option(range, 'full', spanLabel('full', seq.exportSpan('full'), seq.tempo, seq.projectRegions?.() ?? seq.signature), { selected: options.range !== 'loop' });
      const loop = option(range, 'loop', loopOn ? spanLabel('loop', seq.exportSpan('loop'), seq.tempo, seq.projectRegions?.() ?? seq.signature) : 'Loop — turn the loop on first',
        { selected: options.range === 'loop', disabled: !loopOn });
      loop.title = loopOn ? '' : 'The loop is set in the Sequencer';
    };
    // The one control that depends on the format: bit depth, bitrate or quality.
    const fillQuality = () => {
      quality.replaceChildren();
      if (options.format === 'mp3') {
        qualityCaption.textContent = 'Bitrate';
        for (const rate of MP3_RATES) option(quality, rate, `${rate} kbps`, { selected: Number(options.bitrateKbps) === rate });
      } else if (options.format === 'ogg') {
        qualityCaption.textContent = 'Quality';
        const names = Array.isArray(seq.exportCapabilities?.oggQualityOptions) ? seq.exportCapabilities.oggQualityOptions : [];
        const chosen = options.qualityIndex >= 0 ? Math.min(options.qualityIndex, names.length - 1) : names.length - 1;
        if (!names.length) option(quality, -1, 'High', { selected: true });
        names.forEach((name, index) => option(quality, index, name, { selected: index === chosen }));
      } else {
        qualityCaption.textContent = 'Bit depth';
        for (const bits of WAV_BITS) option(quality, bits, `${bits}-bit`, { selected: Number(options.bits) === bits });
      }
    };
    const fillState = () => {
      const exporting = seq.exporting === true;
      start.disabled = exporting;
      cancel.disabled = !exporting;
      line.textContent = exportStatusText(status, exporting);
      line.classList.toggle('error', status?.state === 'error');
    };

    listen(range, 'change', () => { options.range = range.value === 'loop' ? 'loop' : 'full'; });
    listen(format, 'change', () => { options.format = format.value; fillQuality(); });
    listen(quality, 'change', () => {
      const value = Number(quality.value);
      if (options.format === 'mp3') options.bitrateKbps = value;
      else if (options.format === 'ogg') options.qualityIndex = value;
      else options.bits = value;
    });
    listen(tail, 'change', () => {
      const value = Number(tail.value);
      options.tailSeconds = Number.isFinite(value) ? Math.max(0, Math.min(30, value)) : 2;
      tail.value = String(options.tailSeconds);
    });
    listen(start, 'click', () => { seq.exportMaster(options.range === 'loop' ? 'loop' : 'full', { ...options }); });
    listen(cancel, 'click', () => { seq.cancelExport(); });

    // A press outside closes it, except on its own button, whose click does.
    const inside = (node) => {
      for (let current = node; current; current = current.parentNode) if (current === element || current === button) return true;
      return false;
    };
    listen(document, 'pointerdown', (event) => { if (!inside(event?.target)) close(); }, true);
    listen(document, 'keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault?.(); close(); }
    }, true);
    listen(globalThis, 'resize', () => close());
    const offs = [
      hub.events.on('sequencer:export', fillState),
      hub.events.on('sequencer:export-capabilities', fillQuality),
      hub.events.on('sequencer:changed', fillRange),
      hub.events.on('sequencer:tempo', fillRange),
      hub.events.on('sequencer:playScope', fillRange),
      hub.events.on('audioPlayer:file', fillRange),
      hub.events.on('network:change', fillRange)
    ];

    function close() {
      if (!panel) return;
      for (const off of listeners) off();
      for (const off of offs) off?.();
      element.remove();
      panel = null;
      button.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    }

    fillRange();
    fillQuality();
    fillState();
    document.body.appendChild(element);
    // Under the button, its right edge on the button's, kept on screen.
    const box = button.getBoundingClientRect();
    const width = element.offsetWidth || 0;
    const left = Math.max(8, Math.min(box.right - width, (Number(globalThis.innerWidth) || box.right) - width - 8));
    element.style.left = `${left}px`;
    element.style.top = `${box.bottom + 6}px`;
    button.classList.add('open');
    button.setAttribute('aria-expanded', 'true');
    panel = { element, close };
    start.focus?.();
  }

  const onClick = () => (panel ? panel.close() : open());
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', onClick);
  const offs = [
    hub.events.on('sequencer:export', (message) => {
      status = message || null;
      renderButton();
      // An export that fails with the panel closed would say so nowhere.
      if (message?.state === 'error' && !panel) open();
    })
  ];
  renderButton();
  return () => {
    panel?.close();
    button.removeEventListener('click', onClick);
    for (const off of offs) off?.();
  };
}
