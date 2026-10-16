/**
 * IndexedDB layer.
 *
 * Why IndexedDB and not chrome.storage: at 500 channels × ~15 entries we are in
 * the thousands of records, with a need to sort by date and filter by state.
 * chrome.storage.local would force deserialising the whole blob on every read —
 * exactly the pattern that makes competing extensions slow once a lot of videos
 * are hidden.
 *
 * The "hidden" filtering happens inside the composite index [hidden,
 * publishedAt]: a hidden video is never read, never deserialised, never
 * rendered. The cost of hiding is therefore constant, whatever the number of
 * hidden items.
 */

import { log } from './log.js';
import { normalize, broadcastKind, videoIncomplete, DAY } from './util.js';
import { hasCurrentVideoVerdict } from './short-policy.js';

export const DB_NAME = 'ytfeed';
export const DB_VERSION = 8;

const STORE_CHANNELS = 'channels';
const STORE_VIDEOS = 'videos';
const STORE_META = 'meta';
const STORE_HISTORY = 'history';
const STORE_DURATIONS = 'durations';
const STORE_HISTO_CHANNELS = 'histoChannels';
const STORE_SHORTS = 'videoClassifications';
const STORE_NATIVE_VIDEOS = 'nativeVideos';

/** Universal upper bound for time keys (largest value a JS Date holds). */
const MAX_TS = 8.64e15;

/** Every visible video, whatever its date.
 *  Arrays compare element by element: [0, x] < [1]. */
const VISIBLE_RANGE = IDBKeyRange.bound([0], [1], false, true);

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/**
 * Indexes for live and announced broadcasts.
 *
 * A broadcast keeps its state until we go and re-read it, and there was no way
 * to find one again other than by sweeping the most recent videos. A live from
 * the day before left that window before it ended and stayed announced as
 * "live" forever. These two indexes designate them all, whatever their
 * publication date.
 *
 * Created outside the first-open block: skipping them on already installed
 * databases would fix the problem for new ones only.
 */
function indexBroadcasts(videos) {
  if (!videos.indexNames.contains('by_live')) videos.createIndex('by_live', 'isLive');
  if (!videos.indexNames.contains('by_upcoming')) videos.createIndex('by_upcoming', 'isUpcoming');
}

/**
 * The bin, in the order things were put into it.
 *
 * `by_visible` orders both sides by publication date, which is right for the
 * feed and wrong for the bin: what someone looks for after hiding a run of
 * videos is the run they just hid, not whatever happens to be the most
 * recently published among everything they have ever hidden. Same shape as
 * `by_visible`, the second element being the moment of hiding.
 *
 * Created here and not only in the store creation block, which runs on a brand
 * new database alone: an index added there would never exist on installed
 * profiles, that is to say exactly the ones with a full bin.
 */
function indexHiddenOrder(videos) {
  if (!videos.indexNames.contains('by_hidden_at')) {
    videos.createIndex('by_hidden_at', ['hidden', 'hiddenAt']);
  }
}

/**
 * Gives every hidden row a numeric `hiddenAt` before the index above is built.
 *
 * A composite key one half of which is `undefined` is not a valid key, and
 * IndexedDB does not complain about one: it leaves the record out of the
 * index. A single row written before this field existed, or restored from a
 * backup that did not carry it, would therefore disappear from the bin
 * entirely — a worse defect than the ordering this is here to fix. Every
 * writer in this file does set it, so the pass is expected to find nothing;
 * it costs one sweep, once, and removes the need to be sure of that.
 *
 * `discoveredAt` stands in where there is nothing better. It is not when the
 * video was hidden, but it orders those rows plausibly among themselves
 * instead of piling them all at the bottom on zero.
 */
function backfillHiddenAt(videos) {
  const req = videos.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    const video = cursor.value;
    if (typeof video.hiddenAt !== 'number') {
      video.hiddenAt = video.hidden ? (video.discoveredAt || video.publishedAt || 0) : 0;
      cursor.update(video);
    }
    cursor.continue();
  };
}

/** Opens (or reopens) the database. The MV3 service worker can be killed at any
 *  moment, so the connection is lazy and recreated on demand. */
export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      log.info(`IndexedDB migration ${event.oldVersion} → ${DB_VERSION}`);

      // Keep exclusions after removing the video itself. Otherwise an old Atom
      // response or an in-flight enrichment can put it straight back.
      if (!db.objectStoreNames.contains(STORE_SHORTS)) {
        db.createObjectStore(STORE_SHORTS, { keyPath: 'id' });
      }

      // Independent evidence for the reverse audit. Native rows must stay out
      // of `videos`: observing something on YouTube proves neither that it is a
      // long-form upload nor that TrackTube is allowed to insert it.
      if (!db.objectStoreNames.contains(STORE_NATIVE_VIDEOS)) {
        const nativeVideos = db.createObjectStore(STORE_NATIVE_VIDEOS, { keyPath: 'id' });
        nativeVideos.createIndex('by_published', 'publishedAt');
      }

      if (!db.objectStoreNames.contains(STORE_CHANNELS)) {
        const channels = db.createObjectStore(STORE_CHANNELS, { keyPath: 'id' });
        // Scheduler: "which channels are due right now?"
        channels.createIndex('by_due', 'nextDueAt');
        channels.createIndex('by_active', 'active');
      }

      if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
        const videos = db.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
        videos.createIndex('by_published', 'publishedAt');
        videos.createIndex('by_channel', 'channelId');
        // The index the whole feed rendering rests on.
        videos.createIndex('by_visible', ['hidden', 'publishedAt']);
        indexBroadcasts(videos);
        indexHiddenOrder(videos);
      } else {
        const videos = req.transaction.objectStore(STORE_VIDEOS);
        indexBroadcasts(videos);
        backfillHiddenAt(videos);
        indexHiddenOrder(videos);
      }

      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }

      // History imported from Takeout. The key combines video and timestamp:
      // rewatching a video is a distinct event, but reimporting the same file
      // must not duplicate anything.
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        const history = db.createObjectStore(STORE_HISTORY, { keyPath: 'key' });
        history.createIndex('by_time', 'watchedAt');
        history.createIndex('by_channel', 'channelId');
        history.createIndex('by_video', 'videoId');
      } else {
        // Already installed database: the per-video index came with live watch
        // tracking, which needs to ask "do we already know a session on this
        // video?" without sweeping fifteen thousand entries. Created here
        // rather than in the block above, which only runs on the very first
        // open — skipping it would have left every existing profile without the
        // index, that is to say precisely those that have any history.
        const history = req.transaction.objectStore(STORE_HISTORY);
        if (!history.indexNames.contains('by_video')) {
          history.createIndex('by_video', 'videoId');
        }
      }

      // Durations fetched for the history analysis. A separate store, and not
      // the videos store: the history goes back years and contains thousands of
      // videos from channels one is not subscribed to. Writing them into
      // `videos` would make them all show up in the feed.
      if (!db.objectStoreNames.contains(STORE_DURATIONS)) {
        db.createObjectStore(STORE_DURATIONS, { keyPath: 'videoId' });
      }

      // What we learned about a channel by enriching it: its mean duration, and
      // the ordered list of its latest uploads, from which the streaks follow.
      // Separate from `channels`, which only holds the current subscriptions —
      // the history cites thousands of others.
      if (!db.objectStoreNames.contains(STORE_HISTO_CHANNELS)) {
        db.createObjectStore(STORE_HISTO_CHANNELS, { keyPath: 'channelId' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // If another version wants to install itself, we release the connection.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };

    req.onerror = () => reject(req.error);
    req.onblocked = () => log.warn('IndexedDB open blocked by another tab');
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });

  return dbPromise;
}

/** Turns an IDBRequest into a promise. */
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Runs `fn` inside a transaction and resolves when the transaction is
 * *committed* (not merely when `fn` has returned).
 *
 * Important: `fn` must never await anything other than IDBRequests, otherwise
 * the transaction closes itself.
 *
 * @template R
 * @param {string | string[]} stores
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => R | Promise<R>} fn
 * @returns {Promise<R>}
 */
export async function withTx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    let failed = false;

    tx.oncomplete = () => { if (!failed) resolve(result); };
    tx.onerror = () => { failed = true; reject(tx.error); };
    tx.onabort = () => { failed = true; reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError')); };

    Promise.resolve(fn(tx)).then(
      (r) => { result = r; },
      (err) => { failed = true; reject(err); try { tx.abort(); } catch { /* already finished */ } },
    );
  });
}

// ---------------------------------------------------------------------------
// meta: small key/value pairs (sync cursors, settings, timestamps)
// ---------------------------------------------------------------------------

export async function metaGet(key, fallback = null) {
  const row = await withTx(STORE_META, 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_META).get(key)));
  return row === undefined ? fallback : row.value;
}

export async function metaSet(key, value) {
  await withTx(STORE_META, 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(STORE_META).put({ key, value })));
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Channel
 * @property {string} id            UC… identifier
 * @property {string} title
 * @property {string} avatarUrl
 * @property {number} addedAt
 * @property {1|0} active           0 = unsubscribed / ignored, excluded from sync
 * @property {'UULF'|'UU'} feedMode feed mode chosen for this channel
 * @property {string|null} feedHash fingerprint of the last content seen
 *   (YouTube provides neither ETag nor Last-Modified: change detection goes
 *    through a fingerprint, not a conditional request)
 * @property {number} lastFetchAt   last attempt
 * @property {number} lastSuccessAt last usable answer
 * @property {number} lastChangeAt  last time the content changed
 * @property {number} lastUploadAt  date of the most recent known upload
 * @property {number} nextDueAt     next scheduled query
 * @property {number} failCount     consecutive failures (drives the backoff)
 * @property {number|null} uploadIntervalMs  median gap between uploads
 * @property {number} videoCount    videos known for this channel
 * @property {number} directBackfillAt  last complete Videos-tab rebuild
 * @property {number} missingSince  first complete automatic list missing this channel
 * @property {'unknown'|'yes'|'no'} livesMode  does the channel broadcast live
 * @property {string|null} livesHash  fingerprint of the last lives feed seen
 */

/** Default values for a freshly imported channel. */
export function makeChannel(id, title, avatarUrl, now = Date.now()) {
  return {
    id,
    title: title ?? '',
    avatarUrl: avatarUrl ?? '',
    addedAt: now,
    active: 1,
    missingSince: 0,
    feedMode: 'UULF',
    feedHash: null,
    lastFetchAt: 0,
    lastSuccessAt: 0,
    lastChangeAt: 0,
    lastUploadAt: 0,
    nextDueAt: 0, // due immediately
    failCount: 0,
    uploadIntervalMs: null,
    videoCount: 0,
    directBackfillAt: 0,
    /**
     * State of the lives feed (playlist `UULV`), disjoint from the videos feed.
     * `unknown` until probed, `yes` if the channel broadcasts, `no` otherwise.
     * It carries no due date of its own: the live feed is read whenever the
     * channel is read. See the note in `sync-engine.js`.
     */
    livesMode: 'unknown',
    livesHash: null,
    /** Order of magnitude as YouTube shows it, not an exact value. */
    subscriberCount: null,
    /** The `@name` handle, when the subscription list gives it. */
    handle: null,
  };
}

export async function getChannel(id) {
  return withTx(STORE_CHANNELS, 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_CHANNELS).get(id)));
}

export async function getAllChannels() {
  return withTx(STORE_CHANNELS, 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_CHANNELS).getAll()));
}

/**
 * The followed channels, as a set of ids, read through the `by_active` index.
 *
 * Only the keys: the feed needs to answer "is this one of mine?" and nothing
 * else, and reading nine hundred full channel records on every page of the
 * grid to answer it would be absurd.
 */
export async function getActiveChannelIds() {
  return withTx(STORE_CHANNELS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_CHANNELS).index('by_active');
    return new Set(await reqToPromise(index.getAllKeys(IDBKeyRange.only(1))));
  });
}

export async function putChannel(channel) {
  return withTx(STORE_CHANNELS, 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(STORE_CHANNELS).put(channel)));
}

/**
 * Switches one channel off by hand, because the reader says they left it.
 *
 * Every other way a channel stops being followed goes through YouTube's
 * subscription list, and reading that list needs a session cookie the isolated
 * content world cannot always see — on such a browser `maybeReconcile` returns
 * before it asks anything, so nothing prunes, ever. Three successive repairs to
 * the pruning logic were invisible to a reader in that position, who went on
 * seeing videos from channels they had left for nine days.
 *
 * This is the escape hatch, and it is deliberately local: no request, no list,
 * no guard to satisfy. `missingSince` is left at zero because the decision is
 * not an observation waiting for confirmation, and a later believable list that
 * does hold the channel switches it back on through `reconcileChannels` like
 * any other.
 *
 * @returns {Promise<{found: boolean, title: string}>}
 */
export async function forgetChannel(channelId) {
  return withTx(STORE_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_CHANNELS);
    const channel = await reqToPromise(store.get(channelId));
    if (!channel) return { found: false, title: '' };
    channel.active = 0;
    channel.missingSince = 0;
    await reqToPromise(store.put(channel));
    return { found: true, title: channel.title ?? '' };
  });
}

/**
 * Merges an imported subscription list with what we already have: new channels
 * are created, existing ones keep their sync state (etag, pace, counters) and
 * only see title and avatar refreshed. Channels absent from the import are
 * deactivated, never deleted — we do not lose the history if the import is
 * partial.
 *
 * @param {Array<{id: string, title?: string, avatarUrl?: string}>} imported
 */
/**
 * How small a complete list may be, against the last one believed, before it is
 * read as a truncated read rather than a batch of departures; and the number of
 * channels below which that ratio says nothing. See the reasoning inside
 * `reconcileChannels`.
 */
const MIN_LIST_SHARE = 0.75;
const MIN_LIST_FOR_WIPE_GUARD = 20;
/** Meta keys holding the last believed list size, and the last refused one. */
const META_LIST_BASELINE = 'subs.listBaseline';
const META_LIST_DOUBT = 'subs.listDoubt';
/** A doubt is only confirmed by a second read at least this much later. */
const LIST_DOUBT_DELAY_MS = 60 * 60 * 1000;

export async function reconcileChannels(imported, { complete = false, confirmAbsent = false } = {}) {
  const now = Date.now();
  const seen = new Set(imported.map((c) => c.id));

  return withTx([STORE_CHANNELS, STORE_META], 'readwrite', async (tx) => {
    const meta = tx.objectStore(STORE_META);
    const store = tx.objectStore(STORE_CHANNELS);
    const existing = await reqToPromise(store.getAll());
    const byId = new Map(existing.map((c) => [c.id, c]));

    let added = 0;
    let updated = 0;
    let deactivated = 0;

    for (const inc of imported) {
      const prev = byId.get(inc.id);
      if (prev) {
        prev.title = inc.title || prev.title;
        prev.avatarUrl = inc.avatarUrl || prev.avatarUrl;
        // Never overwritten by an absence: an import from a Takeout file
        // carries neither the subscriber count nor the handle, and must not
        // erase what a full import had picked up.
        if (Number.isFinite(inc.subscriberCount)) prev.subscriberCount = inc.subscriberCount;
        if (inc.handle) prev.handle = inc.handle;
        prev.missingSince = 0;
        if (!prev.active) { prev.active = 1; prev.nextDueAt = 0; }
        await reqToPromise(store.put(prev));
        updated++;
      } else {
        await reqToPromise(store.put({
          ...makeChannel(inc.id, inc.title, inc.avatarUrl, now),
          subscriberCount: Number.isFinite(inc.subscriberCount) ? inc.subscriberCount : null,
          handle: inc.handle ?? null,
        }));
        added++;
      }
    }

    // The identifiers are returned, not merely their count: the caller decides
    // whether it also purges their videos. It can only do so if it knows the
    // list is complete — on a truncated import, that would be a massacre.
    //
    // **And the deactivation itself is now subject to the same condition**,
    // which it was not. `listSubscriptions` walks the account's list page by
    // page and reports `complete: false` when a page fails to come back or the
    // forty page cap is reached; the daily reconciliation handed that partial
    // list over all the same, and everything past the break was deactivated.
    // A deactivated channel is no longer swept, so its publications simply stop
    // arriving, with nothing on screen to say so — the one failure this
    // extension cannot afford. Keeping a channel that really was unsubscribed
    // costs one feed read per sweep until the next complete list; the opposite
    // mistake costs the videos.
    // A completed pagination is not proof of a complete list, and this is what
    // that costs when it is wrong. Measured on a real profile on 14 October
    // 2026: 930 rows in the channels store, which counts every channel ever
    // seen, and **116 still active** against 592 real subscriptions. The rest
    // had been switched off by reconciliations that reported `complete: true`
    // while handing over a fraction of the account's subscriptions. A
    // deactivated channel is never swept and `ingestAuthenticatedUploads`
    // refuses it outright, so its publications simply stopped arriving, with
    // nothing on screen to say so.
    //
    // Nobody unsubscribes from four fifths of their list in one day, so a pass
    // that would is not a list of departures, it is a bad read. The share of
    // the active list is what says so, not an absolute count, and a floor sits
    // under it because a small list makes any share look alarming — leaving
    // three channels out of five is an afternoon's pruning.
    //
    // **The guard applies to the unattended reconciliation only.** It was put
    // on both paths first and that was wrong, in a way that took a day to show
    // and is worth not repeating: the repair that woke a profile's channels
    // back up left 930 active against a real list of 592, so the next
    // reconciliation wanted to switch off a third of them, the guard refused, and
    // the channels the reader had genuinely left went on filling the feed with
    // nothing able to prune them. A guard that blocks the cleanup of a repair
    // is a deadlock, not a safety net.
    //
    // An import is somebody pressing a button and watching the result, and it
    // carries `confirmAbsent: false` precisely because it is meant to take
    // effect at once. The daily reconciliation is the one that runs unwatched
    // on whatever YouTube happened to return, it is the path that emptied a
    // real profile, and it already waits for two observations an hour apart
    // before switching anything off. The guard belongs there and only there.
    //
    // **And it is measured against the last list YouTube gave, not against our
    // own active count.** Exempting the manual import was not enough, and the
    // reason is that the share of the active list is the wrong quantity: our
    // active count is whatever an earlier bad read or a repair happened to
    // leave it at. On the profile above it stood at 930 against a real list of
    // 592, so the daily pass wanted to switch off 36 % of it, every day,
    // forever — above the quarter the guard allowed, refused every time, and
    // `UCLS4wuBNQTIr4RAAG_stxOQ` went on painting 42 minute videos into a feed
    // of channels the reader does not follow. The deadlock was not fixed by
    // exempting one path; it was still there on the only path that runs by
    // itself, which is to say for anybody who does not think to re-import.
    //
    // What actually goes wrong is YouTube returning a short list, and the way
    // to see that is to compare it with the last list YouTube returned. 592
    // after 592 is a believable afternoon's pruning however many channels we
    // hold; 116 after 592 is a bad read. So the baseline is the last list
    // believed, a complete list smaller than three quarters of it is doubted,
    // and a refusal is never final: the same size coming back an hour later is
    // a second observation and it is believed, which is the rule
    // `confirmAbsent` already applies channel by channel. Without that, a
    // reader who genuinely unsubscribed from a third of their list in one go
    // would be refused for good — the same deadlock, one level up.
    const incoming = seen.size;
    const baseline = await reqToPromise(meta.get(META_LIST_BASELINE));
    const doubt = await reqToPromise(meta.get(META_LIST_DOUBT));
    const baseSize = baseline?.value?.size ?? 0;
    const doubted = baseSize >= MIN_LIST_FOR_WIPE_GUARD
      && incoming < baseSize * MIN_LIST_SHARE;
    // A second read agreeing with the refused one, far enough apart to be a
    // separate observation rather than a retry of the same failure.
    const doubtSize = doubt?.value?.size ?? 0;
    const confirmedTwice = doubtSize > 0
      && now - (doubt?.value?.at ?? 0) >= LIST_DOUBT_DELAY_MS
      && Math.abs(incoming - doubtSize) <= Math.max(5, doubtSize * 0.1);
    const massWipe = complete && confirmAbsent && doubted && !confirmedTwice;

    const activeCount = existing.filter((c) => c.active).length;
    const wouldDeactivate = existing.filter((c) => c.active && !seen.has(c.id)).length;

    // Only a list that was acted upon becomes the yardstick for the next one,
    // and a refused one is remembered separately. Writing the baseline from a
    // refused read would ratchet it down to whatever the broken read returned,
    // and the guard would then wave through the very list it had just refused.
    if (complete) {
      if (massWipe) {
        await reqToPromise(meta.put({ key: META_LIST_DOUBT, value: { size: incoming, at: now } }));
      } else {
        await reqToPromise(meta.put({ key: META_LIST_BASELINE, value: { size: incoming, at: now } }));
        if (doubtSize) await reqToPromise(meta.delete(META_LIST_DOUBT));
      }
    }

    const deactivatedIds = [];
    let awaitingConfirmation = 0;
    if (complete && !massWipe) {
      for (const prev of existing) {
        if (!seen.has(prev.id) && prev.active) {
          // A completed pagination is not proof that YouTube returned every
          // channel. One daily observation of absence only starts a grace
          // period; a second, at least an hour later, confirms removal.
          if (confirmAbsent && (!prev.missingSince || now - prev.missingSince < 60 * 60 * 1000)) {
            if (!prev.missingSince) {
              prev.missingSince = now;
              await reqToPromise(store.put(prev));
            }
            awaitingConfirmation++;
            continue;
          }
          prev.active = 0;
          prev.missingSince = 0;
          await reqToPromise(store.put(prev));
          deactivated++;
          deactivatedIds.push(prev.id);
        }
      }
    }

    return {
      added, updated, deactivated, deactivatedIds, awaitingConfirmation, total: seen.size,
      // Said out loud so the caller never has to infer it from a zero.
      deactivationSkipped: !complete || massWipe,
      // And the refusal is named, because "nothing was deactivated" and "we
      // refused to deactivate eight hundred channels" are not the same event
      // and only the second one needs looking at. The two list sizes go with
      // it: they are what the decision was taken on, and reading the refusal
      // without them tells nobody whether the list or the guard was wrong.
      massWipeRefused: massWipe
        ? { active: activeCount, wouldDeactivate, list: incoming, baseline: baseSize }
        : null,
    };
  });
}

/**
 * Switches every channel back on.
 *
 * The repair for a profile already emptied by the above, which no ordinary path
 * undoes: an import only reactivates the channels it was given, so the ones a
 * bad read left out stay off for good, and a feed goes on looking merely quiet.
 *
 * Reactivating a channel that really was unsubscribed is deliberately accepted
 * here. It is not permanent: the next reconciliation given a believable list
 * switches it off again, and `confirmAbsent` already makes that take two
 * observations an hour apart, so the mistake costs a day of feed reads where
 * the one it undoes costs every video.
 *
 * @returns {Promise<number>} how many channels were switched back on.
 */
export async function reactivateAllChannels() {
  return withTx(STORE_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_CHANNELS);
    const existing = await reqToPromise(store.getAll());
    let woken = 0;
    for (const channel of existing) {
      if (channel.active) continue;
      channel.active = 1;
      channel.missingSince = 0;
      // Due immediately: the point of the repair is the videos that were not
      // collected while it slept, not the next scheduled turn.
      channel.nextDueAt = 0;
      await reqToPromise(store.put(channel));
      woken++;
    }
    return woken;
  });
}

/**
 * Fills in the missing avatars from what we harvested.
 *
 * The initial import does not always get them — it depends on how YouTube
 * rendered the subscriptions page. The native feed carries them too, so coverage
 * completes itself as one browses.
 *
 * An already known avatar is not replaced by default: native-feed harvesting
 * must not churn the database.  A direct authenticated channel response can be
 * authoritative, though, and may replace an expired URL so that the strict
 * display guard can release the channel's videos immediately.
 *
 * @param {Map<string, string> | Array<[string, string]>} avatarsByChannelId
 * @param {{replace?: boolean}} [opts]
 */
export async function fillMissingAvatars(avatarsByChannelId, { replace = false } = {}) {
  const entries = [...avatarsByChannelId].filter(([, url]) => url);
  if (!entries.length) return 0;

  return withTx(STORE_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_CHANNELS);
    let filled = 0;
    for (const [id, avatarUrl] of entries) {
      const channel = await reqToPromise(store.get(id));
      if (!channel || channel.avatarUrl === avatarUrl || (!replace && channel.avatarUrl)) continue;
      channel.avatarUrl = avatarUrl;
      await reqToPromise(store.put(channel));
      filled++;
    }
    return filled;
  });
}

/**
 * Forgets avatars whose address no longer answers.
 *
 * YouTube's avatar addresses expire. A channel kept the one collected at import
 * for good, the image stopped loading a few weeks later, and the grid drew a
 * coloured initial in its place — half the feed, on an old profile. Forgetting
 * the address puts the channel back among those whose picture is missing, which
 * the catch-up already knows how to fill, and the completeness guard holds its
 * videos back in the meantime instead of showing them bare.
 *
 * @param {string[]} channelIds
 * @returns {Promise<number>} number of channels actually cleared
 */
export async function dropChannelAvatars(channelIds) {
  const ids = [...new Set((channelIds ?? []).filter(Boolean))];
  if (!ids.length) return 0;

  return withTx(STORE_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_CHANNELS);
    let cleared = 0;
    for (const id of ids) {
      const channel = await reqToPromise(store.get(id));
      if (!channel?.avatarUrl) continue;
      delete channel.avatarUrl;
      await reqToPromise(store.put(channel));
      cleared++;
    }
    return cleared;
  });
}

/**
 * Active channels whose avatar is unknown.
 *
 * Most recently publishing first: theirs are the thumbnails at the top of the
 * feed, so the only ones whose missing picture gets noticed.
 *
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
export async function listChannelsMissingAvatar(limit = 30) {
  const channels = await getAllChannels();
  return channels
    .filter((c) => c.active && !c.avatarUrl)
    .sort((a, b) => (b.lastUploadAt ?? 0) - (a.lastUploadAt ?? 0))
    .slice(0, limit)
    .map((c) => c.id);
}

/**
 * Channels due for a query, the most overdue first.
 * @param {number} limit
 * @param {number} now
 */
export async function getDueChannels(limit, now = Date.now()) {
  return withTx(STORE_CHANNELS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_CHANNELS).index('by_due');
    const out = [];
    const cursorReq = index.openCursor(IDBKeyRange.upperBound(now));

    await new Promise((resolve, reject) => {
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || out.length >= limit) return resolve();
        if (cursor.value.active) out.push(cursor.value);
        cursor.continue();
      };
    });

    return out;
  });
}

// ---------------------------------------------------------------------------
// videos
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Video
 * @property {string} id            YouTube videoId
 * @property {string} channelId
 * @property {string} channelTitle
 * @property {string} title
 * @property {number} publishedAt   epoch ms
 * @property {string} thumbUrl
 * @property {number|null} views
 * @property {number|null} durationSec  enrichment (native feed), often null
 * @property {1|0} hidden
 * @property {number} hiddenAt
 * @property {1|0} starred       marked "watch first"
 * @property {number} starredAt
 * @property {1|0} watched
 * @property {number} watchProgress 0..1
 * @property {number} discoveredAt  when *we* first saw it
 * @property {number} seenNativeAt  0 if YouTube never showed it in its own
 *   subscriptions feed. This is the direct measure of what the algorithm hides
 *   from us, and the basis of the exhaustiveness audit.
 * @property {'rss'|'native'} source
 */

/**
 * Inserts the videos that do not exist yet and updates the volatile fields of
 * those that do. User state (hidden, watched, watchProgress) and `discoveredAt`
 * are never overwritten.
 *
 * @param {Partial<Video>[]} incoming
 * @param {object} [opts]
 * @param {boolean} [opts.allowInsert]  false = only update existing videos,
 *   never create any. This is the native feed harvest's mode: it enriches and
 *   measures, it does not feed the feed.
 * @returns {Promise<{inserted: number, updated: number, insertedIds: string[]}>}
 */
export async function upsertVideos(incoming, { allowInsert = true } = {}) {
  if (!incoming.length) return { inserted: 0, updated: 0, insertedIds: [] };
  const now = Date.now();

  // Pending states from a backup restored before the videos existed. Read
  // outside the transaction: `meta` is another store.
  const pending = await metaGet(META_PENDING_RESTORE, {});
  const consumed = [];

  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    let inserted = 0;
    let updated = 0;
    const insertedIds = [];

    let skipped = 0;
    // What this batch actually marked as "seen in the native feed". The date
    // comes from the database, not from the batch: the DOM harvest only carries
    // video identifiers.
    const nativeMarked = { count: 0, oldestPublishedAt: Number.POSITIVE_INFINITY };
    const markNative = (publishedAt) => {
      nativeMarked.count++;
      if (publishedAt < nativeMarked.oldestPublishedAt) nativeMarked.oldestPublishedAt = publishedAt;
    };

    for (const v of incoming) {
      const classification = await reqToPromise(tx.objectStore(STORE_SHORTS).get(v.id));
      if (classification?.isShort === true || classification?.membersOnly === true) {
        skipped++;
        continue;
      }
      const prev = await reqToPromise(store.get(v.id));

      if (!prev) {
        // Two reasons to create nothing, and neither is an error:
        //  - without a channelId, the record would be inconsistent;
        //  - in enrichment mode, the source is not meant to feed the feed, only
        //    to complete what the feeds already brought in.
        if (!allowInsert || !v.channelId) { skipped++; continue; }

        const record = {
          id: v.id,
          channelId: v.channelId,
          channelTitle: v.channelTitle ?? '',
          title: v.title ?? '',
          publishedAt: v.publishedAt ?? now,
          publishedAtApprox: v.publishedAtApprox === true,
          thumbUrl: v.thumbUrl ?? '',
          views: v.views ?? null,
          durationSec: v.durationSec ?? null,
          shortVerifiedAt: classification?.isShort === false ? classification.checkedAt : 0,
          shortValidUntil: classification?.isShort === false ? classification.validUntil : 0,
          hidden: classification?.userHiddenAt ? 1 : 0,
          hiddenAt: classification?.userHiddenAt || 0,
          starred: 0,
          starredAt: 0,
          watched: 0,
          watchProgress: 0,
          discoveredAt: now,
          seenNativeAt: v.seenNativeAt ?? 0,
          isLive: v.isLive ? 1 : 0,
          isUpcoming: v.isUpcoming ? 1 : 0,
          // Comes from the lives feed: the video is a broadcast, either running
          // or a replay. The Atom feed does not tell the two apart, it is the
          // duration — known only once the broadcast is over — that decides at
          // display time.
          wasLive: v.wasLive ? 1 : 0,
          source: v.source ?? 'rss',
        };

        // A backup restored before synchronisation waits here until the video
        // finally shows up. That is what makes restoring onto an empty database
        // genuinely useful.
        const restored = pending[v.id];
        if (restored) {
          applyUserState(record, restored);
          if (restored.hidden !== undefined) {
            await writeHiddenState(tx, v.id, record.hidden ? record.hiddenAt || now : 0);
          }
          consumed.push(v.id);
        }

        await reqToPromise(store.put(record));
        inserted++;
        insertedIds.push(v.id);
        if (v.seenNativeAt) markNative(v.publishedAt ?? now);
        continue;
      }

      // Volatile fields only. We never downgrade a known value to null: RSS does
      // not have the durations, it must not erase those the native feed gave us.
      let dirty = false;
      const merge = (key, value) => {
        if (value != null && value !== '' && prev[key] !== value) { prev[key] = value; dirty = true; }
      };
      merge('title', v.title);
      merge('thumbUrl', v.thumbUrl);
      merge('channelTitle', v.channelTitle);
      merge('durationSec', v.durationSec);
      // Relative tab dates must not become permanent: an exact RSS/player
      // timestamp replaces them, while later relative dates cannot degrade it.
      if (prev.publishedAtApprox && Number.isFinite(v.publishedAt) && v.publishedAtApprox !== true) {
        merge('publishedAt', v.publishedAt);
        prev.publishedAtApprox = false;
        dirty = true;
      }
      // Only the separately recorded player verdict can authorise display.
      // A captured Atom/native row must not restore a verdict invalidated by
      // a more recent unanswered request.
      merge('shortVerifiedAt', classification?.isShort === false ? classification.checkedAt : 0);
      merge('shortValidUntil', classification?.isShort === false ? classification.validUntil : 0);

      // A view counter only ever goes up. Atom lags on a fresh video and has
      // been seen serving zero for a video already watched a few hundred times;
      // taking it at face value made the count fall back to zero on the very
      // refresh meant to bring it up to date. A genuine reset does not exist:
      // YouTube never takes views away.
      if (Number.isFinite(v.views) && v.views > (prev.views ?? -1)) {
        prev.views = v.views;
        dirty = true;
      }

      // A video already known from the long-form feed can reappear in the lives
      // one: that is how we learn it was a live. The reverse does not exist, so
      // the marker never clears.
      if (v.wasLive && !prev.wasLive) { prev.wasLive = 1; dirty = true; }

      // Audit marker: the first sighting in the native feed is authoritative,
      // later ones do not move it.
      if (v.seenNativeAt && !prev.seenNativeAt) {
        prev.seenNativeAt = v.seenNativeAt;
        markNative(prev.publishedAt);
        dirty = true;
      }

      // Watch progress never goes backwards.
      if (Number.isFinite(v.watchProgress) && v.watchProgress > (prev.watchProgress ?? 0)) {
        prev.watchProgress = v.watchProgress;
        if (v.watchProgress >= 0.9) prev.watched = 1;
        dirty = true;
      }

      if (dirty) { await reqToPromise(store.put(prev)); updated++; }
    }

    return {
      inserted,
      updated,
      skipped,
      insertedIds,
      nativeMarked: Number.isFinite(nativeMarked.oldestPublishedAt) ? nativeMarked : { count: 0, oldestPublishedAt: null },
    };
  }).then(async (result) => {
    if (consumed.length) {
      const rest = { ...pending };
      for (const id of consumed) delete rest[id];
      await metaSet(META_PENDING_RESTORE, rest);
    }
    return { ...result, restored: consumed.length };
  });
}

/**
 * Ceiling on the withheld videos handed back to the caller.
 *
 * The count itself is not capped: it is what shows on screen. The list only
 * serves to start the resolution, and resolving more than two hundred channels
 * in a single load would make no sense anyway.
 */
const MAX_WITHHELD = 240;

/**
 * One page of the feed, most recent first.
 *
 * The `hidden` filtering is carried by the composite index: the cursor only
 * visits visible records. Hiding 10,000 videos costs nothing here.
 *
 * @param {object} opts
 * @param {number} [opts.limit]
 * @param {{publishedAt: number, id: string} | null} [opts.after]  pagination cursor
 * @param {boolean} [opts.includeHidden]
 * @param {number} [opts.since]  do not go further back than this date
 * @param {boolean} [opts.onlyUnseen]  keep only what YouTube's own native feed
 *   never displayed
 * @param {string} [opts.query]      words looked for in the title or the channel
 * @param {string} [opts.channelId]  restrict to a single channel
 * @param {boolean} [opts.onlyStarred]  keep only the starred videos
 * @param {boolean} [opts.onlyHidden]   show ONLY the hidden videos
 * @param {boolean} [opts.requireComplete]  only display a video if we know how
 *   to show it in full. See `videoIncomplete()`.
 * @returns {Promise<{items: Video[], nextCursor: {publishedAt: number, id: string} | null,
 *   withheld: Video[], withheldCount: number}>}
 */
export async function getFeedPage({
  limit = 60, after = null, includeHidden = false, since = 0, onlyUnseen = false,
  query = '', channelId = null, onlyStarred = false, onlyHidden = false,
  hideWatched = false, minDurationSec = 0, maxAgeDays = 0, onlyInProgress = false,
  inProgressMinSec = IN_PROGRESS_MIN_SECONDS,
  hideLives = false, hideReplays = false, hideUpcoming = false,
  requireComplete = false, activeChannelIds = null,
} = {}) {
  // Searching sweeps the cursor rather than using a dedicated index: IndexedDB
  // offers no full-text index, and at a few tens of thousands of records a
  // filtered sweep stays under 100 ms — plenty for an action triggered on every
  // keystroke.
  const terms = normalize(query).split(/\s+/).filter(Boolean);

  // A starred video escapes the comfort filters: it was explicitly singled out,
  // it would be absurd for a duration setting to make it disappear.
  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * DAY : 0;

  const matches = (v) => {
    if (channelId && v.channelId !== channelId) return false;
    // The last word on whose videos these are. Collection already refuses a
    // channel that is not followed, but a row can outlive the subscription
    // that justified it — a channel left since, or woken by a repair — and
    // until something prunes it, it goes on filling the grid. Asking the
    // question at paint time is cheap and does not depend on any of that
    // having gone right.
    if (activeChannelIds && !activeChannelIds.has(v.channelId)) return false;
    if (onlyUnseen && v.seenNativeAt) return false;
    if (onlyStarred && !v.starred) return false;
    if (onlyInProgress && !isInProgress(v, inProgressMinSec)) return false;

    if (!v.starred) {
      if (hideWatched && v.watched) return false;
      if (minDurationSec && v.durationSec > 0 && v.durationSec < minDurationSec) return false;
      if (cutoff && v.publishedAt < cutoff) return false;
      // A broadcast's three states are set separately, because they are not
      // worth the same. A live is only worth anything while it happens. Replays
      // pile up fast — a daily streamer produces as many as all the other
      // channels put together. And a scheduled broadcast has nothing to show
      // yet: the recurring ones come back endlessly in the timeline.
      // The classification is shared with the badge: reasoning about them
      // separately had produced a timeline where one called "replay" what the
      // other let through as an appointment.
      const kind = broadcastKind(v);
      if (hideLives && kind === 'live') return false;
      if (hideUpcoming && kind === 'upcoming') return false;
      if (hideReplays && kind === 'replay') return false;
    }

    if (!terms.length) return true;
    const haystack = normalize(`${v.title} ${v.channelTitle}`);
    return terms.every((t) => haystack.includes(t));
  };

  // Both stores when the safeguard is armed: the grid has no access to the
  // database, so this, and nowhere else, is where we know whether a thumbnail
  // will be able to show its channel.
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);

    const items = [];
    const withheld = [];
    let withheldCount = 0;
    // The feed stops at now. Premieres and scheduled lives carry a future date:
    // without this bound they plant themselves at the top of the feed and stay
    // there until they air, which is the most common complaint about the
    // subscriptions feed. They can be consulted separately.
    //
    // The bound lifts when they have been explicitly asked for, otherwise
    // unticking their removal only showed the ones whose time is unknown: the
    // others, precisely the best documented, stayed stuck here.
    const horizon = hideUpcoming ? Date.now() : MAX_TS;
    const upper = after ? Math.min(after.publishedAt, horizon) : horizon;

    let hitLimit = false;
    let lastVisited = null;

    const push = (cursor, ts) => {
      if (after && !isPastCursor(ts, cursor.primaryKey, after)) return true; // already rendered

      // The cursor moves on even over discarded records: its real position must
      // therefore be remembered, otherwise the next page would walk them again
      // forever without ever making progress.
      // Carries whichever key the active cursor is ordered on, not always the
      // publication date: the bin walks on the moment of hiding, and a cursor
      // remembering the wrong field would page over the same rows for ever.
      // The name stays, because the caller only hands it back untouched.
      lastVisited = { publishedAt: ts, id: cursor.value.id };

      if (!matches(cursor.value)) return true;

      if (requireComplete && videoIncomplete(cursor.value)) {
        withheldCount++;
        // The list serves to start the resolution: no point putting in a video
        // the API has already declared missing, nothing will ever come.
        if (cursor.value.durationSec !== -1 && withheld.length < MAX_WITHHELD) {
          withheld.push(cursor.value);
        }
        return true;
      }

      items.push(cursor.value);
      if (items.length >= limit) { hitLimit = true; return false; }
      return true;
    };

    if (includeHidden) {
      const index = store.index('by_published');
      const range = IDBKeyRange.bound(since, upper);
      await iterate(index.openCursor(range, 'prev'), (c) => push(c, c.key));
    } else if (onlyHidden) {
      // The bin is ordered by when a video was put in it, never by when it was
      // published. Someone who has just hidden a run of videos is looking for
      // that run; sorting on the publication date buried it under whatever was
      // most recently published among everything they had ever hidden, which
      // on a long-lived bin means it never appeared at the top at all.
      //
      // `since` is not applied: it bounds a publication window, and the bin is
      // not one. The grid does not send it for this view either.
      const index = store.index('by_hidden_at');
      const range = IDBKeyRange.bound([1, 0], [1, after ? after.publishedAt : MAX_TS]);
      await iterate(index.openCursor(range, 'prev'), (c) => push(c, c.key[1]));
    } else {
      // The composite index carries the feed: the first element of the key
      // selects the visible side, the second keeps the reverse chronological
      // order, and a hidden video is never even visited.
      const index = store.index('by_visible');
      const range = IDBKeyRange.bound([0, since], [0, upper]);
      await iterate(index.openCursor(range, 'prev'), (c) => push(c, c.key[1]));
    }

    return { items, nextCursor: hitLimit ? lastVisited : null, withheld, withheldCount };
  });
}

/** Minimum watch time, by default, to call a video "started". */
const IN_PROGRESS_MIN_SECONDS = 60;

/**
 * Video started but not finished.
 *
 * The threshold is expressed in real seconds when the duration is known: thirty
 * seconds of an hour-long video does not mean the same thing as thirty seconds
 * of a two minute one. Without a duration, we fall back on the ratio.
 *
 * @param {Video} v
 */
function isInProgress(v, minSeconds = IN_PROGRESS_MIN_SECONDS) {
  if (v.watched) return false;
  const progress = v.watchProgress ?? 0;
  if (progress <= 0) return false;
  return v.durationSec > 0
    ? progress * v.durationSec >= minSeconds
    : progress >= 0.05;
}

/**
 * True if the current record lies strictly after the pagination cursor, and so
 * is still to be rendered.
 *
 * Two videos can share the same `publishedAt` — a common case, YouTube rounds to
 * the second. The primary key breaks the tie, which guarantees pagination with
 * neither duplicates nor gaps.
 */
function isPastCursor(ts, primaryKey, after) {
  if (ts > after.publishedAt) return false;
  if (ts === after.publishedAt && primaryKey >= after.id) return false;
  return true;
}

/**
 * Walks a cursor. `onRow` returns false to stop, any other value to continue.
 * Advancing is handled here, never by the caller.
 */
function iterate(cursorReq, onRow) {
  return new Promise((resolve, reject) => {
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      let keepGoing;
      try { keepGoing = onRow(cursor); } catch (err) { return reject(err); }
      if (keepGoing === false) return resolve();
      cursor.continue();
    };
  });
}

// A hidden video's row may be removed when its channel disappears from a
// subscription-list refresh. Keep the user's decision in the classification
// store, which every subsequent insertion already reads in the same transaction.
async function writeHiddenState(tx, id, hiddenAt) {
  const store = tx.objectStore(STORE_SHORTS);
  const previous = await reqToPromise(store.get(id));
  if (hiddenAt) {
    await reqToPromise(store.put({ ...previous, id, userHiddenAt: hiddenAt }));
  } else if (previous?.userHiddenAt) {
    const next = { ...previous };
    delete next.userHiddenAt;
    if (Object.keys(next).length === 1) await reqToPromise(store.delete(id));
    else await reqToPromise(store.put(next));
  }
}

/**
 * Flips the hidden state of a batch of videos.
 *
 * **A missing row does not cancel the decision.** It used to: the loop read the
 * row, found nothing and moved on, so nothing at all was written. The grid can
 * perfectly well paint a card whose row has since been deleted — a channel
 * purge removes the videos of every channel a reconciliation switches off, and
 * the grid holds its thumbnails until the next paint — and collection recreates
 * that row as soon as the channel comes back. Fifteen videos hidden one evening
 * came back the next morning that way, which is the one gesture this product
 * cannot afford to lose. The decision is therefore recorded in the
 * classification store for every id, present or not, and the insertion path
 * already reads it back as `userHiddenAt`.
 *
 * @returns {Promise<{changed: number, recorded: number, missing: number}>}
 *   rows updated, decisions written, and how many of those had no row.
 */
export async function setHidden(ids, hidden) {
  const now = Date.now();
  const flag = hidden ? 1 : 0;

  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    let changed = 0;
    let recorded = 0;
    let missing = 0;
    for (const id of ids) {
      const v = await reqToPromise(store.get(id));
      await writeHiddenState(tx, id, hidden ? (v?.hiddenAt || now) : 0);
      recorded++;
      if (!v) { missing++; continue; }
      if (v.hidden === flag) continue;
      v.hidden = flag;
      v.hiddenAt = hidden ? now : 0;
      // Hiding and starring contradict each other: a video set aside cannot stay
      // marked "watch first", otherwise it would go on populating that view from
      // the bin. Coming back into the feed does not restore the star — deciding
      // to put it back is separate from deciding to take the video back.
      if (hidden) v.starred = 0;
      await reqToPromise(store.put(v));
      changed++;
    }
    return { changed, recorded, missing };
  });
}

/**
 * Hides every visible video of a channel in one go.
 *
 * The "I want nothing from this channel for now" gesture, without going as far
 * as unsubscribing — future videos will reappear normally.
 *
 * @param {string} channelId
 * @returns {Promise<string[]>} the hidden identifiers, so it can be undone
 */
export async function hideChannelVideos(channelId, hidden = true) {
  const now = Date.now();
  const flag = hidden ? 1 : 0;

  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    const videos = await reqToPromise(store.index('by_channel').getAll(IDBKeyRange.only(channelId)));
    const changedIds = [];

    for (const v of videos) {
      await writeHiddenState(tx, v.id, hidden ? v.hiddenAt || now : 0);
      if ((v.hidden ?? 0) !== flag) {
        v.hidden = flag;
        v.hiddenAt = hidden ? now : 0;
        if (hidden) v.starred = 0;
        await reqToPromise(store.put(v));
        changedIds.push(v.id);
      }
    }

    return changedIds;
  });
}

/**
 * Deletes every video of a channel.
 *
 * Used when unsubscribing: marking the channel inactive stops future fetches,
 * but would leave everything it has already published in the feed.
 * Unsubscribing and going on seeing its releases would make no sense.
 *
 * The deletion is physical, but hidden decisions survive a later resubscription
 * or a temporary omission from YouTube's subscription list.
 *
 * @param {string} channelId
 * @returns {Promise<number>} number of videos deleted
 */
export async function deleteChannelVideos(channelId) {
  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    const videos = await reqToPromise(store.index('by_channel').getAll(IDBKeyRange.only(channelId)));
    let removed = 0;
    for (const video of videos) {
      if (video.hidden) await writeHiddenState(tx, video.id, video.hiddenAt || Date.now());
      await reqToPromise(store.delete(video.id));
      removed++;
    }
    return removed;
  });
}

/**
 * Stars or unstars every video of a channel.
 * @returns {Promise<string[]>} the modified identifiers
 */
export async function setChannelStarred(channelId, starred) {
  const now = Date.now();
  const flag = starred ? 1 : 0;

  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    const videos = await reqToPromise(store.index('by_channel').getAll(IDBKeyRange.only(channelId)));
    const changedIds = [];

    for (const v of videos) {
      if ((v.starred ?? 0) !== flag) {
        v.starred = flag;
        v.starredAt = starred ? now : 0;
        if (starred && v.hidden) {
          v.hidden = 0; v.hiddenAt = 0;
          await writeHiddenState(tx, v.id, 0);
        }
        await reqToPromise(store.put(v));
        changedIds.push(v.id);
      }
    }

    return changedIds;
  });
}

/**
 * Stars or unstars videos.
 *
 * The exact opposite of hiding: instead of setting aside what one does not
 * want, one singles out what one wants to see first.
 */
export async function setStarred(ids, starred) {
  const now = Date.now();
  const flag = starred ? 1 : 0;

  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    let changed = 0;
    for (const id of ids) {
      const v = await reqToPromise(store.get(id));
      if (!v || (v.starred ?? 0) === flag) continue;
      v.starred = flag;
      v.starredAt = starred ? now : 0;
      // Starring a video necessarily brings it back into view: an invisible
      // priority is not what anyone wants.
      if (starred && v.hidden) {
        v.hidden = 0; v.hiddenAt = 0;
        await writeHiddenState(tx, id, 0);
      }
      await reqToPromise(store.put(v));
      changed++;
    }
    return changed;
  });
}

/**
 * Videos without a duration, grouped by channel.
 *
 * YouTube's internal API delivers durations by upload playlist: one request
 * brings back up to a hundred videos from the same channel. Grouping here
 * therefore avoids asking for the same page a thousand times — that is what
 * makes enrichment possible without an API key.
 *
 * Broadcasts are kept apart from videos: they live in another playlist
 * (`UULV`), and looking for them in the long-form one could never yield
 * anything. That is exactly what left replays without a duration indefinitely,
 * and so displayed as running lives.
 *
 * @param {number} maxChannels
 * @param {number} maxVideos  global safeguard on the walk
 * @returns {Promise<Array<{channelId: string, ids: string[], liveIds: string[]}>>}
 */
export async function getMissingDurationsByChannel(maxChannels = 12, maxVideos = 600) {
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_VIDEOS).index('by_published');
    /** @type {Map<string, {ids: string[], liveIds: string[]}>} */
    const groups = new Map();
    let seen = 0;

    await iterate(index.openCursor(null, 'prev'), (cursor) => {
      const v = cursor.value;
      if (v.durationSec == null && v.channelId) {
        let group = groups.get(v.channelId);
        if (!group) {
          if (groups.size >= maxChannels) return ++seen < maxVideos;
          group = { ids: [], liveIds: [] };
          groups.set(v.channelId, group);
        }
        (v.wasLive ? group.liveIds : group.ids).push(v.id);
      }
      return ++seen < maxVideos;
    });

    return [...groups].map(([channelId, group]) => ({ channelId, ...group }));
  });
}

/**
 * The broadcasts the database believes to be running or upcoming.
 *
 * Kept apart from the quest for missing durations, which only looks at recently
 * published videos and stops after a few hundred: a live started the day before
 * left it before finishing, and nothing would ever re-read its state again.
 * Here the date does not matter, only the state does, and it is re-read for as
 * long as it is not switched off.
 *
 * The result takes the shape of `getMissingDurationsByChannel`'s groups so it
 * can be read by the same code on the page side: everything goes into
 * `liveIds`, since a broadcast only lives in the `UULV` playlist.
 *
 * @param {number} maxChannels
 * @returns {Promise<Array<{channelId: string, ids: string[], liveIds: string[]}>>}
 */
export async function getActiveBroadcasts(maxChannels = 24) {
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    /** @type {Map<string, Set<string>>} */
    const groups = new Map();

    const collect = (indexName) => iterate(
      store.index(indexName).openCursor(IDBKeyRange.only(1)), (cursor) => {
        const v = cursor.value;
        if (!v.channelId) return true;
        let ids = groups.get(v.channelId);
        if (!ids) {
          if (groups.size >= maxChannels) return true;
          ids = new Set();
          groups.set(v.channelId, ids);
        }
        ids.add(v.id);
        return true;
      });

    // Both cursors are opened in the same turn of the loop: an IndexedDB
    // transaction closes as soon as it has no pending request left, and chaining
    // them would have seen the second arrive too late.
    await Promise.all([collect('by_live'), collect('by_upcoming')]);

    return [...groups].map(([channelId, ids]) => (
      { channelId, ids: [], liveIds: [...ids] }));
  });
}

/**
 * Records the state of the broadcasts as just read: running, scheduled, or
 * finished for all the others.
 *
 * That state is volatile by nature — one broadcast starts, another ends, and
 * nothing comes to tell us. It is therefore rewritten in full on every reading
 * rather than set once: the identifiers absent from both lists are switched off,
 * within the limit of the broadcasts we have actually just re-read.
 *
 * A scheduled broadcast whose start time is known carries that time as its
 * publication date. That is what places it correctly in "Upcoming"; the date the
 * Atom feed gives is the one the announcement was created, often days before the
 * appointment.
 *
 * @param {object} states
 * @param {string[]} [states.live]  broadcasts seen running
 * @param {Array<[string, number|null]>} [states.upcoming]  [id, announced start]
 * @param {string[]} [states.checked] broadcasts whose state was just re-read
 */
export async function setBroadcastStates({ live = [], upcoming = [], checked = [] } = {}) {
  const liveNow = new Set(live);
  const scheduled = new Map(upcoming);
  const toRecheck = new Set([...checked, ...live, ...scheduled.keys()]);
  if (!toRecheck.size) return 0;

  return withTx(STORE_VIDEOS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    let changed = 0;
    for (const id of toRecheck) {
      const v = await reqToPromise(store.get(id));
      if (!v) continue;

      const isLive = liveNow.has(id) ? 1 : 0;
      const isUpcoming = !isLive && scheduled.has(id) ? 1 : 0;
      const startsAt = scheduled.get(id);
      const date = isUpcoming && startsAt > 0 ? startsAt : v.publishedAt;

      if (v.isLive === isLive && v.isUpcoming === isUpcoming && v.publishedAt === date) continue;
      v.isLive = isLive;
      v.isUpcoming = isUpcoming;
      v.publishedAt = date;
      await reqToPromise(store.put(v));
      changed++;
    }
    return changed;
  });
}

/**
 * Records the durations fetched.
 * @param {Map<string, number>} durations
 * @param {string[]} [unavailable]  marked -1 so they are not asked for again
 */
export async function setDurations(durations, unavailable = []) {
  return withTx(STORE_VIDEOS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    let written = 0;

    for (const [id, seconds] of durations) {
      const v = await reqToPromise(store.get(id));
      if (!v || v.durationSec === seconds) continue;
      v.durationSec = seconds;
      // A known duration settles the question: a broadcast that has one is over.
      // Without this, a live read once kept its red badge forever, and an
      // announced broadcast stayed "upcoming" after it had happened.
      if (v.isLive) v.isLive = 0;
      if (v.isUpcoming) v.isUpcoming = 0;
      await reqToPromise(store.put(v));
      written++;
    }

    for (const id of unavailable) {
      const v = await reqToPromise(store.get(id));
      if (!v || v.durationSec != null) continue;
      v.durationSec = -1;
      await reqToPromise(store.put(v));
    }

    return written;
  });
}

/**
 * Records a video's watch progress.
 *
 * `progress` is the **position** of the playhead: it feeds the red bar on the
 * thumbnail. `completed` says whether the video was actually gone through — the
 * watch tracker judges that, by adding up the time that really elapsed. The two
 * are distinct on purpose: dragging the bar to the end advances the position
 * without having watched a thing.
 *
 * @param {string} id
 * @param {number} progress   position 0..1
 * @param {boolean} [completed]
 */
export async function setWatched(id, progress = 1, completed = false) {
  return withTx(STORE_VIDEOS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    const v = await reqToPromise(store.get(id));
    if (!v) return false;
    v.watchProgress = Math.max(v.watchProgress ?? 0, progress);
    if (completed) v.watched = 1;
    await reqToPromise(store.put(v));
    return true;
  });
}

/**
 * Every video identifier in the database, in one go.
 *
 * Used by the direct refresh, which receives a hundred or so identifiers per
 * channel and only needs an exact date for those it does not know. The first
 * version queried the database key by key: at nine hundred channels, ninety
 * thousand reads, serialised behind a single connection while sixteen network
 * requests were coming in in parallel. The queue grew as the sweep went on,
 * which made the progress bar lag all the more as it neared the end.
 *
 * `getAllKeys` only reads the primary keys, without deserialising a single
 * record: one operation instead of ninety thousand, for a few megabytes of
 * eleven-character strings for the duration of the sweep.
 *
 * @returns {Promise<Set<string>>}
 */
export async function allVideoIds() {
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const keys = await reqToPromise(tx.objectStore(STORE_VIDEOS).getAllKeys());
    return new Set(keys);
  });
}

/**
 * Which of these ids the database already holds.
 *
 * Serves the Shorts screening of the Atom path: an entry already stored has
 * been through the check once, and paying a player request for it on every
 * quarter hour would multiply the cost of the automatic cycle by the size of a
 * feed instead of by the number of new videos.
 *
 * @param {string[]} ids
 * @returns {Promise<Set<string>>}
 */
export async function existingVideoIds(ids) {
  if (!ids?.length) return new Set();
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    const out = new Set();
    for (const id of ids) {
      const key = await reqToPromise(store.getKey(id));
      if (key !== undefined) out.add(id);
    }
    return out;
  });
}

/**
 * The feed's records for a handful of identifiers.
 *
 * Point reads rather than a cursor: the caller is the day journal, which asks
 * for the few dozen videos of one day. Sweeping the index for that would read
 * tens of thousands of records to keep twenty.
 *
 * @returns {Promise<Map<string, object>>}  only the identifiers actually found
 */
export async function getVideosByIds(ids) {
  const wanted = [...new Set(ids)].filter(Boolean);
  if (!wanted.length) return new Map();
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    const found = new Map();
    for (const id of wanted) {
      const video = await reqToPromise(store.get(id));
      if (video) found.set(id, video);
    }
    return found;
  });
}

/**
 * A channel's most recent videos, newest to oldest. `offset` serves to load the
 * next batch in the triage view.
 */
export async function getChannelVideos(channelId, limit = 8, offset = 0) {
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_VIDEOS).index('by_channel');
    const out = [];
    await iterate(index.openCursor(IDBKeyRange.only(channelId)), (cursor) => {
      out.push(cursor.value);
      return true;
    });
    out.sort((a, b) => b.publishedAt - a.publishedAt);
    return out.slice(offset, offset + limit);
  });
}

/**
 * Per-channel statistics, for the subscription triage.
 *
 * A single sweep of the store rather than one query per channel: at 900
 * subscriptions, the second approach would open 900 cursors where one pass is
 * enough.
 *
 * @returns {Promise<Map<string, {videoCount: number, hiddenCount: number, watchedCount: number}>>}
 */
async function getChannelStats() {
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const stats = new Map();

    await iterate(tx.objectStore(STORE_VIDEOS).openCursor(), (cursor) => {
      const v = cursor.value;
      let s = stats.get(v.channelId);
      if (!s) { s = { videoCount: 0, hiddenCount: 0, watchedCount: 0 }; stats.set(v.channelId, s); }
      s.videoCount++;
      if (v.hidden) s.hiddenCount++;
      if (v.watched) s.watchedCount++;
      return true;
    });

    return stats;
  });
}

/**
 * Channel side facts, for the games.
 *
 * The duel compared nothing but our own relationship to a channel — hours
 * watched, videos opened, last visit — and those quantities sit close together
 * by construction: one does not watch a channel a hundred times more than
 * another. What the channel itself does spans orders of magnitude: a daily
 * uploader against a quarterly one, two million views against three thousand.
 * That is where a duel becomes a question rather than a coin toss.
 *
 * Everything comes from the feed index, therefore from the `UULF` playlist:
 * Shorts are not in it, and neither their views nor their durations weigh on
 * these figures.
 *
 * One sweep of the videos, like the triage does: at nine hundred subscriptions
 * one pass beats nine hundred queries.
 *
 * @returns {Promise<Map<string, {videos: number, views: number,
 *   viewsSamples: number, bestViews: number, bestTitle: string,
 *   durTotal: number, durCount: number, uploadIntervalMs: number|null,
 *   lastUploadAt: number}>>}
 */
export async function getChannelFacts() {
  const channels = await getAllChannels();

  const facts = await withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const map = new Map();
    await iterate(tx.objectStore(STORE_VIDEOS).openCursor(), (cursor) => {
      const v = cursor.value;
      if (!v.channelId) return true;
      let f = map.get(v.channelId);
      if (!f) {
        f = { videos: 0, views: 0, viewsSamples: 0, bestViews: 0, bestTitle: '',
              durTotal: 0, durCount: 0 };
        map.set(v.channelId, f);
      }
      f.videos++;
      // A live not yet broadcast has neither views nor duration: it is counted
      // as a video and weighs on nothing else.
      if (Number.isFinite(v.views) && v.views > 0) {
        f.views += v.views;
        f.viewsSamples++;
        if (v.views > f.bestViews) { f.bestViews = v.views; f.bestTitle = v.title ?? ''; }
      }
      if (v.durationSec > 0) { f.durTotal += v.durationSec; f.durCount++; }
      return true;
    });
    return map;
  });

  for (const c of channels) {
    if (!c.active) continue;
    let f = facts.get(c.id);
    if (!f) {
      f = { videos: 0, views: 0, viewsSamples: 0, bestViews: 0, bestTitle: '',
            durTotal: 0, durCount: 0 };
      facts.set(c.id, f);
    }
    f.uploadIntervalMs = c.uploadIntervalMs ?? null;
    f.lastUploadAt = c.lastUploadAt ?? 0;
  }

  // A channel of the history we are not subscribed to has no cadence and no
  // last upload: the games rule it out of those questions rather than compare
  // it at zero.
  for (const f of facts.values()) {
    if (f.uploadIntervalMs === undefined) f.uploadIntervalMs = null;
    if (f.lastUploadAt === undefined) f.lastUploadAt = 0;
  }

  return facts;
}

/** Active channels enriched with their statistics, ready for the triage. */
export async function getChannelsForTriage() {
  const [channels, stats] = await Promise.all([getAllChannels(), getChannelStats()]);

  return channels
    .filter((c) => c.active)
    .map((c) => ({
      id: c.id,
      title: c.title,
      avatarUrl: c.avatarUrl,
      addedAt: c.addedAt,
      lastUploadAt: c.lastUploadAt,
      uploadIntervalMs: c.uploadIntervalMs,
      ...(stats.get(c.id) ?? { videoCount: 0, hiddenCount: 0, watchedCount: 0 }),
    }));
}

/**
 * Every video published since `since`, hidden ones included.
 * Used by the audit, which must reason on everything we know.
 * @param {number} since  epoch ms
 */
export async function getVideosSince(since) {
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_VIDEOS).index('by_published');
    const out = [];
    await iterate(index.openCursor(IDBKeyRange.lowerBound(since)), (cursor) => {
      out.push(cursor.value);
      return true;
    });
    return out;
  });
}

/**
 * The feed's pulse: what was published recently, by day and by channel.
 *
 * A single sweep bounded to thirty days serves both answers. Doing it in two
 * passes would cost the same walk twice, and these figures are shown side by
 * side in the popup — they have to describe the same instant anyway.
 *
 * Hidden videos count too: hiding a card must not change publication volume.
 *
 * @param {number} days  depth of the scan
 */
export async function getFeedPulse(days = 30) {
  const now = Date.now();
  const since = now - days * DAY;

  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    // `by_published` and not `by_visible`: the pulse describes what the channels
    // published, not what is left in the feed. Counting visible videos only
    // would make the histogram drop as one tidies up, and on an account where
    // nothing is hidden it would already not mean the same thing as on an
    // account where a lot is.
    const index = tx.objectStore(STORE_VIDEOS).index('by_published');
    const range = IDBKeyRange.bound(since, now);

    const perDay = new Map();
    const perChannelWeek = new Map();
    const perChannelMonth = new Map();
    const weekAgo = now - 7 * DAY;

    const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

    for (const v of await reqToPromise(index.getAll(range))) {
      // The day is the one in the local timezone: that is the one the user reads
      // on the videos, and a UTC split would shift half the evenings.
      const d = new Date(v.publishedAt);
      bump(perDay, `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
      bump(perChannelMonth, v.channelId);
      if (v.publishedAt >= weekAgo) bump(perChannelWeek, v.channelId);
    }

    const top = (map) => [...map.entries()]
      .map(([channelId, count]) => ({ channelId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      perDay: Object.fromEntries(perDay),
      topWeek: top(perChannelWeek),
      topMonth: top(perChannelMonth),
    };
  });
}

/**
 * Number of visible videos, in total and by age bracket.
 *
 * These are `count()` calls on the composite index, so the engine opens no
 * record at all: it stays instant even at several tens of thousands of videos.
 * That is what makes it possible to show a useful statistic in an
 * infinite-scroll feed, where counting what is loaded on screen teaches nothing.
 *
 * @param {number[]} [periodsInDays]
 */
export async function getFeedCounts(periodsInDays = [1, 7, 30], { withViews = false } = {}) {
  const now = Date.now();

  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_VIDEOS).index('by_visible');

    // The total stops at now, like the feed: a scheduled broadcast is not "to
    // watch", it does not exist yet.
    const total = await reqToPromise(index.count(IDBKeyRange.bound([0], [0, now])));
    const hidden = await reqToPromise(index.count(IDBKeyRange.bound([1], [2], false, true)));
    const upcoming = await reqToPromise(index.count(IDBKeyRange.bound([0, now], [0, MAX_TS])));

    const byPeriod = {};
    for (const days of periodsInDays) {
      // Bounded at now: a scheduled premiere does not count as "to watch in the
      // last 24 h".
      const range = IDBKeyRange.bound([0, now - days * DAY], [0, now]);
      byPeriod[days] = await reqToPromise(index.count(range));
    }

    // Starred and started videos are indexed by nothing: counting them requires
    // a sweep. It only happens on request — the feed's toolbar calls this
    // function on every re-read and does not need them, only the popup shows
    // those two numbers.
    let starred = 0;
    let inProgress = 0;
    if (withViews) {
      // Avoid one IndexedDB event per video on every popup opening.
      for (const video of await reqToPromise(index.getAll(VISIBLE_RANGE))) {
        if (video.starred) starred += 1;
        if (isInProgress(video)) inProgress += 1;
      }
    }

    return { total, hidden, upcoming, byPeriod, starred, inProgress };
  });
}

/** Counters for the popup and the audit. */
export async function getStats() {
  return withTx([STORE_VIDEOS, STORE_CHANNELS, STORE_META], 'readonly', async (tx) => {
    const videos = tx.objectStore(STORE_VIDEOS);
    const channels = tx.objectStore(STORE_CHANNELS);

    const total = await reqToPromise(videos.count());
    const visible = await reqToPromise(videos.index('by_visible').count(VISIBLE_RANGE));
    const channelCount = await reqToPromise(channels.count());
    const activeChannels = await reqToPromise(channels.index('by_active').count(IDBKeyRange.only(1)));
    // When YouTube's subscription list was last read and acted upon. Nothing
    // else switches a channel off, and reading that list needs a session cookie
    // the isolated world cannot always see — on such a browser the daily
    // reconciliation returns before asking anything and the active flags are
    // whatever an old import left behind, for ever, in silence. Three repairs
    // to the pruning logic were spent before anyone thought to ask whether it
    // had ever run once. This is that question, answered on screen.
    const baseline = await reqToPromise(tx.objectStore(STORE_META).get('subs.listBaseline'));

    return {
      total,
      visible,
      hidden: total - visible,
      channelCount,
      activeChannels,
      lastListAt: baseline?.value?.at ?? 0,
      lastListSize: baseline?.value?.size ?? 0,
    };
  });
}

/**
 * Removes the videos that had been created by the native feed harvest.
 *
 * A one-off cleanup: that source could let in Shorts the `UULF` feeds had
 * correctly kept out. It no longer inserts anything, but the records already
 * created remain to be deleted.
 *
 * Starred videos are spared: the user took an interest in them, we do not erase
 * them behind their back.
 *
 * @returns {Promise<number>} number of videos deleted
 */
export async function purgeNativeInserted() {
  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    const videos = await reqToPromise(store.getAll());
    let removed = 0;
    for (const v of videos) {
      if (v.source !== 'native' || v.starred) continue;
      if (v.hidden) await writeHiddenState(tx, v.id, v.hiddenAt || Date.now());
      await reqToPromise(store.delete(v.id));
      removed++;
    }
    return removed;
  });
}

/** A Short lasts three minutes at most. Above it, the question does not arise. */
const SHORT_MAX_SEC = 180;

/**
 * The videos that could still be Shorts, in slices.
 *
 * A Short that got in before YouTube’s verdict was consulted has nothing to set
 * it apart in the database, and only the player record can rule. What this does
 * is narrow the list of records to consult.
 *
 * **A video whose duration is unknown is a candidate**, and that correction
 * matters more than it looks. The filter used to require a known duration under
 * three minutes — but the Atom feed carries no duration at all. Every video
 * collected by the automatic cycle was therefore invisible to this pass, which
 * is precisely the population the pass exists for: YouTube reclassifies a video
 * as a Short several hours after it goes up, well after the screening at
 * insertion has said no. A Short reported by hand in the feed, months after the
 * backstop was written, was of exactly that kind.
 *
 * The pass converges rather than growing without end: a video found not to be a
 * Short gets its duration written, and above three minutes it leaves the
 * candidates for good.
 *
 * The walk follows the primary key and not a date: that is the only order that
 * makes it possible to resume exactly where one stopped after the service worker
 * was killed.
 *
 * @param {string|null} afterId    last identifier already examined
 * @param {number} max             identifiers returned at most
 * @param {number} maxExamined     records walked at most
 * @returns {Promise<{ids: string[], lastId: string|null, done: boolean}>}
 */
export async function listShortCandidates(afterId = null, max = 25, maxExamined = 3000) {
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const range = afterId ? IDBKeyRange.lowerBound(afterId, true) : null;
    const ids = [];
    let lastId = afterId;
    let examined = 0;

    await iterate(tx.objectStore(STORE_VIDEOS).openCursor(range), (cursor) => {
      const v = cursor.value;
      lastId = cursor.key;
      examined++;
      if (!(v.durationSec > SHORT_MAX_SEC)) ids.push(v.id);
      return ids.length < max && examined < maxExamined;
    });

    return { ids, lastId, done: examined < maxExamined && ids.length < max };
  });
}

/**
 * How long a video stays worth asking about, and how often it is asked.
 *
 * A verdict given at the moment of collection is not final. YouTube reclassifies
 * a short video as a Short some hours after it goes up, and until it does, every
 * source we read calls it a video: it sits in the `UULF` playlist, it is served
 * by that playlist's Atom feed, and it is absent from `UUSH`. Measured on
 * `d2_n6R7bn8w` on 28 August 2026, several hours after publication: still first
 * in `UULF`, nowhere in `UUSH`, and `canonicalUrl` already pointing at
 * `/shorts/`. YouTube's own listings disagree with YouTube's own player, and the
 * player is the one that is right — which is why looking at the channel's video
 * list, whatever form one reads it in, cannot settle the question.
 *
 * So it has to be asked again. The window is where the reclassification happens,
 * the period is how long a Short can survive in the feed in the worst case.
 *
 * The cost is bounded and small. A player record is 8 KB, measured. An account
 * following nine hundred channels collects on the order of two hundred videos a
 * day, hence some three hundred inside the window, each asked twelve times over
 * its stay: about thirty six hundred records a day, 29 MB — against the 1.4 GB
 * a day the Atom collection already costs. Two per cent, for the one guarantee
 * the extension exists to give.
 */
export const SHORT_RECHECK_WINDOW_MS = 36 * 60 * 60 * 1000;
export const SHORT_RECHECK_EVERY_MS = 3 * 60 * 60 * 1000;

/**
 * The tighter period, and who gets it.
 *
 * Three hours was measured against bandwidth and it holds for the window as a
 * whole, but it is what one waits in the worst case, and a Short showing for
 * three hours is a Short showing. Measured on `r4orIinlASc` on 1 September 2026:
 * thirty seven seconds, published at 22:15 Paris, screened at collection while
 * `canonicalUrl` still read `/watch`, reclassified afterwards, and in the feed
 * when the user found it.
 *
 * So the budget goes where the risk is. A Short cannot last more than three
 * minutes, therefore a video that lasts longer is one YouTube will not
 * reclassify, and it keeps the three hourly rate. Everything at or below the
 * ceiling, **and everything whose duration is unknown**, is asked again every
 * quarter hour.
 *
 * This is not the mistake the paragraph below warns against, and the difference
 * matters: duration is used to ask *more often*, never to ask less and never to
 * conclude. No video is screened less than it was; a record with no duration is
 * treated as suspect rather than as settled.
 *
 * The cost stays bounded. On an account following nine hundred channels, some
 * two hundred videos a day of which roughly a tenth are under the ceiling: about
 * thirty records in the window, four times an hour, 8 KB each — under 24 MB a
 * day, on top of the 29 MB the window already cost.
 */
export const SHORT_RECHECK_FAST_MS = 15 * 60 * 1000;

/** The Shorts ceiling, three minutes since October 2024, plus a margin: a limit
 *  YouTube has already moved once is not one to sit exactly on. */
const SHORT_CEILING_SEC = 200;

/**
 * The recent videos due another verdict, the ones that can still turn first.
 *
 * The lap above walks the whole index in identifier order, which is to say in an
 * order unrelated to time: a video collected this morning may wait days for its
 * turn. This pass covers the window where reclassification happens, and nothing
 * else.
 *
 * Being due does not depend on the duration. It did, and that was the defect: a
 * video whose duration was already known was taken for settled, when duration
 * says nothing about the matter — a Short of eighteen seconds and a video of
 * twenty five seconds are not told apart by any figure. What the record now
 * carries is the date of its last verdict, which is the only thing that decides.
 * Duration only says how often the question comes back, see the two periods
 * above.
 *
 * The two lanes are gathered separately and the fast one is served first,
 * because the cap is the whole point: filled newest first from a single list, a
 * burst of long uploads would push the very records this exists for out of the
 * slice.
 *
 * @param {number} now  the moment of the pass, epoch ms
 * @param {number} max  identifiers returned at most
 */
export async function listShortRecheck(now, max = 20) {
  const floor = now - SHORT_RECHECK_WINDOW_MS;
  const fastDue = now - SHORT_RECHECK_FAST_MS;
  const slowDue = now - SHORT_RECHECK_EVERY_MS;
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_VIDEOS).index('by_published');
    const fast = [];
    const slow = [];
    await iterate(index.openCursor(IDBKeyRange.lowerBound(floor), 'prev'), (cursor) => {
      const v = cursor.value;
      // Unknown duration goes with the short ones: we do not know, so we ask.
      const quick = !(v.durationSec > SHORT_CEILING_SEC);
      // A record that predates this field has never been asked, and is due.
      if (!(v.shortCheckedAt > (quick ? fastDue : slowDue))) (quick ? fast : slow).push(v.id);
      // Walked to the end of the window unless the fast lane alone already
      // fills the slice. Stopping on the total would let a burst of long
      // uploads at the top hide an older short one further down, which is
      // exactly the record this pass exists for. The window holds a few hundred
      // records and this is a local read: the full walk costs nothing.
      return fast.length < max;
    });
    return [...fast, ...slow].slice(0, max);
  });
}

/**
 * Among the videos named, the ones a verdict is due on.
 *
 * Publication age never exempts a requested record. Old shortCheckedAt values
 * predate the three-state parser and cannot serve as proof of a negative verdict.
 *
 * @param {string[]} ids
 * @param {number} now  the moment of the pass, epoch ms
 */
/**
 * Clears an avatar URL copied onto many unrelated channels.
 *
 * YouTube may legitimately serve two channels the same picture, but the exact
 * signed `yt3` URL appearing on three or more active subscriptions is the trace
 * left by the old parser selecting the signed-in account avatar from every
 * authenticated response. The next channel read restores each real owner.
 */
export async function dropSharedChannelAvatars(minCopies = 3) {
  const minimum = Math.max(3, Math.trunc(Number(minCopies) || 3));
  return withTx(STORE_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_CHANNELS);
    const channels = await reqToPromise(store.getAll());
    const groups = new Map();
    for (const channel of channels) {
      if (!channel.active || !/^https:\/\/yt3\./.test(channel.avatarUrl ?? '')) continue;
      if (!groups.has(channel.avatarUrl)) groups.set(channel.avatarUrl, []);
      groups.get(channel.avatarUrl).push(channel);
    }

    let cleared = 0;
    for (const duplicated of groups.values()) {
      if (duplicated.length < minimum) continue;
      for (const channel of duplicated) {
        delete channel.avatarUrl;
        await reqToPromise(store.put(channel));
        cleared++;
      }
    }
    return cleared;
  });
}

/** Recent known ids for every channel, built in one local database pass. */
export async function getRecentVideoIdsByChannel(limit = 30, { completeOnly = false } = {}) {
  const cap = Math.max(1, Math.trunc(limit) || 30);
  return withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const byChannel = new Map();
    for (const video of await reqToPromise(tx.objectStore(STORE_VIDEOS).getAll())) {
      if (!video.channelId) continue;
      // A row created by RSS can exist while the strict display guard still
      // withholds it for lack of duration. It must not tell the authenticated
      // sweep "already repaired" or it will stay invisible forever.
      if (completeOnly && !(video.durationSec > 0 || video.isLive || video.isUpcoming)) continue;
      const rows = byChannel.get(video.channelId) ?? [];
      rows.push({ id: video.id, publishedAt: video.publishedAt ?? 0 });
      byChannel.set(video.channelId, rows);
    }
    return new Map([...byChannel].map(([channelId, rows]) => [
      channelId,
      rows.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, cap).map((row) => row.id),
    ]));
  });
}

// ---------------------------------------------------------------------------
// Native YouTube observations (reverse completeness audit only)
// ---------------------------------------------------------------------------

/**
 * Keeps every distinct video identifier observed in YouTube's subscriptions
 * page, including identifiers absent from TrackTube's own video store.
 *
 * Missing renderer fields are completed from an existing TrackTube row when
 * possible. This is a measurement store only; nothing here enters the feed.
 */
export async function recordNativeVideos(incoming, at = Date.now(), { replace = false } = {}) {
  const rows = [...new Map((incoming ?? []).filter((v) => v?.id).map((v) => [v.id, v])).values()];
  if (!rows.length && !replace) return { count: 0, inserted: 0, dated: 0, oldestPublishedAt: null };

  return withTx([STORE_NATIVE_VIDEOS, STORE_VIDEOS], 'readwrite', async (tx) => {
    const observations = tx.objectStore(STORE_NATIVE_VIDEOS);
    const videos = tx.objectStore(STORE_VIDEOS);
    if (replace) await reqToPromise(observations.clear());
    let inserted = 0;
    let dated = 0;
    let oldestPublishedAt = Number.POSITIVE_INFINITY;

    for (const incomingRow of rows) {
      const [previous, known] = await Promise.all([
        reqToPromise(observations.get(incomingRow.id)),
        reqToPromise(videos.get(incomingRow.id)),
      ]);
      const publishedAt = [incomingRow.publishedAt, known?.publishedAt, previous?.publishedAt]
        .find((value) => Number.isFinite(value) && value > 0);
      const take = (key) => incomingRow[key] || known?.[key] || previous?.[key] || '';
      const record = {
        id: incomingRow.id,
        firstSeenAt: previous?.firstSeenAt ?? at,
        lastSeenAt: at,
        title: take('title'),
        channelId: take('channelId'),
        channelTitle: take('channelTitle'),
        ...(publishedAt ? { publishedAt } : {}),
      };
      await reqToPromise(observations.put(record));
      if (!previous) inserted++;
      if (publishedAt) {
        dated++;
        if (publishedAt < oldestPublishedAt) oldestPublishedAt = publishedAt;
      }
    }

    return {
      count: rows.length,
      inserted,
      dated,
      oldestPublishedAt: Number.isFinite(oldestPublishedAt) ? oldestPublishedAt : null,
    };
  });
}

/**
 * Native observations whose publication falls in the requested period.
 * Old `seenNativeAt` markers cannot be used here: they never retained videos
 * missing from TrackTube, so treating them as a complete reverse sample would
 * manufacture a reassuring but invalid result after migration.
 */
export async function getNativeVideosSince(since) {
  return withTx(STORE_NATIVE_VIDEOS, 'readonly', async (tx) => {
    const found = new Map();
    const native = tx.objectStore(STORE_NATIVE_VIDEOS);

    await iterate(native.index('by_published').openCursor(IDBKeyRange.lowerBound(since)), (cursor) => {
      found.set(cursor.value.id, cursor.value);
      return true;
    });

    const undated = [];
    await iterate(native.openCursor(), (cursor) => {
      if (!Number.isFinite(cursor.value.publishedAt)) undated.push(cursor.value);
      return true;
    });

    return { videos: [...found.values()], undated };
  });
}

/** Atom and classification writes share both stores, so their order cannot
 * resurrect a confirmed Short. Unknown responses invalidate a prior verdict. */
export async function recordVideoClassification(
  id, isShort, at, validUntil = 0, { authoritativeLong = false } = {},
) {
  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const videos = tx.objectStore(STORE_VIDEOS);
    const shorts = tx.objectStore(STORE_SHORTS);
    const previous = await reqToPromise(shorts.get(id));
    if (previous?.isShort === true && !(authoritativeLong && isShort === false)) {
      return { blocked: true, removed: 0 };
    }
    const video = await reqToPromise(videos.get(id));
    if (isShort === true) {
      await reqToPromise(shorts.put({
        ...previous, id, isShort: true, checkedAt: at, validUntil: 0,
        ...(video?.hidden ? { userHiddenAt: video.hiddenAt || Date.now() } : {}),
      }));
      await reqToPromise(videos.delete(id));
      return { blocked: true, removed: video ? 1 : 0 };
    }
    if (previous?.checkedAt > at) return { blocked: false, removed: 0 };
    await reqToPromise(shorts.put({
      ...previous, id, isShort: isShort === false ? false : null,
      checkedAt: at, validUntil: isShort === false ? validUntil : 0,
    }));
    if (video) {
      video.shortVerifiedAt = isShort === false ? at : 0;
      video.shortValidUntil = isShort === false ? validUntil : 0;
      if (isShort === false) video.shortCheckedAt = at;
      await reqToPromise(videos.put(video));
    }
    return { blocked: false, removed: 0 };
  });
}

/**
 * Persists YouTube's explicit Members-only badge without calling it a Short.
 * The shared classification store is deliberate: every insertion already
 * consults it atomically, so RSS cannot resurrect a restricted video after the
 * authenticated tab removed it. A later public Videos-tab card clears the
 * flag and allows the ordinary player verdict to insert it.
 */
export async function recordMembersOnly(id, membersOnly, at = Date.now()) {
  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const videos = tx.objectStore(STORE_VIDEOS);
    const classifications = tx.objectStore(STORE_SHORTS);
    const previous = await reqToPromise(classifications.get(id));
    const video = await reqToPromise(videos.get(id));
    await reqToPromise(classifications.put({
      ...previous,
      id,
      membersOnly: membersOnly === true,
      membersCheckedAt: at,
      ...(membersOnly === true && video?.hidden
        ? { userHiddenAt: video.hiddenAt || Date.now() } : {}),
    }));
    if (membersOnly === true && video) await reqToPromise(videos.delete(id));
    return { blocked: membersOnly === true, removed: membersOnly === true && video ? 1 : 0 };
  });
}

export async function knownShortIds(ids) {
  return withTx(STORE_SHORTS, 'readonly', async (tx) => {
    const found = new Set();
    for (const id of ids) {
      const verdict = await reqToPromise(tx.objectStore(STORE_SHORTS).get(id));
      if (verdict?.isShort === true) found.add(id);
    }
    return found;
  });
}

/**
 * Records that these videos were put to the player, and when.
 *
 * Written apart from `upsertVideos` on purpose: that function merges what the
 * feeds bring, and this is not a fact about the video but about us — what we
 * have already asked. Mixing the two would mean an Atom re-read could pass for a
 * verdict.
 */
export async function markShortChecked(ids, at = Date.now()) {
  if (!ids.length) return 0;
  return withTx(STORE_VIDEOS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    let written = 0;
    for (const id of ids) {
      const v = await reqToPromise(store.get(id));
      if (!v) continue;
      v.shortCheckedAt = at;
      await reqToPromise(store.put(v));
      written++;
    }
    return written;
  });
}

/**
 * Deletes videos by name, whatever their origin.
 *
 * Used for the Shorts recognised after the fact: `UULF` keeps them out at the
 * source, but YouTube sometimes reclassifies a short video a few hours after it
 * goes up, and it has time to be collected before that. Hiding them would not
 * be enough — a Short must be nowhere, not even in the "hidden" view, and not in
 * the counters.
 *
 * @param {string[]} ids
 * @returns {Promise<number>} number of videos actually deleted
 */
export async function deleteVideos(ids) {
  if (!ids?.length) return 0;
  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    let removed = 0;
    for (const id of ids) {
      const v = await reqToPromise(store.get(id));
      if (!v) continue;
      if (v.hidden) await writeHiddenState(tx, id, v.hiddenAt || Date.now());
      await reqToPromise(store.delete(id));
      removed++;
    }
    return removed;
  });
}

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------
/**
 * A backup is worth what it restores.
 *
 * Version 1 saved a summary: the subscription list, the states of the videos
 * that had one, and the measured sessions. Everything else was declared
 * rebuildable — the videos would come back from the feeds, the Takeout history
 * could be requested from Google again. Restoring it on a fresh profile proved
 * what that reasoning was worth: four hundred and three states waited for a
 * synchronisation to bring their video back, the imported history was simply
 * gone, and the durations fetched one by one over a week had to be fetched
 * again.
 *
 * Version 2 saves the database. Channels with all their fields, the record of
 * every video carrying a state, the whole history whatever its origin, the
 * durations and what we learned about the channels of that history. It is
 * heavier — a few megabytes rather than a few hundred kilobytes — and that is
 * the price of the word backup.
 *
 * Version 1 files are still read: the format is recognised, and what it lacks
 * is treated as absent rather than as empty.
 */
const BACKUP_FORMAT = 'tracktube-backup';
const BACKUP_VERSION = 2;

/**
 * States whose video is unknown, kept aside until one turns up.
 *
 * Version 2 leaves almost nothing here, since it restores the video itself. It
 * remains for version 1 files, and for a record too damaged to be inserted.
 */
const META_PENDING_RESTORE = 'restore.pending';

/** State fields that exist only thanks to the user: irreplaceable. */
const USER_STATE_FIELDS = ['hidden', 'hiddenAt', 'starred', 'starredAt', 'watched', 'watchProgress'];

const hasUserState = (v) =>
  v.hidden || v.starred || v.watched || (v.watchProgress ?? 0) > 0;

/** Every record of a store, in one read. */
async function dumpStore(name) {
  return withTx(name, 'readonly', async (tx) => reqToPromise(tx.objectStore(name).getAll()));
}

/**
 * Exports the database, minus what would be noise.
 *
 * Only the videos carrying a state are taken: the others come back from the
 * feeds identical, and a feed of forty thousand videos would weigh ten
 * megabytes for nothing. Everything else is taken whole.
 */
export async function exportUserData() {
  const channels = await dumpStore(STORE_CHANNELS);
  const history = await dumpStore(STORE_HISTORY);
  const durations = await dumpStore(STORE_DURATIONS);
  const histoChannels = await dumpStore(STORE_HISTO_CHANNELS);

  const videos = await withTx(STORE_VIDEOS, 'readonly', async (tx) => {
    const out = [];
    await iterate(tx.objectStore(STORE_VIDEOS).openCursor(), (cursor) => {
      if (hasUserState(cursor.value)) out.push(cursor.value);
      return true;
    });
    return out;
  });
  // A channel can have been removed from the local feed while the user's hidden
  // choices still need to survive a reinstall. Version 2 already accepts
  // videoStates, so keep these small, recordless states in that field.
  const savedIds = new Set(videos.map((video) => video.id));
  const videoStates = await withTx(STORE_SHORTS, 'readonly', async (tx) => {
    const out = [];
    await iterate(tx.objectStore(STORE_SHORTS).openCursor(), (cursor) => {
      const row = cursor.value;
      if (row.userHiddenAt && !savedIds.has(row.id)) {
        out.push({ id: row.id, hidden: 1, hiddenAt: row.userHiddenAt });
      }
      return true;
    });
    return out;
  });

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    channels,
    videos,
    videoStates,
    history,
    durations,
    histoChannels,
  };
}

/**
 * Reads a backup of either version into one shape.
 *
 * Pure function, hence testable without a database: it is the only place that
 * knows a version 1 file called its measured sessions `watchSessions` and its
 * states `videoStates`.
 *
 * @param {object} payload
 */
function normalizeBackup(payload) {
  if (payload?.format !== BACKUP_FORMAT) throw new Error('err.badbackup');
  const version = Number(payload.version) || 1;
  const arr = (v) => (Array.isArray(v) ? v : []);

  return {
    version,
    exportedAt: Number(payload.exportedAt) || 0,
    channels: arr(payload.channels),
    videos: arr(payload.videos),
    // Version 1 had no video records, only flags to reapply.
    videoStates: arr(payload.videoStates),
    history: version >= 2 ? arr(payload.history) : arr(payload.watchSessions),
    durations: arr(payload.durations),
    histoChannels: arr(payload.histoChannels),
    settings: payload.settings ?? null,
  };
}

/** How many records a restore has to go through, so the bar can be honest. */
function backupSize(norm) {
  return norm.channels.length + norm.videos.length + norm.videoStates.length
    + norm.history.length + norm.durations.length + norm.histoChannels.length;
}

// --- the five steps, one store each -----------------------------------------

/**
 * The subscriptions, exactly as they were.
 *
 * The old restore went through `reconcileChannels`, which reactivates every
 * channel it is handed — the right behaviour for an import from YouTube, where
 * the list is by definition the list of active subscriptions, and the wrong one
 * for a backup, which also carries the channels one has deliberately left.
 * Nine hundred and ten subscriptions came back where four hundred remained, and
 * two weeks of triage were undone by the restore meant to protect them.
 *
 * Nothing absent from the file is deactivated: a channel subscribed to since
 * the export is not an error to correct.
 */
async function restoreChannels(list) {
  if (!list?.length) return { applied: 0 };
  const now = Date.now();

  return withTx(STORE_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_CHANNELS);
    let applied = 0;

    for (const inc of list) {
      if (!inc?.id) continue;
      const prev = await reqToPromise(store.get(inc.id));
      const base = prev ?? makeChannel(inc.id, inc.title, inc.avatarUrl, now);

      await reqToPromise(store.put({
        ...base,
        ...inc,
        active: inc.active === undefined ? base.active : (inc.active ? 1 : 0),
        // The collection state belongs to this profile and never to the file: a
        // fingerprint restored from elsewhere would have us skip a feed that has
        // changed since, and a due date from last month would make every channel
        // due at once.
        feedHash: prev?.feedHash ?? null,
        livesHash: prev?.livesHash ?? null,
        nextDueAt: prev?.nextDueAt ?? 0,
        lastFetchAt: prev?.lastFetchAt ?? 0,
        lastSuccessAt: prev?.lastSuccessAt ?? 0,
        failCount: prev?.failCount ?? 0,
        // A backup deliberately contains only videos carrying user state, not
        // the full feed. Its old direct checkpoint can therefore never prove
        // that this freshly restored database is complete. The next manual
        // sweep must rebuild the first hundred entries before it may stop on a
        // locally known id again.
        directBackfillAt: prev?.directBackfillAt ?? 0,
      }));
      applied++;
    }

    return { applied };
  });
}

/**
 * A restorable video record: enough to be rendered and to be indexed.
 *
 * `by_visible` is the composite `[hidden, publishedAt]`. A record whose
 * `publishedAt` is not a number is absent from that index, therefore invisible
 * in the feed while occupying a row — the kind of defect one chases for an
 * hour. Such a record is refused rather than written.
 */
function restorableVideo(v) {
  if (!v?.id || !v.channelId) return null;
  const publishedAt = Number(v.publishedAt);
  if (!Number.isFinite(publishedAt) || publishedAt <= 0) return null;

  return {
    ...v,
    publishedAt,
    hidden: v.hidden ? 1 : 0,
    watched: v.watched ? 1 : 0,
    watchProgress: Number(v.watchProgress) || 0,
  };
}

/**
 * The videos and their states.
 *
 * Restoring the record and not merely its flags is what makes a restore
 * immediate. It is the one source outside the feeds allowed to create a video,
 * and the exception holds: the file carries our own index, already sifted of
 * its Shorts, not a page’s DOM. The alternative was measured on a real
 * profile — four hundred and three states waiting hours for a synchronisation,
 * and a feed that came back in pieces.
 */
export async function restoreVideos(list, pending = {}) {
  if (!list?.length) return { applied: 0, created: 0, deferred: 0 };

  return withTx([STORE_VIDEOS, STORE_SHORTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_VIDEOS);
    let applied = 0;
    let created = 0;
    let deferred = 0;

    for (const inc of list) {
      if (!inc?.id) continue;
      const prev = await reqToPromise(store.get(inc.id));
      if (inc.hidden !== undefined) {
        await writeHiddenState(tx, inc.id, inc.hidden ? inc.hiddenAt || Date.now() : 0);
      }

      if (!prev) {
        const fresh = restorableVideo(inc);
        if (!fresh) { pending[inc.id] = inc; deferred++; continue; }
        await reqToPromise(store.put(fresh));
        created++;
        continue;
      }

      applyUserState(prev, inc);
      await reqToPromise(store.put(prev));
      applied++;
    }

    return { applied, created, deferred };
  });
}

/**
 * The whole history, whatever its origin.
 *
 * Version 1 saved the measured sessions alone, on the grounds that Google
 * reissues a Takeout export on demand. It does, several days later, and it
 * knows nothing of the seconds actually watched. A history imported the day
 * before an export vanished on restore.
 *
 * A row measured here always wins over the same row read from a file: the
 * running database knows the viewing, the file only knows what it knew the day
 * it was written. Conversely a measured row inside the file replaces a Takeout
 * row here, for the same reason.
 */
async function restoreHistory(list) {
  if (!list?.length) return { applied: 0, kept: 0 };

  return withTx(STORE_HISTORY, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTORY);
    let applied = 0;
    let kept = 0;
    let sessions = 0;

    for (const s of list) {
      if (!s?.videoId) continue;
      const key = s.key ?? (s.watchedAt ? `${s.videoId}|${s.watchedAt}` : null);
      if (!key) continue;

      const prev = await reqToPromise(store.get(key));
      if (prev && (prev.source === 'live' || s.source !== 'live')) { kept++; continue; }

      await reqToPromise(store.put({ ...s, key }));
      applied++;
      if (s.source === 'live') sessions++;
    }

    return { applied, kept, sessions };
  });
}

/**
 * The durations, which cost a request each.
 *
 * A duration already known here is not touched: the negative verdicts of the
 * settling pass — `-1` unknowable, `-2` Short — are worth less than a real
 * figure, and a real figure is worth more than anything the file could say.
 */
async function restoreDurations(list) {
  if (!list?.length) return { applied: 0 };

  return withTx(STORE_DURATIONS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_DURATIONS);
    let applied = 0;

    for (const d of list) {
      if (!d?.videoId || !Number.isFinite(d.sec)) continue;
      const prev = await reqToPromise(store.get(d.videoId));
      if (prev && (prev.sec > 0 || !(d.sec > 0))) continue;
      await reqToPromise(store.put({ videoId: d.videoId, sec: d.sec }));
      applied++;
    }

    return { applied };
  });
}

/** What we learned about the channels of the history, merged rather than replaced. */
async function restoreHistoChannels(list) {
  if (!list?.length) return { applied: 0 };

  return withTx(STORE_HISTO_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTO_CHANNELS);
    let applied = 0;

    for (const c of list) {
      if (!c?.channelId) continue;
      const prev = await reqToPromise(store.get(c.channelId));

      await reqToPromise(store.put(prev ? {
        ...prev,
        ...c,
        // The Shorts lists are unions: each side may have seen a page the other
        // did not, and a Short forgotten here is an hour credited wrongly there.
        shorts: [...new Set([...(prev.shorts ?? []), ...(c.shorts ?? [])])],
        uploads: (prev.uploads?.length ?? 0) >= (c.uploads?.length ?? 0)
          ? prev.uploads : (c.uploads ?? []),
        meanSec: prev.meanSec || c.meanSec || 0,
        shortsTruncated: Boolean(prev.shortsTruncated && c.shortsTruncated),
      } : c));
      applied++;
    }

    return { applied };
  });
}

/**
 * Restores a backup, in slices, saying where it stands.
 *
 * The whole thing in a single transaction gave one instantaneous “done” and no
 * way to tell a restore that had worked from one that had not. Slices cost
 * nothing — a few transactions rather than one — and give a bar that measures
 * something real: records written over records to write.
 *
 * @param {object} payload
 * @param {object} [options]
 * @param {(p: {step: string, done: number, total: number}) => void} [options.onProgress]
 * @param {number} [options.sliceSize]
 */
export async function importUserData(payload, { onProgress = null, sliceSize = 400 } = {}) {
  const norm = normalizeBackup(payload);
  const total = backupSize(norm);
  const pending = { ...(await metaGet(META_PENDING_RESTORE, {})) };

  const result = {
    version: norm.version,
    channels: 0,
    videos: 0,
    created: 0,
    history: 0,
    historyKept: 0,
    durations: 0,
    histoChannels: 0,
    deferred: 0,
    sessions: 0,
    total,
  };

  let done = 0;
  const tell = (step) => onProgress?.({ step, done, total });
  tell('start');

  /** Walks one list in slices, reporting between each. */
  const run = async (step, list, apply) => {
    for (let i = 0; i < list.length; i += sliceSize) {
      const slice = list.slice(i, i + sliceSize);
      await apply(slice);
      done += slice.length;
      tell(step);
    }
  };

  await run('channels', norm.channels, async (slice) => {
    result.channels += (await restoreChannels(slice)).applied;
  });

  await run('videos', norm.videos, async (slice) => {
    const r = await restoreVideos(slice, pending);
    result.videos += r.applied;
    result.created += r.created;
    result.deferred += r.deferred;
  });

  // Version 1 states: no record to insert, only flags to reapply, and what
  // finds no video waits for one.
  await run('videos', norm.videoStates, async (slice) => {
    const r = await restoreVideos(slice, pending);
    result.videos += r.applied;
    result.deferred += r.deferred;
  });

  await run('history', norm.history, async (slice) => {
    const r = await restoreHistory(slice);
    result.history += r.applied;
    result.historyKept += r.kept;
    // Counted apart because it is the irreplaceable half: a Takeout row can be
    // asked of Google again, a measured session cannot.
    result.sessions += r.sessions;
  });

  await run('durations', norm.durations, async (slice) => {
    result.durations += (await restoreDurations(slice)).applied;
  });

  await run('histo', norm.histoChannels, async (slice) => {
    result.histoChannels += (await restoreHistoChannels(slice)).applied;
  });

  await metaSet(META_PENDING_RESTORE, pending);
  result.pending = Object.keys(pending).length;

  done = total;
  tell('done');
  return result;
}

function applyUserState(video, state) {
  for (const f of USER_STATE_FIELDS) {
    if (state[f] === undefined) continue;
    // Playback progress goes up and never comes back down, here as everywhere:
    // a restore must not rewind a video watched since the export.
    if (f === 'watchProgress') {
      video[f] = Math.max(video[f] ?? 0, Number(state[f]) || 0);
      continue;
    }
    video[f] = state[f];
  }
}

// ---------------------------------------------------------------------------
// Imported history
// ---------------------------------------------------------------------------

/**
 * Records history entries, without duplicates.
 *
 * The same Takeout file can be imported twice — typically after a fresh export —
 * and the periods then overlap heavily. The `video|timestamp` key means
 * reimporting inflates nothing, while keeping repeated viewings of the same
 * video, which are distinct events.
 *
 * @param {Array<{videoId: string, watchedAt: number, title: string,
 *   channelId: string | null, channelTitle: string}>} entries
 * @param {object} [options]
 * @param {number} [options.measuredSince] timestamp of the first session
 *   measured by the extension; below it, no row can be a duplicate
 * @returns {Promise<{inserted: number, duplicates: number, superseded: number}>}
 */
export async function putHistory(entries, { measuredSince = 0 } = {}) {
  return withTx(STORE_HISTORY, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTORY);
    const byVideo = store.index('by_video');
    /** Verdict per video, so the index is not queried again on every row. */
    const measuredCache = new Map();
    let inserted = 0;
    let duplicates = 0;
    let superseded = 0;

    for (const e of entries) {
      const key = `${e.videoId}|${e.watchedAt}`;
      if (await reqToPromise(store.get(key))) { duplicates++; continue; }

      // The rule is the video's, not the timestamp's: if the extension has
      // already measured this video, its version is better than the export's and
      // the imported row brings nothing. What is left to import are the videos
      // the extension never saw go by — watched before it was installed, on a
      // phone, on a television. They are a minority, and that is what makes the
      // rule workable.
      //
      // One exception, and it is not a relaxation but a fact: a row older than
      // the very first measured session cannot be the duplicate of a measurement
      // that did not exist yet. Without it, rewatching a video from last year
      // today would erase last year's viewing on import.
      if (e.watchedAt >= measuredSince && await alreadyMeasured(byVideo, e.videoId, measuredCache)) {
        superseded++;
        continue;
      }

      // The export knows the hour, the scraped row only knew the day: keeping
      // both would count the viewing twice on that day.
      await dropScrapedTwins(store, byVideo, e.videoId, e.watchedAt);

      await reqToPromise(store.put({ key, source: 'takeout', ...e }));
      inserted++;
    }

    return { inserted, duplicates, superseded };
  });
}


/** Do two timestamps fall on the same day, as the user's clock counts days? */
function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

/**
 * Removes the rows scraped off YouTube's history page that a precise row now
 * covers.
 *
 * A scraped row says "this video, that day" and nothing more. The moment a
 * Takeout export or a measurement gives that same viewing to the second, the
 * scraped one stops being information and becomes a double count: the day
 * would hold two viewings where there was one.
 *
 * @returns {Promise<number>} how many were dropped
 */
async function dropScrapedTwins(store, byVideo, videoId, watchedAt) {
  const known = await reqToPromise(byVideo.getAll(IDBKeyRange.only(videoId)));
  let dropped = 0;
  for (const row of known) {
    if (row.source !== 'yt' || !sameLocalDay(row.watchedAt, watchedAt)) continue;
    await reqToPromise(store.delete(row.key));
    dropped++;
  }
  return dropped;
}

/**
 * Records viewings read off YouTube's own history page.
 *
 * This source is deliberately the third one, and everything about it says so.
 * Takeout gives the second of every viewing; the history page gives a heading —
 * "Yesterday", "Aug 21", "Jan 26, 2025" — and nothing finer. So every row lands
 * at local noon, the same video opened twice in one day collapses into one, and
 * the hour of the day cannot be counted from it.
 *
 * What it gives in exchange is reach, and the measurement is not close.
 * On one real account, on 28 August 2026: the Takeout export held 12 764
 * viewings and started on 23 May 2024, while the history page paged back to
 * 24 March 2020 and yielded 44 349 — three and a half times as many, four years
 * earlier, in 255 requests and about four minutes.
 *
 * The precedence is what keeps the imprecision from spreading: a measured row
 * and a Takeout row both win. A scraped row is only written when nothing at all
 * is already known about that video on that day — and it is deleted as soon as
 * something precise turns up, see `dropScrapedTwins`.
 *
 * @param {Array<{videoId: string, watchedAt: number, title: string,
 *   channelId: string | null, channelTitle: string}>} entries
 * @returns {Promise<{inserted: number, covered: number}>}
 */
export async function putScrapedHistory(entries) {
  return withTx(STORE_HISTORY, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTORY);
    const byVideo = store.index('by_video');
    /** Days already held per video, so the index is read once per video. */
    const daysByVideo = new Map();
    let inserted = 0;
    let covered = 0;

    for (const e of entries) {
      if (!e.videoId || !Number.isFinite(e.watchedAt)) { covered++; continue; }

      let days = daysByVideo.get(e.videoId);
      if (!days) {
        const known = await reqToPromise(byVideo.getAll(IDBKeyRange.only(e.videoId)));
        days = known.map((row) => row.watchedAt);
        daysByVideo.set(e.videoId, days);
      }
      if (days.some((at) => sameLocalDay(at, e.watchedAt))) { covered++; continue; }

      await reqToPromise(store.put({
        key: `${e.videoId}|${e.watchedAt}`,
        source: 'yt',
        videoId: e.videoId,
        watchedAt: e.watchedAt,
        title: e.title ?? '',
        channelId: e.channelId ?? null,
        channelTitle: e.channelTitle ?? '',
        nonResolue: !(e.channelId && e.title),
      }));
      days.push(e.watchedAt);
      inserted++;
    }

    return { inserted, covered };
  });
}

/** Has the extension already measured a session on this video? */
async function alreadyMeasured(byVideo, videoId, cache) {
  if (cache.has(videoId)) return cache.get(videoId);
  const known = await reqToPromise(byVideo.getAll(IDBKeyRange.only(videoId)));
  const verdict = known.some((p) => p.source === 'live');
  cache.set(videoId, verdict);
  return verdict;
}

/**
 * Records, or updates, a watch session measured on the spot.
 *
 * A session is written several times: at regular intervals during playback, then
 * one last time on leaving the page. That is why it overwrites instead of
 * appending — otherwise an hour-long video would leave two hundred history rows
 * instead of one. The key is fixed when the video opens, so reopening the same
 * video later does create a distinct session, as Takeout would.
 *
 * The video's exact duration goes into the durations store along the way: it is
 * read off the player itself, so it is more reliable than anything enrichment
 * will be able to guess, and it saves a network request later on.
 *
 * @param {{videoId: string, watchedAt: number, title: string,
 *   channelId: string | null, channelTitle: string, durationSec: number | null,
 *   watchedSec: number, completed: boolean}} session
 * @returns {Promise<{created: boolean, resolved: boolean}>}
 */
export async function putWatchSession(session) {
  const { videoId, watchedAt, durationSec } = session;
  if (!videoId || !Number.isFinite(watchedAt)) throw new Error('Séance incomplète');

  return withTx([STORE_HISTORY, STORE_DURATIONS, STORE_VIDEOS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTORY);
    const key = `${videoId}|${watchedAt}`;
    const known = await reqToPromise(store.get(key));
    // Measuring a video already scraped for today replaces the scraped row
    // rather than sitting next to it.
    if (!known) {
      await dropScrapedTwins(store, store.index('by_video'), videoId, watchedAt);
    }
    const video = await reqToPromise(tx.objectStore(STORE_VIDEOS).get(videoId));

    const named = nameSession(session, known, video);

    await reqToPromise(store.put({
      key,
      source: 'live',
      ...session,
      ...named,
      // Time watched can only grow: a late report sent from a background tab
      // could arrive after a more complete one.
      watchedSec: Math.max(session.watchedSec ?? 0, known?.watchedSec ?? 0),
      completed: Boolean(session.completed || known?.completed),
    }));

    if (durationSec > 0) {
      await reqToPromise(tx.objectStore(STORE_DURATIONS)
        .put({ videoId, sec: Math.round(durationSec) }));
    }

    // A session that has just been attached to its channel changes the rankings
    // as much as a brand new one: it now enters them, when it was excluded.
    return { created: !known, resolved: Boolean(known?.nonResolue) && !named.nonResolue };
  });
}

/**
 * Decides a session's title and channel, and whether it stays unusable.
 *
 * Three sources, in this order: what the player has just said, what the database
 * already knows about the video, and what had been written for this session. The
 * second is the one that matters: a watched video is almost always a video that
 * came from a subscription feed, so already present with its channel. Doing
 * without it meant throwing away a perfectly identifiable session for the sole
 * reason that the page took a second too long to answer.
 *
 * Without a channel *or* a title, the session is marked unresolved rather than
 * filed under a generic name: the analysis then keeps it out of its rankings
 * instead of pushing a phantom "unknown channel" to the top.
 */
function nameSession(session, known, video) {
  const title = session.title || video?.title || known?.title || '';
  const channelId = session.channelId || video?.channelId || known?.channelId || null;
  const channelTitle = session.channelTitle || video?.channelTitle || known?.channelTitle || '';
  return { title, channelId, channelTitle, nonResolue: !(channelId && title) };
}

/**
 * Attaches, after the fact, the sessions left without a channel.
 *
 * They exist: the tracker long depended on a page value that, after an internal
 * navigation, still described the previous video. Sessions written under those
 * conditions count as deleted videos and appear in no ranking, even though the
 * database knows most of those videos. One pass is enough to recover them.
 *
 * @returns {Promise<{examined: number, resolved: number}>}
 */
export async function resolveOrphanSessions() {
  return withTx([STORE_HISTORY, STORE_VIDEOS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTORY);
    const videos = tx.objectStore(STORE_VIDEOS);

    // Spotting first, rewriting after: a cursor does not pause while one goes
    // and reads another store.
    const toFix = [];
    await iterate(store.index('by_time').openCursor(), (cursor) => {
      const v = cursor.value;
      if (v?.source === 'live' && v.nonResolue) toFix.push(v);
      return true;
    });

    let resolved = 0;
    for (const session of toFix) {
      const video = await reqToPromise(videos.get(session.videoId));
      const named = nameSession(session, null, video);
      if (named.nonResolue) continue;
      await reqToPromise(store.put({ ...session, ...named }));
      resolved++;
    }

    return { examined: toFix.length, resolved };
  });
}

/**
 * The whole history, in a single shape.
 *
 * Two sources feed it and they do not know the same things: a Takeout row knows
 * neither the video's duration nor the time spent on it, a measured session
 * knows both. Returning them as they are would produce a file whose records do
 * not have the same keys depending on where they came from, and where one could
 * not tell "field missing" from "value unknown".
 *
 * Here every row carries the same fields, in the same order, and the unknown is
 * written `null`. The `source` field says where the row comes from, which is the
 * only information that would otherwise be lost.
 *
 * @param {Map<string, number>} [durations]  known durations, to complete the
 *   rows that do not carry one
 */
export async function exportHistory(durations = new Map()) {
  const all = await getAllHistory();

  return all.map((e) => {
    const duration = Number.isFinite(e.durationSec) && e.durationSec > 0
      ? e.durationSec
      : (durations.get(e.videoId) ?? null);
    const watched = Number.isFinite(e.watchedSec) && e.watchedSec > 0 ? e.watchedSec : null;

    return {
      videoId: e.videoId,
      title: e.title || null,
      channelId: e.channelId ?? null,
      channelTitle: e.channelTitle || null,
      watchedAt: e.watchedAt,
      // The readable date on top of the timestamp: a file opened by hand should
      // not require converting milliseconds.
      watchedAtIso: new Date(e.watchedAt).toISOString(),
      durationSec: duration,
      watchedSec: watched,
      // Share of the video watched, when both terms are known. Computed here
      // rather than left to whoever uses the file, so that saturation at one
      // hundred percent is applied once and for all.
      watchedRatio: duration && watched ? Math.min(1, Number((watched / duration).toFixed(4))) : null,
      completed: typeof e.completed === 'boolean' ? e.completed : null,
      resolved: !e.nonResolue,
      source: e.source ?? 'takeout',
    };
  }).sort((a, b) => a.watchedAt - b.watchedAt);
}

/**
 * How many sessions the extension has measured, and since when.
 *
 * Counted on demand rather than held in a counter: a counter would have drifted
 * at the first path that writes without going through it — a backup restore, for
 * instance.
 *
 * `getAll()` and not a cursor, for the reason `getAllHistory` gives just below:
 * a cursor makes one round trip through the event loop per record. This one
 * walked the whole `by_time` index, and once the YouTube history page had
 * brought the store to some fifty seven thousand rows the popup's History tab
 * took close to five seconds to show its two figures. The same measurement had
 * already been made on the channel reports; the lesson had simply not been
 * applied here.
 */
export async function getWatchSessionStats() {
  return withTx(STORE_HISTORY, 'readonly', async (tx) => {
    const all = await reqToPromise(tx.objectStore(STORE_HISTORY).index('by_time').getAll());
    let count = 0;
    let since = 0;
    let seconds = 0;
    for (const v of all) {
      if (v?.source !== 'live') continue;
      count++;
      seconds += v.watchedSec ?? 0;
      // The index reads by increasing date: the first one found is the oldest.
      if (!since) since = v.watchedAt;
    }
    return { count, since, seconds };
  });
}

/** Bounds and volume of the known history, to display it without loading it all. */
export async function getHistorySummary() {
  return withTx(STORE_HISTORY, 'readonly', async (tx) => {
    const index = tx.objectStore(STORE_HISTORY).index('by_time');
    const count = await reqToPromise(tx.objectStore(STORE_HISTORY).count());
    if (!count) return { count: 0, from: null, to: null };

    const oldest = await reqToPromise(index.openCursor(null, 'next'));
    const newest = await reqToPromise(index.openCursor(null, 'prev'));
    return {
      count,
      from: oldest?.value?.watchedAt ?? null,
      to: newest?.value?.watchedAt ?? null,
    };
  });
}

/**
 * The whole history, oldest to most recent.
 *
 * `getAll()` and not a cursor: a cursor makes one round trip through the event
 * loop per record, that is fifteen thousand for a real history. That is what
 * made every channel report open interminably — the read cost several seconds
 * before the first computation had even started.
 */
export async function getAllHistory() {
  return withTx(STORE_HISTORY, 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_HISTORY).index('by_time').getAll()));
}

/**
 * Every known duration, whatever its origin.
 *
 * Two full sweeps rather than targeted reads: the analysis covers tens of
 * thousands of videos, and that many `get` calls would cost far more than
 * walking two stores that fit in memory.
 */
export async function getAllDurations() {
  return (await getHistoryVideoFacts()).durations;
}

/**
 * Everything the analysis needs from the two video stores, in one pass.
 *
 * Three facts come out of the same walk because the feed index is the expensive
 * one to read — tens of thousands of records — and reading it three times to
 * answer three questions would triple a cost the analysis page already feels.
 *
 * - `durations`: every known duration, the `durations` store first, completed by
 *   the feed's own records.
 * - `published`: the publication date of the videos the feed has collected. Only
 *   those: the `durations` store carries no date, so a video watched in 2021 and
 *   never seen go by has none here. Whatever is computed from this map must say
 *   on screen how many rows it rests on.
 * - `uploads`: one `{channelId, publishedAt}` per collected video, which is what
 *   a publication rhythm is read from.
 */
export async function getHistoryVideoFacts() {
  const durations = new Map();

  const rows = await withTx(STORE_DURATIONS, 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_DURATIONS).getAll()));
  for (const d of rows) if (d.sec > 0) durations.set(d.videoId, d.sec);

  const videos = await withTx(STORE_VIDEOS, 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_VIDEOS).getAll()));

  const published = new Map();
  const uploads = [];
  for (const v of videos) {
    // The feed's videos already carry their duration: might as well use it
    // rather than ask YouTube for it again.
    if (v.durationSec > 0 && !durations.has(v.id)) durations.set(v.id, v.durationSec);
    if (v.publishedAt > 0) {
      published.set(v.id, v.publishedAt);
      uploads.push({ channelId: v.channelId, publishedAt: v.publishedAt });
    }
  }

  return { durations, published, uploads };
}

/** Records durations fetched for the history. */
export async function putDurations(entries) {
  return withTx(STORE_DURATIONS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_DURATIONS);
    let written = 0;
    for (const { videoId, sec } of entries) {
      if (!videoId || !(sec > 0)) continue;
      await reqToPromise(store.put({ videoId, sec: Math.round(sec) }));
      written++;
    }
    return written;
  });
}

/**
 * Verdicts kept in the `durations` store alongside the real durations.
 *
 * A positive value is a duration in seconds. The two negatives say "asked, and
 * settled", which is what stops the settling pass from asking again for ever:
 * `-1` for a video YouTube can no longer describe — deleted, private,
 * restricted — and `-2` for a Short. `getAllDurations` only keeps positives, so
 * neither leaks into a computation.
 */
const DURATION_UNKNOWN = -1;
const DURATION_SHORT = -2;

/**
 * History videos whose nature is still unknown, in slices.
 *
 * "Unknown" means: no duration anywhere, and no verdict yet. Those are exactly
 * the videos the analysis was crediting with their channel's mean duration —
 * which is right for an old long form video and absurd for a Short, and nothing
 * in the history tells the two apart. The settling pass resolves them one by
 * one against the only authority there is, the player record.
 *
 * The walk follows the `by_video` index in unique mode: one stop per distinct
 * video rather than per viewing, and an order that can be resumed exactly after
 * the service worker has been killed.
 *
 * @param {string|null} afterId  last video identifier already examined
 * @param {number} max           identifiers returned at most
 * @param {number} maxExamined   distinct videos walked at most
 * @returns {Promise<{items: Array<{id: string, channelId: string|null}>,
 *   lastId: string|null, done: boolean}>}
 */
export async function listHistoryUnsettled(afterId = null, max = 25, maxExamined = 2000) {
  return withTx([STORE_HISTORY, STORE_DURATIONS, STORE_VIDEOS], 'readonly', async (tx) => {
    const range = afterId ? IDBKeyRange.lowerBound(afterId, true) : null;
    const seen = [];
    let lastId = afterId;
    let examined = 0;

    // The cursor callback is synchronous: it can only gather. The lookups that
    // decide what is unsettled happen just below, in the same transaction.
    await iterate(
      tx.objectStore(STORE_HISTORY).index('by_video').openCursor(range, 'nextunique'),
      (cursor) => {
        const e = cursor.value;
        lastId = cursor.key;
        examined++;
        if (!e.nonResolue && e.videoId) seen.push({ id: e.videoId, channelId: e.channelId ?? null });
        return seen.length < max * 4 && examined < maxExamined;
      },
    );

    const durations = tx.objectStore(STORE_DURATIONS);
    const videos = tx.objectStore(STORE_VIDEOS);
    const items = [];
    for (const row of seen) {
      if (items.length >= max) break;
      if (await reqToPromise(durations.get(row.id))) continue;
      const v = await reqToPromise(videos.get(row.id));
      if (v && v.durationSec > 0) continue;
      items.push(row);
    }

    return { items, lastId, done: examined < maxExamined && seen.length < max * 4 };
  });
}

/**
 * Records the settling verdicts.
 *
 * A recognised Short goes onto its channel's Shorts list as well as into the
 * `durations` store: the list is what the analysis reads to rule it out of
 * every total, the store is what stops it being asked about again.
 *
 * @param {{durations?: Array<{videoId: string, sec: number}>,
 *   shorts?: Array<{videoId: string, channelId: string|null}>,
 *   unknown?: string[]}} verdicts
 */
export async function settleHistoryVideos({ durations = [], shorts = [], unknown = [] } = {}) {
  return withTx([STORE_DURATIONS, STORE_HISTO_CHANNELS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_DURATIONS);

    for (const { videoId, sec } of durations) {
      if (videoId && sec > 0) await reqToPromise(store.put({ videoId, sec: Math.round(sec) }));
    }
    for (const id of unknown) {
      if (id) await reqToPromise(store.put({ videoId: id, sec: DURATION_UNKNOWN }));
    }

    const channels = tx.objectStore(STORE_HISTO_CHANNELS);
    const byChannel = new Map();
    for (const { videoId, channelId } of shorts) {
      if (!videoId) continue;
      await reqToPromise(store.put({ videoId, sec: DURATION_SHORT }));
      if (!channelId) continue;
      const list = byChannel.get(channelId) ?? [];
      list.push(videoId);
      byChannel.set(channelId, list);
    }

    for (const [channelId, ids] of byChannel) {
      const known = await reqToPromise(channels.get(channelId));
      // A channel absent from the store is created with the Shorts alone: the
      // history cites channels one is not subscribed to and which enrichment
      // may never have reached, and their Shorts have to be excluded too.
      const merged = new Set([...(known?.shorts ?? []), ...ids]);
      await reqToPromise(channels.put({
        channelId,
        meanSec: known?.meanSec ?? 0,
        sampled: known?.sampled ?? 0,
        uploads: known?.uploads ?? [],
        shorts: [...merged],
        sansShorts: known?.sansShorts ?? false,
        shortsTruncated: known?.shortsTruncated ?? false,
        echec: known?.echec ?? false,
        echecs: known?.echecs ?? 0,
        avatarUrl: known?.avatarUrl ?? null,
        fetchedAt: known?.fetchedAt ?? 0,
      }));
    }

    return { shorts: shorts.length, durations: durations.length, unknown: unknown.length };
  });
}

/**
 * What we know about a channel cited by the history: mean duration and latest
 * uploads. `uploads` is ordered from most recent to oldest.
 *
 * The `echec` and `sansShorts` field names stay as they were first written: they
 * are stored on disk, and renaming one would silently reset what every existing
 * profile knows about its channels.
 */
export async function putHistoChannel({
  channelId, meanSec, sampled, uploads, shorts, shortsTruncated = false,
  avatarUrl, echec = false,
}) {
  return withTx(STORE_HISTO_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTO_CHANNELS);
    const known = await reqToPromise(store.get(channelId));
    await reqToPromise(store.put({
      channelId,
      meanSec: Math.round(meanSec) || 0,
      sampled: sampled || 0,
      uploads: Array.isArray(uploads) ? uploads : [],
      // The channel's Shorts, kept so they can be ruled out everywhere: neither
      // in the uploads that feed the streaks, nor in the viewings counted. An
      // empty list from a failed enrichment must not erase the one we had, hence
      // the fallback to the known value.
      shorts: Array.isArray(shorts) && shorts.length ? shorts : (known?.shorts ?? []),
      // Marks that this record comes from a Shorts-free enrichment. Earlier
      // records mixed Shorts and long form into `uploads`, which broke the
      // streaks; the flag makes it possible to spot and redo them, whereas an
      // empty list of Shorts is perfectly legitimate.
      sansShorts: true,
      // The Shorts list stops at a ceiling: we know some are missing, so this
      // channel's videos of unknown duration must not be credited with its
      // mean. Kept on the record so the reason is readable from the console.
      shortsTruncated: Boolean(shortsTruncated),
      // A failed channel is marked rather than left out: that is what lets the
      // queue move on without retrying it in a loop, and lets it be picked up
      // later in case the failure was only temporary.
      echec,
      // An already known avatar survives an enrichment that brings none back: a
      // channel gone quiet must not lose its picture.
      avatarUrl: avatarUrl ?? known?.avatarUrl ?? null,
      fetchedAt: Date.now(),
    }));
    return true;
  });
}

/**
 * Marks a channel as failed, without destroying anything.
 *
 * This is the fix for a costly defect: the failure used to be recorded through
 * `putHistoChannel` with a mean of zero and an empty upload list, which
 * **overwrote** what we already knew about the channel. A perfectly enriched
 * channel whose avatar we then missed lost its mean duration, and all its videos
 * fell back into "duration unknown" — hence a progress bar that went backwards
 * instead of forwards.
 */
export async function putHistoFailure(channelId) {
  if (!channelId) return false;
  return withTx(STORE_HISTO_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTO_CHANNELS);
    const known = await reqToPromise(store.get(channelId));
    await reqToPromise(store.put({
      channelId,
      meanSec: known?.meanSec ?? 0,
      sampled: known?.sampled ?? 0,
      uploads: known?.uploads ?? [],
      shorts: known?.shorts ?? [],
      sansShorts: known?.sansShorts ?? false,
      avatarUrl: known?.avatarUrl ?? null,
      echec: true,
      // Attempts, not just "it failed". A channel that is gone fails at every
      // pass, and with no count it came back into the queue every hour for
      // ever: the fetch had no end, and the interface said so.
      echecs: (known?.echecs ?? 0) + 1,
      fetchedAt: Date.now(),
    }));
    return true;
  });
}

/**
 * Sets the avatar only, without touching the durations.
 *
 * A channel already enriched before avatars existed does not need its two
 * hundred videos re-read to get a picture: that is one request instead of three.
 */
export async function putHistoAvatar(channelId, avatarUrl) {
  if (!channelId || !avatarUrl) return false;
  return withTx(STORE_HISTO_CHANNELS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTO_CHANNELS);
    const known = await reqToPromise(store.get(channelId));
    await reqToPromise(store.put({
      channelId,
      meanSec: known?.meanSec ?? 0,
      sampled: known?.sampled ?? 0,
      uploads: known?.uploads ?? [],
      shorts: known?.shorts ?? [],
      sansShorts: known?.sansShorts ?? false,
      echec: known?.echec ?? false,
      avatarUrl,
      fetchedAt: known?.fetchedAt ?? Date.now(),
    }));
    return true;
  });
}

/** Every enriched channel, indexed by identifier. */
export async function getHistoChannels() {
  const rows = await withTx(STORE_HISTO_CHANNELS, 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_HISTO_CHANNELS).getAll()));
  return new Map(rows.map((c) => [c.channelId, c]));
}

/** Erases the whole imported history. */
export async function clearHistory() {
  return withTx(STORE_HISTORY, 'readwrite', async (tx) => {
    await reqToPromise(tx.objectStore(STORE_HISTORY).clear());
    return true;
  });
}
