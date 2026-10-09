/**
 * Ordering and suspicion score for subscription triage.
 *
 * Deliberately free of side effects and of database access: this is the part
 * where a weighting mistake would go unnoticed, so it is the part we want to be
 * able to check by hand.
 */

import { t, bcp47 } from './i18n.js';

const DAY = 86_400_000;
const MONTH = 30 * DAY;

/** Beyond this, inactivity counts as total — two years without publishing. */
const MAX_INACTIVITY_MONTHS = 24;

/** Below this, the hide ratio means nothing statistically. */
const MIN_VIDEOS_FOR_RATIO = 3;

/**
 * @typedef {object} TriageChannel
 * @property {string} id
 * @property {string} title
 * @property {number} lastUploadAt
 * @property {number|null} uploadIntervalMs
 * @property {number} videoCount    known videos
 * @property {number} hiddenCount   of which hidden
 * @property {number} watchedCount  of which watched
 * @property {number} addedAt
 */

/**
 * Suspicion score, between 0 and 1. The higher it is, the more the channel
 * deserves to be looked at first.
 *
 * Two main signals, for two distinct reasons to unsubscribe: the channel no
 * longer publishes, or it does publish and you systematically dismiss what it
 * publishes.
 *
 * The second rests on `hiddenCount`, which counts **explicit hides only** — the
 * cross on a thumbnail or a multiple selection. Watching a video does not hide
 * it: `watched` and `hidden` are two independent fields, and the "remove
 * watched videos" setting is only a display filter. Without that separation, a
 * heavily watched channel would look like a systematically rejected one, and
 * the score would point at exactly the channels worth keeping.
 *
 * @param {TriageChannel} channel
 * @param {number} [now]
 * @param {object} [opts]
 * @param {boolean} [opts.hasWatchData]  true if watch tracking has already
 *   observed something, somewhere
 */
export function suspicionScore(channel, now = Date.now(), { hasWatchData = false } = {}) {
  const months = channel.lastUploadAt
    ? (now - channel.lastUploadAt) / MONTH
    : MAX_INACTIVITY_MONTHS; // never seen publishing anything: treated as inactive
  const inactivity = Math.min(1, Math.max(0, months / MAX_INACTIVITY_MONTHS));

  const hideRatio = channel.videoCount >= MIN_VIDEOS_FOR_RATIO
    ? channel.hiddenCount / channel.videoCount
    : 0;

  // "Never watched anything" only means something if there is something to
  // compare against. Watch tracking is recent: as long as it has recorded
  // nothing anywhere, this term would not tell neglected channels apart from
  // the rest — it would merely reward those with fewer than five known videos.
  const neverWatched = hasWatchData && channel.watchedCount === 0 && channel.videoCount >= 5 ? 1 : 0;

  return 0.45 * inactivity + 0.45 * hideRatio + 0.10 * neverWatched;
}

/**
 * The orderings offered to the user.
 *
 * There is **no** "by subscription age" ordering. The date you subscribed is
 * nowhere accessible: not in the Atom feeds, not in the DOM of the
 * subscriptions page. Only `subscriptions.list` provides it, and that requires
 * full OAuth authentication, not a simple API key.
 *
 * The `addedAt` field of our database is only the import date — hence almost
 * identical for every channel. Sorting on it produced an arbitrary order
 * presented as chronological: worse than no order at all.
 */
export const ORDERS = /** @type {const} */ ({
  SUSPECT: 'suspect',
  ALPHA: 'alpha',
});

/**
 * Keys, not texts: this module is also imported by the service worker, which
 * displays nothing. The screen is what translates, as it writes the label.
 */
export const ORDER_LABELS = {
  [ORDERS.SUSPECT]: 'tri.order.suspect',
  [ORDERS.ALPHA]: 'tri.order.alpha',
};

/**
 * Sorts the channels in the requested order.
 * Does not modify the array it receives.
 *
 * @param {TriageChannel[]} channels
 * @param {string} order
 * @param {number} [now]
 */
export function sortChannels(channels, order, now = Date.now()) {
  const list = [...channels];

  if (order === ORDERS.ALPHA) {
    // `localeCompare` with base sensitivity: accents and case must not separate
    // "Étonnante" from "Etonnante" in the list.
    return list.sort((a, b) =>
      (a.title || '').localeCompare(b.title || '', bcp47(), { sensitivity: 'base' }));
  }

  // Is watch tracking fed with anything? We deduce it from the whole set rather
  // than channel by channel: a channel with no views only tells us something if
  // other channels have some.
  const opts = { hasWatchData: hasWatchData(list) };

  return list.sort((a, b) => suspicionScore(b, now, opts) - suspicionScore(a, now, opts));
}

/**
 * Sentence describing the publishing cadence.
 *
 * The wording changes depending on whether the channel still publishes: saying
 * "publishes 2 videos a month" of a channel silent for two years would be
 * false.
 *
 * @param {TriageChannel} channel
 * @param {number} [now]
 */
export function describeCadence(channel, now = Date.now()) {
  if (!channel.uploadIntervalMs) return null;

  const perMonth = MONTH / channel.uploadIntervalMs;
  const rate = perMonth >= 1
    ? t('tri.rate.permonth', { n: Math.round(perMonth) })
    : t('tri.rate.everymonths', { n: Math.round(channel.uploadIntervalMs / MONTH) });

  const active = channel.lastUploadAt && now - channel.lastUploadAt < 6 * MONTH;
  return t(active ? 'tri.rate.now' : 'tri.rate.past', { rate });
}

/**
 * Sentence about the hide ratio, or null when it is not significant.
 *
 * Someone who never hides anything must not be shown a useless "0 out of 12",
 * and a "1 out of 2" over two videos proves nothing.
 *
 * @param {TriageChannel} channel
 */
export function describeHiding(channel) {
  if (channel.videoCount < MIN_VIDEOS_FOR_RATIO || channel.hiddenCount < MIN_VIDEOS_FOR_RATIO) {
    return null;
  }
  return t('tri.hiding', { n: channel.hiddenCount, total: channel.videoCount });
}

/**
 * Sentence about what has been watched from this channel, or null.
 *
 * Triage was written before watch tracking: the card described what the channel
 * publishes without ever saying what you do with it, which is the question
 * being asked. The line only appears when the record has something to say —
 * otherwise "0 out of 14" would say nothing about the channel, only that the
 * extension has just been installed. Hence `hasWatchData`, deduced from the
 * whole set of channels and not from this one, exactly as in `suspicionScore`.
 *
 * The total is the number of videos the extension knows, not the channel's own:
 * the scope is therefore stated in the sentence.
 *
 * @param {TriageChannel} channel
 * @param {object} [opts]
 * @param {boolean} [opts.hasWatchData]
 */
export function describeWatching(channel, { hasWatchData = false } = {}) {
  if (!hasWatchData || (channel.videoCount ?? 0) < MIN_VIDEOS_FOR_RATIO) return null;
  return t('tri.watched', { n: channel.watchedCount ?? 0, total: channel.videoCount });
}

/**
 * Has watch tracking observed anything, anywhere?
 * @param {TriageChannel[]} channels
 */
export function hasWatchData(channels) {
  return channels.some((c) => (c.watchedCount ?? 0) > 0);
}

/**
 * Channels silent for a long time, candidates for bulk handling.
 * @param {TriageChannel[]} channels
 * @param {number} [months]
 * @param {number} [now]
 */
export function findDormant(channels, months = 24, now = Date.now()) {
  return channels.filter((c) => !c.lastUploadAt || now - c.lastUploadAt > months * MONTH);
}

/**
 * What the subscription list amounts to, in four raw figures.
 *
 * The bottom of the Triage tab does not show a randomly drawn highlight but the
 * same four numbers every time it opens: they describe the work that remains,
 * and you compare them from one session to the next. Each one matches one of
 * the signals triage uses to rank channels.
 *
 * @param {TriageChannel[]} channels
 * @returns {{perWeek: number, silent: number, neverWatched: number|null, mostlyHidden: number}}
 */
export function triageFigures(channels, { now = Date.now() } = {}) {
  let perWeek = 0;
  let silent = 0;
  let neverWatched = 0;
  let mostlyHidden = 0;
  let watched = 0;

  for (const c of channels) {
    if (c.uploadIntervalMs > 0) perWeek += (7 * DAY) / c.uploadIntervalMs;
    if (c.lastUploadAt && now - c.lastUploadAt > MAX_INACTIVITY_MONTHS * MONTH) silent++;
    watched += c.watchedCount ?? 0;

    if ((c.videoCount ?? 0) < MIN_VIDEOS_FOR_RATIO) continue;
    if (!c.watchedCount) neverWatched++;
    if ((c.hiddenCount ?? 0) / c.videoCount >= 0.7) mostlyHidden++;
  }

  return {
    perWeek: Math.round(perWeek),
    silent,
    // Without a minimum of recorded views, "no video watched" says nothing
    // about the channels: it says the extension has just been installed. The
    // figure then stays quiet rather than accusing everyone.
    neverWatched: watched >= 30 ? neverWatched : null,
    mostlyHidden,
  };
}
