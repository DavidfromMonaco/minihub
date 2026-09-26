/**
 * The interface's layouts: Original, one page at a time, and Hybrid 1, the
 * Sequencer above and the Patch Bay -- or the page opened from the sidebar --
 * below. Asked by the author on 2026-09-26: playing the MiniLab meant going
 * back and forth between the Patch Bay and the Sequencer all session long.
 *
 * WHAT HYBRID 1 IS, MECHANICALLY
 * ------------------------------
 * The page area stays `#content`, below: every page still mounts there, and
 * every caller that opens one is unchanged. Above it, `#content-top` holds the
 * Sequencer, docked (`ModuleSystem.dock`) for as long as the layout lasts. The
 * two are separated by a bar that is dragged, and the share it leaves the
 * Sequencer is remembered, like the layout itself: both are the user's, not a
 * project's -- a project sent to someone does not impose its author's screen.
 *
 * The screen never decides the sound (invariant 2): a layout mounts and
 * unmounts pages, it touches no cable.
 *
 * THE KEYBOARD
 * ------------
 * Both pages answer Ctrl+C, Ctrl+V, Ctrl+D and Delete, and both would, at
 * once. The keys go to the half pressed last -- `paneHasKeys` is what each
 * page asks first -- and that half wears a thin outline. Space, Ctrl+Z and the
 * menus stay global: they are the application's, not a page's.
 */

export const LAYOUTS = Object.freeze(['original', 'hybrid-1']);
const LAYOUT_KEY = 'interfaceLayout';
const SPLIT_KEY = 'hybridSplit';
const DOCKED_MODULE = 'sequencer';
/** What the lower page shows when the Sequencer leaves it for the top. */
const LOWER_DEFAULT = 'routing';
/** The Sequencer's share of the height: never so small or so large that the
 *  other half is a strip nobody can use. */
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;
const SPLIT_DEFAULT = 0.5;
const SPLIT_STEP = 0.05;

export function normalizeLayout(value) {
  return LAYOUTS.includes(value) ? value : 'original';
}

export function clampSplit(value) {
  const share = Number(value);
  return Number.isFinite(share) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, share)) : SPLIT_DEFAULT;
}

/**
 * May the page mounted in `container` take a keystroke? Always, in the
 * Original layout -- a page alone on screen owns the keyboard, as it always
 * did. In Hybrid 1, only the half pressed last.
 */
export function paneHasKeys(container) {
  const pane = container?.closest?.('[data-pane]');
  return !pane || pane.classList.contains('pane-active');
}

export function installInterfaceLayout(hub, {
  root = globalThis.document,
  workspace = root?.getElementById?.('workspace'),
  top = root?.getElementById?.('content-top'),
  splitter = root?.getElementById?.('pane-splitter'),
  main = root?.getElementById?.('content'),
  keys = [...(root?.querySelectorAll?.('[data-layout]') || [])]
} = {}) {
  if (!workspace || !top || !splitter || !main) return null;
  let current = 'original';
  let split = clampSplit(hub.settings.get(SPLIT_KEY));
  // The Original layout's state, whatever the markup said.
  top.hidden = true;
  splitter.hidden = true;

  const setActivePane = (pane) => {
    for (const element of [top, main]) element.classList.toggle('pane-active', element === pane);
  };
  // Capture, so the half is chosen before the page under the pointer acts on
  // the press -- a Ctrl+D right after a click must go where the click went.
  const onPress = (event) => {
    if (current === 'original') return;
    setActivePane(top.contains(event.target) ? top : main);
  };
  workspace.addEventListener('pointerdown', onPress, true);
  workspace.addEventListener('focusin', onPress, true);

  const applySplit = () => {
    // CSSOM, which the CSP allows; a style attribute it would drop in silence.
    top.style.flexBasis = `${split * 100}%`;
    splitter.setAttribute('aria-valuenow', String(Math.round(split * 100)));
  };

  const renderKeys = () => {
    for (const key of keys) key.setAttribute('aria-pressed', String(key.dataset.layout === current));
  };

  function set(name) {
    const next = normalizeLayout(name);
    if (next === current) {
      renderKeys();
      return current;
    }
    current = next;
    const hybrid = current === 'hybrid-1';
    workspace.classList.toggle('layout-hybrid', hybrid);
    top.hidden = !hybrid;
    splitter.hidden = !hybrid;
    if (hybrid) {
      top.dataset.pane = 'top';
      main.dataset.pane = 'bottom';
      // The Sequencer cannot be in both halves: the page it leaves shows the
      // Patch Bay, the other half of what the author works between.
      if (hub.modules.activeId === DOCKED_MODULE) hub.modules.activate(LOWER_DEFAULT, main);
      hub.modules.dock(DOCKED_MODULE, top);
      applySplit();
      setActivePane(top);
    } else {
      hub.modules.undock();
      delete top.dataset.pane;
      delete main.dataset.pane;
      top.classList.remove('pane-active');
      main.classList.remove('pane-active');
    }
    hub.settings.set(LAYOUT_KEY, current);
    renderKeys();
    hub.events.emit('layout:changed', current);
    return current;
  }

  // ---- the bar between the halves ----
  const shareAt = (clientY) => {
    const box = workspace.getBoundingClientRect();
    return box.height > 0 ? (clientY - box.top) / box.height : split;
  };
  const commitSplit = (value) => {
    split = clampSplit(value);
    applySplit();
  };
  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.classList.add('dragging');
    const move = (moveEvent) => commitSplit(shareAt(moveEvent.clientY));
    const up = () => {
      splitter.classList.remove('dragging');
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', up);
      hub.settings.set(SPLIT_KEY, split);
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
  });
  // A double-click puts it back in the middle, as a divider does elsewhere.
  splitter.addEventListener('dblclick', () => {
    commitSplit(SPLIT_DEFAULT);
    hub.settings.set(SPLIT_KEY, split);
  });
  splitter.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowUp' ? -SPLIT_STEP : event.key === 'ArrowDown' ? SPLIT_STEP : 0;
    if (!step) return;
    event.preventDefault();
    commitSplit(split + step);
    hub.settings.set(SPLIT_KEY, split);
  });

  for (const key of keys) key.addEventListener('click', () => set(key.dataset.layout));

  const layout = { get current() { return current; }, set, LAYOUTS };
  hub.layout = layout;
  renderKeys();
  set(hub.settings.get(LAYOUT_KEY));
  return layout;
}
