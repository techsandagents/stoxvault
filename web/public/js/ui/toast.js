/**
 * STOXVAULT — toasts.
 *
 * `#toast-region` is `role="status" aria-live="polite"`, so a toast announces
 * itself once and then gets out of the way. Rules from web/DOM.md section 13:
 *
 *   - info and success auto-dismiss after ~4s
 *   - an error that offers a retry never auto-dismisses; the user decides
 *   - at most three at a time, oldest dropped
 *   - errors are for real failures. "No token yet" is an empty state, not an error.
 */

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 4000;

let region = null;
let template = null;

function mount() {
  if (!region) region = document.getElementById('toast-region');
  if (!template) template = document.getElementById('tpl-toast');
  return Boolean(region && template);
}

function dismiss(node) {
  if (!node || !node.isConnected) return;
  if (node.__timer) clearTimeout(node.__timer);
  node.remove();
}

/**
 * Show a toast.
 *
 * @param {object} options
 * @param {'info'|'success'|'warn'|'error'} [options.kind='info']
 * @param {string} options.title   three or four words
 * @param {string} [options.text]  one sentence
 * @param {() => void} [options.onRetry] shows the Retry button
 * @param {string} [options.retryLabel='Retry']
 * @param {number} [options.timeout] override the auto-dismiss (0 = sticky)
 * @param {string} [options.key] replaces an existing toast with the same key,
 *                               so a polling failure cannot stack up
 * @returns {() => void} dismiss this toast
 */
export function toast({ kind = 'info', title, text = '', onRetry = null, retryLabel = 'Retry', timeout, key } = {}) {
  if (!mount()) return () => {};

  if (key) {
    for (const existing of region.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) dismiss(existing);
  }

  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.kind = kind;
  if (key) node.dataset.key = key;

  node.querySelector('[data-field="title"]').textContent = title || defaultTitle(kind);
  const textEl = node.querySelector('[data-field="text"]');
  textEl.textContent = text || '';
  textEl.hidden = !text;

  const actions = node.querySelector('[data-role="actions"]');
  const retryBtn = actions ? actions.querySelector('[data-action="retry"]') : null;
  if (onRetry && actions && retryBtn) {
    actions.hidden = false;
    retryBtn.textContent = retryLabel;
    retryBtn.addEventListener('click', () => {
      dismiss(node);
      try {
        onRetry();
      } catch (err) {
        /* a failing retry handler must not take the page with it */
      }
    });
  }

  const closeBtn = node.querySelector('[data-action="dismiss"]');
  if (closeBtn) closeBtn.addEventListener('click', () => dismiss(node));

  region.appendChild(node);

  while (region.children.length > MAX_TOASTS) dismiss(region.firstElementChild);

  const sticky = kind === 'error' && onRetry;
  const ms = timeout === undefined ? (sticky ? 0 : kind === 'error' ? 8000 : AUTO_DISMISS_MS) : timeout;
  if (ms > 0) node.__timer = setTimeout(() => dismiss(node), ms);

  return () => dismiss(node);
}

function defaultTitle(kind) {
  switch (kind) {
    case 'success':
      return 'Done';
    case 'warn':
      return 'Heads up';
    case 'error':
      return 'Something failed';
    default:
      return 'Note';
  }
}

/** Convenience wrappers so call sites read as sentences. */
export const info = (title, text, opts) => toast({ ...opts, kind: 'info', title, text });
export const success = (title, text, opts) => toast({ ...opts, kind: 'success', title, text });
export const warn = (title, text, opts) => toast({ ...opts, kind: 'warn', title, text });
export const error = (title, text, opts) => toast({ ...opts, kind: 'error', title, text });

/** Remove every toast — used when the page is refreshed wholesale. */
export function clearToasts() {
  if (!mount()) return;
  for (const node of [...region.children]) dismiss(node);
}

/**
 * The last-resort copy path for browsers where `navigator.clipboard` is absent
 * or refuses (an insecure origin, a denied permission). A detached, off-screen
 * textarea is selected and `document.execCommand('copy')` is asked to take it;
 * the node is removed and the previous selection restored either way.
 *
 * @param {string} text
 * @returns {boolean} whether the copy actually happened
 */
function legacyCopy(text) {
  if (typeof document.execCommand !== 'function') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  let ok = false;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  } finally {
    area.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
  return ok;
}

/**
 * The copy-to-clipboard helper every copy button on the page shares.
 * `navigator.clipboard` rejects in an insecure context and when the permission
 * is denied, so there is a `execCommand` fallback behind it, and if that fails
 * too the user is told plainly rather than left with an unhandled rejection.
 *
 * @param {string} text the full value — never the truncated one
 * @param {HTMLElement} button the button to flash
 * @param {string} label what was copied, for the toast
 */
export async function copyToClipboard(text, button, label = 'Copied') {
  if (!text) return false;

  let copied = false;
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard API');
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (err) {
    copied = legacyCopy(text);
  }

  if (copied) {
    if (button) {
      button.classList.add('is-copied');
      setTimeout(() => button.classList.remove('is-copied'), 1200);
    }
    toast({ kind: 'success', title: 'Copied', text: label, key: 'copy' });
    return true;
  }

  toast({
    kind: 'error',
    title: 'Could not copy',
    text: 'Your browser blocked clipboard access. Select the text and copy it manually.',
    key: 'copy',
  });
  return false;
}

export default { toast, info, success, warn, error, clearToasts, copyToClipboard };
