/**
 * Content script (isolated world): bridge to the MAIN world, harvest of the
 * native feed, subscription import.
 *
 * Everything arriving from the MAIN world is treated as untrusted: the page
 * could forge these messages. We therefore validate the shape of every record
 * before passing it on to the service worker.
 */

import { MSG, send } from '../lib/messages.js';
import { log } from '../lib/log.js';
import { t, initLocale, LANG_KEY } from '../lib/i18n.js';
import {
  mountFeedView, unmountFeedView, applyDurations, applyAvatars,
} from './feed-view.js';
import { installWatchTracking, nudgeWatchTracking } from './watch-tracker.js';
import { mountTriage, unmountTriage } from './triage.js';
import { mountBulk, BULK_FLAG } from './batch.js';
import { accountKey } from '../lib/account.js';
import { factsFromVideosTab } from '../lib/innertube-parse.js';
import {
  setAccountKey, activeAccountKey, setForeignAccount, isForeignAccount,
} from './active-account.js';

const CHANNEL_FROM_MAIN = 'tracktube-main';
const CHANNEL_TO_MAIN = 'tracktube-iso';

const RE_VIDEO_ID = /^[\w-]{11}$/;
const RE_CHANNEL_ID = /^UC[\w-]{22}$/;

/**
 * Validates an image URL coming from YouTube.
 *
 * Thumbnail and avatar URLs are frequently **protocol relative**
 * (`//yt3.ggpht.com/…`). Requiring `https://` rejected them all silently, which
 * left avatars blank. We complete them instead of throwing them away.
 *
 * @param {unknown} value
 * @returns {string} the https URL, or '' if unusable
 */
function safeImageUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  const url = value.startsWith('//') ? `https:${value}` : value;
  return url.startsWith('https://') ? url : '';
}

/** Last facts passed on for each video during this navigation. */
const sentVideoIds = new Map();

let requestCounter = 0;
const pending = new Map();

// ---------------------------------------------------------------------------
// Bridge with the MAIN world
// ---------------------------------------------------------------------------

/**
 * Asks the MAIN world a question.
 *
 * `extra` is merged into the message: some requests need a parameter — saying
 * which video we believe is playing, so the page can refuse to answer if it is
 * already showing another one.
 */
export function askMainWorld(type, extra = {}, timeoutMs = 4000) {
  const requestId = `r${++requestCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);

    pending.set(requestId, (payload) => {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(payload);
    });

    window.postMessage(
      { source: CHANNEL_TO_MAIN, ...extra, type, requestId }, window.location.origin);
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== CHANNEL_FROM_MAIN) return;

  const resolver = msg.payload?.requestId ? pending.get(msg.payload.requestId) : null;
  if (resolver) { resolver(msg.payload); return; }

  if (msg.type === 'ready') onNavigate(msg.payload?.path ?? location.pathname);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates a harvested record.
 *
 * The `channelId` is **optional**, and that is the important point: the audit
 * only needs the video id, since all it does is mark videos already known from
 * the RSS feeds. Requiring it — when it depends on YouTube's internal Polymer
 * structure — was enough to make the whole harvest fail silently as soon as
 * Google changed its components.
 *
 * Without a `channelId`, the record cannot create a video in the database; it
 * can only mark an existing one. That is exactly what is wanted.
 */
function sanitizeVideo(v) {
  if (!v || !RE_VIDEO_ID.test(v.id ?? '')) return null;

  const record = {
    id: v.id,
    durationSec: Number.isFinite(v.durationSec) ? v.durationSec : null,
    watchProgress: Number.isFinite(v.watchProgress) ? v.watchProgress : null,
  };

  if (!RE_CHANNEL_ID.test(v.channelId ?? '')) return record;

  const scheduledAt = Number.isFinite(v.scheduledAt) ? v.scheduledAt : null;
  // A scheduled broadcast carries its start date: that is what places it at the
  // right rank the day it goes live.
  const publishedAt = scheduledAt ?? (Number.isFinite(v.publishedAt) ? v.publishedAt : null);

  return {
    ...record,
    isLive: v.isLive === true,
    isUpcoming: v.isUpcoming === true,
    channelId: v.channelId,
    channelTitle: String(v.channelTitle ?? '').slice(0, 200),
    title: String(v.title ?? '').slice(0, 500),
    // If the relative date could not be read, we invent nothing: the service
    // worker will keep the Atom feed's, which is exact.
    ...(publishedAt ? { publishedAt } : {}),
    thumbUrl: safeImageUrl(v.thumbUrl),
    // The native feed also carries the channel avatar. That is a precious catch
    // up source: the initial import does not always get one.
    channelAvatar: safeImageUrl(v.channelAvatar),
  };
}

function sanitizeChannel(c) {
  if (!c || !RE_CHANNEL_ID.test(c.id ?? '')) return null;
  const subscribers = Number(c.subscriberCount);
  return {
    id: c.id,
    title: String(c.title ?? '').slice(0, 200),
    avatarUrl: safeImageUrl(c.avatarUrl),
    // The subscription list already carries both of these: gathering them here
    // costs no extra request.
    subscriberCount: Number.isFinite(subscribers) && subscribers >= 0 ? subscribers : null,
    handle: /^@[\w.-]{1,40}$/.test(c.handle ?? '') ? c.handle : null,
  };
}

// ---------------------------------------------------------------------------
// Harvesting the native feed
// ---------------------------------------------------------------------------

/**
 * Records what YouTube actually displays.
 *
 * Dual purpose, as planned in the architecture: it is both an enrichment source
 * (the durations, which RSS does not give) and the audit's measuring
 * instrument (knowing what YouTube shows is the only way to quantify what it
 * leaves out).
 */
async function harvestNativeFeed() {
  const payload = await askMainWorld('harvest-feed');

  if (!payload) {
    log.warn('Harvest: no answer from the MAIN world (script not injected?)');
    return;
  }

  const fresh = [];
  for (const raw of payload.videos ?? []) {
    const v = sanitizeVideo(raw);
    if (!v) continue;
    // YouTube sometimes attaches its renderer data after the stable watch link
    // has already appeared. Send the row again when it gains a date, title or
    // channel instead of freezing an undated observation for the whole visit.
    const signature = JSON.stringify([
      v.channelId ?? '', v.channelTitle ?? '', v.title ?? '', v.publishedAt ?? 0,
      v.durationSec ?? null, v.watchProgress ?? null, v.isLive ?? false, v.isUpcoming ?? false,
    ]);
    if (sentVideoIds.get(v.id) === signature) continue;
    sentVideoIds.set(v.id, signature);
    fresh.push(v);
  }

  // The diagnostics go up even when there is nothing to send: that is the only
  // way to tell "the page is empty" from "the extraction is broken".
  const diagnostic = {
    linksFound: payload.domCount ?? 0,
    enrichedByPolymer: payload.enriched ?? 0,
    newThisRound: fresh.length,
    alreadySent: sentVideoIds.size,
  };
  log.info('Native feed harvest', diagnostic);

  if (!fresh.length) {
    await send(MSG.NATIVE_HARVEST, { videos: [], diagnostic, key: activeAccountKey() });
    return;
  }

  const res = await send(MSG.NATIVE_HARVEST, { videos: fresh, diagnostic, key: activeAccountKey() });
  log.debug(`Harvest: ${fresh.length} videos passed on`, res);
}

/** Triggers the harvest again when the user scrolls. */
function watchScroll() {
  let timer = null;
  const onScroll = () => {
    clearTimeout(timer);
    timer = setTimeout(harvestNativeFeed, 1200);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return () => { window.removeEventListener('scroll', onScroll); clearTimeout(timer); };
}

// ---------------------------------------------------------------------------
// Detecting subscriptions made while browsing
// ---------------------------------------------------------------------------

/** Last state read for each channel during this navigation. */
const reportedSubscriptions = new Map();

/** Sources on which a "not subscribed" can be taken at face value. */
const TRUSTED_NEGATIVE_SOURCES = new Set(['data']);

/** How often the subscription state is re-read on a page that carries one. */
const SUBSCRIPTION_POLL_MS = 2000;

/** One trace per channel and per navigation, to keep the console readable. */
const loggedReads = new Set();

/** Where the report of the last notification is dropped, for diagnostics. */
const LAST_REPORT_KEY = 'ytfeed:lastReport';

/**
 * Reads the subscription state of the displayed channel and reports it if it
 * changed.
 *
 * This is what makes it pointless to run an import again after every new
 * subscription: subscribing from a video page or a channel page necessarily
 * goes through here.
 *
 * We observe the state in a loop instead of reacting to a click on the button.
 * Two reasons, both observed: unsubscribing goes through a confirmation dialog
 * whose button is *outside* the subscription component, so a listener placed on
 * it never saw an unsubscription leave; and YouTube offers several paths to the
 * same action, all of which would have to be enumerated. Re-reading three
 * selectors every two seconds costs less than chasing after them.
 */
async function checkSubscription() {
  const payload = await askMainWorld('read-subscription');
  if (!payload?.channelId || !RE_CHANNEL_ID.test(payload.channelId)) return;

  const { channelId, subscribed, source } = payload;

  if (!loggedReads.has(channelId)) {
    loggedReads.add(channelId);
    log.info(`Subscription state of ${channelId}: ${subscribed} (source: ${source ?? 'none'})`);
  }

  // Inconclusive reading: we report nothing rather than guess.
  if (typeof subscribed !== 'boolean') return;

  const previous = reportedSubscriptions.get(channelId);
  if (previous === subscribed) return;
  reportedSubscriptions.set(channelId, subscribed);

  // An unsubscription is never concluded from a single reading: the channel
  // must have been seen subscribed on this very page, then seen ceasing to be.
  // In other words, the gesture must have been observed. Without this rule, a
  // not yet hydrated button — which reads as "not subscribed" — would be enough
  // to take a channel out of the feed and erase its videos.
  if (!subscribed) {
    if (previous !== true) return;
    if (!TRUSTED_NEGATIVE_SOURCES.has(source)) {
      // Less reliable source: we confirm with a second reading before acting.
      await new Promise((r) => setTimeout(r, 1500));
      const again = await askMainWorld('read-subscription');
      if (again?.channelId !== channelId || again?.subscribed !== false) {
        reportedSubscriptions.set(channelId, again?.subscribed ?? true);
        return;
      }
    }
  }

  log.info(`Subscription change on ${channelId}: ${previous} → ${subscribed} (source: ${source})`);

  const res = await send(MSG.SUBSCRIPTION_SEEN, { channelId, subscribed, source, key: activeAccountKey() });

  // Persistent trace of the last notification. A YouTube tab's console loses
  // messages as one navigates and as the page updates, which makes the question
  // "did the notification leave, and what did the database answer?"
  // undemonstrable. `__ytFeedDiag()` reads it back.
  try {
    sessionStorage.setItem(LAST_REPORT_KEY, JSON.stringify({
      when: new Date().toISOString(), channelId, before: previous, after: subscribed, source, answer: res,
    }));
  } catch { /* storage unavailable: the trace is not indispensable */ }

  if (!res.ok) { log.error('Notification refused', res.error); return; }

  // A single banner, the one for the addition: the channel enters the feed and
  // its videos are fetched right after, so something arrives on screen that is
  // worth announcing.
  //
  // The two others were removed. "Channel removed from the feed" and "Channel
  // already followed" served to prove the detection was running, while it was
  // being tuned: they confirmed a reading, not an action. On an installed
  // account they appeared at every visit to a followed channel. The trace stays
  // in the log and in `__ytFeedDiag()`.
  if (res.added) {
    const banner = showBanner(t('cs.sub.added'));
    setTimeout(() => banner.update(t('cs.sub.added.done')), 4000);
    setTimeout(() => banner.remove(), 8000);
  }
}

/** Watches the page's subscription state for as long as we stay on it. */
function watchSubscribeButton() {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try { await checkSubscription(); } catch (err) { log.error('Could not read the subscription', err); }
    if (!stopped) timer = setTimeout(tick, SUBSCRIPTION_POLL_MS);
  };

  // The button is not rendered right away after an SPA navigation.
  timer = setTimeout(tick, 1200);

  return () => { stopped = true; clearTimeout(timer); };
}

// ---------------------------------------------------------------------------
// Subscription import
// ---------------------------------------------------------------------------

const IMPORT_FLAG = 'ytfeed:pendingImport';

/**
 * Fetches the complete subscription list and imports it.
 *
 * The first version scrolled the `/feed/channels` page all the way down,
 * waiting for YouTube to load each batch. It was slow — close to a minute for
 * nine hundred subscriptions —, dependent on rendering, and regularly
 * truncated: the list sometimes stops loading after a hundred entries, without
 * saying so.
 *
 * We now ask the internal API for the list, the one the page calls itself. Five
 * requests, about a second, and a result that is either complete or plainly
 * flagged as incomplete.
 *
 * @param {(p: {found: number, done: boolean}) => void} [onProgress]
 */
async function importSubscriptions(onProgress) {
  const { listSubscriptions, innertubeAvailable } = await import(
    chrome.runtime.getURL('src/content/innertube.js'));

  if (!await innertubeAvailable()) {
    return { ok: false, error: t('cs.import.nosession') };
  }

  const { channels, complete } = await listSubscriptions((found) => onProgress?.({ found, done: false }));
  const clean = channels.map(sanitizeChannel).filter(Boolean);
  onProgress?.({ found: clean.length, done: true, truncated: !complete });

  if (!clean.length) return { ok: false, error: t('cs.import.empty') };

  const result = await send(MSG.IMPORT_SUBSCRIPTIONS, { channels: clean, complete, key: activeAccountKey() });
  return { ...result, truncated: !complete };
}

/** The history moves during the day: more often than the subscriptions. */
const HISTORY_EVERY_MS = 6 * 3600e3;
const HISTORY_KEY = 'ytfeed:lastHistorySyncAt';

/**
 * Picks up what has been watched elsewhere.
 *
 * Playback tracking only sees what happens in this browser: a video watched on
 * a phone or a TV stayed "to watch" indefinitely. We thought that blind spot
 * unavoidable, the public API having closed off history in 2016 — but YouTube's
 * interface shows it, so its internal API serves it. Two hundred entries in one
 * request, without asking anyone for anything.
 *
 * An entry with no progress is a video watched to the end: YouTube only shows a
 * resume bar on those left partway.
 */
async function maybeSyncWatchHistory() {
  // The history read here is that of the tab's session: under another account,
  // it would mark as watched videos the database owner never opened.
  if (isForeignAccount()) return;
  const stored = await chrome.storage.local.get([HISTORY_KEY, 'ytfeed:settings']);
  if (Date.now() - (stored?.[HISTORY_KEY] ?? 0) < HISTORY_EVERY_MS) return;

  const { listWatchHistory, innertubeAvailable } = await import(
    chrome.runtime.getURL('src/content/innertube.js'));
  if (!await innertubeAvailable()) return;

  const watched = await listWatchHistory({ max: 200 });
  if (!watched.length) return;
  await chrome.storage.local.set({ [HISTORY_KEY]: Date.now() });

  const threshold = Number(stored?.['ytfeed:settings']?.watchedPercent) || 70;
  const entries = watched.map(({ videoId, percent }) => ({
    id: videoId,
    progress: percent === null ? 1 : percent / 100,
    completed: percent === null || percent >= threshold,
  }));

  const res = await send(MSG.MARK_WATCHED, { entries, key: activeAccountKey() });
  if (res?.ok && res.updated) log.info(`${res.updated} video(s) watched elsewhere, carried into the feed`);
}

/** One re-read a day is enough: subscriptions do not change every hour. */
const RECONCILE_EVERY_MS = 24 * 3600e3;
const RECONCILE_KEY = 'ytfeed:lastReconcileAt';

/**
 * Brings the subscription list back in line with YouTube, without asking
 * anything.
 *
 * An unsubscription made elsewhere — from the phone, from another machine —
 * used to be invisible: the channel stayed in the feed indefinitely, and only a
 * manual reimport made it disappear. Nothing justified that blind spot once the
 * list became readable in a second.
 *
 * Reconciliation only deletes videos if the list is *complete*: an interrupted
 * pagination would make still followed channels look abandoned.
 */
async function maybeReconcile() {
  // This is the extension's most destructive path: it deactivates everything
  // absent from the list read. Read under another account, it empties the feed
  // of the database's owner.
  if (isForeignAccount()) return;
  const stored = await chrome.storage.local.get(RECONCILE_KEY);
  if (Date.now() - (stored?.[RECONCILE_KEY] ?? 0) < RECONCILE_EVERY_MS) return;

  const { listSubscriptions, innertubeAvailable } = await import(
    chrome.runtime.getURL('src/content/innertube.js'));
  if (!await innertubeAvailable()) return;

  const { channels, complete } = await listSubscriptions();
  const clean = channels.map(sanitizeChannel).filter(Boolean);
  if (!clean.length) return;

  const res = await send(MSG.IMPORT_SUBSCRIPTIONS, {
    channels: clean, complete, automatic: true, key: activeAccountKey(),
  });
  const r = res?.result;
  if (!res?.ok || !r) return;
  // A rejected import must be retried on the next page, not postponed a day.
  await chrome.storage.local.set({ [RECONCILE_KEY]: Date.now() });

  log.info(`Reconciliation: ${r.added} added, ${r.deactivated} removed`);

  // We only report what changes something for the user. A reconciliation that
  // finds nothing must stay completely silent.
  if (r.added || r.deactivated) {
    const parts = [];
    if (r.added) parts.push(t('cs.reconcile.added', { n: r.added }));
    if (r.deactivated) parts.push(t('cs.reconcile.removed', { n: r.deactivated }));
    const banner = showBanner(t('cs.reconcile', { parts: parts.join(', ') }));
    setTimeout(() => banner.remove(), 6000);
  }
}

/** Resumes an import requested from the popup, which opened the page for it. */
async function resumePendingImport() {
  // storage.local and not storage.session: by default, session is not readable
  // from a content script without raising its access level.
  const stored = await chrome.storage.local.get(IMPORT_FLAG);
  if (!stored?.[IMPORT_FLAG]) return;
  await chrome.storage.local.remove(IMPORT_FLAG);
  await runImport();
}

/**
 * Import requested from the popup, run on the already open YouTube tab.
 *
 * The import no longer needs a particular page: any page of the site supplies
 * the session and the configuration the internal API needs.
 */
let importRunning = false;
let authenticatedSweepRunning = false;

async function runAuthenticatedSweep(channels, progressId) {
  const { fetchChannelUploads, fetchChannelVideosTab, fetchAuthenticatedVideoFacts } = await import(
    chrome.runtime.getURL('src/content/innertube.js')
  );
  const { collectChannelWindow } = await import(chrome.runtime.getURL('src/content/channel-sweep.js'));
  const queue = (channels ?? []).filter((channel) => RE_CHANNEL_ID.test(channel?.id ?? ''));
  let reported = 0;
  return collectChannelWindow(queue, {
    fetchTab: fetchChannelVideosTab,
    fetchUploads: fetchChannelUploads,
    fetchFacts: fetchAuthenticatedVideoFacts,
    persist: (payload) => send(MSG.AUTH_SWEEP_CHANNEL, { ...payload, key: activeAccountKey() }),
    progress: async ({ done, total }) => {
      if (done !== total && done - reported < 4) return;
      reported = done;
      await send(MSG.AUTH_SWEEP_PROGRESS, { progressId, done, total, key: activeAccountKey() });
    },
  });
}

async function runImport() {
  if (importRunning) return;
  importRunning = true;

  log.info('Subscription import requested');
  const banner = showBanner(t('cs.import.running'));

  const result = await importSubscriptions(({ found, done }) => {
    banner.update(t(done ? 'cs.import.found' : 'cs.import.searching', { n: found }));
  });

  if (!result?.ok) {
    banner.update(t('pop.csv.failed', { error: result?.error ?? t('cs.unknown') }));
    setTimeout(() => banner.remove(), 8000);
    importRunning = false;
    return;
  }

  const total = result.result?.total ?? 0;
  banner.update(result.truncated
    // A truncated import must show: otherwise one believes everything was
    // imported and wonders why some channels never appear in the feed.
    ? t('cs.import.truncated', { n: total })
    : t('cs.import.done', { n: total }));

  setTimeout(() => banner.remove(), result.truncated ? 15_000 : 4000);
  importRunning = false;
}

// The popup speaks directly to the open tab rather than dropping a flag and
// opening a page: it is instant, and nothing moves on screen.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === MSG.AUTH_SWEEP_RUN) {
    if (authenticatedSweepRunning) { sendResponse({ ok: false, reason: 'source-busy' }); return false; }
    authenticatedSweepRunning = true;
    const channels = Array.isArray(msg.channels) ? msg.channels : [];
    const progressId = String(msg.progressId ?? '').slice(0, 80);
    const key = activeAccountKey();

    // A complete sweep can last more than a minute. Keeping the
    // `tabs.sendMessage` reply open for its whole duration makes Chrome close
    // the channel and discard the final result. Acknowledge the launch now;
    // every channel is already persisted separately, and a short final message
    // announces completion.
    sendResponse({ ok: true, started: true, total: channels.length });
    Promise.resolve()
      .then(() => runAuthenticatedSweep(channels, progressId))
      .then(
        (result) => send(MSG.AUTH_SWEEP_DONE, {
          progressId, total: channels.length, result, key,
        }),
        (error) => send(MSG.AUTH_SWEEP_DONE, {
          progressId,
          total: channels.length,
          result: {
            ok: false,
            reason: 'source-unavailable',
            error: String(error?.message ?? error),
          },
          key,
        }),
      )
      .then((reply) => {
        if (!reply?.ok) throw new Error(reply?.error || 'err.emptyreply');
      })
      .catch((error) => log.warn('Authenticated sweep completion unavailable', error))
      .finally(() => { authenticatedSweepRunning = false; });
    return false;
  }
  if (msg?.type === MSG.AUDIT_NATIVE_SOURCE) {
    (async () => {
      const { fetchSubscriptionsFeed, innertubeAvailable } = await import(
        chrome.runtime.getURL('src/content/innertube.js')
      );
      if (!await innertubeAvailable()) return { ok: false, reason: 'source-unavailable' };
      const result = await fetchSubscriptionsFeed(msg.windowDays);
      const videos = (result.videos ?? []).filter((video) => RE_VIDEO_ID.test(video.id ?? '')).map((video) => ({
        id: video.id,
        title: String(video.title ?? '').slice(0, 500),
        channelTitle: String(video.channelTitle ?? '').slice(0, 200),
        ...(RE_CHANNEL_ID.test(video.channelId ?? '') ? { channelId: video.channelId } : {}),
        ...(Number.isFinite(video.publishedAt) ? { publishedAt: video.publishedAt } : {}),
      }));
      return { ...result, videos, key: activeAccountKey() };
    })().then(sendResponse, (error) => sendResponse({
      ok: false, reason: 'source-unavailable', error: String(error?.message ?? error),
    }));
    return true;
  }
  if (msg?.type === MSG.RUN_IMPORT) runImport();
  if (msg?.type === MSG.HISTORY_ENRICH_RUN) enrichHistory();
  if (msg?.type === MSG.HISTORY_SCRAPE_RUN) scrapeHistory();
  return false;
});


// ---------------------------------------------------------------------------
// Completing the history from YouTube's own history page
// ---------------------------------------------------------------------------

let historyScrapeRunning = false;

/**
 * Pages YouTube's history page and sends what it holds to the worker.
 *
 * Here rather than in the extension page for the usual reason: that page has
 * neither youtube.com's cookies nor its internal configuration. Here rather
 * than in the worker for a second one: the history is served only to the signed
 * in session, and the worker deliberately calls the internal API without one.
 *
 * Measured on 28 August 2026, on a complete history: 255 requests, 44 349
 * viewings, back to 24 March 2020, in about four minutes. It is long, and that
 * is why the token lives in the worker — closing the tab costs one page, not
 * the run.
 */
async function scrapeHistory() {
  if (historyScrapeRunning) return;
  historyScrapeRunning = true;

  try {
    const { fetchHistoryPage, innertubeAvailable } = await import(
      chrome.runtime.getURL('src/content/innertube.js'));
    if (!await innertubeAvailable()) {
      log.warn('Internal API unavailable: history page unreadable');
      return;
    }

    const state = await send(MSG.HISTORY_SCRAPE_STATE);
    if (!state?.ok || !state.running) return;
    let token = state.token ?? null;

    for (;;) {
      const page = await fetchHistoryPage(token);
      if (!page) break;

      const res = await send(MSG.HISTORY_SCRAPE_PUT, {
        entries: page.entries,
        continuation: page.continuation,
        oldest: page.oldest,
      });
      if (!res?.ok || !res.running) break;
      token = res.token;
    }
  } finally {
    historyScrapeRunning = false;
  }
}


// ---------------------------------------------------------------------------
// History enrichment
// ---------------------------------------------------------------------------

let historyEnrichRunning = false;

/**
 * Fetches the durations of the channels cited by the imported history.
 *
 * The analysis page is an extension page: it has neither youtube.com's cookies
 * nor the site's internal configuration, so it cannot query the API. The work
 * is done here, on an open YouTube tab, and driven by the service worker which
 * hands out the channels one by one.
 *
 * Two requests per channel, not one per video: the uploads playlist yields a
 * hundred videos with their durations per page, and we read two hundred. That
 * is what makes the operation viable — fifteen thousand requests would not be.
 *
 * The channel avatar travels in the same response, hence for free.
 */
async function enrichHistory() {
  if (historyEnrichRunning) return;
  historyEnrichRunning = true;

  try {
    const { fetchChannelUploads, fetchChannelAvatar, innertubeAvailable } = await import(
      chrome.runtime.getURL('src/content/innertube.js'));
    if (!await innertubeAvailable()) {
      log.warn('Internal API unavailable: enrichment impossible');
      return;
    }

    for (;;) {
      const res = await send(MSG.HISTORY_ENRICH_NEXT, { batch: 3 });
      if (!res?.ok || !res.channels?.length) break;

      for (const { channelId, avatarNeeded, avatarOnly } of res.channels) {
        // A channel that fails must not take the queue down with it.
        //
        // That was the flaw blocking the recovery: a deleted, renamed or
        // momentarily broken channel let the exception bubble up out of the
        // loop. The worker, for its part, stayed "running" with the same
        // channel at the head of the queue — nothing moved any more, and the
        // page showed a frozen progress for hours.
        //
        // So we record an empty result: the channel is marked as handled, the
        // queue moves on, and its videos will simply stay without a duration.
        // That is something the page already knows how to say.
        try {
          if (avatarOnly) {
            await send(MSG.HISTORY_ENRICH_PUT, {
              channelId, avatarOnly: true, avatarUrl: await fetchChannelAvatar(channelId),
            });
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }

          // Shorts are ruled out here as everywhere else: that is the point of
          // the extension. Including them skewed everything computed on the
          // uploads list — a channel followed without missing a single video
          // showed a streak of zero because the latest upload was a Short,
          // never watched.
          const { videos, avatarUrl } = await fetchChannelUploads(channelId, {
            max: 200, kind: 'long',
          });

          // One more request to know which of its Shorts exist. Without that
          // list, a watched Short would stay in the history with no known
          // duration and would be credited with the channel's average long form
          // duration: three quarters of an hour for one minute watched. Knowing
          // it lets us rule it out instead of inventing it.
          //
          // Three hundred and not one hundred, and the truncation is reported.
          // A hundred was one page, and a channel that publishes mostly Shorts
          // has thousands: everything watched before the last hundred stayed
          // unknown and was credited with the mean of the channel's stream
          // VODs. On a real export that turned about thirty Shorts into sixty
          // five hours on a channel the user had watched once.
          const SHORTS_MAX = 300;
          const shortIds = await fetchChannelUploads(channelId, {
            max: SHORTS_MAX, kind: 'shorts',
          }).then((r) => r.videos.map((v) => v.id)).catch(() => null);
          const shorts = shortIds ?? [];
          // `null` is a failed request, not an empty catalogue: in doubt we
          // treat the list as cut off rather than vouch for it.
          const shortsTruncated = shortIds === null || shortIds.length >= SHORTS_MAX;

          // One more request, and only for the channels the page shows: on a
          // channel with no long form upload, the playlist yields no image at
          // all, and the ranking would be left with its monogram.
          const avatar = avatarUrl
            ?? (avatarNeeded ? await fetchChannelAvatar(channelId) : null);

          await send(MSG.HISTORY_ENRICH_PUT, {
            channelId,
            avatarUrl: avatar,
            videos: videos.map((v) => ({ id: v.id, durationSec: v.durationSec ?? 0 })),
            shorts,
            shortsTruncated,
          });
        } catch (err) {
          log.warn('Channel skipped during enrichment', channelId, err);
          // A failed avatar catch up is not a channel failure: it already has
          // its durations, it is only missing an image. We move the queue on
          // without marking anything.
          await send(MSG.HISTORY_ENRICH_PUT, avatarOnly
            ? { channelId, avatarOnly: true, avatarUrl: null }
            : { channelId, videos: [], failed: true }).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    log.info('History enrichment finished');
  } catch (err) {
    log.warn('History enrichment interrupted', err);
  } finally {
    historyEnrichRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

let durationsRunning = false;

/**
 * Fills in the missing durations from the page.
 *
 * Atom feeds do not carry the duration, and the public API demanded a key for
 * it — hence a Google Cloud project, for a mere display. The internal API gives
 * it for free, in batches of a hundred videos from a single channel.
 *
 * The work is done discreetly, on an already open page, and in small batches:
 * there is no urgency in knowing the duration of a video one has not yet
 * decided to watch.
 */
/** Channels handled per round. One request each. */
const DURATIONS_PER_ROUND = 8;

/** Rest between two channels: nothing is urgent, and hammering the internal API
 *  would be the surest way to get noticed. */
const CHANNEL_REST_MS = 400;

/** Rest between two rounds, as long as there is work left. */
const ROUND_REST_MS = 3000;

/**
 * Ceiling on channels handled per open page.
 *
 * It exists for the very first run: on a base of nine hundred freshly
 * synchronised subscriptions, everything has to be filled in at once. The
 * ceiling spreads that catch up over several visits instead of running the
 * internal API for ten minutes straight on the first one.
 */
const DURATIONS_MAX_PER_PAGE = 60;

/**
 * Records the state of a channel's broadcasts: ongoing, announced, or over.
 *
 * Three possible states in the `UULV` playlist, and a single reading to settle
 * them. A scheduled broadcast is neither a live stream nor a replay: it is an
 * appointment, which has no business in a chronological feed until it has
 * happened.
 *
 * @param {Function} listChannelUploads
 * @param {string} channelId
 * @param {Set<string>} expected
 * @param {{durations: Array, live: Array, upcoming: Array, checked: Array}} out
 */
async function readBroadcasts(listChannelUploads, channelId, expected, out) {
  for (const video of await listChannelUploads(channelId, { max: 100, kind: 'lives' })) {
    if (!expected.has(video.id)) continue;
    if (video.durationSec) out.durations.push([video.id, video.durationSec]);
    out.checked.push(video.id);
    if (video.isLive) out.live.push(video.id);
    // The "scheduled" badge is often missing, whereas the absence of a duration
    // is reliable: a broadcast only has one once it is over. So the duration
    // decides, and the badge confirms.
    else if (video.isUpcoming || !video.durationSec) {
      out.upcoming.push([video.id, video.scheduledAt ?? 0]);
    }
  }
}

async function enrichDurations() {
  if (durationsRunning) return;
  durationsRunning = true;

  try {
    const { listChannelUploads, innertubeAvailable } = await import(
      chrome.runtime.getURL('src/content/innertube.js'));
    if (!await innertubeAvailable({ authenticated: false })) return;

    let handled = 0;
    // An ongoing broadcast has no duration, and will not have one before it
    // ends: it therefore stays forever "to be filled in". Without a memory of
    // the videos already examined, the loop would have kept at it until the
    // ceiling.
    const alreadySeen = new Set();

    // In a loop, and no longer a single round. One round of eight channels left
    // most of the feed without a duration: the page shows sixty, coming from
    // some forty different channels, and the Atom feeds carry none. The
    // thumbnails stayed bare until the page was reopened, several times.
    while (handled < DURATIONS_MAX_PER_PAGE) {
      const res = await send(MSG.NEED_DURATIONS, { maxChannels: DURATIONS_PER_ROUND });
      if (!res?.ok || !res.groups?.length) break;

      const expected = res.groups.flatMap((g) => [...g.ids, ...(g.liveIds ?? [])]);
      if (expected.every((id) => alreadySeen.has(id))) break; // this round would say nothing new
      for (const id of expected) alreadySeen.add(id);

      const durations = [];
      const live = [];
      const upcoming = [];
      const checked = [];
      const missing = [];

      for (const { channelId, ids, liveIds = [] } of res.groups) {
        // Two playlists, because broadcasts are not in the long form one.
        // Looking for them where they cannot be left every replay without a
        // duration — hence displayed as ongoing live streams, days after the
        // broadcast ended.
        if (ids.length) {
          const wanted = new Set(ids);
          const uploads = await listChannelUploads(channelId, { max: 100, kind: 'long' });
          for (const video of uploads) {
            if (!wanted.delete(video.id)) continue;
            if (video.durationSec) durations.push([video.id, video.durationSec]);
          }
          // What is left in `wanted` is not in the long form playlist. The
          // absence only means something if the whole playlist was seen: at a
          // hundred entries returned there are more behind, and the missing
          // video may simply be older. Below that, it is a fact — and a fact
          // that has to be settled, otherwise those videos come back every
          // round and monopolise the slots reserved for channels.
          if (uploads.length < 100) missing.push(...wanted);
          handled++;
          await new Promise((r) => setTimeout(r, CHANNEL_REST_MS));
        }

        if (liveIds.length) {
          await readBroadcasts(listChannelUploads, channelId, new Set(liveIds),
            { durations, live, upcoming, checked });
          handled++;
          await new Promise((r) => setTimeout(r, CHANNEL_REST_MS));
        }
      }

      if (!durations.length && !checked.length && !missing.length) break; // nothing more to get

      // Absences are settled on the worker side, which has the watch record: it
      // alone can say a video is a Short, and remove it.
      if (missing.length) send(MSG.SETTLE_ABSENT, { ids: missing }).catch(() => {});

      const write = await send(MSG.SET_DURATIONS, { durations, live, upcoming, checked });
      if (write?.ok) log.debug(`${write.written} durations filled in, ${write.lives} broadcasts updated`);
      // The grid may be displayed under our feet: it updates without a reload
      // rather than waiting for the next visit.
      applyDurations(durations);

      await new Promise((r) => setTimeout(r, ROUND_REST_MS));
    }
  } catch (err) {
    log.warn('Could not enrich the durations', err);
  } finally {
    durationsRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

/**
 * How often to re-read while a broadcast is ongoing.
 *
 * A broadcast that ends warns nobody: nothing in the Atom feed nor in our
 * database changes at the moment it stops. The only way to know is to go and
 * ask again, and the freshness of the display is worth exactly the frequency at
 * which we do so.
 */
const LIVE_INTERVAL_MS = 2 * 60_000;

/** Channels read per pass. They are rare: an ongoing broadcast is an event, not
 *  an ordinary state. */
const LIVE_PER_ROUND = 12;

/** Pace when only appointments are left: the announced time moves little. */
const LIVE_QUIET_INTERVAL_MS = 10 * 60_000;

/** First reading, before the durations one: it is the most perishable. */
const LIVE_DELAY_MS = 2500;

let liveRunning = false;
let liveTimer = null;

/**
 * Re-reads the state of the broadcasts, then reschedules itself as long as some
 * are left.
 *
 * This pass is distinct from the durations one and takes priority over it. The
 * two look alike but do not answer the same need: filling in a missing duration
 * can wait until tomorrow, whereas an ended live stream still announcing itself
 * as live is wrong on screen from the second it finishes. Mixed together,
 * broadcasts inherited the durations' budget and its window limited to recent
 * videos, hence day old live streams still shown as ongoing.
 */
async function watchBroadcasts() {
  if (liveRunning) return;
  liveRunning = true;

  let next = 0;
  try {
    const { listChannelUploads, innertubeAvailable } = await import(
      chrome.runtime.getURL('src/content/innertube.js'));
    if (!await innertubeAvailable({ authenticated: false })) return;

    const res = await send(MSG.NEED_BROADCASTS, { maxChannels: LIVE_PER_ROUND });
    if (!res?.ok || !res.groups?.length) return;

    const reading = { durations: [], live: [], upcoming: [], checked: [] };
    const expected = new Set();

    for (const { channelId, liveIds = [] } of res.groups) {
      if (!liveIds.length) continue;
      for (const id of liveIds) expected.add(id);
      await readBroadcasts(listChannelUploads, channelId, new Set(liveIds), reading);
      await new Promise((r) => setTimeout(r, CHANNEL_REST_MS));
    }

    if (!reading.checked.length) return;

    const write = await send(MSG.SET_DURATIONS, reading);
    if (write?.ok) log.debug(`${write.lives} broadcasts requalified`);

    // What the database believed ongoing and no longer is. The grid may be
    // displayed under our feet: the red badge drops right away rather than at
    // the next page load.
    const alive = new Set([...reading.live, ...reading.upcoming.map(([id]) => id)]);
    const ended = new Set([...expected].filter((id) => !alive.has(id)));
    applyDurations(reading.durations, { ended });

    // As long as a live stream runs, we come back quickly. If none is left, the
    // next visit will do: nothing more can change without a feed telling us
    // first.
    if (reading.live.length) next = LIVE_INTERVAL_MS;
    else if (reading.upcoming.length) next = LIVE_QUIET_INTERVAL_MS;
  } catch (err) {
    log.warn('Could not read the broadcasts', err);
  } finally {
    liveRunning = false;
    clearTimeout(liveTimer);
    liveTimer = next ? setTimeout(watchBroadcasts, next) : null;
  }
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

let avatarsRunning = false;

/**
 * Fills in the channel avatars the import could not read.
 *
 * Without this, those channels show an initial badge instead of their image.
 * The catch up already existed, but only from YouTube's native feed — which the
 * extension precisely covers with its own grid, so it hardly ever triggered.
 * Here the source is the internal API, available on any page of the site.
 *
 * One request per channel, and only for those that have nothing: the cost dies
 * out on its own once the list is covered.
 */
async function enrichAvatars() {
  if (avatarsRunning) return;
  avatarsRunning = true;

  try {
    const { fetchChannelAvatar, innertubeAvailable } = await import(
      chrome.runtime.getURL('src/content/innertube.js'));
    if (!await innertubeAvailable({ authenticated: false })) return;

    const res = await send(MSG.NEED_AVATARS, { max: 25 });
    if (!res?.ok || !res.channelIds?.length) return;

    const avatars = [];
    for (const channelId of res.channelIds) {
      const url = safeImageUrl(await fetchChannelAvatar(channelId));
      if (url) avatars.push([channelId, url]);
      await new Promise((r) => setTimeout(r, CHANNEL_REST_MS));
    }

    if (!avatars.length) return;
    const write = await send(MSG.SET_AVATARS, { avatars });
    if (write?.ok) log.debug(`${write.filled} avatars filled in`);
    applyAvatars(avatars);
  } catch (err) {
    log.warn('Could not catch up on the avatars', err);
  } finally {
    avatarsRunning = false;
  }
}

/** Discreet progress banner, bottom right. */
function showBanner(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px', 'z-index:99999',
    'padding:12px 18px', 'border-radius:10px',
    'background:#07070e', 'color:#e9e9f5', 'border:1px solid #25253c',
    'font:500 14px/1.4 Roboto,Arial,sans-serif', 'box-shadow:0 4px 24px rgba(0,0,0,.4)',
  ].join(';');
  document.body?.appendChild(el);
  return {
    update: (t) => { el.textContent = t; },
    remove: () => el.remove(),
  };
}

// ---------------------------------------------------------------------------
// Signed in account
// ---------------------------------------------------------------------------

/**
 * Reads the account signed in on this tab and makes it known.
 *
 * The key then accompanies everything the tab causes to be written: the
 * database belongs to the browser profile and not to the account, and without
 * it a second account opened in the same window writes into the same indexes.
 * See `src/lib/account.js` for what it is worth, `./active-account.js` for the
 * drawer that shares it with triage, playback tracking and list application.
 */
/** The warning banner is only shown once per tab. */
let foreignAccountAnnounced = false;

async function readAccount() {
  const cfg = await askMainWorld('account');
  // With no answer, we keep what we knew: overwriting with `null` would amount
  // to lifting the guard on a mere failed reading, whereas a real sign out does
  // answer, with `loggedIn: false`.
  if (!cfg) return;
  const key = accountKey(cfg);
  setAccountKey(key);
  if (!key) return;

  // The worker adopts the account if the database has none yet. Nothing to show
  // in that case: it is an attachment, not a user action.
  const res = await send(MSG.ACCOUNT_SEEN, { key });
  if (!res.ok) return;
  setForeignAccount(res.matches === false);
  // This separate message keeps the worker's event alive until the overdue
  // collection finishes, without delaying the account guard above. It is cheap
  // when nothing is due and repairs a delayed or lost Chrome alarm as soon as a
  // YouTube tab is available.
  if (res.matches !== false) send(MSG.AUTO_SYNC_NUDGE, { key }).catch(() => {});
  if (res.matches !== false || foreignAccountAnnounced) return;

  // Here, on the other hand, it has to be said: everything the tab would cause
  // to be written is refused, and without a word the extension would simply
  // look broken.
  foreignAccountAnnounced = true;
  const banner = showBanner(t('cs.compte.autre'));
  setTimeout(() => banner.remove(), 10_000);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

let teardown = null;

let currentPath = null;

function onNavigate(path) {
  // Two different videos share the same `/watch` path: without the id, going
  // from one to the other would be seen as "nothing changed" and the playback
  // tracking would stay attached to the previous one.
  const key = path.startsWith('/watch')
    ? `${path}?v=${new URL(location.href).searchParams.get('v') ?? ''}`
    : path;

  // The MAIN world re-announces its presence at every page update; without this
  // guard, we would unmount and remount the grid for nothing.
  if (key === currentPath) return;
  currentPath = key;

  // Re-read on every page: changing account goes through a navigation, and
  // everything the tab then causes to be written must carry the right key.
  readAccount().catch((err) => log.warn('Account unreadable', err));

  teardown?.();
  teardown = null;
  sentVideoIds.clear();
  reportedSubscriptions.clear();
  loggedReads.clear();
  unmountFeedView();
  unmountTriage();
  // Playback tracking, for its part, does not unmount: playback may very well
  // continue in miniplayer mode on a page that is no longer `/watch`.
  nudgeWatchTracking();

  // The import goes through the internal API: any page of the site will do.
  // Reserving it for `/feed/channels`, as in the days when that list had to be
  // scrolled, amounted to never honouring the request from another page.
  resumePendingImport();

  // Then, once things are quiet, the realignment with YouTube — at most once a
  // day, and showing nothing if there is nothing to say.
  setTimeout(() => maybeReconcile().catch((err) => log.warn('Reconciliation impossible', err)), 8000);
  setTimeout(() => maybeSyncWatchHistory().catch((err) => log.warn('Could not read the history', err)), 12_000);

  // Durations and avatars are filled in from any YouTube page, and no longer
  // from the feed alone. That is what makes them present *when the feed opens*
  // rather than a few seconds later: the work already happened while a video
  // was playing. The delay is longer elsewhere, where nothing is waiting for the
  // result on screen.
  const quiet = path.startsWith('/feed/subscriptions') ? 5000 : 20_000;
  setTimeout(enrichDurations, quiet);
  setTimeout(enrichAvatars, quiet + 4000);

  // Broadcasts go first, and on every page: their state goes stale in minutes
  // where a missing duration stays true forever. The timer already armed by a
  // previous navigation is not restarted for all that — `watchBroadcasts`
  // guards against a second pass.
  if (!liveTimer) setTimeout(watchBroadcasts, LIVE_DELAY_MS);

  if (path.startsWith('/watch')) {
    teardown = watchSubscribeButton();
    return;
  }

  // Channel pages are the other place one subscribes from.
  if (path.startsWith('/@') || path.startsWith('/channel/') || path.startsWith('/c/')) {
    teardown = watchSubscribeButton();
    return;
  }

  if (path.startsWith('/feed/subscriptions')) {
    mountFeedView().catch((err) => log.error('Could not mount the grid', err));
    // The native grid stays loaded in the background: we harvest it to recover
    // durations and playback progress, and to measure what YouTube actually
    // shows.
    setTimeout(harvestNativeFeed, 1500);
    teardown = watchScroll();
  } else if (path.startsWith('/feed/channels')) {
    // No delay: triage depends only on our database, and letting the
    // subscription list show for a second before covering it gave the
    // impression the extension was slow to start.
    resumePendingTriage();
  }
}

const TRIAGE_FLAG = 'ytfeed:pendingTriage';

/**
 * Opens triage, or the application of a list, when the popup asked for it.
 *
 * Both are shown over `/feed/channels`, the natural page for that. The flag is
 * removed before mounting: if the screen fails, we do not want it reopening
 * indefinitely at every pass over the page.
 */
async function resumePendingTriage() {
  const stored = await chrome.storage.local.get([TRIAGE_FLAG, BULK_FLAG]);

  if (stored?.[BULK_FLAG]) {
    await chrome.storage.local.remove(BULK_FLAG);
    mountBulk().catch((err) => log.error('Could not open the bulk application', err));
    return;
  }

  if (!stored?.[TRIAGE_FLAG]) return;
  await chrome.storage.local.remove(TRIAGE_FLAG);
  mountTriage().catch((err) => log.error('Could not open the triage', err));
}

export async function init() {
  log.info('Content script active');

  // The banners are written at the moment they are shown: it is enough for the
  // language to be known before, and re-read if it changes mid session.
  await initLocale();
  chrome.storage.onChanged.addListener((changes, zone) => {
    if (zone === 'local' && changes[LANG_KEY]) initLocale();
  });

  // Once for the tab, and not on every page: YouTube's player survives internal
  // navigations, and the tracking must survive them too.
  installWatchTracking({ readPlayer: () => askMainWorld('player-now') });

  // Before the first page, and awaited: the harvest and the reconciliation that
  // follow write to the database, and they must be able to say which account
  // they are talking about.
  await readAccount();

  // If the MAIN world already announced its presence before we loaded, we do
  // not miss the first page.
  onNavigate(location.pathname);
}
