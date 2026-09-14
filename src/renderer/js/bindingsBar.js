/**
 * The bindings bar's page: a window docked under one plugin editor.
 *
 * It draws what the main renderer sends and reports what was clicked, and that
 * is all it does. The markup is `renderControlBindings()`'s, escaped where it was
 * built, in the renderer that owns the bindings; this page holds no binding, no
 * profile and no rule about either. src/main/bindingsBarWindows.js, D-021.
 */
import { applyMiniLabSurfaceLayout } from './ui/surfaceLayout.js';
import { controlBindingActionOf } from './core/controlBindingActions.js';

const root = document.getElementById('bindings-bar-root');
const api = window.bindingsBarAPI;

/**
 * How many columns the strip needs before the one holding the help and the
 * Learn toolbar: one per faceplate and one per keyboard name. The grid reads it
 * from `--bar-columns`, set through the CSSOM because the CSP drops a `style`
 * attribute.
 */
function leadingColumns() {
  return [...root.children]
    .filter((child) => !child.matches('.control-bindings-help:first-child, .control-learn-toolbar'))
    .length;
}

api.onRender((html) => {
  root.innerHTML = html;
  root.style.setProperty('--bar-columns', String(Math.max(1, leadingColumns())));
  applyMiniLabSurfaceLayout(root);
});

root.addEventListener('click', (event) => {
  const action = controlBindingActionOf(event.target);
  if (action) api.action(action);
});

api.ready();
