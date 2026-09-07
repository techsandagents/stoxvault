/**
 * STOXVAULT — runtime configuration.
 *
 * A classic script (not a module) so it runs before app.js and can be edited by
 * hand on a deployed host without a build step. It sets exactly one thing:
 *
 *   window.STOCKDROP.apiBase   the origin every request in js/api.js is built on
 *
 * Resolution order:
 *   1. <meta name="api-base" content="..."> in index.html — the one-line switch
 *   2. ?api=<url> on the page URL — for pointing a local page at a remote server
 *      while debugging (kept out of localStorage on purpose; it is not sticky)
 *   3. http://localhost:4700 when the page itself is served from localhost
 *   4. the Railway deployment
 *
 * A trailing slash is stripped so `apiBase + '/api/config'` is always right, and
 * a value that is not a parsable http(s) URL is rejected rather than silently
 * producing broken requests.
 */
(function bootConfig(global) {
  'use strict';

  var LOCAL_API = 'http://localhost:4700';
  var REMOTE_API = 'https://stockdrop-production.up.railway.app';

  var LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', ''];

  /** Trim, drop a trailing slash, and require an absolute http(s) URL. */
  function clean(value) {
    if (typeof value !== 'string') return null;
    var raw = value.trim();
    if (!raw) return null;
    var url;
    try {
      url = new URL(raw, global.location ? global.location.href : undefined);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    var out = url.origin + url.pathname;
    return out.replace(/\/+$/, '');
  }

  function fromMeta() {
    if (!global.document || !global.document.querySelector) return null;
    var el = global.document.querySelector('meta[name="api-base"]');
    return el ? clean(el.getAttribute('content')) : null;
  }

  function isLocalHost(host) {
    var h = typeof host === 'string' ? host : (global.location ? global.location.hostname : '');
    if (LOCAL_HOSTS.indexOf(h) !== -1) return true;
    // 192.168.x.x / 10.x.x.x — a phone testing against the dev machine
    return /^(?:10|127)\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h);
  }

  /**
   * `?api=` is a DEVELOPMENT switch, and it is deliberately crippled.
   *
   * Every API call carries the session bearer token, so an attacker who can
   * choose the API origin can harvest it: send someone
   * `https://<the real site>/?api=https://attacker.example`, they open a page
   * that looks entirely legitimate, and their token is posted straight to the
   * attacker. The page origin, the TLS certificate and the padlock all still
   * look right, which is what makes it dangerous.
   *
   * So it is honoured only when BOTH the page and the target are local: on a
   * deployed origin the parameter is ignored outright, and even locally it
   * cannot be pointed at a remote host. To develop against a remote API, set
   * the <meta name="api-base"> tag instead — that requires editing the page,
   * which an attacker sending a link cannot do.
   */
  function fromQuery() {
    if (!global.location || !global.location.search) return null;
    if (!isLocalHost()) return null;
    var raw;
    try {
      raw = clean(new URLSearchParams(global.location.search).get('api'));
    } catch (err) {
      return null;
    }
    if (!raw) return null;
    try {
      if (!isLocalHost(new URL(raw).hostname)) return null;
    } catch (err) {
      return null;
    }
    return raw;
  }

  var existing = global.STOCKDROP && typeof global.STOCKDROP === 'object' ? global.STOCKDROP : {};

  // First source that yields a usable URL wins. `apiSource` records which one it
  // was so the footer and a console check can be honest about which server the
  // page is talking to.
  // A page served from localhost is a developer running the local server, so the
  // local API wins over the deployed <meta> value. Without this, opening the static
  // site locally would silently talk to production. An explicit ?api= still wins,
  // so a local page can still be pointed at a remote server on purpose.
  var candidates = [
    ['query', fromQuery()],
    ['preset', clean(existing.apiBase)],
    [isLocalHost() ? 'localhost-default' : null, isLocalHost() ? LOCAL_API : null],
    ['meta', fromMeta()],
    ['built-in-default', REMOTE_API],
  ];

  var chosen = null;
  for (var i = 0; i < candidates.length && !chosen; i++) {
    if (candidates[i][1]) chosen = candidates[i];
  }

  existing.apiBase = chosen[1];
  existing.apiSource = chosen[0];
  existing.solscan = 'https://solscan.io';

  global.STOCKDROP = existing;
})(typeof window !== 'undefined' ? window : globalThis);
