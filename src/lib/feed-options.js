/**
 * Option contract between the grid and the feed query.
 *
 * This file exists because of a real bug: the service worker copied the options
 * one by one, and `onlyHidden` was forgotten when it was added. The "Hidden"
 * view therefore returned the ordinary feed, without the slightest error — the
 * option was simply lost on the way.
 *
 * The list is isolated here for two reasons: the service worker uses it to
 * filter what it forwards, and the tests can compare it against the real
 * signature of `getFeedPage()` without having to load the whole background.
 */

export const FEED_PAGE_OPTIONS = [
  'limit', 'after', 'since',
  'includeHidden', 'onlyHidden', 'onlyStarred', 'onlyUnseen',
  'query', 'channelId',
  'hideWatched', 'minDurationSec', 'maxAgeDays', 'onlyInProgress', 'inProgressMinSec',
  'hideLives', 'hideReplays', 'hideUpcoming',
  'requireComplete',
];

/**
 * Options the query accepts but the page may never send.
 *
 * `activeChannelIds` is the set of followed channels, and it is the answer to
 * "is this one of mine?" that decides whether a row is painted at all. It is
 * read from the database by the worker on each page, deliberately: forwarding
 * it would mean a tab could name the channels it considers followed, and the
 * one guarantee this extension sells is that nothing else gets in.
 *
 * Named here rather than simply left out, so the contract test keeps meaning
 * what it says — the test that caught `onlyHidden` being dropped also catches
 * an option quietly added to the query and never forwarded, and it can only go
 * on doing that if the exceptions are written down.
 */
export const FEED_PAGE_INTERNAL_OPTIONS = ['activeChannelIds'];

/**
 * Copies only the listed keys, skipping the ones that are absent — so the
 * defaults get to apply instead of being overridden with `undefined`.
 *
 * @param {Record<string, unknown>} source
 * @param {string[]} keys
 */
export function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Names of the options a function really accepts, read from its destructured
 * signature.
 *
 * Used by the consistency test: it compares what the function can receive with
 * what the service worker agrees to forward. Deliberately limited to the first
 * `{…}` block of the signature, which is exactly the case at hand.
 *
 * @param {Function} fn
 * @returns {string[]}
 */
export function destructuredParamNames(fn) {
  const source = fn.toString();
  const start = source.indexOf('{', source.indexOf('('));
  const end = source.indexOf('}', start);
  if (start === -1 || end === -1) return [];

  return source
    .slice(start + 1, end)
    .split(',')
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean);
}
