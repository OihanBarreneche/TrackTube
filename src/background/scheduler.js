/**
 * Scheduler.
 *
 * It was adaptive for a long time: every channel got a cadence derived from its
 * observed publishing frequency, so as to fit within a request budget. That
 * design rested on an estimate that was never verified, and measurement
 * contradicted it on both of the points that justified it.
 *
 * What measurement says, against YouTube's real servers, in August 2026:
 *
 * 1. Request volume is not the constraint. Three hundred requests fired twenty
 *    four at a time run at 164 per second, without a single 429. A sweep of
 *    nine hundred channels fits in about ten seconds.
 * 2. The constraint is the cache. The feeds are served with `max-age=900` and
 *    no validator, no ETag and no Last-Modified. The age of the copies served,
 *    measured over sixteen real channels, ranges from 58 to 873 seconds.
 *    Querying a channel faster than its quarter of an hour of cache returns
 *    exactly the same bytes.
 *
 * The adaptive cadence therefore bought unpredictability in exchange for a
 * saving nobody needed, and it was what made us miss a channel publishing every
 * four months: its usual interval divided by four put it several hours away.
 *
 * The rule is now a single one: every active channel is re-read on every sweep.
 * Three exceptions only, all verifiable and none based on popularity or
 * frequency — a channel dormant for over a year, a channel with no long form
 * video at all, and the back off after a network failure.
 *
 * These functions are deliberately pure: they touch neither the network nor the
 * database, and can be checked by hand from the console.
 */

import { MINUTE, HOUR, DAY, median } from '../lib/util.js';

/**
 * Lifetime of a feed copy in YouTube's cache.
 *
 * This is the only physical figure in this file: everything else follows from
 * it. Below it, a request can bring back nothing other than the copy already
 * received.
 */
export const CACHE_TTL = 15 * MINUTE;

/**
 * Re-read period of a channel.
 *
 * The floor sits below the cache, at ten minutes, and that is deliberate. A
 * period shorter than `CACHE_TTL` does not fetch fresher bytes — it cannot,
 * there are none — but `computeNextDue` phase locks on the `Age` header and its
 * safety rail never lets a read be pushed beyond half the period. Ten minutes
 * therefore tightens the worst case, the one where the `Age` header is missing
 * or where two cache nodes disagree, and leaves the ordinary case untouched.
 * What it costs is bandwidth, which measurement has twice shown not to be the
 * binding constraint on an ordinary subscription list.
 *
 * The default is no longer a single figure: see `defaultCadence`.
 */
export const SWEEP_DEFAULT = 10 * MINUTE;
export const SWEEP_MIN = 10 * MINUTE;
export const SWEEP_MAX = 6 * HOUR;

/**
 * Default cadence, sized on the number of channels followed.
 *
 * The cost of a sweep is linear in the list: about 10 KB per channel and per
 * read. At ten minutes, three hundred channels come to 430 MB a day and nobody
 * notices; fifteen hundred would come to 2.2 GB, which is no longer something
 * to impose on someone who never asked for it. So the period widens as the list
 * grows, and the wake-up widens with it — there is no point in looking every
 * three minutes for channels whose turn comes every half hour.
 *
 * This is a *default*, not a rule: the two settings stay free, and a list of
 * two thousand channels can be put back to ten minutes by hand. It is applied
 * once, when the subscriptions are imported, and never again.
 *
 * The thresholds come from the user's own list sizes, not from a model.
 */
export const CADENCE_TIERS = [
  { upTo: 500, alarmMinutes: 3, sweepMinutes: 10 },
  { upTo: 1000, alarmMinutes: 5, sweepMinutes: 15 },
  { upTo: Infinity, alarmMinutes: 10, sweepMinutes: 30 },
];

/**
 * @param {number} channelCount
 * @returns {{alarmMinutes: number, sweepMinutes: number}}
 */
export function defaultCadence(channelCount) {
  const n = Number.isFinite(channelCount) && channelCount > 0 ? channelCount : 0;
  const tier = CADENCE_TIERS.find((c) => n <= c.upTo) ?? CADENCE_TIERS[CADENCE_TIERS.length - 1];
  return { alarmMinutes: tier.alarmMinutes, sweepMinutes: tier.sweepMinutes };
}

/**
 * Without a single publication for a year, the channel goes dormant.
 *
 * The threshold is deliberately very high. The old one was ninety days, which
 * put to sleep a channel publishing every four months — exactly the case that
 * prompted this rewrite. A channel silent for a year is not silent
 * intermittently: it has stopped, and two hours of delay before noticing its
 * return cost nobody anything.
 */
const DORMANT_AFTER = 365 * DAY;
export const DORMANT_INTERVAL = 2 * HOUR;

/**
 * A channel whose "long form videos" feed does not exist: it only publishes
 * Shorts. That is the one format the extension exists in order not to show, so
 * we merely check now and then that it has not changed its mind.
 */
export const NO_LONGFORM_INTERVAL = 6 * HOUR;

export const MAX_BACKOFF = 24 * HOUR;

/**
 * We aim slightly after the copy expires, not the exact second: the cache is
 * renewed by the first request following expiry, and landing right on it would
 * amount to tossing a coin.
 */
const MARGIN_MS = 20_000;

/**
 * Jitter, forward only.
 *
 * Symmetric jitter would make half the reads land before the copy expires: a
 * request spent for nothing, and the news pushed back by a whole quarter of an
 * hour. That is the opposite of what we are after.
 */
const JITTER_MS = 45_000;

const DEFAULT_TUNING = {
  sweepMs: SWEEP_DEFAULT,
  slowDormant: true,
};

/**
 * Brings a collection setting back to something sane.
 *
 * @param {{sweepMs?: number, slowDormant?: boolean}} [tuning]
 * @returns {typeof DEFAULT_TUNING}
 */
export function normalizeTuning(tuning) {
  const t = tuning && typeof tuning === 'object' ? tuning : {};
  const raw = Number(t.sweepMs);
  return {
    sweepMs: Number.isFinite(raw) && raw > 0
      ? clamp(raw, SWEEP_MIN, SWEEP_MAX)
      : SWEEP_DEFAULT,
    slowDormant: t.slowDormant !== false,
  };
}

/**
 * Nominal re-read interval of a channel.
 *
 * @param {import('../lib/db.js').Channel & {noLongform?: boolean}} channel
 * @param {number} now
 * @param {{sweepMs?: number, slowDormant?: boolean}} [tuning]
 */
export function computeInterval(channel, now = Date.now(), tuning) {
  const { sweepMs, slowDormant } = normalizeTuning(tuning);

  // A channel with no long form video but which streams live is not a dead
  // channel: its lives enter the feed, so it keeps the normal regime. Only one
  // that publishes *nothing but* Shorts is set aside.
  if (channel.noLongform && channel.livesMode !== 'yes') {
    return Math.max(sweepMs, NO_LONGFORM_INTERVAL);
  }

  // A failure leaves the normal regime: we back off, exponentially.
  if (channel.failCount > 0) {
    return Math.min(sweepMs * 2 ** channel.failCount, MAX_BACKOFF);
  }

  if (slowDormant && channel.lastUploadAt && now - channel.lastUploadAt > DORMANT_AFTER) {
    return Math.max(sweepMs, DORMANT_INTERVAL);
  }

  return sweepMs;
}

/**
 * Time of the next query, phase locked on YouTube's cache.
 *
 * The `Age` header of the response says how long the copy received has existed.
 * From it we deduce the second at which it will be replaced, and that is when
 * we come back. Without that phase locking, our rhythm and the cache's drift
 * relative to one another: a video waits on average half a period for the copy
 * to be renewed, then half a period more for our turn to come. Phase locking
 * removes the second term and halves the discovery delay, at a constant number
 * of requests.
 *
 * @param {import('../lib/db.js').Channel} channel
 * @param {number} now
 * @param {{sweepMs?: number, slowDormant?: boolean}} [tuning]
 * @param {number} [ageMs]  age of the copy received, 0 if unknown
 */
export function computeNextDue(channel, now = Date.now(), tuning, ageMs = 0) {
  const interval = computeInterval(channel, now, tuning);
  const age = Number.isFinite(ageMs) && ageMs > 0 ? Math.min(ageMs, CACHE_TTL) : 0;

  let due = now + interval;

  if (age > 0) {
    const created = now - age;
    const cycles = Math.max(1, Math.ceil(interval / CACHE_TTL));
    // Safety rail: the cache is distributed, two reads can land on nodes whose
    // copies do not have the same age. Phase locking must never drag us beyond
    // twice the nominal rhythm, otherwise a spread of ages would silently
    // double the bandwidth. Convergence then takes two or three reads instead
    // of one.
    due = Math.max(created + cycles * CACHE_TTL + MARGIN_MS, now + interval / 2);
  }

  return Math.round(due + Math.random() * JITTER_MS);
}

/**
 * Median gap between two publications, from the known dates.
 * The median rather than the mean: a channel on a six month break then three
 * videos in one week must not be classified as "weekly".
 *
 * This figure no longer drives collection — that is precisely what we got rid
 * of. It remains on display in subscription triage, where it answers a real
 * question: does this channel still publish?
 *
 * @param {number[]} publishedTimestamps
 * @returns {number|null} null if fewer than two dates
 */
export function estimateUploadInterval(publishedTimestamps) {
  if (publishedTimestamps.length < 2) return null;

  const sorted = [...publishedTimestamps].sort((a, b) => b - a);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i - 1] - sorted[i];
    if (gap > 0) gaps.push(gap);
  }

  return gaps.length ? median(gaps) : null;
}

/**
 * Applies the result of a query to the scheduling state.
 * Writes nothing: returns the updated channel, leaving it to the caller to
 * persist it.
 *
 * @param {import('../lib/db.js').Channel} channel
 * @param {object} outcome
 * @param {'ok'|'unchanged'|'not-found'|'no-longform'|'rate-limited'|'error'} outcome.kind
 * @param {number[]} [outcome.publishedTimestamps]  dates seen in this feed
 * @param {string|null} [outcome.fingerprint]
 * @param {number|null} [outcome.retryAfterMs]
 * @param {number} [outcome.ageMs]  age of the copy served by the cache
 * @param {number} [now]
 */
export function applyOutcome(channel, outcome, now = Date.now(), tuning) {
  const next = { ...channel, lastFetchAt: now };

  switch (outcome.kind) {
    case 'ok':
    case 'unchanged': {
      next.failCount = 0;
      next.lastSuccessAt = now;
      next.noLongform = false;
      if (outcome.fingerprint) next.feedHash = outcome.fingerprint;

      const stamps = outcome.publishedTimestamps ?? [];
      if (stamps.length) {
        next.lastUploadAt = Math.max(next.lastUploadAt ?? 0, ...stamps);
        const estimated = estimateUploadInterval(stamps);
        if (estimated) next.uploadIntervalMs = estimated;
      }

      if (outcome.kind === 'ok') next.lastChangeAt = now;
      break;
    }

    case 'no-longform':
      // The channel exists but its "long form videos" feed does not: it only
      // publishes Shorts, or it only streams live. The two cases are not
      // handled the same way now that lives enter the feed — `computeInterval`
      // settles it, from what the lives probe will have concluded. Here we
      // merely record that there is no long form video, without deactivating
      // the channel: it may very well publish one later.
      next.failCount = 0;
      next.lastSuccessAt = now;
      next.noLongform = true;
      break;

    case 'not-found':
      // Channel deleted, suspended, or obsolete identifier.
      next.failCount = (channel.failCount ?? 0) + 1;
      if (next.failCount >= 3) next.active = 0;
      break;

    case 'rate-limited':
      // Not the channel's fault: we do not penalise its failure counter, we
      // just push it back. The global pause is handled by the sync engine.
      next.nextDueAt = now + (outcome.retryAfterMs ?? 30 * MINUTE);
      return next;

    case 'error':
    default:
      next.failCount = (channel.failCount ?? 0) + 1;
      break;
  }

  next.nextDueAt = computeNextDue(next, now, tuning, outcome.ageMs ?? 0);
  return next;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Daily cost of collection, for display.
 *
 * The computation has become trivial — a sign that the design is too. It is no
 * longer there to drive anything, only so that the setting says what it costs
 * instead of leaving it to be guessed.
 *
 * Channels that stream live count double: their lives feed is read at the same
 * rhythm as their video feed, hence one more request on every pass.
 *
 * @param {import('../lib/db.js').Channel[]} channels
 * @param {number} avgBytesPerFeed
 * @param {{sweepMs?: number, slowDormant?: boolean}} [tuning]
 */
export function estimateDailyCost(channels, avgBytesPerFeed = 16_500, tuning) {
  const now = Date.now();
  let requests = 0;
  for (const c of channels) {
    if (!c.active) continue;
    const perPass = c.livesMode === 'yes' ? 2 : 1;
    requests += perPass * DAY / computeInterval(c, now, tuning);
  }
  return {
    requestsPerDay: Math.round(requests),
    bytesPerDay: Math.round(requests * avgBytesPerFeed),
  };
}
