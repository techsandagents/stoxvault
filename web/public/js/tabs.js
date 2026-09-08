/**
 * STOXVAULT — the tab bar.
 *
 * The page is one screen with five panels and exactly one of them visible, so
 * this is the only navigation on the site. It is a real ARIA tablist, not a set
 * of links dressed up as one:
 *
 *   - roving tabindex: the selected tab is the only one reachable with Tab
 *   - ArrowLeft/ArrowRight (and Up/Down) move selection AND focus, wrapping
 *   - Home/End jump to the ends; Enter and Space activate natively (they are
 *     buttons), so no key handler fights the browser
 *   - `aria-selected` and the panels' `hidden` are written together, never apart
 *
 * The selection is mirrored into the URL hash with `history.replaceState`, never
 * `location.hash =`, which would scroll the page. An unknown or empty hash — a
 * skip link's `#main` included — falls back to Overview.
 *
 * Switching a tab does not fetch anything. `onSelect` is the hook the app uses
 * to build a panel the first time it is opened and to stop animating the ones
 * that are not on screen.
 */

const FALLBACK = 'overview';

/** The tab a hash names, or Overview when it names nothing we have. */
export function tabFromHash(hash, names) {
  const raw = String(hash || '')
    .replace(/^#/, '')
    .trim()
    .toLowerCase();
  return names.includes(raw) ? raw : FALLBACK;
}

export function createTabs({ onSelect } = {}) {
  const bar = document.getElementById('tab-bar');
  const tabs = bar ? [...bar.querySelectorAll('[role="tab"]')] : [];

  if (!bar || tabs.length === 0) {
    return { select() {}, current: () => null, names: () => [], start() {} };
  }

  const byName = new Map(tabs.map((tab) => [tab.dataset.tab, tab]));
  const names = tabs.map((tab) => tab.dataset.tab);
  let current = null;

  const panelOf = (tab) => {
    const id = tab.getAttribute('aria-controls');
    return id ? document.getElementById(id) : null;
  };

  function writeHash(name) {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    const next = `#${name}`;
    if (window.location.hash === next) return;
    try {
      window.history.replaceState(null, '', next);
    } catch (err) {
      /* a sandboxed frame can refuse this; the tab still switches */
    }
  }

  /**
   * @param {string} name
   * @param {object} [options]
   * @param {boolean} [options.focus]  move focus to the tab (keyboard/click)
   * @param {boolean} [options.scroll] keep the tab in view in the phone scroller
   * @param {boolean} [options.hash]   mirror into the URL
   */
  function select(name, { focus = false, scroll = true, hash = true } = {}) {
    const tab = byName.get(name) || byName.get(FALLBACK) || tabs[0];
    if (!tab) return;

    for (const other of tabs) {
      const on = other === tab;
      other.setAttribute('aria-selected', on ? 'true' : 'false');
      other.tabIndex = on ? 0 : -1;
      const panel = panelOf(other);
      if (panel) panel.hidden = !on;
    }

    if (focus) tab.focus();
    if (scroll && typeof tab.scrollIntoView === 'function') {
      tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    if (hash) writeHash(tab.dataset.tab);

    const previous = current;
    current = tab.dataset.tab;
    // The callback runs even on a repeat selection of the same tab only when it
    // is the first one — the app uses it to build a panel exactly once.
    if (previous !== current && typeof onSelect === 'function') onSelect(current, previous);
  }

  bar.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tab.dataset.tab) select(tab.dataset.tab, { focus: true });
  });

  bar.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = tabs.findIndex((tab) => tab.dataset.tab === current);
    if (index < 0) return;

    let next = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = tabs[(index + 1) % tabs.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = tabs[(index - 1 + tabs.length) % tabs.length];
        break;
      case 'Home':
        next = tabs[0];
        break;
      case 'End':
        next = tabs[tabs.length - 1];
        break;
      default:
        return; // Tab, Enter and Space belong to the browser
    }

    event.preventDefault();
    select(next.dataset.tab, { focus: true });
  });

  // "…pick your basket" links inside the How-it-works prose. They are buttons,
  // not anchors, because they switch panel rather than navigate.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-tab-link]');
    if (!link) return;
    const name = link.dataset.tabLink;
    if (!byName.has(name)) return;
    event.preventDefault();
    select(name, { focus: true });
  });

  window.addEventListener('hashchange', () => {
    // Someone edited the address bar, used Back, or followed `#main`. Unknown
    // hashes land on Overview, which is also what the brand link should do.
    select(tabFromHash(window.location.hash, names), { hash: false });
  });

  return {
    /** Read the hash and select. Called once, after the panels are wired. */
    start() {
      select(tabFromHash(window.location.hash, names), {
        scroll: false,
        hash: Boolean(window.location.hash),
      });
    },
    select,
    current: () => current,
    names: () => names.slice(),
  };
}

export default createTabs;
