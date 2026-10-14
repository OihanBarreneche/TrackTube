/**
 * Synchronisation engine.
 *
 * Runs inside the service worker, which can be killed at any moment. The work
 * is therefore cut into time bounded slices, and every bit of progress is
 * persisted as it happens: an interruption costs one channel at worst, never a
 * whole cycle.
 */

import {
  getDueChannels, putChannel, upsertVideos, metaGet, metaSet, getAllChannels, getChannel,
  allVideoIds, existingVideoIds, getVideosSince, getVideosByIds, knownShortIds,
  recordVideoClassification, recordMembersOnly,
} from '../lib/db.js';
import { fetchUploadsDirect } from './innertube-direct.js';
import {
  fetchScreenedVideoFacts as fetchVideoFacts, refreshChannelShorts, announceGone,
} from './shorts.js';
import { fetchChannelFeed, FEED_MODES } from '../lib/rss.js';
import {
  applyOutcome, normalizeTuning, CACHE_TTL, SWEEP_DEFAULT,
} from './scheduler.js';
import { pool, MINUTE, HOUR, DAY } from '../lib/util.js';
import { log } from '../lib/log.js';
import { shortVerdictLifetime } from '../lib/short-policy.js';

/**
 * Simultaneous requests.
 *
 * Long pinned at five out of caution, without any measurement. Three hundred
 * requests fired twenty four at a time go through at 164 per second without a
 * single 429: that caution was costing minutes of sweeping for nothing. Twelve
 * leaves headroom under what was measured and lets a full sweep of nine hundred
 * channels fit inside the time budget of a single wake up.
 */
const DEFAULT_CONCURRENCY = 32;

/** Budget per service worker wake up. Under the MV3 limit, with room to spare
 *  for the database writes. */
const DEFAULT_BUDGET_MS = 45_000;

const META_RATE_LIMITED_UNTIL = 'sync.rateLimitedUntil';
const META_LAST_TICK = 'sync.lastTickAt';
const META_STATS = 'sync.stats';
const META_UULF_ALARM = 'sync.uulfAlarm';

/**
 * How many consecutive "no long form video" verdicts, without a single UULF
 * success, before we conclude the prefix itself is dead on Google's side.
 * On a real subscription list, fifteen channels in a row without a single long
 * form video does not happen.
 */
const UULF_ALARM_THRESHOLD = 15;

/** Prevents two concurrent cycles inside the same service worker instance. */
let running = false;

/** Same role, for the direct sweep, which may run during a cycle. */
let sweeping = false;

/**
 * Processes the channels that are due, within a time budget.
 *
 * @param {object} [opts]
 * @param {number} [opts.budgetMs]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.maxChannels]
 * @param {(p: {done: number, total: number, channel: string}) => void} [opts.onProgress]
 */
export async function runSyncTick({
  budgetMs = DEFAULT_BUDGET_MS,
  concurrency = DEFAULT_CONCURRENCY,
  // High enough to cover any subscription list in a single cycle. It is the
  // time budget that bounds the work, not this ceiling: capping it silently
  // skipped the channels beyond it, and the progress bar announced a total
  // lower than the real number of subscriptions.
  maxChannels = 5000,
  onProgress,
} = {}) {
  if (running) return { skipped: 'already-running' };
  running = true;

  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;

  try {
    const pausedUntil = await metaGet(META_RATE_LIMITED_UNTIL, 0);
    if (pausedUntil > startedAt) {
      return { skipped: 'rate-limited', resumesAt: pausedUntil };
    }

    // Re-read period chosen by the user, never below YouTube's quarter hour of
    // cache: below that, the very same copy would come back.
    const tuning = await readTuning();
    const lives = await livesEnabled();

    const due = await getDueChannels(maxChannels, startedAt);
    if (!due.length) {
      await metaSet(META_LAST_TICK, startedAt);
      return { checked: 0, inserted: 0, changed: 0, remaining: 0 };
    }

    const tally = {
      checked: 0, inserted: 0, changed: 0, unchanged: 0, errors: 0, notFound: 0,
      noLongform: 0, livesChecked: 0, livesInserted: 0, recovered: 0,
    };
    // Shared by the whole tick: the budget is the sweep's, not the channel's.
    const overflow = { left: MAX_OVERFLOW_CHANNELS };
    let aborted = false;
    let done = 0;

    await pool(due, concurrency, async (channel) => {
      // We never cut a request in flight: we simply stop starting new ones.
      if (aborted || Date.now() > deadline) { aborted = true; return; }

      const result = await syncChannel(channel, tuning, { lives, overflow }).catch((error) => ({
        kind: 'error', message: error?.message ?? String(error),
      }));

      tally.checked++;
      tally.inserted += result.inserted ?? 0;
      tally.livesChecked += result.livesChecked ?? 0;
      tally.livesInserted += result.livesInserted ?? 0;
      tally.recovered += result.recovered ?? 0;
      if (result.kind === 'ok') tally.changed++;
      else if (result.kind === 'unchanged') tally.unchanged++;
      else if (result.kind === 'not-found') tally.notFound++;
      else if (result.kind === 'no-longform') tally.noLongform++;
      else if (result.kind === 'error') tally.errors++;

      if (result.kind === 'rate-limited') {
        const until = Date.now() + (result.retryAfterMs ?? 15 * MINUTE);
        aborted = true;
        await metaSet(META_RATE_LIMITED_UNTIL, until);
        log.warn(`429 received — sync paused until ${new Date(until).toISOString()}`);
      }

      onProgress?.({ done: ++done, total: due.length, channel: channel.title || channel.id });
    });

    await metaSet(META_LAST_TICK, Date.now());
    await recordStats(tally);
    await checkUulfHealth(tally);

    const summary = {
      ...tally,
      durationMs: Date.now() - startedAt,
      remaining: aborted ? Math.max(0, due.length - tally.checked) : 0,
      aborted,
    };
    log.info('Sync cycle', summary);
    return summary;
  } finally {
    running = false;
  }
}

async function readSettings() {
  try {
    const stored = await chrome.storage.local.get('ytfeed:settings');
    return stored?.['ytfeed:settings'] ?? {};
  } catch {
    return {};
  }
}

/** Live streams enter the feed unless the user turns them down. */
async function livesEnabled() {
  return (await readSettings()).syncLives !== false;
}

/**
 * Effective collection settings.
 *
 * Two numbers, and no more arithmetic: the re-read period, and whether or not
 * to slow down channels dormant for over a year. The channel list no longer
 * enters the equation — that was the heart of the old system, which re-read all
 * the less often the more people you followed, and therefore made collection
 * all the less predictable.
 *
 * @param {import('../lib/db.js').Channel[]} [channels]  ignored, kept for callers
 */
export async function readTuning(channels) {  // eslint-disable-line no-unused-vars
  const s = await readSettings();
  const minutes = Number(s.sweepMinutes);
  return normalizeTuning({
    sweepMs: Number.isFinite(minutes) && minutes > 0 ? minutes * MINUTE : SWEEP_DEFAULT,
    slowDormant: s.slowDormant !== false,
  });
}

/*
 * There is no re-probe delay on the live feed any more, and the figure it is
 * replaced with is zero.
 *
 * It used to be two weeks, on the reasoning that a channel going live for the
 * first time is a rare event and that noticing it at once would cost one
 * request per channel per pass, "far more than it brings back". The first half
 * is true, the second was never measured, and it was wrong. A channel that has
 * never streamed has no `UULV` playlist at all: the feed answers **404 in
 * 1612 bytes**, measured on 8 October 2026 over thirteen channels, six of which
 * answered that way — the other seven held a real live feed, which is far more
 * than "rare". A channel already known to broadcast was on the ordinary cadence
 * anyway, so what the delay actually bought was 1.6 KB per silent channel per
 * sweep, and what it cost is a whole class of misses: GOTAGA's neighbour
 * GIUSEPPE streamed twice on 7 October 2026 and `Co7jh46dJ7w` reached the
 * reverse audit as a video TrackTube never saw.
 *
 * `livesNextDueAt` is gone with it, and not merely set to the same value as
 * `nextDueAt`. A second due date on the same row is a second thing to keep in
 * step, and it was already out of step: `markAllDue`, the "re-read everything
 * now" of the manual refresh, clears `nextDueAt` and `feedHash` and never knew
 * about this field — so even an explicit full refresh went on skipping the live
 * feeds until the fortnight ran out. The two feeds of one channel are now read
 * together because there is nothing left that could separate them. That is the
 * rule this file already states for the main feed: determinism before saving
 * requests.
 */

/**
 * How many entries the Atom feed returns, at most.
 *
 * Fifteen, always, and **it does not say that it truncated**. There is no
 * "next page" link, no total, nothing: a channel that published fifteen videos
 * and a channel that published forty give the same answer, and the last
 * twenty five simply are not there. Automatic collection reads this feed and
 * nothing else, so past fifteen it goes blind without noticing.
 *
 * The case is not theoretical and it is not about frantic publishing. The
 * extension only runs while the browser does: a profile left closed for a
 * fortnight comes back to a channel that has published thirty times, and the
 * fifteen it is handed are the recent half.
 */
const RSS_PAGE_ENTRIES = 15;

/**
 * Videos one saturated feed may recover in a single pass, and channels per tick.
 *
 * The recovery reads the upload playlist, which answers a hundred entries in
 * one request, then spends one player record per video to get an exact date —
 * the playlist only carries "2 months ago". Both numbers are there to bound
 * what a profile reopened after a month can set off at once; what is not
 * recovered keeps its flag and comes back on the following tick.
 */
const MAX_OVERFLOW_VIDEOS = 40;
const MAX_OVERFLOW_CHANNELS = 8;
const OVERFLOW_CONCURRENCY = 4;

/**
 * Reads past the fifteenth entry, for a channel whose feed looked truncated.
 *
 * Only called when the Atom read gave fifteen entries of which **every single
 * one was new**: that is the one shape that cannot be told apart from a longer
 * list cut short. A channel seen for the first time is excluded upstream, since
 * everything is new there by construction and it would mean a playlist read per
 * subscription on the first run.
 */
async function recoverFeedOverflow(channel) {
  const direct = await fetchUploadsDirect(channel.id);
  const ids = (direct?.videos ?? []).map((video) => video.id).filter(Boolean);
  // No answer at all: the flag stays, and the next tick tries again. Treating
  // a failed request as "nothing to recover" is the mistake this whole pass
  // exists to undo.
  if (!ids.length) return { recovered: 0, ok: false };

  const [stored, shorts] = await Promise.all([getVideosByIds(ids), knownShortIds(ids)]);
  const fresh = ids
    .filter((id) => !stored.has(id) && !shorts.has(id))
    .slice(0, MAX_OVERFLOW_VIDEOS);
  if (!fresh.length) return { recovered: 0, ok: true };

  const facts = [];
  await pool(fresh, OVERFLOW_CONCURRENCY, async (id) => {
    const fact = await fetchVideoFacts(id);
    // An inconclusive record withholds nothing and inserts nothing: the video
    // stays unknown and the flag is cleared anyway, because the next saturated
    // read will raise it again. Nothing here may depend on a request that
    // failed.
    if (!fact || fact.isShort || !Number.isFinite(fact.publishedAt)) return;
    const { isShort, ...fields } = fact;
    facts.push({
      ...fields, channelId: channel.id, channelTitle: channel.title, source: 'innertube',
    });
  });
  if (!facts.length) return { recovered: 0, ok: true };

  const written = await upsertVideos(facts);
  if (written.inserted) {
    log.info(`Feed truncated at ${RSS_PAGE_ENTRIES}: ${written.inserted} recovered on ${channel.id}`);
  }
  return { recovered: written.inserted, ok: true };
}

/**
 * Queries a channel's live feed, when its turn comes.
 *
 * Live streams and their replays do not show up in the "long form videos" feed:
 * these are two disjoint playlists. Without this pass, a channel that only ever
 * goes live was plainly absent from the feed, whereas YouTube's own native feed
 * does show it.
 *
 * The Atom feed does not say whether a broadcast is ongoing or over. We do not
 * make it up: the entry is flagged as coming from a live stream, and it is the
 * absence of a duration that makes it render as such. The duration arrives with
 * enrichment, hence as soon as the replay exists.
 *
 * @returns {Promise<{patch: object, inserted: number, checked: number}>}
 */
async function syncChannelLives(channel, now) {
  const res = await fetchChannelFeed(channel.id, { mode: FEED_MODES.LIVE });

  if (res.status === 'not-found') {
    // The playlist does not exist: this channel has never gone live. It is the
    // only honest reading of a 404, and it says nothing about tomorrow, which
    // is why it no longer buys a delay.
    return { patch: { livesMode: 'no' }, inserted: 0, checked: 1 };
  }

  if (res.status !== 'ok') {
    // No verdict written at all. Recording "no" on a failed request would turn
    // one refused connection into a channel believed never to stream.
    return { patch: {}, inserted: 0, checked: 1,
      rateLimited: res.status === 'rate-limited', retryAfterMs: res.retryAfterMs };
  }

  const entries = res.feed.entries;
  const patch = { livesMode: entries.length ? 'yes' : 'no', livesHash: res.fingerprint };

  if (!entries.length) return { patch, inserted: 0, checked: 1 };

  // Broadcast dates count as publications: without them, a channel that only
  // goes live would stay forever at "unknown cadence", and would end up passing
  // for dormant.
  patch.publishedTimestamps = entries.map((e) => e.publishedAt);

  // No fingerprint guard here, for the same reason as in the main feed: the
  // fingerprint only carries ids and dates, it deliberately ignores view
  // counters. Stopping on "unchanged" amounted to never rewriting a replay's
  // view count. The feed is already downloaded and parsed, and `upsertVideos`
  // only writes what actually moved.
  const written = await upsertVideos(entries.map((e) => ({
    id: e.id,
    channelId: e.channelId || channel.id,
    channelTitle: e.channelTitle || channel.title,
    title: e.title,
    publishedAt: e.publishedAt,
    thumbUrl: e.thumbUrl,
    views: e.views,
    wasLive: true,
    source: 'rss-live',
  })));

  return { patch, inserted: written.inserted, checked: 1 };
}

// Read the channel's Shorts list once, then filter by exact membership.
/**
 * How recent an unknown entry has to be to be worth one player record.
 *
 * Measured on 7 October 2026, on the channel that produced the complaint
 * (GOTAGA, `UCCFqUJYKT97UerMmb6DM0bw`): its `UULF` Atom feed carried the Short
 * `x8Jw8NGjpbY` as its **newest** entry — 19 seconds, `canonicalUrl` reading
 * `https://www.youtube.com/shorts/x8Jw8NGjpbY`. "UULF excludes Shorts at the
 * source" is the premise the whole Atom path rested on, and it no longer holds.
 *
 * `UUSH` did list that video, so the second guard had the facts. What failed is
 * *when* it was asked: `refreshChannelShorts` caches its list for an hour and
 * returns without reading while that cache is warm, so a Short published inside
 * the hour was filtered against a list older than itself. On a channel that
 * posts Shorts several times a day, that window is hit constantly — which is
 * why every Short that got through came from the same channel.
 *
 * Only unknown and recent entries are verified. A row we already hold has been
 * screened on display, and a first run reads fifteen entries for nine hundred
 * channels: verifying all of them would be some thirteen thousand player
 * records. Past a week YouTube has had time to classify, `UUSH` carries the
 * verdict, and the residual pass still repairs what is already stored.
 */
const VERIFY_SHORT_WINDOW_MS = 7 * DAY;

/** Player records in flight for one channel's feed. Same as the display pass. */
const VERIFY_CONCURRENCY = 4;

/**
 * The entries of a feed that are not Shorts.
 *
 * Three layers, cheapest first: the ids already tombstoned, then the channel's
 * `UUSH` list, then one player record per unknown recent entry.
 *
 * That last call is not a new cost. It is the one the display screening already
 * made on the first paint of every freshly collected row, moved to collection —
 * where a Short can still be stopped before it has a row at all, instead of
 * being removed from a grid it has already appeared in. `fetchVideoFacts` here
 * is `fetchScreenedVideoFacts`, which tombstones a recognised Short and records
 * the negative verdict with its lifetime, so the display pass has nothing left
 * to ask about the rows this lets through.
 *
 * An inconclusive record changes nothing: the entry is kept exactly as it was
 * before, under the `UUSH` list and the display screening. A player endpoint
 * that stops answering therefore degrades to the previous behaviour instead of
 * freezing discovery — nothing here may ever withhold a video on the strength
 * of a failed request.
 */
async function withoutShorts(entries, channelId, { refresh = true } = {}) {
  if (refresh) await refreshChannelShorts(channelId);
  const shorts = await knownShortIds(entries.map((e) => e.id));
  const kept = entries.filter((e) => !shorts.has(e.id));
  if (!kept.length) return kept;

  const since = Date.now() - VERIFY_SHORT_WINDOW_MS;
  const stored = await getVideosByIds(kept.map((e) => e.id));
  const unknown = kept.filter((e) => !stored.has(e.id) && e.publishedAt >= since);
  if (!unknown.length) return kept;

  const confirmed = new Set();
  await pool(unknown, VERIFY_CONCURRENCY, async (entry) => {
    const facts = await fetchVideoFacts(entry.id).catch(() => null);
    if (facts?.isShort === true) confirmed.add(entry.id);
  });
  if (!confirmed.size) return kept;

  log.info(`Shorts refused at collection: ${confirmed.size} on ${channelId}`);
  return kept.filter((e) => !confirmed.has(e.id));
}

/**
 * Synchronises one channel: fetch, change detection, insertion, then update of
 * its scheduling state.
 *
 * @param {import('../lib/db.js').Channel} channel
 * @param {number|object} [tuning]  cadence settings chosen by the user
 * @param {{lives?: boolean}} [opts]
 */
async function syncChannel(channel, tuning = 1, { lives = true, overflow = null } = {}) {
  const now = Date.now();
  const mode = channel.feedMode ?? FEED_MODES.LONGFORM;
  const res = await fetchChannelFeed(channel.id, { mode });

  // A 429 stops everything for this channel, the live pass included: this is
  // the moment to ask for less, not for as much.
  if (res.status === 'rate-limited') {
    await putChannel(applyOutcome(channel, { kind: 'rate-limited', retryAfterMs: res.retryAfterMs }, now, tuning));
    return { kind: 'rate-limited', retryAfterMs: res.retryAfterMs, inserted: 0 };
  }

  /** @type {{kind: string, message?: string}} */
  let verdict;
  let entries = [];

  if (res.status === 'ok') {
    entries = res.feed.entries;
    const unchanged = channel.feedHash != null && channel.feedHash === res.fingerprint;
    verdict = { kind: unchanged ? 'unchanged' : 'ok' };
  } else if (res.status === 'not-found' && mode === FEED_MODES.LONGFORM) {
    // A 404 on the "long form videos" feed is ambiguous: either the channel is
    // gone, or it exists but only publishes Shorts, or it only ever goes live.
    // We settle it with a probe on the complete feed — one more request, but
    // only in that rare case, and it avoids wrongly deactivating a live
    // channel.
    const probe = await fetchChannelFeed(channel.id, { mode: FEED_MODES.ALL });
    // A transient error is not evidence that a channel disappeared. Three
    // false not-found verdicts would otherwise deactivate a valid subscription.
    verdict = {
      kind: probe.status === 'ok' ? 'no-longform'
        : probe.status === 'not-found' ? 'not-found'
        : probe.status === 'rate-limited' ? 'rate-limited' : 'error',
      retryAfterMs: probe.retryAfterMs,
      message: probe.message,
    };
  } else {
    verdict = {
      kind: res.status === 'not-found' ? 'not-found' : 'error',
      message: res.message,
    };
  }

  // The live pass happens before scheduling is settled: it is what tells us
  // whether a channel with no long form video is dead or merely live only, and
  // that answer changes the interval we are about to compute.
  let live = { patch: {}, inserted: 0, checked: 0 };
  // Two cases and no third: a channel whose upload playlist does not exist has
  // no live playlist either, and a channel answering 429 must not be asked a
  // second question. Everywhere else, being read means being read whole.
  const livesDue = lives && !['not-found', 'rate-limited'].includes(verdict.kind);
  if (livesDue) live = await syncChannelLives(channel, now);
  if (live.rateLimited) verdict = { kind: 'rate-limited', retryAfterMs: live.retryAfterMs };

  let inserted = 0;
  let truncated = false;
  // Including when the fingerprint has not moved. The fingerprint only carries
  // ids and dates — it deliberately ignores view counters, which change all the
  // time and would make every feed look "different". The consequence had been
  // missed: skipping the write on "unchanged" amounted to never rewriting the
  // view counts. A video kept the counter it had at discovery, that is a few
  // hundred views for a video ten minutes old, until the channel published
  // again. The feed is already downloaded and parsed at this point: re-reading
  // it costs nothing more on the network, and `upsertVideos` only writes the
  // records that actually changed.
  if ((verdict.kind === 'ok' || verdict.kind === 'unchanged') && entries.length) {
    // UULF already excludes Shorts at the source. Its companion UUSH list only
    // needs a fresh read when this feed changed; doing it for every unchanged
    // channel doubled the ordinary automatic sweep. The separate residual pass
    // still catches a video YouTube reclassifies after publication.
    const kept = await withoutShorts(entries, channel.id, { refresh: verdict.kind === 'ok' });
    const written = await upsertVideos(kept.map((e) => ({
      id: e.id,
      channelId: e.channelId || channel.id,
      // The title comes from the entry's author, never from the feed title: in
      // UULF mode the latter reads literally "Videos".
      channelTitle: e.channelTitle || channel.title,
      title: e.title,
      publishedAt: e.publishedAt,
      thumbUrl: e.thumbUrl,
      views: e.views,
      durationSec: e.durationSec,
      source: 'rss',
    })));
    inserted = written.inserted;

    // Fifteen entries of which not one was already known. Either the channel
    // published exactly that many since the last read, or it published more and
    // the feed cut the rest off without a word. The two cannot be told apart
    // from here, so the longer list is read. `lastSuccessAt` keeps a channel
    // read for the first time out of this: everything is new there by
    // construction, and the first sweep of a fresh profile would otherwise
    // become one playlist read per subscription.
    if (entries.length >= RSS_PAGE_ENTRIES && inserted === kept.length && kept.length
      && channel.lastSuccessAt > 0) {
      truncated = true;
    }
  }

  // `publishedTimestamps` travels inside the patch but is not a channel field:
  // it feeds the cadence computation, not the database.
  const { publishedTimestamps: liveDates = [], ...livePatch } = live.patch;
  const dates = entries.length ? entries.map((e) => e.publishedAt) : liveDates;

  const updated = applyOutcome({ ...channel, ...livePatch }, {
    kind: verdict.kind === 'no-longform' && liveDates.length ? 'ok' : verdict.kind,
    publishedTimestamps: dates,
    fingerprint: res.fingerprint,
    retryAfterMs: verdict.retryAfterMs ?? null,
    // The `Age` header says how long the copy we received has existed, hence
    // when it will be replaced. That is what lets us come back at the right
    // moment rather than at some arbitrary one.
    ageMs: (res.ageSec ?? 0) * 1000,
  }, now, tuning);
  // The verdict handed back to the caller stays "no long form video": that is
  // what the UULF safeguard watches. Only scheduling treated it as a success,
  // because the channel did publish something.
  if (verdict.kind === 'no-longform') updated.noLongform = true;

  // Dropped rather than left behind: a profile installed before 0.96.0 carries
  // a date two weeks out on this field, and a field nothing reads is a field
  // the next reader will wonder about.
  delete updated.livesNextDueAt;

  // Raised here, acted upon here when there is room, and kept on the row when
  // there is not: a profile reopened after a month can saturate hundreds of
  // feeds at once, and the recovery of the last of them must not depend on the
  // flag still being derivable from the next read — it will not be, since the
  // fifteen entries are in the database by now.
  let recovered = 0;
  const owed = truncated || Boolean(channel.overflowAt);
  if (owed && overflow && overflow.left > 0) {
    overflow.left -= 1;
    const result = await recoverFeedOverflow(channel);
    recovered = result.recovered;
    if (result.ok) delete updated.overflowAt;
    else updated.overflowAt = now;
  } else if (owed) {
    updated.overflowAt = channel.overflowAt ?? now;
  }

  const total = inserted + live.inserted + recovered;
  if (total) updated.videoCount = (channel.videoCount ?? 0) + total;
  await putChannel(updated);

  return {
    kind: verdict.kind,
    retryAfterMs: verdict.retryAfterMs,
    inserted: total,
    livesChecked: live.checked,
    livesInserted: live.inserted,
    recovered,
    message: verdict.message,
  };
}

/**
 * Simultaneous requests for the direct sweep.
 *
 * Measured: two hundred POSTs sixteen at a time all go through, without a
 * single 429, at 35.8 per second. Sixteen is therefore a proven figure, not an
 * estimate.
 */
const DIRECT_CONCURRENCY = 16;

/**
 * How many fresh videos per channel may get their exact date resolved.
 *
 * Fifteen, because that is what an Atom feed would have given: the button never
 * does worse than the old one, and never does a deep backfill, which is the job
 * of automatic collection.
 */
const MAX_DATES_PER_CHANNEL = 15;

/**
 * Global ceiling on date resolutions for one click.
 *
 * Without it, a first click on an empty database would ask for fifteen dates
 * for each of nine hundred channels, that is thirteen thousand five hundred
 * requests. The rest is not lost: automatic collection picks it up, and the
 * count is handed back to the caller so it can be shown on screen.
 */
const MAX_DATES_PER_CLICK = 300;

/**
 * Time safeguard. The sweep is not meant to reach it — nine hundred channels
 * fit in twenty five seconds — but an outsized list must not leave the service
 * worker running indefinitely.
 */
const DIRECT_BUDGET_MS = 180_000;

/**
 * Is the internal interface still answering? Three channels are enough to tell.
 *
 * One alone would not do: the first of the list may be deleted or have no long
 * form video at all, which would tip everyone over to Atom for a bad reason.
 */
async function probeDirect(channels) {
  for (const channel of channels.slice(0, 3)) {
    const res = await fetchUploadsDirect(channel.id);
    if (res?.videos?.length) return true;
  }
  return false;
}

/**
 * Full sweep through the internal API, without cache.
 *
 * This is what the page's refresh button does. Atom feeds are served with a
 * quarter hour of cache and no validator: a channel re-read within that window
 * returns exactly the same bytes, so the old button could not see a video
 * published two minutes earlier. The internal API, for its part, carries no
 * cache header at all.
 *
 * This path never touches scheduling: not `feedHash`, not `lastFetchAt`, not
 * `nextDueAt`. Automatic collection keeps its rhythm and its change detection,
 * both of which rest on the Atom feeds. A click adds videos, it does not move
 * the calendar.
 *
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {(p: {done: number, total: number, channel: string}) => void} [opts.onProgress]
 * @returns {Promise<object>} Includes `directUnavailable` when the internal API
 *   is blocked; every Atom feed is still swept in that case.
 */
export async function runDirectSweep({
  concurrency = DIRECT_CONCURRENCY,
  budgetMs = DIRECT_BUDGET_MS,
  onProgress,
} = {}) {
  // A lock distinct from the automatic collection's, and deliberately so.
  // Sharing them made the button go mute as soon as a scheduled wake up landed
  // at the same moment: the user clicked and read "nothing new" without
  // anything having been looked up. The two paths do not step on each other,
  // this one not touching scheduling.
  if (sweeping) return { skipped: 'already-running' };
  sweeping = true;

  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;

  try {
    const channels = (await getAllChannels()).filter((c) => c.active);
    if (!channels.length) return { direct: true, checked: 0, inserted: 0, total: 0 };

    // Taken once for the whole sweep. The contents age during the run, but only
    // by what the sweep itself inserts, and we add those in as we go.
    const known = await allVideoIds();

    // The direct API may reject extension traffic with HTTP 403 while the Atom
    // feeds keep answering. That is not a reason to abort: RSS has exact dates
    // and can recover every recent long form entry on its own.
    const directAvailable = await probeDirect(channels);
    if (!directAvailable) log.warn('Internal API silent — sweeping every Atom feed');

    const tally = {
      direct: true, total: channels.length,
      checked: 0, inserted: 0, errors: 0, deferred: 0, shorts: 0, refreshed: 0,
      directUnavailable: !directAvailable,
    };
    let dateBudget = MAX_DATES_PER_CLICK;
    let done = 0;
    let aborted = false;

    await pool(channels, concurrency, async (channel) => {
      if (Date.now() > deadline) { aborted = true; return; }

      const inserted = await sweepChannel(
        channel, known, () => dateBudget, (n) => { dateBudget -= n; }, tally,
        { directAvailable },
      );
      if (inserted == null) tally.errors++;
      else { tally.checked++; tally.inserted += inserted; }

      onProgress?.({ done: ++done, total: channels.length, channel: channel.title || channel.id });
    });

    // After the sweep, not during: the recount must also cover the videos this
    // very click has just discovered, whose counter comes from a record read
    // before anyone could watch them.
    // When browse is blocked for automated queries, do not answer by firing up
    // to four hundred player calls. RSS already supplied the videos and their
    // view counts; exact recounting can wait for the direct API to recover.
    if (!aborted && directAvailable) await refreshRecentViews(tally);

    const summary = {
      ...tally,
      durationMs: Date.now() - startedAt,
      remaining: aborted ? Math.max(0, channels.length - tally.checked - tally.errors) : 0,
      aborted,
    };
    log.info('Direct sweep', summary);
    return summary;
  } finally {
    sweeping = false;
  }
}

/**
 * Rewrites the view counters of a channel's already known videos.
 *
 * The direct sweep only looked at unknown ids: a video already in the database
 * was never re-read, and therefore kept the counter it had at discovery. A
 * video found ten minutes after release still showed one hundred and twenty
 * four views the next day, when it had forty five thousand.
 *
 * The counter comes from the Atom feed and not from the playlist, the playlist
 * only yielding a rounded, translated text along the lines of "16K views".
 *
 * Atom is exact on a settled video and late on a fresh one, which the first
 * measurement had missed for having only looked at videos over a day old.
 * Measured again on 27 August 2026, Atom against the player record: 145 against
 * 154 at three hours, 687 against 737 at four hours, 7 499 against 8 433 at six
 * hours — twelve per cent short — then equal to the unit at seventeen days and
 * within three views at thirty days. Hence `refreshRecentViews` below, which
 * takes the young ones from the player record. This pass keeps the rest, where
 * it is both exact and ten times cheaper.
 *
 * The request runs in parallel with the playlist one: 230 ms against 394 ms
 * measured, so it does not lengthen the sweep, and it weighs ten kilobytes
 * gzipped against sixty one for the playlist.
 *
 * Atom already supplies exact dates. Insert its missing entries too: leaving
 * discovery solely to player requests lost videos when those requests failed
 * or the shared date budget was spent on earlier channels.
 */
async function collectDatedFeed(channel, known, { refreshShorts = true } = {}) {
  const res = await fetchChannelFeed(channel.id, { mode: channel.feedMode ?? FEED_MODES.LONGFORM });
  if (res.status !== 'ok') return { inserted: 0, updated: 0, ok: false };

  const entries = await withoutShorts(res.feed.entries, channel.id, { refresh: refreshShorts });
  const written = await upsertVideos(entries.map((e) => ({
    id: e.id,
    channelId: e.channelId || channel.id,
    channelTitle: e.channelTitle || channel.title,
    title: e.title,
    publishedAt: e.publishedAt,
    thumbUrl: e.thumbUrl,
    views: e.views,
    durationSec: e.durationSec,
    source: 'rss',
  })));
  for (const entry of entries) known.add(entry.id);

  if (written.inserted) {
    const latest = (await getChannel(channel.id)) ?? channel;
    await putChannel({ ...latest, videoCount: (latest.videoCount ?? 0) + written.inserted });
  }
  return { ...written, ok: true };
}

/**
 * How far back the exact recount reaches. Beyond that, Atom's counter is equal
 * to the watch page's and the pass above is enough.
 */
const VIEWS_WINDOW_MS = 48 * HOUR;

/**
 * Ceiling on the recount, per click. Four hundred player records at sixteen in
 * flight is about four seconds — the sweep itself takes twenty five.
 */
const MAX_VIEWS_PER_CLICK = 400;

/**
 * Recounts the recent videos from the player record, exactly.
 *
 * This is the answer to "I force a refresh and a video fifteen minutes old
 * still shows zero views". Atom is the only source the automatic cycle can
 * afford, and Atom lags on a young video — sometimes down to zero in its first
 * minutes. Worse, its copy is served with a quarter hour of cache and no
 * validator, so clicking again inside that window returns the very same bytes:
 * the counter could not move however many times one clicked.
 *
 * The player record has no cache header at all and gives the count to the unit.
 * It costs one request per recent video, which is why it is bounded to two days
 * and to four hundred videos, and why only a click pays it.
 *
 * No ranking, no sampling: the videos are taken newest first and every one
 * inside the window is recounted, so two identical clicks do the same work.
 *
 * The record also carries YouTube's verdict on the nature of the video, so a
 * Short reclassified since its collection is removed here as well — one more
 * place where one cannot survive.
 *
 * @param {object} tally  counters of the sweep under way
 */
async function refreshRecentViews(tally) {
  const recent = (await getVideosSince(Date.now() - VIEWS_WINDOW_MS))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_VIEWS_PER_CLICK);
  if (!recent.length) return;

  const counted = [];
  let removed = 0;
  await pool(recent, DIRECT_CONCURRENCY, async (video) => {
    const facts = await fetchVideoFacts(video.id).catch(() => null);
    if (!facts) return;
    if (facts.isShort) { removed += facts.removed ?? 0; return; }
    if (facts.views == null) return;
    counted.push({ id: video.id, channelId: video.channelId, views: facts.views });
  });

  tally.shorts = (tally.shorts ?? 0) + removed;
  if (counted.length) {
    const written = await upsertVideos(counted, { allowInsert: false });
    tally.recounted = written.updated;
  }
}

/**
 * One channel: reading the playlist, dating the fresh videos, inserting.
 *
 * @returns {Promise<number|null>} videos inserted, or `null` if the API did not
 *   answer for this channel — to be told apart from a "nothing new".
 */
async function sweepChannel(channel, known, dateBudgetLeft, spend, tally,
  { directAvailable = true } = {}) {
  if (directAvailable) await refreshChannelShorts(channel.id);
  // Both sources can discover. Atom's exact dates avoid spending player calls
  // on entries already present in the RSS response.
  const [res, refreshed] = await Promise.all([
    directAvailable ? fetchUploadsDirect(channel.id) : Promise.resolve(null),
    collectDatedFeed(channel, known, { refreshShorts: directAvailable }),
  ]);
  tally.refreshed += refreshed.updated;
  if (!res) return refreshed.ok ? refreshed.inserted : null;

  const ids = res.videos.map((v) => v.id).filter(Boolean);

  // Live streams are not in the long form playlist: two disjoint lists. The
  // test is "not known to be silent" and not "known to broadcast", because a
  // channel whose live feed has never been read yet — a fresh install, a
  // subscription added a minute ago — would otherwise be swept without it, and
  // the manual refresh is exactly where someone goes when something is missing.
  if (channel.livesMode !== 'no') {
    const live = await fetchUploadsDirect(channel.id, { kind: 'lives' });
    for (const v of live?.videos ?? []) if (v.id && !ids.includes(v.id)) ids.push(v.id);
  }

  const fresh = ids.filter((id) => !known.has(id));
  if (!fresh.length) return refreshed.inserted;
  // Marked straight away: the same video can come back through the live
  // playlist, and dating it twice would cost a request for nothing.
  for (const id of fresh) known.add(id);

  // The playlist is served newest first: the first unknown ones are the most
  // recent, hence the ones that matter.
  const slots = Math.min(fresh.length, MAX_DATES_PER_CHANNEL, Math.max(0, dateBudgetLeft()));
  tally.deferred += fresh.length - slots;
  if (!slots) return refreshed.inserted;
  spend(slots);

  const facts = [];
  for (const id of fresh.slice(0, slots)) {
    // Serially: parallelism is already taken at the channel level, and under
    // normal conditions there are only one or two videos here.
    const fact = await fetchVideoFacts(id);
    if (!fact) continue;
    // The watch record says what the playlist does not. `UULF` had let through
    // an eighteen second Short, in 16:9, published a few hours earlier: YouTube
    // had not reclassified it yet. We neither insert it nor memorise it — it
    // will leave `UULF` on its own, and until then recounting it costs one
    // record per sweep, which is bounded and rare.
    if (fact.isShort) { tally.shorts = (tally.shorts ?? 0) + 1; continue; }
    if (!Number.isFinite(fact.publishedAt)) { tally.deferred++; continue; }
    const { isShort, ...fields } = fact;
    facts.push({
      ...fields,
      channelId: channel.id,
      channelTitle: channel.title,
      source: 'innertube',
    });
  }
  if (!facts.length) return refreshed.inserted;

  const written = await upsertVideos(facts);
  if (written.inserted) {
    // Re-read just before writing: an automatic cycle may be running at the
    // same time and may already have bumped this counter.
    const latest = (await getChannel(channel.id)) ?? channel;
    await putChannel({ ...latest, videoCount: (latest.videoCount ?? 0) + written.inserted });
  }
  return refreshed.inserted + written.inserted;
}

/**
 * Inserts new ids obtained from a signed-in per-channel Videos-tab request.
 * Both discovery and player facts normally come from the YouTube tab: making
 * the second request anonymously here used to turn a successful discovery
 * into a silent deferral whenever YouTube refused the service worker.
 */
export async function ingestAuthenticatedUploads(
  channelId, directVideos, { backfilled = false, source = 'innertube-authenticated' } = {},
) {
  const channel = await getChannel(channelId);
  if (!channel?.active) return { inserted: 0, deferred: 0, ignored: true };

  const byId = new Map((directVideos ?? [])
    .filter((video) => /^[\w-]{11}$/.test(video?.id ?? ''))
    .map((video) => [video.id, video]));
  const ids = [...byId.keys()];
  const stored = await getVideosByIds(ids);
  const targets = ids.filter((id) => {
    const direct = byId.get(id);
    const row = stored.get(id);
    return direct?.membersOnly
      || !row
      || !(row.durationSec > 0 || row.isLive || row.isUpcoming);
  });
  if (!targets.length) {
    if (backfilled) {
      const latest = await getChannel(channel.id);
      if (latest) await putChannel({ ...latest, directBackfillAt: Date.now() });
    }
    return { inserted: 0, updated: 0, deferred: 0, checked: ids.length };
  }

  const facts = [];
  let deferred = 0;
  let shorts = 0;
  let members = 0;
  for (const id of targets) {
    const direct = byId.get(id);
    if (direct.membersOnly) {
      const classification = await recordMembersOnly(id, true, Date.now());
      if (classification.removed) announceGone([id]);
      members++;
      continue;
    }
    // A Members-first publication eventually becomes public. Its unbadged
    // Videos-tab card is the explicit signal that clears the old tombstone.
    await recordMembersOnly(id, false, Date.now());
    const supplied = direct?.authenticatedFacts;
    const signedFact = supplied?.id === id ? supplied : null;
    const fact = signedFact ?? await fetchVideoFacts(id).catch(() => null);
    if (fact?.membersOnly === true) {
      const classification = await recordMembersOnly(id, true, Date.now());
      if (classification.removed) announceGone([id]);
      members++;
      continue;
    }
    if (!fact || !Number.isFinite(fact.publishedAt)) { deferred++; continue; }
    if (fact.isShort === true) {
      const classification = await recordVideoClassification(id, true, Date.now());
      if (classification.removed) announceGone([id]);
      shorts++;
      continue;
    }
    // An absent canonical URL is not proof that this is a normal video. It is
    // retried on the next sweep instead of weakening the no-Short guarantee.
    if (fact.isShort !== false) { deferred++; continue; }
    // A row with no duration is withheld by the display guard, so inserting one
    // creates a video that exists in the database and can never reach the grid
    // — the failure mode that makes a publication look lost rather than late.
    // The test is the one `videoIncomplete` and `factsFromVideosTab` already
    // apply, a broadcast being the case where no duration is the right answer.
    if (!(fact.durationSec > 0) && !fact.isLive && !fact.isUpcoming) { deferred++; continue; }
    const checkedAt = Date.now();
    await recordVideoClassification(
      id,
      false,
      checkedAt,
      checkedAt + shortVerdictLifetime(fact.durationSec),
    );
    const { authenticatedFacts, membersOnly, sourceKind, ...directFields } = direct;
    const { isShort, membersOnly: playerMembersOnly, ...fields } = fact;
    facts.push({
      ...directFields,
      ...fields,
      id,
      channelId: channel.id,
      channelTitle: channel.title,
      source,
    });
  }

  const written = facts.length ? await upsertVideos(facts) : { inserted: 0 };
  const completedBackfill = backfilled && deferred === 0;
  if (written.inserted || completedBackfill) {
    const latest = (await getChannel(channel.id)) ?? channel;
    await putChannel({
      ...latest,
      videoCount: (latest.videoCount ?? 0) + (written.inserted ?? 0),
      ...(completedBackfill ? { directBackfillAt: Date.now() } : {}),
    });
  }
  return {
    inserted: written.inserted ?? 0,
    updated: written.updated ?? 0,
    deferred,
    shorts,
    members,
    checked: ids.length,
  };
}

/** RSS fallback for the few channels whose signed playlist request fails. */
export async function ingestChannelRssFallback(channelId) {
  const channel = await getChannel(channelId);
  if (!channel?.active) return { inserted: 0, deferred: 0, ignored: true };
  const known = new Set();
  const result = await collectDatedFeed(channel, known, { refreshShorts: true });
  return {
    inserted: result.inserted ?? 0,
    deferred: 0,
    sourceFailed: true,
    rssOk: result.ok,
  };
}

/**
 * Makes due every channel whose cached copy may have been replaced.
 *
 * Serves the manual refresh from the page. It used to rank channels by relative
 * lateness and keep only two hundred of them, which made the button non
 * deterministic: two identical clicks did not re-read the same channels, and a
 * rare channel could never come up.
 *
 * The criterion is now factual and unranked: a channel read more than a quarter
 * hour ago may have something new, a channel read more recently cannot —
 * YouTube would serve the copy already received. The second count is handed
 * back to the caller so it can be shown on screen, without which "nothing new"
 * would be indistinguishable from "nothing checked".
 *
 * @returns {Promise<{due: number, cached: number}>}
 */
export async function markExpiredDue() {
  const now = Date.now();
  const channels = (await getAllChannels()).filter((c) => c.active);

  let due = 0;
  let cached = 0;

  for (const c of channels) {
    if (now - (c.lastFetchAt || 0) < CACHE_TTL) { cached++; continue; }
    due++;
    if ((c.nextDueAt ?? 0) <= now) continue; // already due, nothing to force
    c.nextDueAt = now - 1;
    await putChannel(c);
  }

  return { due, cached };
}

/** Forces every active channel to be queried immediately. */
export async function markAllDue() {
  const channels = await getAllChannels();
  const now = Date.now();
  let count = 0;
  for (const c of channels) {
    if (!c.active) continue;
    c.nextDueAt = now - 1;
    c.feedHash = null; // we really want to re-read, not short circuit
    await putChannel(c);
    count++;
  }
  await metaSet(META_RATE_LIMITED_UNTIL, 0);
  return count;
}

async function recordStats(tally) {
  const prev = await metaGet(META_STATS, { cycles: 0, checked: 0, inserted: 0, errors: 0 });
  await metaSet(META_STATS, {
    cycles: prev.cycles + 1,
    checked: prev.checked + tally.checked,
    inserted: prev.inserted + tally.inserted,
    errors: prev.errors + tally.errors,
    lastAt: Date.now(),
  });
}

/**
 * Safeguard on the UULF prefix.
 *
 * `UULF` is not documented by Google and could disappear. If it did, every
 * channel would return 404 on the "long form videos" feed and our probe would
 * conclude "no long form video" everywhere: the feed would empty out silently.
 *
 * We most certainly do not switch over to the complete feed automatically —
 * that would reintroduce Shorts, which is precisely what the extension exists
 * to avoid. We raise a visible alert and leave the decision to the user.
 */
async function checkUulfHealth(tally) {
  if (tally.checked === 0) return;

  const alarm = await metaGet(META_UULF_ALARM, { streak: 0, raised: false });

  if (tally.changed > 0 || tally.unchanged > 0) {
    // At least one UULF feed answered: the mechanism is alive.
    if (alarm.streak !== 0 || alarm.raised) {
      await metaSet(META_UULF_ALARM, { streak: 0, raised: false });
    }
    return;
  }

  const streak = alarm.streak + tally.noLongform;
  const raised = streak >= UULF_ALARM_THRESHOLD;

  if (raised && !alarm.raised) {
    log.error(
      `${streak} channels in a row with no "long form videos" feed and no UULF success. ` +
      `The UULF prefix has probably been withdrawn by Google. The feed will empty out. ` +
      `No automatic switch to the complete feed: that would reintroduce Shorts.`,
    );
  }

  await metaSet(META_UULF_ALARM, { streak, raised });
}

/** Current engine state, for the popup. */
export async function getSyncState() {
  const [lastTickAt, rateLimitedUntil, stats, uulfAlarm] = await Promise.all([
    metaGet(META_LAST_TICK, 0),
    metaGet(META_RATE_LIMITED_UNTIL, 0),
    metaGet(META_STATS, null),
    metaGet(META_UULF_ALARM, { streak: 0, raised: false }),
  ]);
  return { lastTickAt, rateLimitedUntil, stats, uulfAlarm, running };
}
