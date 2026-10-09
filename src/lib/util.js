import { t, getLocale } from './i18n.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Runs `worker` on every element of `items` with at most `limit` concurrent
 * tasks. Rejections are caught per element: the loop never stops because a
 * single channel failed.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<{ok: true, value: R} | {ok: false, error: any}>>}
 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Median of an array of numbers. Returns null when empty.
 * @param {number[]} values
 */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Decodes the XML/HTML entities found in YouTube's Atom feeds. Deliberately
 * self contained: neither `DOMParser` nor `textarea` exists inside an MV3
 * service worker.
 * @param {string} s
 */
export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(\w+));/g, (match, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    switch (name) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return match;
    }
  });
}

/** U+0300–U+036F: combining diacritical marks, isolated by the NFD form. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Comparable form of a string: lower case, accents stripped.
 *
 * Indispensable for searching in French — "Étonnante" has to be findable by
 * typing "etonnante".
 *
 * @param {string} s
 */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase();
}

/** Short relative date, YouTube style. */
export function relativeTime(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / MINUTE);
  if (mins < 1) return t('time.now');
  if (mins < 60) return t('time.minutes', { n: mins });
  const hours = Math.floor(diff / HOUR);
  if (hours < 24) return t('time.hours', { n: hours });
  const days = Math.floor(diff / DAY);
  if (days < 7) return t('time.days', { n: days });
  if (days < 30) return t('time.weeks', { n: Math.floor(days / 7) });
  if (days < 365) return t('time.months', { n: Math.floor(days / 30) });
  return t('time.years', { n: Math.floor(days / 365) });
}

/** Abbreviated view counter. */
export function formatViews(n) {
  if (n == null) return '';

  // The decimal comma is only French in French: the separator follows the
  // chosen language, not the language of the code.
  const decimal = (x, digits) => (getLocale() === 'fr'
    ? x.toFixed(digits).replace('.', ',')
    : x.toFixed(digits));

  if (n < 1000) return t('views.count', { n });
  if (n < 1_000_000) return t('views.thousands', { n: decimal(n / 1000, n < 10_000 ? 1 : 0) });
  return t('views.millions', { n: decimal(n / 1_000_000, n < 10_000_000 ? 1 : 0) });
}

/**
 * "1,07 M d'abonnés" or "1.07M subscribers" → 1070000.
 *
 * The decimal separator, the space and the suffix all vary with the interface
 * language; only the "number then multiplier" shape is stable.
 *
 * Anchoring at the start of the string is not cosmetic: without it, the handle
 * "@1nonly" read as "1 subscriber". YouTube happens to deliver the count and
 * the handle in interchangeable fields, so the caller tries both — the wrong
 * field has to be rejected outright. A count always starts with its number, a
 * handle never does.
 *
 * "Md" (French for billion) must come before "M" in the alternation, otherwise
 * "2,4 Md" reads as "2,4 M" and a factor of a thousand is lost.
 */
export function parseCompactCount(text) {
  if (!text) return null;
  // U+00A0 and U+202F: the non breaking spaces YouTube puts between the
  // number and its multiplier. Escaped so they stay visible in a diff.
  const clean = String(text).replace(/[\u00a0\u202f]/g, ' ').trim();

  const m = /^(\d[\d ]*(?:[.,]\d+)?)\s*(Md|[kKmMbBG])?/.exec(clean);
  if (!m) return null;

  const number = Number(m[1].replace(/ /g, '').replace(',', '.'));
  if (!Number.isFinite(number)) return null;

  const factors = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, G: 1e9, Md: 1e9 };
  return Math.round(number * (factors[m[2]] ?? 1));
}

/**
 * What kind of broadcast is this: a live in progress, a replay, or a scheduled
 * premiere?
 *
 * This classification lives here because two places must draw exactly the same
 * conclusion: the feed query, which decides whether to let it through, and the
 * badge, which says what it is. Reasoning them out separately once produced a
 * grid where announced lives were labelled "replay".
 *
 * The decisive rule is duration. A broadcast that has one is over, by
 * construction: YouTube only knows it once the stream has been cut. The lives
 * playlist reading is what applies that rule: over there, an entry without a
 * duration really has not happened yet, and that is a measurement.
 *
 * Here, the same absence does not mean the same thing. An entry that arrived
 * through the Atom feed has no duration because the Atom feed never carries
 * one, not because the broadcast is still ahead. Concluding "scheduled" from it
 * produced thumbnails dated several days back, with no duration, announced as
 * not having happened yet — and nothing corrected them, since the duration
 * quest looked for them in the long form playlist, where a broadcast never is.
 * So as long as the reading has not happened, we conclude nothing: `null` makes
 * the safety gate hold the video back, which is the honest answer.
 *
 * Once the reading has happened, `isLive` and `isUpcoming` carry the verdict
 * and are read first: the deduction below only covers the unmeasured case.
 *
 * A publication date in the future is by itself enough to classify an entry as
 * scheduled, broadcast or not: that is the case for premieres, which the native
 * feed dates at their release time.
 *
 * @returns {'live'|'replay'|'upcoming'|null} null for an ordinary video
 */
export function broadcastKind(video, now = Date.now()) {
  if (video.isLive) return 'live';
  if (video.isUpcoming) return 'upcoming';
  if (video.publishedAt > now) return 'upcoming';
  if (!video.wasLive) return null;
  return video.durationSec > 0 ? 'replay' : null;
}

/**
 * What a video is missing before it can be shown, or `null` if nothing is.
 *
 * Ordinary videos need a duration to distinguish unresolved broadcast state.
 * A missing channel avatar is cosmetic and must never hide a publication.
 *
 * Two absences are not gaps: a live in progress and an announced broadcast have
 * no duration and cannot have one until they are over.
 *
 * The rule lives here because two places must read it identically: the query,
 * which holds the video back, and the grid, which releases it once the gaps are
 * filled. Reasoning them out separately would have produced held back videos
 * that nothing ever came to release.
 *
 * @param {{channelId: string, channelAvatar?: string, durationSec?: number}} video
 * @returns {'duration' | null}
 */
export function videoIncomplete(video) {
  const broadcast = broadcastKind(video);
  if (broadcast === 'live' || broadcast === 'upcoming') return null;
  return video.durationSec > 0 ? null : 'duration';
}
