/**
 * Home module: the four project actions, and what MiniHub is.
 *
 * Two columns. The left one is the only place a project starts, so each action
 * is a full-width card rather than one of four small tiles: the picture is the
 * fastest way to tell them apart, and the label says the same thing in words.
 * The right one answers the question a first launch actually asks -- what is
 * this, and how finished is it -- and offers the three places where the rest of
 * the answer lives.
 *
 * Every card is a <button>: the keyboard reaches it, Enter and Space work, and
 * a disabled card stops being reachable without any code of ours.
 */
import { escapeHtml } from '../../core/html.js';
import { BUILD_STAMP } from '../../core/buildStamp.js';
import {
  newIcon, currentIcon, loadIcon, templatesIcon, departureArrow
} from './homeIcons.js';

/**
 * One card. `art` is the picture behind it, `accent` the colour of its icon.
 *
 * The four nested spans are not decoration: a `clip-path` cuts the corners off
 * a box and takes its border with it, so the outline is drawn as a filled shape
 * with an identical shape inset 1px on top of it -- once for the card, once for
 * the picture's slanted edge. That is where the frame lines of the design come
 * from; a `border` cannot follow a bevel.
 */
function card({ action, accent, art, alt, icon, title, subtitle, enabled = true }) {
  return `
    <button class="home-card" type="button" data-project-action="${action}" data-accent="${accent}"${enabled ? '' : ' disabled'}>
      <span class="home-card-frame">
        <span class="home-card-face">
          <span class="home-card-art">
            <span class="home-card-art-face">
              <img class="home-card-photo" src="assets/home/${art}" alt="${escapeHtml(alt)}" draggable="false" />
            </span>
          </span>
          <span class="home-card-body">
            <span class="home-card-icon">${icon}</span>
            <span class="home-card-title">${escapeHtml(title)}</span>
            <span class="home-card-sub">${escapeHtml(subtitle)}</span>
          </span>
        </span>
      </span>
    </button>`;
}

/**
 * One button that leaves MiniHub. It names the host it opens in its own label,
 * rather than behind a confirmation nobody wants asked twice -- the same rule
 * as the Browse setups button, and one test holds both to it. The renderer
 * names a destination; `src/main/externalLinks.js` owns the address and refuses
 * any other name.
 */
function departure(destination, label, host) {
  return `
    <button class="btn home-link" type="button" data-site="${destination}">
      ${departureArrow()}<span class="home-link-text">${label}</span><span class="home-link-host">${host}</span>
    </button>`;
}

export function createHomeModule(hub) { return {
  id: 'home',
  name: 'Home',
  navEntry: { label: 'Home', icon: 'home', group: 'home', fixed: true },

  mount(container) {
    const recentName = hub.settings.get('recentProjectName');
    const recentPath = hub.settings.get('recentProjectPath');
    container.innerHTML = `
      <div class="home-page">
        <div class="home-actions">
          ${card({
            action: 'new', accent: 'amber', art: 'new-project.jpg',
            alt: 'A long-necked dinosaur watching a meteor come down: the world before the project.',
            icon: newIcon(), title: 'New', subtitle: 'Start a new project'
          })}
          ${card({
            action: 'recent', accent: 'blue', art: 'current-project.jpg',
            alt: 'A robotic arm lifting one lit crate out of a stack of identical dark ones.',
            icon: currentIcon(), title: 'Current Project',
            subtitle: recentName || 'No recent project', enabled: Boolean(recentPath)
          })}
          ${card({
            action: 'load', accent: 'amber', art: 'load-project.jpg',
            alt: 'A robotic arm pulling a glowing crate out of a warehouse shelf.',
            icon: loadIcon(), title: 'Load', subtitle: 'Open an existing project'
          })}
          ${card({
            action: 'template', accent: 'purple', art: 'templates.jpg',
            alt: 'Identical crates travelling down a conveyor, one of them lit.',
            icon: templatesIcon(), title: 'Templates', subtitle: 'Use a project template'
          })}
        </div>
        <section class="home-about">
          <h1 class="home-about-title">Welcome to MiniHub</h1>
          <p class="home-about-lead">
            Create something new, continue your work, load an existing project,
            or start from a template.
          </p>
          <p class="home-about-text">
            MiniHub turns an Arturia MiniLab 3 into a desktop music workstation:
            a Patch Bay where nodes are joined by typed cables, a native VST3
            host, a sample-accurate MIDI and audio sequencer, and physical knobs
            bound to the parameters of your own plugins.
          </p>
          <div class="home-about-state">
            <span class="pill warn">Pre-alpha ${escapeHtml(BUILD_STAMP.version)}</span>
            <p class="home-about-text">
              Under active development, and honest about it: the Patch Bay, the
              VST3 host, the Sequencer and control learning are built and
              covered by automated tests, while other corners are unfinished.
              Nothing leaves this machine &mdash; MiniHub makes no network call,
              and works with no connection at all.
            </p>
          </div>
          <div class="home-about-links">
            ${departure('source', 'Source code', 'github.com/DavidfromMonaco/minihub')}
            ${departure('site', 'Website', 'minihub.site')}
            ${departure('report', 'Report a bug', 'github.com')}
          </div>
          <p class="home-about-note">
            Reporting opens a pre-filled issue in your browser, with your
            version, build and Windows release already written in it. Nothing is
            sent until you post it yourself.
          </p>
          <p class="home-about-error" id="home-link-error" hidden></p>
        </section>
      </div>`;
    // A card is a button wrapping a picture, an icon and two labels, so the
    // click always lands on one of those children - reading `event.target`
    // alone matched almost nothing and the tiles did nothing at all.
    container.onclick = (event) => {
      const target = event.target?.closest?.('[data-project-action], [data-site]');
      if (!target) return;
      const action = target.dataset?.projectAction;
      if (action === 'new') hub.project.newProject();
      if (action === 'template') hub.project.newFromBasicTemplate();
      if (action === 'recent' && recentPath) hub.project.load(recentPath);
      if (action === 'load') hub.project.load();
      const destination = target.dataset?.site;
      if (destination) this._open(destination, container);
    };
    this._container = container;
  },

  /**
   * Open a named place outside MiniHub. A refusal is reported in the page: the
   * browser coming up is the only feedback a success gets, so a failure that
   * said nothing would look exactly like a click that did nothing.
   */
  async _open(destination, container) {
    const opened = await Promise.resolve(hub.api?.siteOpen?.(destination)).catch(() => false);
    const error = container.querySelector?.('#home-link-error');
    if (!error) return;
    if (opened) { error.hidden = true; error.textContent = ''; return; }
    error.textContent = 'That page could not be opened. Your browser refused it, or none is set.';
    error.hidden = false;
  },

  // `#content` is shared by every module: leaving the handler installed lets
  // Home react to clicks on another module's page.
  unmount() {
    if (this._container) this._container.onclick = null;
    this._container = null;
  }
}; }
