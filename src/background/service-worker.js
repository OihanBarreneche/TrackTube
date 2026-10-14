/**
 * MV3 service worker: scheduling, message routing, database writes.
 *
 * Constraint worth remembering: this worker is not a process. Chrome kills it
 * as soon as it goes idle and restarts it on an event. No live state survives
 * between two wake-ups — everything that matters lives in IndexedDB.
 */

import { UI_SNAPSHOT } from '../lib/ui-snapshot.js';
import { route, MSG, broadcast } from '../lib/messages.js';
import {
  runSyncTick, runDirectSweep, ingestAuthenticatedUploads, ingestChannelRssFallback,
  markAllDue, markExpiredDue, getSyncState, readTuning,
} from './sync-engine.js';
import { runAudit, runReverseAudit, recordNativeCoverage, getNativeCoverage } from './audit.js';
import {
  openDb, getStats, setHidden, setWatched,
  reconcileChannels, getAllChannels, upsertVideos, getChannelVideos,
  getFeedCounts, hideChannelVideos, fillMissingAvatars, dropChannelAvatars,
  dropSharedChannelAvatars, setStarred,
  purgeNativeInserted, exportUserData, importUserData, getFeedPulse,
  setChannelStarred, getChannelsForTriage, getChannelFacts,
  getChannel, putChannel, makeChannel, metaGet, metaSet, deleteChannelVideos,
  getMissingDurationsByChannel, getActiveBroadcasts,
  setDurations, setBroadcastStates, listChannelsMissingAvatar,
  putHistory, putScrapedHistory, getHistorySummary, clearHistory, putWatchSession,
  getWatchSessionStats, exportHistory,
  getAllHistory, getHistoryVideoFacts, putDurations, putHistoChannel, putHistoAvatar,
  putHistoFailure, getHistoChannels, resolveOrphanSessions, getVideosSince,
  listHistoryUnsettled, settleHistoryVideos, getVideosByIds, recordNativeVideos,
  getRecentVideoIdsByChannel,
} from '../lib/db.js';
import {
  fetchScreenedVideoFacts as fetchVideoFacts, getScreenedFeedPage, verifiedFeedVideos, refreshChannelShorts, screenFeedVideos,
} from './shorts.js';
import { sameAccount } from '../lib/account.js';
import {
  computeStats, computeChannelStreaks, extractThemes, classifyTopics,
  detectAutoOpened, previousRange, computeChannelReport, listHistoryChannels,
  findVideosByTerm, refineChannelMeans, historyHighlights, buildDayJournal,
  computeWatchDelays, computeChannelDelays, computeSessions, computeRewatches, computeDropoff,
  computeUploadRhythm,
} from '../lib/history.js';
import { triageFigures } from '../lib/triage-order.js';
import {
  estimateDailyCost, computeInterval, defaultCadence, CACHE_TTL,
} from './scheduler.js';
import { median, pool } from '../lib/util.js';
import { FEED_PAGE_OPTIONS, pick } from '../lib/feed-options.js';
import { log } from '../lib/log.js';

const ALARM_SYNC = 'ytfeed:sync';

/**
 * Collection wake-up period, in minutes.
 *
 * This is a granularity, not a rate: on every wake-up, only the channels whose
 * turn has come are queried. Waking up more often therefore does not read more
 * channels, it brings collection closer to the moment they fall due — a few
 * minutes gained on discovery at best.
 *
 * The bounds are deliberately narrow. Below two minutes the wake-up costs more
 * than it returns: YouTube's feeds are served with a fifteen minute cache, and
 * the very same copy would come back. Above ten, the timeline drifts away from
 * what the site shows.
 */
const ALARM_PERIOD_DEFAULT = 3;
const ALARM_PERIOD_MIN = 2;
const ALARM_PERIOD_MAX = 10;

/** Last harvest report, for diagnosis from the popup. */
const META_LAST_HARVEST = 'harvest.last';

/**
 * A subscriptions page card does not have to come from a subscription:
 * YouTube mixes its recommendations into it, which is the reason the reverse
 * audit only judges channels the extension follows. A card whose channel id is
 * not even well formed is discarded before it can cost a lookup.
 */
const RE_CHANNEL_ID = /^UC[\w-]{22}$/;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// The stored key strings below stay as they were first written, French spelling
// included: they are data, and renaming one would make its one-time maintenance
// pass look undone and run again on every existing profile.
const META_PURGED_NATIVE = 'maintenance.purgedNativeInserts';
const META_SESSIONS_RESOLVED = 'maintenance.seancesResolues';
const META_SHARED_AVATARS_CLEARED = 'maintenance.sharedAccountAvatars08813';

/** The collection cadence has been sized on the list: see applyDefaultCadence. */
const META_CADENCE_SIZED = 'maintenance.cadenceSized';

/** The welcome screen has been seen: do not reopen it. */
const ONBOARDED_KEY = 'ytfeed:onboarded';

/**
 * Answers left in storage so the popup can draw before asking anything.
 *
 * Both are read from the whole of a store and both are asked for the moment the
 * popup opens, on a service worker that is cold nearly every time — it is killed
 * after some thirty seconds idle. Written from here and not from the popup, so
 * that a popup closed before its refresh ended still leaves the next one
 * something to draw. They are caches: losing them costs one slow opening.
 */
const HIST_SUMMARY_KEY = UI_SNAPSHOT.history;
const FEED_PULSE_KEY = UI_SNAPSHOT.pulse;

/** Stores `answer` under `key` without making the caller wait on the disk. */
let snapshotEpoch = 0;
let snapshotWrites = Promise.resolve();
function remember(key, answer, epoch = snapshotEpoch) {
  snapshotWrites = snapshotWrites.then(() => epoch === snapshotEpoch
    ? chrome.storage.local.set({ [key]: answer }) : undefined).catch(() => {});
  return answer;
}

async function clearSnapshots(keys = Object.values(UI_SNAPSHOT)) {
  snapshotEpoch += 1;
  await snapshotWrites;
  await chrome.storage.local.remove(keys);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  log.info(`Installation (${details.reason})`);
  await openDb();
  await ensureAlarm();
  await purgeNativeInsertsOnce();
  await resolveOrphanSessionsOnce();
  if (details.reason === 'install') await openWelcome();
});

/**
 * Opens the welcome screen, once and only once.
 *
 * With no subscriptions imported the extension shows nothing, and nothing says
 * why: the first launch is the only moment where we can explain where the
 * videos come from and ask for the import. The flag guards against reloads of
 * the unpacked extension, which go through `install` again.
 */
async function openWelcome() {
  const stored = await chrome.storage.local.get(ONBOARDED_KEY);
  if (stored?.[ONBOARDED_KEY]) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
}

/**
 * One-off cleanup of the videos created by the native feed harvest, from before
 * it stopped inserting. That is the path Shorts used to come in by.
 */
async function purgeNativeInsertsOnce() {
  if (await metaGet(META_PURGED_NATIVE, false)) return;
  const removed = await purgeNativeInserted();
  await metaSet(META_PURGED_NATIVE, true);
  if (removed) log.info(`${removed} videos from the native feed removed (Shorts among them)`);
}

/**
 * Repairs the watch sessions that were written without a channel.
 *
 * The tracker long read the current video from a page value that YouTube's
 * internal navigations do not refresh: after a click on a suggested video it
 * still described the previous one, and the session went out anonymous. Those
 * rows count as deleted videos and enter no ranking, even though the database
 * knows most of those videos from the subscription feed. One pass gives them
 * back to their channel.
 */
async function resolveOrphanSessionsOnce() {
  if (await metaGet(META_SESSIONS_RESOLVED, false)) return;
  const { examined, resolved } = await resolveOrphanSessions();
  await metaSet(META_SESSIONS_RESOLVED, true);
  if (examined) log.info(`Sessions without a channel: ${resolved} reattached out of ${examined}`);
}

// Repair existing rows by channel lists, never by a player request per row.
async function purgeResidualShorts() {
  const channels = (await getAllChannels()).filter((c) => c.active);
  if (!channels.length) return;
  const offset = (await metaGet('shorts.repairOffset', 0)) % channels.length;
  const batch = channels.slice(offset, offset + 24);
  for (let start = 0; start < batch.length; start += 4) {
    await Promise.all(batch.slice(start, start + 4).map((c) => refreshChannelShorts(c.id)));
  }
  await metaSet('shorts.repairOffset', (offset + batch.length) % channels.length);
}

/**
 * Settling the history: no video is credited with hours without a verdict.
 *
 * A video watched in 2021 is in no playlist we read: it is older than the two
 * hundred uploads and the three hundred Shorts the enrichment fetches. Until
 * now it was credited with its channel's mean duration, which is a fair
 * estimate for an old long form video and an absurdity for a Short. On a real
 * export, some thirty Shorts of a channel that publishes stream VODs came to
 * sixty five hours on a channel their owner had watched once.
 *
 * The mean cannot be made smarter: nothing in a Takeout line says what the
 * video was. What settles it is the player record, whose `canonicalUrl` points
 * either at `/shorts/` or at `/watch` — the same authority the feed already
 * uses, and the only one there is. A recognised Short joins its channel's
 * Shorts list and leaves every total; a long form video gets its exact
 * duration, which is better than the mean it had; a video YouTube can no longer
 * describe is marked settled so it is never asked about again.
 *
 * It runs in the worker, without a session and without a tab: `fetchVideoFacts`
 * goes out with `credentials: 'omit'`. Twenty five records per wake-up, the
 * same slice as the feed's backstop, and unlike that one this pass **does**
 * finish: the set of watched videos is finite.
 */
const META_SETTLE_HISTORY = 'maintenance.settleHistory';
const SETTLE_PER_SLICE = 25;

async function settleHistoryDurations() {
  const state = await metaGet(META_SETTLE_HISTORY, { done: false, cursor: null, settled: 0 });
  if (state.done) return;

  const { items, lastId, done } = await listHistoryUnsettled(state.cursor, SETTLE_PER_SLICE);

  const durations = [];
  const shorts = [];
  const unknown = [];

  for (const { id, channelId } of items) {
    const facts = await fetchVideoFacts(id);
    // No answer at all: deleted, private, or a network hiccup. Marked settled
    // either way — retrying for ever is what made the duration fetch look like
    // a task that never ends.
    if (!facts) { unknown.push(id); continue; }
    if (facts.isShort) { shorts.push({ videoId: id, channelId }); continue; }
    if (facts.durationSec > 0) durations.push({ videoId: id, sec: facts.durationSec });
    else unknown.push(id);
  }

  if (items.length) await settleHistoryVideos({ durations, shorts, unknown });

  await metaSet(META_SETTLE_HISTORY, {
    // A finished lap stops for good, and is restarted from scratch by a new
    // import: the history only grows at its own end, and the videos added there
    // are recent enough for the enrichment to have placed them already.
    done,
    cursor: done ? null : lastId,
    settled: (state.settled ?? 0) + items.length,
  });

  if (shorts.length) log.info(`${shorts.length} Short(s) taken out of the history`);
  if (done) log.info(`History settled: ${(state.settled ?? 0) + items.length} videos examined`);

  // The durations and the Shorts lists have moved: the analysis must not serve
  // the hours it had cached.
  if (durations.length || shorts.length) invalidateAnalysis('durations', 'histo');
}

/**
 * The settings a backup carries.
 *
 * Deliberately not everything under the `ytfeed:` prefix: `pendingImport`,
 * `pendingLot` and `pendingTriage` are actions waiting to happen, and restoring
 * them into another profile would set them off by themselves.
 */
const BACKED_UP_SETTINGS = ['ytfeed:settings', 'ytfeed:lang', 'ytfeed:columns', 'ytfeed:onboarded'];

// ---------------------------------------------------------------------------
// Database owner
// ---------------------------------------------------------------------------

/**
 * The account the data in this database belongs to.
 *
 * `{ key, adopteLe, vuLe }`. Adopted on the first sighting of a signed-in
 * session, and never changed on its own: what was collected for one account
 * cannot be reinterpreted as belonging to another.
 */
const META_OWNER = 'account.owner';

async function readOwner() {
  return metaGet(META_OWNER, null);
}

/**
 * Records what the tab saw, and adopts the account if the database is blank.
 *
 * @returns {Promise<{key: string|null, adopted: boolean, matches: boolean}>}
 */
async function noteAccount(key) {
  const current = await readOwner();
  const now = Date.now();

  if (!key) return { key: current?.key ?? null, adopted: false, matches: true };

  if (!current?.key) {
    await metaSet(META_OWNER, { key, adopteLe: now, vuLe: now });
    log.info('Database attached to the signed-in account');
    return { key, adopted: true, matches: true };
  }

  const matches = current.key === key;
  if (matches) await metaSet(META_OWNER, { ...current, vuLe: now });
  return { key: current.key, adopted: false, matches };
}

/**
 * Does this observation come from the owning account?
 *
 * The check happens here and not in the tab: the page could perfectly well omit
 * the key, and the worker is the one that writes.
 */
async function rightAccount(key) {
  const current = await readOwner();
  return sameAccount(current?.key, key);
}

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
});

/** The period chosen in the popup, brought back inside the bounds. */
async function alarmPeriod() {
  try {
    const stored = await chrome.storage.local.get('ytfeed:settings');
    const raw = Number(stored?.['ytfeed:settings']?.alarmMinutes);
    if (!Number.isFinite(raw) || raw <= 0) return ALARM_PERIOD_DEFAULT;
    return Math.min(ALARM_PERIOD_MAX, Math.max(ALARM_PERIOD_MIN, Math.round(raw)));
  } catch {
    return ALARM_PERIOD_DEFAULT;
  }
}

/**
 * Sizes the collection cadence on the subscription list, once.
 *
 * Ten minutes for three hundred channels and half an hour for two thousand are
 * not the same bill: see `CADENCE_TIERS` in the scheduler. The figures are
 * written to the settings rather than applied silently, so that the popup shows
 * the cadence actually in force and lets it be changed.
 *
 * Two guards. A cadence already stored is never overwritten — the user chose
 * it, and the daily reconciliation goes through this same import path. And the
 * whole thing runs only once: growing past a threshold later must not quietly
 * slow down a collection someone is happy with.
 *
 * @param {number} channelCount
 */
async function applyDefaultCadence(channelCount) {
  if (await metaGet(META_CADENCE_SIZED)) return;
  await metaSet(META_CADENCE_SIZED, { at: Date.now(), channelCount });

  const stored = (await chrome.storage.local.get('ytfeed:settings'))?.['ytfeed:settings'] ?? {};
  if (stored.sweepMinutes || stored.alarmMinutes) return;

  const cadence = defaultCadence(channelCount);
  await chrome.storage.local.set({ 'ytfeed:settings': { ...stored, ...cadence } });
  await ensureAlarm();
  log.info(`Cadence sized for ${channelCount} channels`, cadence);
}

async function ensureAlarm() {
  const wanted = await alarmPeriod();
  const existing = await chrome.alarms.get(ALARM_SYNC);
  // Rescheduling identically would push the next wake-up back every time the
  // settings are saved: we only redo it when the period actually changes.
  if (existing && existing.periodInMinutes === wanted) return;
  await chrome.alarms.create(ALARM_SYNC, { periodInMinutes: wanted, delayInMinutes: 0.2 });
  log.info(`Sync alarm scheduled every ${wanted} min`);
}

/** Removes the signed-in account avatar accidentally copied to many channels. */
async function repairSharedAvatarsOnce() {
  if (await metaGet(META_SHARED_AVATARS_CLEARED, false)) return;
  const cleared = await dropSharedChannelAvatars(3);
  await metaSet(META_SHARED_AVATARS_CLEARED, true);
  if (cleared) log.info(`${cleared} incorrect shared channel avatars cleared`);
}

// Alarms normally survive a worker suspension, but Chrome documents that they
// may be cleared on a browser restart or an extension reload. `onStartup` alone
// cannot repair that case once the browser is already running. Every cold worker
// start therefore verifies the one alarm on which collection depends.
ensureAlarm().catch((err) => log.warn('Sync alarm unavailable at worker start', err));
repairSharedAvatarsOnce().catch((err) => log.warn('Shared avatar repair unavailable', err));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_SYNC) return;
  try {
    const result = await runSyncTick({ budgetMs: 45_000, concurrency: 32 });
    announceFeedUpdated(result.inserted);
  } catch (err) {
    log.error('Sync cycle failed', err);
  }
  // After collection, never before: an up-to-date feed comes first.
  try {
    await purgeResidualShorts();
  } catch (err) {
    log.warn('Shorts catch-up failed', err);
  }
  try {
    await settleHistoryDurations();
  } catch (err) {
    log.warn('History settling failed', err);
  }
});

/**
 * As long as a port is connected, Chrome keeps the service worker alive.
 * The popup uses that so a manual full synchronisation is not interrupted
 * halfway through.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ytfeed:keepalive') return;
  log.debug('Keepalive port opened');
  // Opening a port alone no longer resets MV3's idle timer. Real messages do.
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => log.debug('Keepalive port closed'));
});

/**
 * Minimum spacing between two announcements.
 *
 * One announcement per channel meant nine hundred `tabs.query` calls followed
 * by as many cross-process messages, all sent within some twenty seconds.
 * Crossing the boundary costs more than the network request it announces: the
 * queue grew, the bar showed progress further and further behind the real work,
 * and the end felt endless while the sweep was already over.
 *
 * Six announcements per second are plenty for a progress ring.
 */
const PROGRESS_MS = 150;

let lastProgressAt = 0;
const lastManualProgress = new Map();

/**
 * Broadcasts progress to the extension pages and the open YouTube tabs alike.
 *
 * `chrome.runtime.sendMessage` does not reach content scripts: they need
 * `chrome.tabs.sendMessage`. Without it, the grid's refresh button would spin
 * without ever showing progress.
 *
 * @param {object} payload
 * @param {boolean} [force]  always let it through, for the final announcement
 */
function announceProgress(payload, force = false) {
  if (payload.progressId) {
    const previous = lastManualProgress.get(payload.progressId) ?? -1;
    if (Number(payload.done) < previous) return;
    lastManualProgress.set(payload.progressId, Number(payload.done) || 0);
    if (force) setTimeout(() => lastManualProgress.delete(payload.progressId), 5000);
  }
  const now = Date.now();
  if (!force && now - lastProgressAt < PROGRESS_MS) return;
  lastProgressAt = now;

  broadcast(MSG.SYNC_PROGRESS, payload);

  chrome.tabs.query({ url: '*://www.youtube.com/*' })
    .then((tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: MSG.SYNC_PROGRESS, ...payload })
          .catch(() => { /* tab with no active content script */ });
      }
    })
    .catch(() => { /* no access to the tabs */ });
}

/** Makes newly collected rows appear in an already mounted subscriptions tab. */
function announceFeedUpdated(inserted) {
  if (!(inserted > 0)) return;
  const payload = { inserted: Math.trunc(inserted) };
  broadcast(MSG.FEED_UPDATED, payload);
  chrome.tabs.query({ url: '*://www.youtube.com/*' })
    .then((tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: MSG.FEED_UPDATED, ...payload })
          .catch(() => { /* tab with no active content script */ });
      }
    })
    .catch(() => { /* no YouTube tab */ });
}

// ---------------------------------------------------------------------------
// History analysis
// ---------------------------------------------------------------------------

/**
 * The exclusions decided by the user, in `chrome.storage`.
 *
 * Two separate lists, because they are two different gestures: hiding a channel
 * is a permanent editorial choice — one's own channel, opened to re-read
 * oneself —, setting a video aside is a data correction.
 */
async function readExclusions() {
  const { histoBlacklist = [], histoExcludedVideos = [] } =
    await chrome.storage.local.get(['histoBlacklist', 'histoExcludedVideos']);
  return {
    blacklist: new Set(histoBlacklist),
    excludedVideos: new Set(histoExcludedVideos),
  };
}

/**
 * The large sets of the analysis, kept from one message to the next.
 *
 * Opening a channel report would otherwise re-read the whole history, every
 * duration and every channel — the same work as a second earlier, for an
 * identical result. These are near-immutable while browsing: they only move on
 * import, on erase and on enrichment, three moments where we invalidate
 * explicitly.
 *
 * It is the promise that is memoised, not its value: two messages arriving at
 * the same time then share a single read instead of starting two.
 */
const analysisCache = new Map();

/**
 * Short expiry, on top of the explicit invalidation.
 *
 * Invalidation covers what the analysis page writes itself. It does not cover
 * feed collection, which runs in the background in another module and lays down
 * new durations knowing nothing about this cache. Two minutes are enough to
 * make the gap invisible, without wiring the scheduler to the analysis.
 */
const STALE_MS = 120_000;

function memo(key, load) {
  const known = analysisCache.get(key);
  if (known && Date.now() - known.at < STALE_MS) return known.value;

  // A read that fails must not stay cached: the error would otherwise outlive
  // its cause.
  const value = load().catch((err) => {
    analysisCache.delete(key);
    throw err;
  });
  analysisCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Cache entries derived from other entries: invalidating them by hand at every
 * call site would be a guaranteed oversight, and a stale average is all the
 * harder to spot for staying plausible.
 */
const DERIVED_FROM = {
  means: ['history', 'durations', 'histo'],
  shorts: ['histo'],
};

function invalidateAnalysis(...keys) {
  // Recomputing invalidates the analysis, not the last displayed answer.
  // Ordinary session writes previously erased the popup's persistent cache.

  if (!keys.length) { analysisCache.clear(); return; }
  for (const k of keys) analysisCache.delete(k);
  for (const [derived, sources] of Object.entries(DERIVED_FROM)) {
    if (sources.some((s) => keys.includes(s))) analysisCache.delete(derived);
  }
}

/** How many days a brand new video may stay unwatched without breaking its
 *  channel's streak. One week: beyond that, it is a missed video. */
const GRACE_DAYS = 7;

const histoCache = {
  history: () => memo('history', getAllHistory),
  // Counted by sweeping: memoised so that a Takeout import, which arrives in
  // dozens of successive batches, does not redo it for every batch.
  sessions: () => memo('sessions', getWatchSessionStats),
  /**
   * The three facts the analysis reads from the video stores, in one walk.
   *
   * Memoised together and not one by one: the feed index holds tens of thousands
   * of records, and the durations, the publication dates and the upload list all
   * come out of the same `getAll`.
   */
  facts: () => memo('facts', getHistoryVideoFacts),
  durations: async () => (await histoCache.facts()).durations,
  published: async () => (await histoCache.facts()).published,
  uploads: async () => (await histoCache.facts()).uploads,
  histo: () => memo('histo', getHistoChannels),
  channels: () => memo('channels', getAllChannels),
  exclusions: () => memo('exclusions', readExclusions),

  /**
   * Every known Short, across all channels.
   *
   * A Short has no business in the statistics: that is the very point of the
   * extension, and the reason the feed reads `UULF`. The history, however, does
   * contain them — Takeout does not tell them apart from the other rows.
   * Recognising them therefore requires each channel's list of Shorts, fetched
   * during enrichment, and that is what we gather here.
   */
  shorts: () => memo('shorts', async () => {
    const histo = await histoCache.histo();
    const ids = new Set();
    for (const c of histo.values()) for (const id of c.shorts ?? []) ids.add(id);
    return ids;
  }),

  /**
   * The videos published over the last few days, by identifier.
   *
   * A streak must not drop to zero because a channel published this morning.
   * Upload playlists carry no date at all: it is the feed, continuously synced
   * for followed channels, that knows which one is fresh. Outside subscriptions
   * the list is empty and the streak stays strict.
   */
  recent: () => memo('recent', async () => {
    const videos = await getVideosSince(Date.now() - GRACE_DAYS * 864e5);
    return new Set(videos.map((v) => v.videoId ?? v.id));
  }),

  /**
   * Mean duration per channel, as the page must use it.
   *
   * Computed once and shared by every view: without that, the home page, a
   * channel's report and the directory could each estimate the same video
   * differently depending on which view displayed it.
   */
  means: () => memo('means', async () => {
    const [all, durations, histo, shorts] = await Promise.all([
      histoCache.history(), histoCache.durations(), histoCache.histo(), histoCache.shorts(),
    ]);
    const uploads = new Map();
    for (const [id, c] of histo) if (c.meanSec > 0) uploads.set(id, c.meanSec);
    // Shorts are kept out of the sample like everywhere else: a Short duration
    // left in the database by an earlier enrichment would drag the mean down,
    // which is exactly the defect being fixed.
    return refineChannelMeans(all.filter((e) => !shorts.has(e.videoId)), durations, uploads);
  }),
};

/**
 * What the computations must not see: the videos the user set aside by hand,
 * and the Shorts.
 *
 * The two meet here because the analysis functions know of only one set of
 * videos to ignore. They stay separate elsewhere: the list of suspects must go
 * on saying what the user ticked, without mixing in Shorts they never unticked.
 */
function toExclude(excludedVideos, shorts) {
  if (!shorts.size) return excludedVideos;
  const all = new Set(excludedVideos);
  for (const id of shorts) all.add(id);
  return all;
}

// The exclusions live in `chrome.storage`, which announces changes by itself:
// no need to invalidate them by hand from every write.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('histoBlacklist' in changes || 'histoExcludedVideos' in changes) invalidateAnalysis();
  // The wake-up period is set in the popup: the alarm reschedules itself,
  // without the extension having to be reloaded.
  if ('ytfeed:settings' in changes) {
    ensureAlarm().catch((err) => log.warn('Alarm not rescheduled', err));
  }
});

/**
 * Crosses the history with the current subscriptions.
 *
 * Two symmetrical blind spots, and the only results on the page that call for
 * an action: subscriptions no longer watched, and channels watched without
 * being subscribed. The first feed the triage screen.
 *
 * The comparison only holds one way: a subscription absent from the range was
 * not watched **over that range**, which says nothing about what was done with
 * it before. That is why the date of the last known viewing, all periods
 * together, comes with every row.
 */
function crossSubscriptions(stats, actives, all, from, to, uploads = []) {
  const seenInRange = new Set();
  const lastSeen = new Map();
  for (const e of all) {
    if (!e.channelId) continue;
    if (e.watchedAt >= from && e.watchedAt <= to) seenInRange.add(e.channelId);
    const known = lastSeen.get(e.channelId) ?? 0;
    if (e.watchedAt > known) lastSeen.set(e.channelId, e.watchedAt);
  }

  const never = actives
    .filter((c) => !seenInRange.has(c.id))
    .map((c) => ({ channelId: c.id, title: c.title, lastSeen: lastSeen.get(c.id) ?? null }))
    // Never-watched first, then oldest to most recent: that is the order they
    // should be reviewed in.
    .sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));

  const candidates = stats.unsubscribedCandidates ?? [];

  // How many of the subscriptions published anything over the range.
  //
  // "You watched 47 of your 312 channels" reads as an indictment on a range
  // where two hundred of them published nothing at all: over seven days the
  // honest denominator is the channels that gave you something to watch. The
  // upload list comes from the same walk of the feed index that produced the
  // publication dates, so this costs one pass over an array already in memory.
  const publishing = new Set();
  for (const u of uploads) {
    if (u.publishedAt >= from && u.publishedAt <= to) publishing.add(u.channelId);
  }
  let activeInRange = 0;
  for (const c of actives) if (publishing.has(c.id)) activeInRange++;

  // The two columns stay within reach of each other: twelve rows facing two
  // read as an imbalance in the account, when it is only a display ceiling hit
  // on one side. Three apart at most, and the full total stays written above
  // the list.
  const ceiling = Math.min(12, Math.min(never.length, candidates.length) + 3);

  return {
    total: actives.length,
    // The feed index only knows what it has collected, so this figure cannot
    // speak for a range older than the installation, and the screen that shows
    // it says so.
    activeInRange,
    watchedInRange: actives.filter((c) => seenInRange.has(c.id)).length,
    neverWatched: never.length,
    examples: never.slice(0, ceiling),
    candidates: candidates.slice(0, ceiling),
  };
}

/**
 * The only totals a channel report needs, in one pass.
 *
 * The report needs three numbers and a rank. Getting them through
 * `computeStats` meant recomputing, on every click on a channel, the hourly
 * histogram, the sessions, the concentration and the ranking of three thousand
 * seven hundred channels — to keep three values out of it. A loop is enough.
 *
 * The saturation rule is the same as everywhere else: a video reopened counts
 * its openings, not its time twice. Otherwise the share shown on the report
 * would not match the home page's total.
 */
function rangeTotals(entries, { from, to, durations, channelMeans, blacklist }) {
  const viewsPerChannel = new Map();
  const counted = new Set();
  let opens = 0;
  let seconds = 0;

  for (const e of entries) {
    if (e.nonResolue || !e.channelId) continue;
    if (e.watchedAt < from || e.watchedAt > to) continue;
    if (blacklist.has(e.channelId) || blacklist.has(e.channelTitle)) continue;

    opens++;
    viewsPerChannel.set(e.channelId, (viewsPerChannel.get(e.channelId) ?? 0) + 1);

    if (counted.has(e.videoId)) continue;
    counted.add(e.videoId);
    const exact = durations.get(e.videoId);
    seconds += Number.isFinite(exact) && exact > 0
      ? exact
      : (channelMeans.get(e.channelId) ?? 0);
  }

  const views = [...viewsPerChannel.values()];
  return {
    opens,
    seconds,
    channels: viewsPerChannel.size,
    rank: (channelId) => {
      const mine = viewsPerChannel.get(channelId) ?? 0;
      return mine ? views.filter((n) => n > mine).length + 1 : null;
    },
  };
}

/** Attaches to every streak the name of its channel, as the history knows it. */
function withChannelNames(streaks, entries) {
  const names = new Map();
  for (const e of entries) {
    if (e.channelId && e.channelTitle && !names.has(e.channelId)) names.set(e.channelId, e.channelTitle);
  }
  return streaks.map((s) => ({ ...s, title: names.get(s.channelId) ?? s.channelId }));
}

/** One hour before retrying a channel that failed: most often it is a deleted
 *  channel, sometimes a plain network hiccup. */
const RETRY_AFTER_MS = 3_600_000;

/**
 * Attempts before a channel is given up on for good.
 *
 * Without this ceiling the fetch never ended, and that was the whole of the
 * "still under way" that sat in the settings for ever: a deleted channel fails,
 * waits its hour, comes back into the queue, fails again. The set of videos is
 * finite, so the work has to be finite too.
 *
 * Giving up costs little. A channel with no fetched duration falls back on its
 * own mean, and one that never answered at all leaves its videos among the
 * unknown durations the reliability block already counts. Three attempts is
 * enough to tell a network hiccup from a channel that is gone.
 */
const MAX_ATTEMPTS = 3;

function alreadyDone(known) {
  if (!known) return false;
  // A record from before Shorts were excluded has to be redone: its upload list
  // contains them, and that list is what feeds the streaks and the coverage.
  // Without this re-read, an already enriched channel would keep a streak of
  // zero forever because its latest upload is a Short that was never watched.
  if (!known.sansShorts) return false;

  // A record made under the old hundred Short ceiling, whose list came back
  // full: some of its Shorts are missing, so its mean was being handed to
  // videos that are Shorts. `shortsTruncated` is absent from those records and
  // present on every one written since, which dates them exactly — no need for
  // a version number or a separate maintenance pass.
  const OLD_SHORTS_CEILING = 100;
  if (known.shortsTruncated === undefined
      && (known.shorts?.length ?? 0) >= OLD_SHORTS_CEILING) return false;

  if (!known.echec) return true;
  if ((known.echecs ?? 1) >= MAX_ATTEMPTS) return true;
  return Date.now() - (known.fetchedAt ?? 0) < RETRY_AFTER_MS;
}

/**
 * Typical interval between two reads of a channel, for display.
 *
 * The median rather than the mean: a handful of dormant channels at twenty-four
 * hours would be enough to suggest the feed is re-read once a day, when most of
 * the list turns over far faster.
 */
function medianInterval(channels, tuning) {
  if (!channels.length) return null;
  const now = Date.now();
  return median(channels.map((c) => computeInterval(c, now, tuning)));
}

/**
 * The channels to enrich, most watched first.
 *
 * Order matters more than volume: on a real history, the first 200 channels
 * cover half the viewings and the first 500 more than two thirds, while the
 * long tail — two thirds of the channels were watched only once — would return
 * almost nothing for ten times the time. So we stop early, and the per-channel
 * mean does the rest.
 */
async function buildEnrichQueue(max, avatarsFor = []) {
  const all = await histoCache.history();
  const done = await histoCache.histo();
  const { blacklist } = await histoCache.exclusions();

  const counts = new Map();
  for (const e of all) {
    if (!e.channelId || e.nonResolue) continue;
    if (blacklist.has(e.channelId) || blacklist.has(e.channelTitle)) continue;
    if (alreadyDone(done.get(e.channelId))) continue;
    const c = counts.get(e.channelId);
    if (c) c.views++;
    else counts.set(e.channelId, { channelId: e.channelId, title: e.channelTitle, views: 1 });
  }

  const queue = [...counts.values()].sort((a, b) => b.views - a.views).slice(0, max);

  // Channels already enriched but without a picture go to the front, and only
  // for their avatar: one request each, against three to re-read everything.
  const catchUp = avatarsFor
    .filter((id) => done.has(id) && !done.get(id).avatarUrl)
    .map((channelId) => ({ channelId, avatarOnly: true }));

  // The channels at the head of the queue will end up showing in the ranking:
  // might as well pick up their avatar along the way if the playlist does not
  // carry it. Beyond that, the long tail never appears on screen.
  for (const [i, c] of queue.entries()) if (i < 150) c.avatarNeeded = true;

  return [...catchUp, ...queue];
}

/**
 * Midnight opening the day this instant falls in, in the machine's own time.
 *
 * Local and not UTC, deliberately: the lines the history page gives are dated at
 * local noon, and a floor computed in UTC would cut a day in half for anyone
 * living far enough from Greenwich.
 */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

async function readNativeAuditSource(windowDays) {
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
  if (!tab?.id) return { ok: false, reason: 'no-youtube-tab' };
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.AUDIT_NATIVE_SOURCE,
      windowDays,
    });
    if (!result?.ok) return { ok: false, reason: result?.reason ?? 'source-unavailable' };
    if (!await rightAccount(result.key)) return { ok: false, reason: 'other-account' };
    return result;
  } catch (error) {
    log.warn('Native audit source unavailable', error);
    return { ok: false, reason: 'source-unavailable' };
  }
}

async function runAuthenticatedSweepFromTab(progressId = null) {
  const [tabs, channels, recentIds, settings] = await Promise.all([
    chrome.tabs.query({ url: '*://www.youtube.com/*' }),
    getAllChannels(),
    // Known complete rows skip enrichment, never pagination. Incomplete RSS
    // rows must be revisited even when their ids are already in the database.
    getRecentVideoIdsByChannel(1200, { completeOnly: true }),
    chrome.storage.local.get('ytfeed:settings'),
  ]);
  const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
  if (!tab?.id) return { ok: false, reason: 'no-youtube-tab' };
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.AUTH_SWEEP_RUN,
      progressId,
      channels: channels.filter((channel) => channel.active).map((channel) => {
        return {
          id: channel.id,
          knownIds: recentIds.get(channel.id) ?? [],
          // Probe both tabs each time: a cached no-live verdict cannot exclude
          // a channel's first broadcast from the manual coverage window.
          includeLives: settings?.['ytfeed:settings']?.syncLives !== false,
        };
      }),
    });
    return result?.ok ? result : { ok: false, reason: result?.reason ?? 'source-unavailable' };
  } catch (error) {
    log.warn('Authenticated channel sweep unavailable', error);
    return { ok: false, reason: 'source-unavailable' };
  }
}

route({
  [MSG.SYNC_NOW]: async ({ full = false, quick = false, progressId = null }) => {
    progressId = typeof progressId === 'string' ? progressId.slice(0, 80) : null;
    // Refresh asked for from the page. It re-reads every channel, with no
    // ranking and no exclusion: two identical clicks do the same work. And it
    // goes through the internal API, not the Atom feeds, so as not to run into
    // their quarter of an hour of cache — that is what lets it see a video
    // published two minutes earlier.
    if (quick) {
      // The real per-channel Videos tab, sent from the signed-in tab. Its
      // player records are read in that same session; the anonymous worker is
      // only a fallback. UULF remains the compatibility source if YouTube
      // changes the Videos-tab response.
      const authenticated = await runAuthenticatedSweepFromTab(progressId);
      if (authenticated.ok) {
        return { result: { ...authenticated, direct: true, authenticated: true } };
      }

      const result = await runDirectSweep({
        // The last one always goes through: without it the bar would stay stuck
        // on the second-to-last value left by the throttle.
        onProgress: (p) => announceProgress({ ...p, progressId }, p.done === p.total),
      });
      if (!result.fallback) {
        // A refresh is also the moment one looks at the feed, and therefore the
        // moment a Short reclassified since the last cycle would be seen. The
        // catch-up pass otherwise waits for the alarm, which is up to five
        // minutes away, and the user had already been told the feed was up to
        // date. Failure changes nothing to the refresh itself.
        if (!result.directUnavailable) {
          await purgeResidualShorts().catch((err) => log.warn('Shorts catch-up failed', err));
        }
        return { result };
      }

      // The internal API is undocumented: the day it changes shape, the button
      // becomes the old one again rather than doing nothing at all. It then
      // regains its original limit, stated on screen by `cached`.
      log.warn('Refresh: falling back to the Atom feeds');
      const { due, cached } = await markExpiredDue();
      let done = 0;
      const fallback = await runSyncTick({
        budgetMs: 45_000,
        concurrency: 32,
        onProgress: () => announceProgress({ done: ++done, total: due, progressId }),
      });
      return { result: { ...fallback, total: due, cached, cacheTtlMs: CACHE_TTL } };
    }

    if (!full) {
      return { result: await runSyncTick({
        onProgress: (p) => announceProgress({ ...p, progressId }),
      }) };
    }

    const total = await markAllDue();

    // An explicit request justifies a wide budget and more parallelism: the
    // popup keeps the service worker alive through its port. We loop as long as
    // channels remain, otherwise a budget overrun would leave synchronisation
    // half done without saying so.
    const deadline = Date.now() + 5 * 60_000;
    const totals = { checked: 0, inserted: 0, changed: 0, errors: 0, remaining: 0 };
    let done = 0;

    while (Date.now() < deadline) {
      const round = await runSyncTick({
        budgetMs: 60_000,
        concurrency: 32,
        onProgress: () => announceProgress({ done: ++done, total, channel: '', progressId }),
      });
      if (round.skipped) break;

      totals.checked += round.checked ?? 0;
      totals.inserted += round.inserted ?? 0;
      totals.changed += round.changed ?? 0;
      totals.errors += round.errors ?? 0;
      totals.remaining = round.remaining ?? 0;

      if (!round.remaining) break;
    }

    return { result: { ...totals, total } };
  },

  [MSG.SYNC_STATE]: async () => {
    const epoch = snapshotEpoch;
    const [state, stats, channels, harvest, lastHarvest, channelWindow] = await Promise.all([
      getSyncState(), getStats(), getAllChannels(), getNativeCoverage(),
      metaGet(META_LAST_HARVEST, null),
      metaGet('sync.channelWindow', null),
    ]);
    // Cost is estimated with the setting actually in force, automatic pacing
    // included: showing it at the normal regime would have made the diagnosis
    // wrong the moment the user touches the rate.
    const tuning = await readTuning(channels);
    const actives = channels.filter((c) => c.active);
    return remember(UI_SNAPSHOT.state, {
      state,
      stats,
      harvest,
      lastHarvest,
      channelWindow,
      cost: estimateDailyCost(channels, undefined, tuning),
      cadence: {
        ...tuning,
        channels: actives.length,
        withLives: actives.filter((c) => c.livesMode === 'yes').length,
        medianIntervalMs: medianInterval(actives, tuning),
      },
    }, epoch);
  },

  /**
   * The options are copied by list, not enumerated one by one.
   *
   * Manual enumeration cost us: `onlyHidden` had been added to the query and to
   * the interface, but forgotten here. The filter was silently lost on the way
   * — the "Hidden" view returned the normal feed. A shared allow-list makes the
   * oversight impossible.
   */
  [MSG.GET_FEED_PAGE]: async (msg) => getScreenedFeedPage({
    ...pick(msg, FEED_PAGE_OPTIONS), limit: Math.min(60, Math.max(1, Number(msg.limit) || 60)),
  }),

  [MSG.SET_STARRED]: async ({ ids, starred }) => ({
    changed: await setStarred(ids ?? [], starred !== false),
  }),

  /**
   * Missing durations, to be fetched by a YouTube tab.
   *
   * The tab is the one querying the internal API: it alone has the session and
   * the page configuration. The service worker merely says what to look for and
   * records the result.
   */
  [MSG.NEED_DURATIONS]: async ({ maxChannels = 12 }) => ({
    groups: await getMissingDurationsByChannel(maxChannels),
  }),

  /**
   * Broadcasts to re-read, regardless of date.
   *
   * The answer comes back through `SET_DURATIONS`, which already writes both: a
   * finished broadcast delivers its duration and its end in the same reading,
   * there is no reason to separate them.
   */
  [MSG.NEED_BROADCASTS]: async ({ maxChannels = 24 }) => ({
    groups: await getActiveBroadcasts(maxChannels),
  }),

  [MSG.SET_DURATIONS]: async ({
    durations = [], unavailable = [], live = [], upcoming = [], checked = [],
  }) => {
    const valid = durations.filter(([, s]) => Number.isFinite(s) && s > 0);
    const written = await setDurations(new Map(valid), unavailable);
    // A broadcast's state is read in the same answer as the durations: its
    // thumbnail carries a badge instead of a duration for as long as it is live
    // or merely announced. Setting it here saves a dedicated request.
    const lives = await setBroadcastStates({ live, upcoming, checked });
    return { written, lives };
  },

  /**
   * Settles the fate of videos not found in their channel's playlist.
   *
   * The tab read the whole playlist and did not see those videos. Three cases,
   * and a single player record separates them: it is a Short, and it has no
   * business in the database; the record gives a duration, and the video was
   * simply somewhere other than expected; the record says nothing, the video is
   * deleted or private and its duration is unknowable for good.
   *
   * Without this settling, each of those videos kept a duration of zero and came
   * back on every round of the duration quest, where it took up one of the
   * twelve slots reserved for channels — the others never got there.
   */
  [MSG.SETTLE_ABSENT]: async ({ ids = [] }) => {
    // The ceiling is not a saving on requests but a bound on duration: one
    // record per video, in sequence, on a worker that can be killed.
    const batch = ids.filter((id) => typeof id === 'string').slice(0, 20);
    if (!batch.length) return { shorts: 0, durees: 0, inconnues: 0 };

    let removed = 0;
    const found = new Map();
    const unknown = [];

    for (const id of batch) {
      const facts = await fetchVideoFacts(id);
      if (!facts) { unknown.push(id); continue; }
      if (facts.isShort) { removed += facts.removed ?? 0; continue; }
      if (facts.durationSec > 0) found.set(id, facts.durationSec);
      // A live broadcast has no duration and will only have one once it is
      // over: declaring it unknown would freeze it forever.
      else if (!facts.isLive && !facts.isUpcoming) unknown.push(id);
    }

    await setDurations(found, unknown);
    if (removed) log.info(`${removed} Short(s) removed from the database`);
    return { shorts: removed, durees: found.size, inconnues: unknown.length };
  },

  /** Channels whose avatar is missing, to be fetched by a YouTube tab. */
  [MSG.NEED_AVATARS]: async ({ max = 30 }) => ({
    channelIds: await listChannelsMissingAvatar(max),
  }),

  [MSG.SET_AVATARS]: async ({ avatars = [] }) => ({
    filled: await fillMissingAvatars(avatars.filter(([id, url]) => id && url)),
  }),

  /**
   * Addresses the grid could not load. Forgetting them is what allows the
   * catch-up to go and fetch a fresh one: `fillMissingAvatars` deliberately
   * refuses to overwrite an avatar already recorded.
   */
  [MSG.DROP_AVATARS]: async ({ channelIds = [] }) => ({
    cleared: await dropChannelAvatars(channelIds.filter((id) => typeof id === 'string')),
  }),

  [MSG.EXPORT_DATA]: async () => {
    const data = await exportUserData();
    // The settings live in `chrome.storage`, not in IndexedDB, and are just as
    // lost when a profile goes. The transients are left out: a pending import
    // or a half finished triage restored into another profile would fire on
    // their own.
    data.settings = await chrome.storage.local.get(BACKED_UP_SETTINGS);
    // Recorded so triage can refuse to unsubscribe without a recent backup —
    // the operation being irreversible.
    await metaSet('backup.lastExportAt', Date.now());
    return { data };
  },

  [MSG.IMPORT_DATA]: async ({ data, withSettings = true }) => {
    const result = await importUserData(data, {
      onProgress: (p) => broadcast(MSG.RESTORE_PROGRESS, p),
    });

    // Settings are restored last: they are the part one notices immediately,
    // and applying them before the data would show a feed configured for
    // records that are not there yet.
    if (withSettings && data?.settings && typeof data.settings === 'object') {
      const kept = Object.fromEntries(
        Object.entries(data.settings).filter(([k]) => BACKED_UP_SETTINGS.includes(k)),
      );
      if (Object.keys(kept).length) await chrome.storage.local.set(kept);
      result.settings = Object.keys(kept).length;
    }

    // A backup brings back history, durations and measured sessions: the
    // in-memory analysis would not see them otherwise, and the page would go on
    // showing the totals of an empty database.
    // Everything at once: a restore touches every store the analysis reads.
    invalidateAnalysis();
    await clearSnapshots();
    return { result };
  },

  /**
   * The grid names what it is showing; we screen the verdicts that have expired.
   *
   * Also used before releasing incomplete rows after enrichment. Only existing
   * records with a current explicit non-Short verdict return; publication age,
   * starred/hidden state and duration cannot bypass the screening.
   */
  [MSG.SCREEN_SHORTS]: async ({ ids = [] }) => {
    const batch = [...new Set(ids.filter((id) => typeof id === 'string' && /^[\w-]{11}$/.test(id)))].slice(0, 60);
    const records = await verifiedFeedVideos(batch);
    const channels = [...new Set(records.map((v) => v.channelId))];
    for (let start = 0; start < channels.length; start += 4) {
      await Promise.all(channels.slice(start, start + 4).map(refreshChannelShorts));
    }
    return screenFeedVideos(batch);
  },

  [MSG.GET_FEED_COUNTS]: async ({ periods, withViews = false }) => {
    const epoch = snapshotEpoch;
    const [counts, sync] = await Promise.all([getFeedCounts(periods, { withViews }), getSyncState()]);
    // Collection runs in the background: without this date, nothing says how
    // long the feed has been up to date.
    const answer = { counts, lastSyncAt: sync.lastTickAt };
    return withViews && [1, 7, 30].every(n => periods?.includes(n))
      ? remember(UI_SNAPSHOT.counts, answer, epoch) : answer;
  },

  [MSG.GET_FEED_PULSE]: async ({ days = 30 } = {}) => {
    const epoch = snapshotEpoch;
    const [pulse, channels] = await Promise.all([getFeedPulse(days), getAllChannels()]);
    const titles = new Map(channels.map((c) => [c.id, c.title]));

    // The title is resolved here and not in the popup: it does not have the
    // channel list, and sending the whole thing over for five names would be
    // absurd.
    const named = (list) => list.map((e) => ({ ...e, title: titles.get(e.channelId) ?? '' }));
    const answer = { pulse: { ...pulse, topWeek: named(pulse.topWeek), topMonth: named(pulse.topMonth) } };

    // Thirty days of videos plus the whole channel list: the carousel took a
    // visible moment to appear under the feed tab, on every opening.
    return days === 30 ? remember(FEED_PULSE_KEY, answer, epoch) : answer;
  },

  [MSG.GET_STATS]: async () => ({ stats: await getStats() }),

  [MSG.SET_HIDDEN]: async ({ ids, hidden }) => ({
    changed: await setHidden(ids ?? [], hidden !== false),
  }),

  [MSG.HIDE_CHANNEL]: async ({ channelId, hidden = true }) => ({
    changedIds: await hideChannelVideos(channelId, hidden),
  }),

  [MSG.STAR_CHANNEL]: async ({ channelId, starred }) => ({
    changedIds: await setChannelStarred(channelId, starred !== false),
  }),


  /**
   * History imported from Takeout.
   *
   * The file is parsed on the page side — it can weigh tens of megabytes, and
   * making it travel twice would be absurd. The worker only receives entries
   * that are already normalised.
   */
  [MSG.HISTORY_IMPORT]: async ({ entries }) => {
    if (!Array.isArray(entries) || !entries.length) throw new Error('Historique vide');
    const { since } = await histoCache.sessions();
    const result = await putHistory(entries, { measuredSince: since });
    invalidateAnalysis('history');
    await metaSet('history.lastImportAt', Date.now());
    // The settling walks the videos in identifier order, not in date order: new
    // lines land anywhere in that order, so a finished lap has to be redone. It
    // costs nothing to redo — every video already settled is skipped without a
    // request.
    await metaSet(META_SETTLE_HISTORY, { done: false, cursor: null, settled: 0 });
    log.info('History imported', result);
    return { result };
  },

  /**
   * A session measured on the page, as it happens.
   *
   * The message comes back several times for the same session: it is the key,
   * not the number of calls, that decides whether this is a new viewing. The
   * analysis caches are therefore only invalidated on creation, or the day a
   * session finally finds its channel — ordinary rewrites refine the time
   * watched without changing any of the displayed counts, and invalidating on
   * every report would amount to emptying the cache every ten seconds while a
   * video plays.
   *
   * The title and the channel arrive as the page managed to read them, even
   * incomplete: the database is what fills the gaps, because it already knows
   * the video. Deciding here would mean throwing away an identifiable session
   * for the sole reason that the player answered too late.
   */
  [MSG.WATCH_RECORD]: async ({
    videoId, watchedAt, title, channelId, channelTitle, durationSec, watchedSec,
    completed, key = null,
  }) => {
    // What is watched under another account does not belong to this history:
    // the statistics, the streaks and the themes would come out wrong, and
    // nothing on screen would say why.
    if (!await rightAccount(key)) return { created: false, otherAccount: true };
    const settings = await chrome.storage.local.get('ytfeed:settings');
    if (settings?.['ytfeed:settings']?.liveHistory !== true) return { created: false, disabled: true };

    const { created, resolved } = await putWatchSession({
      videoId,
      watchedAt,
      title: title || '',
      channelId: channelId ?? null,
      channelTitle: channelTitle || '',
      durationSec: durationSec ?? null,
      watchedSec: watchedSec ?? 0,
      completed: Boolean(completed),
    });

    if (!created && !resolved) return { created: false };

    invalidateAnalysis('history', 'durations', 'sessions');
    return { created };
  },

  [MSG.HISTORY_EXPORT]: async () => ({
    entries: await exportHistory(await histoCache.durations()),
  }),

  [MSG.HISTORY_SUMMARY]: async () => {
    const epoch = snapshotEpoch;
    // What the extension recorded by itself, so the page can say since when it
    // no longer needs Takeout.
    const sessions = await histoCache.sessions();
    const answer = {
      summary: await getHistorySummary(),
      lastImportAt: await metaGet('history.lastImportAt', 0),
      liveSince: sessions.since,
      liveSessions: sessions.count,
      liveSeconds: sessions.seconds,
    };

    // Reading every measured session costs about 700 ms on a store of fifty
    // seven thousand rows, and the popup was showing two dashes for several
    // seconds on every opening.
    return remember(HIST_SUMMARY_KEY, answer, epoch);
  },

  /**
   * The statistics are computed here and not in the page: entries can number in
   * the tens of thousands, and the database is on this side.
   *
   * The whole history is loaded, not just the range: knowing that a channel is
   * a discovery requires knowing what came before it, and the comparison period
   * lies outside the range by definition.
   */
  [MSG.HISTORY_STATS]: async ({ from = 0, to = Date.now(), topN = 15, cacheScope = null }) => {
    const epoch = snapshotEpoch;
    const [all, durations, histo, subscriptions, exclusions, channelMeans, shorts, recent,
      published, uploads]
      = await Promise.all([
        histoCache.history(), histoCache.durations(), histoCache.histo(),
        histoCache.channels(), histoCache.exclusions(), histoCache.means(),
        histoCache.shorts(), histoCache.recent(),
        histoCache.published(), histoCache.uploads(),
      ]);
    const { blacklist } = exclusions;
    const excludedVideos = toExclude(exclusions.excludedVideos, shorts);

    const uploadsByChannel = new Map();
    for (const [id, c] of histo) {
      if (c.uploads?.length) uploadsByChannel.set(id, c.uploads);
    }

    const actives = subscriptions.filter((c) => c.active !== false);
    const subscribed = new Set(actives.map((c) => c.id));

    // Two sources of avatars: the subscriptions, known since the import, and
    // the enriched channels, whose picture travels with the durations. Without
    // the second, the most watched channels one is not subscribed to would stay
    // faceless even though they sit at the top of the ranking.
    const avatars = new Map();
    for (const [id, c] of histo) if (c.avatarUrl) avatars.set(id, c.avatarUrl);
    for (const c of actives) if (c.avatarUrl) avatars.set(c.id, c.avatarUrl);

    // How the time is counted is a reader's choice, not a datum: the same rows
    // are read twice here, for the range and for the one before it, and both
    // have to answer in the same unit or the comparison would be nonsense.
    const settings = (await chrome.storage.local.get('ytfeed:settings'))?.['ytfeed:settings'] ?? {};
    const pct = Number(settings.realThreshold);
    const common = {
      topN, durations, channelMeans, blacklist, excludedVideos, subscribed,
      timeModel: settings.timeModel === 'auto' ? 'auto' : 'mixed',
      ...(pct > 0 && pct <= 100 ? { realThreshold: pct / 100 } : {}),
    };
    const stats = computeStats(all, { from, to, ...common });
    const previous = previousRange({ from, to });
    const before = computeStats(all, { ...previous, ...common });

    const streaks = withChannelNames(
      computeChannelStreaks(
        all.filter((e) => !excludedVideos.has(e.videoId)), uploadsByChannel, { recent }),
      all);

    // The streak and the avatar join the ranking: they are the same channels,
    // and separating them would force the interface to do the join.
    const byChannel = new Map(streaks.map((s) => [s.channelId, s]));
    for (const c of stats.topChannels) {
      c.avatarUrl = avatars.get(c.channelId) ?? null;
      c.streak = byChannel.get(c.channelId)?.streak ?? 0;
      c.streakCapped = byChannel.get(c.channelId)?.capped ?? false;
      c.streakPending = byChannel.get(c.channelId)?.pending ?? 0;
    }

    // The blacklist counts as much here as anywhere else: without it, the words
    // of an excluded channel still fed the themes, and clicking on one opened
    // no video at all since the search does exclude it.
    const inRange = all.filter((e) => e.watchedAt >= from && e.watchedAt <= to
      && !excludedVideos.has(e.videoId)
      && !blacklist.has(e.channelId) && !blacklist.has(e.channelTitle));

    const answer = {
      stats,
      previous: { total: before.total, totalSeconds: before.totalSeconds,
                  distinctChannels: before.distinctChannels, activeDays: before.activeDays,
                  meanWatchedShare: before.meanWatchedShare },
      // The name travels with the streak: the closely followed channels are not
      // all in the most-watched ranking, and without it the interface would only
      // have a `UC…` identifier to show.
      streaks: streaks.map((s) => ({ ...s, avatarUrl: avatars.get(s.channelId) ?? null })),
      themes: extractThemes(inRange),
      topics: classifyTopics(inRange),
      subscriptions: crossSubscriptions(stats, actives, all, from, to, uploads),

      // How the watching is shaped, as opposed to how much of it there is. All
      // four are computed on the same retained rows as the rest, and each says
      // on screen how many of them it could actually use.
      delays: computeWatchDelays(inRange, published, { from, to }),
      // Who you are fast for, as opposed to how fast you are. Same rows, same
      // publication dates, one grouping more.
      fastest: computeChannelDelays(inRange, published, { from, to }),
      sessions: computeSessions(inRange, { from, to }),
      rewatches: computeRewatches(inRange, { from, to }),
      dropoff: computeDropoff(inRange, durations, { from, to }),
      enriched: histo.size,
      // The channels shown without an avatar, so the next enrichment pass goes
      // and fetches them first.
      withoutAvatar: stats.topChannels.filter((c) => c.channelId && !c.avatarUrl)
        .map((c) => c.channelId),
    };
    return topN === 15 && typeof cacheScope === 'string' && cacheScope.length <= 200
      ? remember(UI_SNAPSHOT.stats, { ...answer, cacheScope }, epoch) : answer;
  },

  /**
   * A channel's report.
   *
   * The rank is computed here rather than in the report: it only makes sense
   * relative to the other channels of the same range, which only an overall view
   * knows about.
   */
  [MSG.HISTORY_CHANNEL]: async ({ channelId, from = 0, to = Date.now() }) => {
    const [all, durations, histo, subscriptions, exclusions, channelMeans, shorts,
      published, uploads]
      = await Promise.all([
        histoCache.history(), histoCache.durations(), histoCache.histo(),
        histoCache.channels(), histoCache.exclusions(), histoCache.means(),
        histoCache.shorts(), histoCache.published(), histoCache.uploads(),
      ]);
    const { blacklist } = exclusions;
    const excludedVideos = toExclude(exclusions.excludedVideos, shorts);

    const kept = all.filter((e) => !excludedVideos.has(e.videoId));
    const report = computeChannelReport(kept, {
      channelId, from, to, durations, channelMeans,
      uploads: histo.get(channelId)?.uploads ?? [],
    });
    if (!report) return { report: null };

    const overall = rangeTotals(kept, { from, to, durations, channelMeans, blacklist });
    const subscription = subscriptions.find((c) => c.id === channelId && c.active !== false);

    return {
      report: {
        ...report,
        avatarUrl: subscription?.avatarUrl ?? histo.get(channelId)?.avatarUrl ?? null,
        subscribed: Boolean(subscription),
        hidden: blacklist.has(channelId) || blacklist.has(report.title),
        rank: overall.rank(channelId),
        rangeChannels: overall.channels,
        timeShare: overall.seconds ? report.seconds / overall.seconds : 0,
        viewShare: overall.opens ? report.opens / overall.opens : 0,

        // The same three questions as the overall view, asked of this channel
        // alone. `its` is rebuilt here rather than returned by the report: the
        // report is a set of figures, not the rows they came from.
        delays: computeWatchDelays(
          kept.filter((e) => e.channelId === channelId), published, { from, to }),
        dropoff: computeDropoff(
          kept.filter((e) => e.channelId === channelId), durations, { from, to }),
        publishing: computeUploadRhythm(uploads, { channelId }),
      },
    };
  },

  /** Directory for the search: the whole history, as lightweight rows. */
  [MSG.HISTORY_CHANNEL_LIST]: async () => {
    const [all, durations, histo, subscriptions, exclusions, channelMeans, shorts]
      = await Promise.all([
        histoCache.history(), histoCache.durations(), histoCache.histo(),
        histoCache.channels(), histoCache.exclusions(), histoCache.means(),
        histoCache.shorts(),
      ]);
    const { blacklist } = exclusions;
    const excludedVideos = toExclude(exclusions.excludedVideos, shorts);

    const avatars = new Map();
    for (const [id, c] of histo) {
      if (c.avatarUrl) avatars.set(id, c.avatarUrl);
    }
    for (const c of subscriptions) if (c.active !== false && c.avatarUrl) avatars.set(c.id, c.avatarUrl);
    const followed = new Set(subscriptions.filter((c) => c.active !== false).map((c) => c.id));

    const kept = all.filter((e) => !excludedVideos.has(e.videoId)
      && !blacklist.has(e.channelId) && !blacklist.has(e.channelTitle));

    return {
      channels: listHistoryChannels(kept, { durations, channelMeans }).map((c) => ({
        ...c, avatarUrl: avatars.get(c.channelId) ?? null, subscribed: followed.has(c.channelId),
      })),
    };
  },

  /**
   * Channel side facts for the games.
   *
   * Sent as a plain object and not as a Map: message passing serialises through
   * JSON, where a Map arrives empty.
   */
  [MSG.HISTORY_CHANNEL_FACTS]: async () => ({
    facts: Object.fromEntries(await getChannelFacts()),
  }),

  /** The videos behind a theme or a topic, so they can be clicked. */
  [MSG.HISTORY_VIDEOS]: async ({ term = '', topic = '', channelId = null, from = 0, to = Date.now() }) => {
    const [all, durations, exclusions, channelMeans, shorts] = await Promise.all([
      histoCache.history(), histoCache.durations(), histoCache.exclusions(),
      histoCache.means(), histoCache.shorts(),
    ]);
    const { blacklist } = exclusions;
    const excludedVideos = toExclude(exclusions.excludedVideos, shorts);

    const kept = all.filter((e) => !excludedVideos.has(e.videoId)
      && !blacklist.has(e.channelId) && !blacklist.has(e.channelTitle));

    return {
      videos: findVideosByTerm(kept, {
        term, topic, channelId, from, to, durations, channelMeans,
      }),
    };
  },

  /**
   * One day of history, row by row.
   *
   * Deliberately not derived from `computeStats`: the statistics aggregate, and
   * what is wanted here is the opposite — each row as it is stored, with what
   * the feed index knows of the same video beside it. That pairing is what makes
   * this the place to look when a figure elsewhere looks wrong.
   */
  [MSG.HISTORY_DAY]: async ({ from = 0, to = 0 }) => {
    const [all, durations, channelMeans, exclusions, shorts] = await Promise.all([
      histoCache.history(), histoCache.durations(), histoCache.means(),
      histoCache.exclusions(), histoCache.shorts(),
    ]);
    const { blacklist } = exclusions;
    const journal = buildDayJournal(all, {
      from,
      to,
      durations,
      channelMeans,
      excludedVideos: toExclude(exclusions.excludedVideos, shorts),
      blacklist,
    });

    // The other half of the story: what the feed holds for the same videos. A
    // viewing whose video is absent from the feed, or hidden in it, explains at
    // a glance an anomaly that the totals can only hint at.
    const feed = await getVideosByIds(journal.entries.map((e) => e.videoId));
    for (const e of journal.entries) {
      const v = feed.get(e.videoId);
      e.feed = v ? {
        hidden: Boolean(v.hidden),
        watched: Boolean(v.watched),
        watchProgress: v.watchProgress ?? 0,
        starred: Boolean(v.starred),
        publishedAt: Number.isFinite(v.publishedAt) ? v.publishedAt : null,
        durationSec: Number.isFinite(v.durationSec) ? v.durationSec : null,
      } : null;
    }

    return journal;
  },

  /** The videos suspected of being tabs left open, and their verdict. */
  [MSG.HISTORY_SUSPECTS]: async ({ minViews = 11 } = {}) => {
    const [all, { excludedVideos }] = await Promise.all([
      histoCache.history(), histoCache.exclusions(),
    ]);
    return {
      suspects: detectAutoOpened(all, { minViews })
        .map((s) => ({ ...s, excluded: excludedVideos.has(s.videoId) })),
    };
  },

  [MSG.HISTORY_CLEAR]: async () => {
    const cleared = await clearHistory();
    invalidateAnalysis('history');
    await clearSnapshots([UI_SNAPSHOT.history, UI_SNAPSHOT.highlights, UI_SNAPSHOT.stats]);
    return { cleared };
  },


  // -------------------------------------------------- the YouTube history page

  /**
   * Starts the collection and wakes a YouTube tab up to do it.
   *
   * The token is held here, not in the tab: the run is several minutes long —
   * 255 requests for a six year history, measured — and a tab reloaded halfway
   * through must pick up where it stopped rather than start over.
   *
   * A run that reached its end dates itself, and the next one stops there. The
   * page is served newest first, so going back further than the last complete
   * run brings nothing: 255 requests and four minutes on the first pass, and on
   * a pass a month later, the handful of pages that cover the month. The floor
   * is the day *before* the last run rather than the run itself, because these
   * lines carry a day and not an hour: the day the run happened was only
   * covered up to that moment, and it has to be walked again in full. Rewriting
   * it costs nothing — a line is only written where nothing already covers that
   * video on that day.
   */
  [MSG.HISTORY_SCRAPE_START]: async ({ resume = false, full = false } = {}) => {
    if (!resume) {
      await metaSet('histoScrape.token', null);
      await metaSet('histoScrape.inserted', 0);
      await metaSet('histoScrape.covered', 0);
      await metaSet('histoScrape.pages', 0);
      await metaSet('histoScrape.oldest', null);
      await metaSet('histoScrape.startedAt', Date.now());

      const previous = await metaGet('histoScrape.completedAt', null);
      await metaSet('histoScrape.floor',
        full || !Number.isFinite(previous) ? null : startOfDay(previous) - 86_400_000);
    }
    await metaSet('histoScrape.running', true);
    await metaSet('histoScrape.done', false);
    await metaSet('histoScrape.lastPutAt', Date.now());

    const [tab] = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
    if (!tab) {
      await metaSet('histoScrape.running', false);
      return { started: false, reason: 'hist.enr.notab' };
    }

    chrome.tabs.sendMessage(tab.id, { type: MSG.HISTORY_SCRAPE_RUN }).catch(() => {});
    return { started: true };
  },

  [MSG.HISTORY_SCRAPE_STOP]: async () => {
    await metaSet('histoScrape.running', false);
    return { stopped: true };
  },

  /** State of the collection, with the same watchdog as the enrichment. */
  [MSG.HISTORY_SCRAPE_STATE]: async () => {
    const running = await metaGet('histoScrape.running', false);
    const lastPutAt = await metaGet('histoScrape.lastPutAt', 0);
    const stalled = running && lastPutAt > 0 && Date.now() - lastPutAt > 60_000;
    if (stalled) await metaSet('histoScrape.running', false);

    return {
      running: running && !stalled,
      stalled,
      done: await metaGet('histoScrape.done', false),
      token: await metaGet('histoScrape.token', null),
      pages: await metaGet('histoScrape.pages', 0),
      inserted: await metaGet('histoScrape.inserted', 0),
      covered: await metaGet('histoScrape.covered', 0),
      oldest: await metaGet('histoScrape.oldest', null),
      // What the page needs to say how far the next run will go, and to offer
      // starting over from the beginning.
      completedAt: await metaGet('histoScrape.completedAt', null),
      floor: await metaGet('histoScrape.floor', null),
    };
  },

  /**
   * One page of results. The token only moves here, never on handing work out:
   * a worker that dies in between simply makes the tab redo one page.
   */
  [MSG.HISTORY_SCRAPE_PUT]: async ({ entries = [], continuation = null, oldest = null }) => {
    if (!await metaGet('histoScrape.running', false)) return { running: false, token: null };
    await metaSet('histoScrape.lastPutAt', Date.now());

    const { inserted, covered } = await putScrapedHistory(entries);
    await metaSet('histoScrape.inserted', await metaGet('histoScrape.inserted', 0) + inserted);
    await metaSet('histoScrape.covered', await metaGet('histoScrape.covered', 0) + covered);
    await metaSet('histoScrape.pages', await metaGet('histoScrape.pages', 0) + 1);
    if (Number.isFinite(oldest)) await metaSet('histoScrape.oldest', oldest);
    await metaSet('histoScrape.token', continuation);

    // Two ways to be finished, and they mean the same thing: everything from
    // today back to where this run had to reach is collected. YouTube ran out of
    // pages, or this page went past the floor the previous run left. Only these
    // two date the run — a run the user stopped, or one a dead tab left hanging,
    // must not shrink the reach of the next.
    const floor = await metaGet('histoScrape.floor', null);
    const reachedFloor = Number.isFinite(floor) && Number.isFinite(oldest) && oldest <= floor;
    const finished = !continuation || reachedFloor;

    if (finished) {
      await metaSet('histoScrape.running', false);
      await metaSet('histoScrape.done', true);
      // Nothing left to resume: a token kept here would offer picking up a run
      // that has none of its work left to do.
      await metaSet('histoScrape.token', null);
      // The moment the run started, not the moment it ends: the four minutes it
      // took are four minutes of viewings the next run must still walk over.
      await metaSet('histoScrape.completedAt',
        await metaGet('histoScrape.startedAt', null) ?? Date.now());
    }
    if (inserted) invalidateAnalysis('history');

    return { running: !finished, token: finished ? null : continuation };
  },

  // ------------------------------------------------------------- durations

  /**
   * Starts the enrichment and wakes a YouTube tab up to do it.
   *
   * With no tab open nothing can be done: the extension page has no access to
   * youtube.com's cookies. We say so rather than fail silently.
   */
  [MSG.HISTORY_ENRICH_START]: async ({ max = 500, avatarsFor = [] } = {}) => {
    await metaSet('histoEnrich.queue', await buildEnrichQueue(max, avatarsFor));
    await metaSet('histoEnrich.running', true);
    // The watchdog counts from now on, otherwise the date of the previous
    // session's last result would trigger a stop straight away.
    await metaSet('histoEnrich.lastPutAt', Date.now());

    const [tab] = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
    if (!tab) {
      await metaSet('histoEnrich.running', false);
      return { started: false, reason: 'hist.enr.notab' };
    }

    chrome.tabs.sendMessage(tab.id, { type: MSG.HISTORY_ENRICH_RUN }).catch(() => {});
    return { started: true };
  },

  [MSG.HISTORY_ENRICH_STOP]: async () => {
    await metaSet('histoEnrich.running', false);
    return { stopped: true };
  },

  /**
   * State of the fetch, with a watchdog.
   *
   * The working tab can disappear at any moment — closed, navigated away, put
   * to sleep. With no time reference, "running" outlived the tab and the page
   * waited forever on progress nobody was making any more. One minute without
   * a single result therefore counts as a stop.
   */
  [MSG.HISTORY_ENRICH_STATE]: async () => {
    const running = await metaGet('histoEnrich.running', false);
    const queue = await metaGet('histoEnrich.queue', []);
    const lastPutAt = await metaGet('histoEnrich.lastPutAt', 0);
    const stalled = running && lastPutAt > 0 && Date.now() - lastPutAt > 60_000;

    if (stalled) await metaSet('histoEnrich.running', false);

    const histo = await histoCache.histo();
    let failures = 0;
    for (const c of histo.values()) if (c.echec) failures++;

    return {
      running: running && !stalled,
      stalled,
      remaining: queue.length,
      enriched: histo.size - failures,
      failures,
    };
  },

  /** The tab asks for work. Nothing to give means enrichment is over. */
  [MSG.HISTORY_ENRICH_NEXT]: async ({ batch = 3 } = {}) => {
    if (!await metaGet('histoEnrich.running', false)) return { channels: [], remaining: 0 };
    const queue = await metaGet('histoEnrich.queue', []);
    const channels = queue.slice(0, batch);
    if (!channels.length) await metaSet('histoEnrich.running', false);
    return { channels, remaining: queue.length };
  },

  /**
   * Result for one channel. The queue only moves here, never on handing work
   * out: if the worker dies in between, the channel is simply redone.
   */
  [MSG.HISTORY_ENRICH_PUT]: async ({
    channelId, videos = [], shorts = [], shortsTruncated = false,
    avatarUrl = null, avatarOnly = false, failed = false,
  }) => {
    // The heartbeat of the fetch. It is what distinguishes "running" from
    // "stalled": without this date, a tab closed at the wrong moment left the
    // state on "running" forever.
    await metaSet('histoEnrich.lastPutAt', Date.now());

    if (avatarOnly) {
      await putHistoAvatar(channelId, avatarUrl);
    } else if (failed) {
      // A trace of the failure, so the queue moves on and the channel is
      // retried later rather than struck off for good. Above all: without
      // touching what had already been fetched.
      await putHistoFailure(channelId);
    } else {
      const withDuration = videos.filter((v) => v.durationSec > 0);
      await putDurations(withDuration.map((v) => ({ videoId: v.id, sec: v.durationSec })));

      // The playlist queried only returns long form: the mean is therefore clean
      // by construction, without having to guess what is a Short from its
      // duration — which we can no longer do now that they run up to three
      // minutes.
      // No mean when the channel's Shorts could not be enumerated.
      //
      // The mean is what a video of unknown duration is credited with, and the
      // Shorts list is what says a video should not be credited with anything.
      // When the second is cut off, the first stops being an estimate and
      // becomes an invention: a Short watched for forty seconds was counted as
      // a two hour stream VOD. Leaving the mean at zero puts those videos back
      // among the ones whose duration is unknown, which the page states plainly
      // instead of inventing hours for them.
      const meanSec = shortsTruncated || !withDuration.length
        ? 0
        : withDuration.reduce((s, v) => s + v.durationSec, 0) / withDuration.length;

      await putHistoChannel({
        channelId,
        avatarUrl,
        meanSec,
        sampled: withDuration.length,
        uploads: videos.map((v) => v.id),
        shorts,
        shortsTruncated,
      });
    }

    // Durations and channel records have just changed: keeping them cached would
    // display missing hours that the enrichment has already found. The history
    // itself has not moved — no need to re-read it.
    invalidateAnalysis('durations', 'histo');

    const queue = await metaGet('histoEnrich.queue', []);
    await metaSet('histoEnrich.queue', queue.filter((c) => c.channelId !== channelId));
    return { ok: true, remaining: Math.max(0, queue.length - 1) };
  },

  /**
   * The figures at the bottom of the Triage and History tabs.
   *
   * Both together, in a single answer: the popup asks for them at the same
   * moment, and two round trips would only make them appear one after the other.
   *
   * The history goes through the cache: reading it is expensive and the popup
   * opens often. Nothing is formatted here — dates and numbers are read in the
   * page's language and timezone, not in the worker's.
   */
  [MSG.POPUP_HIGHLIGHTS]: async () => {
    const epoch = snapshotEpoch;
    const [all, durations, exclusions, channelMeans, shorts, channels] = await Promise.all([
      histoCache.history(), histoCache.durations(), histoCache.exclusions(),
      histoCache.means(), histoCache.shorts(), getChannelsForTriage(),
    ]);

    return remember(UI_SNAPSHOT.highlights, {
      history: historyHighlights(all, {
        durations,
        channelMeans,
        blacklist: exclusions.blacklist,
        excludedVideos: toExclude(exclusions.excludedVideos, shorts),
      }),
      triage: triageFigures(channels),
    }, epoch);
  },

  [MSG.TRIAGE_CHANNELS]: async () => ({
    channels: await getChannelsForTriage(),
    lastExportAt: await metaGet('backup.lastExportAt', 0),
  }),

  /**
   * Context for applying a list in bulk.
   *
   * The raw channel list, without the triage ranking or videos: the bulk screen
   * only compares identifiers, and loading the thumbnails of nine hundred
   * channels for that would make no sense.
   */
  [MSG.BULK_CONTEXT]: async ({ key = null } = {}) => {
    // Applying a list unsubscribes for good, on the signed-in account.
    // Delivering this database's subscriptions to another account would make it
    // join channels it does not follow and leave its own.
    if (!await rightAccount(key)) throw new Error('err.autrecompte');

    return {
      subscriptions: (await getAllChannels()).map((c) => ({
        id: c.id, title: c.title, avatarUrl: c.avatarUrl ?? null, active: c.active,
      })),
      lastExportAt: await metaGet('backup.lastExportAt', 0),
    };
  },

  [MSG.TRIAGE_VIDEOS]: async ({ channelId, limit = 6, offset = 0 }) => ({
    videos: await getChannelVideos(channelId, limit, offset),
  }),

  /** Position in the triage, so it can be picked up where it was left off. */
  [MSG.TRIAGE_PROGRESS]: async ({ save }) => {
    if (save !== undefined) await metaSet('triage.progress', save);
    return { progress: await metaGet('triage.progress', null) };
  },

  [MSG.SET_WATCHED]: async ({ id, progress, completed }) => ({
    updated: await setWatched(id, progress ?? 1, completed === true),
  }),

  /**
   * Videos read from YouTube's own history.
   *
   * They were not watched here: local tracking only sees playbacks made in this
   * browser, and therefore misses everything that happens on a phone or on a
   * TV. Only videos already known are touched — the history contains plenty of
   * things other than subscriptions.
   */
  [MSG.MARK_WATCHED]: async ({ entries, key = null }) => {
    // The watch history belongs to the session that read it. Coming from another
    // account, it would mark as watched videos never opened here.
    if (!await rightAccount(key)) return { updated: 0, otherAccount: true };
    if (!Array.isArray(entries)) return { updated: 0 };
    let updated = 0;
    for (const e of entries) {
      if (!/^[\w-]{11}$/.test(e?.id ?? '')) continue;
      if (await setWatched(e.id, e.progress ?? 1, e.completed === true)) updated++;
    }
    if (updated) log.info(`${updated} video(s) marked watched from the YouTube history`);
    return { updated };
  },

  [MSG.GET_CHANNELS]: async ({ withVideos = false, videoLimit = 8 }) => {
    const channels = await getAllChannels();
    if (!withVideos) return { channels };
    for (const c of channels) c.recentVideos = await getChannelVideos(c.id, videoLimit);
    return { channels };
  },

  /**
   * A subscription observed while browsing.
   *
   * Saves having to relaunch an import after every new subscription. A channel
   * discovered here is made due immediately, so its videos arrive on the next
   * cycle rather than on the next manual import.
   *
   * On unsubscribing, the channel is deactivated *and* its videos deleted:
   * stopping at deactivation would leave everything it has already published in
   * the feed, which is precisely what one no longer wants to see. The calling
   * content script guarantees we went through a real state change observed on
   * the page, never through a plain negative reading.
   */
  [MSG.SUBSCRIPTION_SEEN]: async ({ channelId, subscribed, key = null }) => {
    // Silently ignored, unlike the import: this is a passing observation, not a
    // requested action. An unsubscription detected on another account would
    // still delete the channel's videos in this database.
    if (!await rightAccount(key)) return { known: false, added: false, otherAccount: true };

    const existing = await getChannel(channelId);

    if (subscribed) {
      if (existing?.active) return { known: true, added: false };

      const channel = existing
        ? { ...existing, active: 1, nextDueAt: 0 }
        : makeChannel(channelId, '', '');
      await putChannel(channel);
      log.info(`Subscription ${existing ? 'reactivated' : 'added'}: ${channelId}`);

      // Without waiting for the next wake-up: we have just subscribed, we want
      // to see its videos right away.
      runSyncTick({ budgetMs: 15_000, maxChannels: 5 }).catch(() => {});
      return { known: Boolean(existing), added: true };
    }

    if (!existing?.active) return { known: Boolean(existing), added: false };

    await putChannel({ ...existing, active: 0, videoCount: 0 });
    const deleted = await deleteChannelVideos(channelId);
    log.info(`Unsubscription detected: ${channelId} — ${deleted} videos deleted`);
    return { known: true, removed: true, deleted };
  },

  [MSG.ACCOUNT_SEEN]: async ({ key = null }) => {
    const account = await noteAccount(key);
    ensureAlarm().catch((err) => log.warn('Sync alarm unavailable after tab wake-up', err));
    return account;
  },

  [MSG.AUTO_SYNC_NUDGE]: async ({ key = null }) => {
    if (!await rightAccount(key)) return { otherAccount: true };
    // The message port remains open for this promise, so Chrome cannot suspend
    // the MV3 worker halfway through the catch-up triggered by an open tab.
    const result = await runSyncTick({ budgetMs: 45_000, concurrency: 32 });
    announceFeedUpdated(result.inserted);
    return { result };
  },

  /**
   * @param {object} msg
   * @param {boolean} [msg.complete] does the list cover *all* the subscriptions?
   *   Only a complete list allows deleting the videos of the absent channels:
   *   on a truncated import — a partial file, an interrupted pagination — that
   *   would erase what is still being followed.
   */
  [MSG.IMPORT_SUBSCRIPTIONS]: async ({ channels, complete = false, automatic = false, key = null }) => {
    if (!Array.isArray(channels) || !channels.length) {
      throw new Error('Import vide');
    }

    // Refused, not ignored: an import from another account would deactivate all
    // of this one's subscriptions, and delete their videos when the list is
    // complete. It is the most destructive operation in the extension, and the
    // daily reconciliation triggers it all by itself.
    if (!await rightAccount(key)) throw new Error('err.autrecompte');

    const result = await reconcileChannels(channels, { complete, confirmAbsent: automatic });
    let purged = 0;

    if (complete && result.deactivatedIds?.length) {
      for (const id of result.deactivatedIds) purged += await deleteChannelVideos(id);
      log.info(`${result.deactivatedIds.length} channel(s) left elsewhere, ${purged} videos removed`);
    }

    await applyDefaultCadence(result.total);

    log.info('Subscriptions imported', result);
    return { result: { ...result, purged } };
  },

  /**
   * Native feed harvest: it serves three purposes at once.
   *  - enrichment, because YouTube gives the durations RSS does not have;
   *  - measurement, because knowing what YouTube showed is the only way to
   *    quantify what it hides;
   *  - collection, because this is the only source that sees a publication at
   *    the moment YouTube does. It used to measure what it was not allowed to
   *    collect, which is how a video could be observed here, recorded in the
   *    audit as missing, and still never reach the grid.
   */
  [MSG.NATIVE_HARVEST]: async ({ videos, diagnostic, key = null }) => {
    // Another account's native feed does not talk about our channels: it would
    // wrongly mark videos as "seen at YouTube", which skews the coverage the
    // audit measures.
    if (!await rightAccount(key)) return { inserted: 0, updated: 0, otherAccount: true };

    // The diagnostic is kept even when the batch is empty: that is what makes it
    // possible to tell "the page contained nothing" from "extraction is
    // broken", without having to open the console.
    if (diagnostic) await metaSet(META_LAST_HARVEST, { ...diagnostic, at: Date.now() });

    if (!Array.isArray(videos) || !videos.length) return { inserted: 0, updated: 0 };

    const now = Date.now();

    const tagged = videos.map((v) => ({ ...v, seenNativeAt: now, source: 'native' }));

    // Preserve the native evidence even when the video is absent from
    // TrackTube. It lives in a separate audit store and can never feed the grid.
    const observed = await recordNativeVideos(tagged, now);

    // Lives and premieres are inserted from the DOM alone. The lives feed
    // (`UULV`) reports them, but without saying which are running or when a
    // premiere starts — only the native feed carries those two facts, and they
    // decide how the video is displayed. Those videos are formally identified
    // by a badge or a start date, so letting them in opens no door to Shorts.
    const broadcasts = tagged.filter((v) => v.isLive || v.isUpcoming);
    const ordinary = tagged.filter((v) => !v.isLive && !v.isUpcoming);

    // This pass stays update only, and it is the one that enriches: it carries
    // the duration and the playback progress onto rows that already exist,
    // whatever their channel, without ever creating anything.
    const written = await upsertVideos(ordinary, { allowInsert: false });
    const lives = broadcasts.length
      ? await upsertVideos(broadcasts, { allowInsert: true })
      : { inserted: 0, updated: 0 };

    // Creation, which this harvest was forbidden for a long time. The reason
    // given was that the page carries Shorts and nothing in its DOM rules them
    // out for certain; that is still true of the DOM, and no longer true of the
    // question, because a verdict now comes from the UUSH list and the player's
    // canonical URL rather than from the card. What this source is worth is the
    // delay: it is the only one that sees a publication at the moment YouTube
    // does, where a feed read waits for its channel's turn and the manual sweep
    // waits for a click.
    //
    // No screening is written here, deliberately. The videos go through the
    // very function the channel sweep creates with, so one policy governs both
    // paths instead of two that drift:
    //   - a channel that is not followed and active is refused outright, which
    //     is what keeps YouTube's recommendations out of the grid;
    //   - a player record that does not positively say "not a Short" inserts
    //     nothing and is retried later;
    //   - a video with no duration is deferred rather than stored invisible.
    // Grouping by channel is what that function expects, and it costs nothing:
    // the tab only sends cards whose contents changed since the last pass.
    //
    // The source is `native-verified` and emphatically not `native`:
    // `purgeNativeInserted` deletes every row whose source is exactly that, and
    // it is the one-time cleanup of the unscreened inserts this harvest used to
    // make, Shorts included. It has already run on installed profiles, but on a
    // fresh one it runs at startup, and reusing the word would arm a cleanup
    // against the rows it is meant to protect.
    const byChannel = new Map();
    for (const video of ordinary) {
      if (!RE_CHANNEL_ID.test(video.channelId ?? '')) continue;
      const batch = byChannel.get(video.channelId);
      if (batch) batch.push(video);
      else byChannel.set(video.channelId, [video]);
    }
    // Four channels at a time. A channel already holding all of its cards with
    // their durations returns before touching the network, so in steady state
    // this costs nothing; the first pass after an install is the one that has a
    // player record to spend per video, and waiting for them one after another
    // would hold the new cards back for as long as there are videos to admit.
    const created = {
      inserted: 0, deferred: 0, shorts: 0, errors: 0, channels: byChannel.size,
    };
    // `pool` reports each job as {ok, value} or {ok, error}: one channel
    // failing must not cost the harvest the others, nor the enrichment and the
    // audit measurement already done above.
    const outcomes = await pool([...byChannel], 4, ([id, batch]) =>
      ingestAuthenticatedUploads(id, batch, { source: 'native-verified' }));
    for (const outcome of outcomes) {
      if (!outcome?.ok) { created.errors++; continue; }
      created.inserted += outcome.value?.inserted ?? 0;
      created.deferred += outcome.value?.deferred ?? 0;
      created.shorts += outcome.value?.shorts ?? 0;
    }
    // The cards appear on their own, which is the whole report this owes the
    // reader: no banner, no sentence.
    announceFeedUpdated(created.inserted);

    // Kept beside the extraction counters, so the diagnostics can tell a page
    // that yielded nothing from one whose videos were all refused, and say on
    // which of the three grounds.
    if (diagnostic) {
      await metaSet(META_LAST_HARVEST, { ...diagnostic, created, at: Date.now() });
    }

    const coverage = await recordNativeCoverage({
      oldestPublishedAt: observed.oldestPublishedAt,
      count: observed.inserted,
    });

    // Catching up on the avatars the initial import could not read.
    const avatars = new Map();
    for (const v of videos) {
      if (v.channelId && v.channelAvatar && !avatars.has(v.channelId)) {
        avatars.set(v.channelId, v.channelAvatar);
      }
    }
    const avatarsFilled = await fillMissingAvatars(avatars);

    return {
      ...written, observed, coverage, avatarsFilled,
      livesInserted: lives.inserted, created,
    };
  },

  [MSG.AUDIT_RUN]: async ({ windowDays }) => ({ report: await runAudit({ windowDays }) }),
  [MSG.AUTH_SWEEP_CHANNEL]: async ({
    channelId, videos, avatarUrl, sourceFailed, backfilled = false, coverage = null, key,
  }) => {
    if (!await rightAccount(key)) return { inserted: 0, deferred: 0, otherAccount: true };
    const avatarsFilled = !sourceFailed && typeof avatarUrl === 'string' && avatarUrl
      ? await fillMissingAvatars(new Map([[channelId, avatarUrl]]), { replace: true })
      : 0;
    const result = sourceFailed
      ? await ingestChannelRssFallback(channelId)
      : await ingestAuthenticatedUploads(channelId, videos, { backfilled });
    if (coverage) {
      const channel = await getChannel(channelId);
      if (channel) await putChannel({ ...channel, directCoverage: {
        ...coverage, partial: coverage.partial || (result.deferred ?? 0) > 0,
        deferred: result.deferred ?? 0,
      } });
    }
    return { ...result, avatarsFilled };
  },
  [MSG.AUTH_SWEEP_PROGRESS]: async ({ progressId, done, total, key }) => {
    if (!await rightAccount(key)) return { otherAccount: true };
    const safeDone = Math.max(0, Number(done) || 0);
    const safeTotal = Math.max(0, Number(total) || 0);
    announceProgress(
      { progressId: String(progressId ?? '').slice(0, 80), done: safeDone, total: safeTotal, channel: '' },
      safeTotal > 0 && safeDone >= safeTotal,
    );
    return { announced: true };
  },
  [MSG.AUTH_SWEEP_DONE]: async ({ progressId, total, result, key }, sender) => {
    const safeTotal = Math.max(0, Number(total) || 0);
    const same = await rightAccount(key);
    const outcome = result && typeof result === 'object' ? result : {};
    const failed = !same || outcome.ok === false;
    const partial = failed || (outcome.errors ?? 0) > 0 || (outcome.deferred ?? 0) > 0
      || (outcome.partial ?? 0) > 0 || (outcome.checked ?? 0) < safeTotal;
    if (same) await metaSet('sync.channelWindow', { ...outcome, at: Date.now(), partial });
    const completion = {
      progressId: String(progressId ?? '').slice(0, 80),
      done: safeTotal,
      total: safeTotal,
      finished: true,
      failed,
      partial,
      result: outcome,
      error: !same ? 'err.autrecompte' : (outcome.error || outcome.reason || null),
    };
    announceProgress(completion, true);
    // The general broadcast is deliberately fire and forget. The initiating
    // tab, however, is waiting for this exact event to release its button and
    // repaint. Await one direct delivery before answering the short DONE
    // message, so worker suspension cannot lose the completion signal.
    if (sender?.tab?.id) {
      await chrome.tabs.sendMessage(sender.tab.id, { type: MSG.SYNC_PROGRESS, ...completion })
        .catch(() => { /* tab navigated after completing the sweep */ });
    }
    if (same) announceFeedUpdated(outcome.inserted);
    return { finished: true, failed };
  },
  [MSG.AUDIT_REVERSE_RUN]: async ({ windowDays }) => {
    const source = await readNativeAuditSource(windowDays);
    if (!source.ok) return { report: { ok: false, reason: source.reason } };
    await recordNativeVideos(source.videos ?? [], Date.now(), { replace: true });
    return { report: await runReverseAudit({ windowDays, source }) };
  },
});

log.info('Service worker started');
