// CORS origin matching.
//
// Every deployment on a hosting platform gets its own URL, so an exact-match
// allow-list quietly blocks each preview build and the site then reports the API
// as unreachable while the API is perfectly healthy. That happened in production
// on 2026-09-07. The fix allows a `*` inside an entry, and these tests pin the
// two halves of the bargain: the project's own deployment URLs are allowed, and
// a wildcard never widens into someone else's domain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { originMatcher, corsOptions } from '../src/index.js';

const LIST = [
  'https://stoxvault.com',
  'https://www.stoxvault.com',
  'https://stoxvault.vercel.app',
  'https://stockdrop-ten.vercel.app',
  'https://stoxvault-*.vercel.app',
  'https://stockdrop-*.vercel.app',
].join(',');

/** Ask the real cors option object, the way the cors package would. */
function allows(origin, corsOrigin = LIST) {
  const opts = corsOptions({ corsOrigin });
  if (opts.origin === '*') return true;
  let out = null;
  opts.origin(origin, (err, ok) => {
    if (err) throw err;
    out = ok;
  });
  return out;
}

test('the configured production origins are allowed', () => {
  for (const origin of [
    'https://stoxvault.com',
    'https://www.stoxvault.com',
    'https://stoxvault.vercel.app',
    'https://stockdrop-ten.vercel.app',
  ]) {
    assert.equal(allows(origin), true, `${origin} should be allowed`);
  }
});

test('a wildcard entry covers this project\'s deployment URLs', () => {
  for (const origin of [
    'https://stoxvault-lapbe1ums-ad7584s-projects.vercel.app',
    'https://stoxvault-git-main-ad7584s-projects.vercel.app',
    'https://stoxvault-fverpp13e-ad7584s-projects.vercel.app',
    'https://stockdrop-nr6snirro-ad7584s-projects.vercel.app',
  ]) {
    assert.equal(allows(origin), true, `${origin} should be allowed`);
  }
});

test('a wildcard never widens past the label it replaces', () => {
  for (const origin of [
    // The wildcard must not swallow dots, or one entry would hand the API to
    // every site on the platform.
    'https://evil.vercel.app',
    'https://stoxvault.evil.vercel.app',
    'https://stoxvault-evil.attacker.app',
    // A suffix attack: the allowed host appears, but is not the actual host.
    'https://stoxvault.com.evil.com',
    'https://notstoxvault.com',
    // Scheme matters. http is not https.
    'http://stoxvault.com',
    // A path cannot appear in an Origin, and must not be accepted as one.
    'https://evil.com/https://stoxvault.com',
    'null',
  ]) {
    assert.equal(allows(origin), false, `${origin} must be refused`);
  }
});

test('a request with no Origin header is allowed through', () => {
  // curl, server-to-server calls and platform health checks send no Origin.
  // CORS only ever governs browsers, so refusing these would break monitoring
  // while protecting nobody.
  assert.equal(allows(undefined), true);
  assert.equal(allows(''), true);
});

test('CORS_ORIGIN=* still allows everything', () => {
  assert.equal(corsOptions({ corsOrigin: '*' }).origin, '*');
  assert.equal(allows('https://anything.example', '*'), true);
});

test('entries are trimmed and blanks ignored', () => {
  const messy = ' https://stoxvault.com , , https://stoxvault-*.vercel.app ,';
  assert.equal(allows('https://stoxvault.com', messy), true);
  assert.equal(allows('https://stoxvault-abc.vercel.app', messy), true);
  assert.equal(allows('https://evil.com', messy), false);
});

test('originMatcher escapes regex metacharacters in the literal parts', () => {
  // A dot in a hostname is a literal dot, not "any character": otherwise
  // `stoxvault.com` would also match `stoxvaultXcom`.
  const match = originMatcher('https://stoxvault.com');
  assert.equal(match('https://stoxvault.com'), true);
  assert.equal(match('https://stoxvaultXcom'), false);

  const wild = originMatcher('https://stoxvault-*.vercel.app');
  assert.equal(wild('https://stoxvault-abc.vercel.app'), true);
  assert.equal(wild('https://stoxvault-abc.vercelXapp'), false);
});

test('the CORS option object keeps the headers the site needs', () => {
  const opts = corsOptions({ corsOrigin: LIST });
  assert.ok(opts.allowedHeaders.includes('Authorization'), 'bearer tokens must survive preflight');
  assert.ok(opts.allowedHeaders.includes('X-Admin-Key'));
  assert.ok(opts.methods.includes('PUT'), 'saving a basket is a PUT');
  assert.ok(opts.methods.includes('OPTIONS'));
});
