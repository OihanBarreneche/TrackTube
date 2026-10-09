/**
 * Message contract between content scripts, popup and service worker.
 *
 * A single typed entry point rather than free strings scattered around: without
 * TypeScript, this is what prevents silent typos.
 */

export const MSG = /** @type {const} */ ({
  // Sync
  SYNC_NOW: 'sync:now',
  SYNC_STATE: 'sync:state',
  SYNC_PROGRESS: 'sync:progress', // broadcast by the service worker
  FEED_UPDATED: 'feed:updated',
  /**
   * Where a restore stands, broadcast slice by slice.
   *
   * A restore used to answer once, at the end, which made an operation that
   * writes twenty thousand records look instantaneous and gave no way to tell
   * one that had worked from one that had not.
   */
  RESTORE_PROGRESS: 'restore:progress',

  // Feed data
  GET_FEED_PAGE: 'feed:page',
  GET_FEED_COUNTS: 'feed:counts',
  GET_FEED_PULSE: 'feed:pulse',
  GET_STATS: 'feed:stats',
  SET_HIDDEN: 'feed:setHidden',
  HIDE_CHANNEL: 'feed:hideChannel',
  SET_STARRED: 'feed:setStarred',
  STAR_CHANNEL: 'feed:starChannel',
  EXPORT_DATA: 'data:export',
  IMPORT_DATA: 'data:import',
  SET_WATCHED: 'feed:setWatched',
  /** Batch of videos watched elsewhere, read off the History page. */
  MARK_WATCHED: 'feed:markWatched',

  /**
   * Verify existing videos before displaying them, at any publication age.
   *
   * The residual pass runs on the alarm, so a Short reclassified since its
   * collection could wait up to a quarter hour before anything looked at it. A
   * feed being opened is the one moment where that delay is visible, so the
   * page names what it displays and the worker screens the ones whose verdict
   * has gone stale. Returns {items}: fresh database rows with a current explicit
   * non-Short verdict. An absent row or indeterminate response returns no item.
   * Also used before releasing videos after duration or avatar enrichment.
   */
  SCREEN_SHORTS: 'feed:screenShorts',

  /**
   * Videos removed from the database, announced to the open tabs.
   *
   * A grid is rendered once and never told anything afterwards: a Short deleted
   * by the residual pass stayed on screen for as long as the tab stayed open,
   * which is how one could still be found in the feed hours after the database
   * had stopped holding it.
   */
  VIDEOS_GONE: 'feed:videosGone',

  /**
   * YouTube account signed in inside the tab, and owner of the database.
   *
   * The database belongs to the browser profile, not to the account: without
   * these two messages, signing in elsewhere mixes the subscriptions, the views
   * and the unsubscriptions of two accounts in the same index. `ACCOUNT_SEEN`
   * announces what the tab sees, adopts the account if the database has none
   * yet, and answers whether the tab is somewhere else.
   */
  ACCOUNT_SEEN: 'account:seen',

  // Subscriptions
  IMPORT_SUBSCRIPTIONS: 'subs:import',
  GET_CHANNELS: 'subs:list',
  SUBSCRIPTION_SEEN: 'subs:seen',

  /** Import request addressed to an already open YouTube tab. */
  RUN_IMPORT: 'subs:runImport',

  /** Missing durations, fetched by the tab through the internal API. */
  NEED_DURATIONS: 'durations:need',
  SET_DURATIONS: 'durations:set',

  /**
   * Videos their channel's playlist does not contain.
   *
   * Without this question, a video missing from `UULF` stayed without a
   * duration forever, and since the hunt for durations restarts from the most
   * recent videos, it occupied one of the twelve slots of the round
   * indefinitely: the other channels never got there. The worker settles the
   * case with a player record, which says both whether it is a Short and, if
   * not, the real duration.
   */
  SETTLE_ABSENT: 'durations:absent',

  /**
   * Broadcasts whose state needs re-reading, whatever their date.
   *
   * They have their own request because they have their own urgency: a missing
   * duration can wait until tomorrow, a live coming to an end must stop being
   * announced as live within minutes.
   */
  NEED_BROADCASTS: 'broadcasts:need',

  /**
   * Missing avatars, same mechanism as the durations.
   *
   * A channel imported from a Takeout file, or whose subscriptions page did not
   * render the image, arrives without an avatar. Its thumbnails then show an
   * initial badge — visible mostly on recent videos, since those are the only
   * ones we look at.
   */
  NEED_AVATARS: 'avatars:need',
  SET_AVATARS: 'avatars:set',
  /** Addresses that no longer answer, to be forgotten so they can be refetched. */
  DROP_AVATARS: 'avatars:drop',

  /**
   * A viewing session measured on the page, at the moment it happens.
   *
   * This is the history the extension builds by itself, as opposed to the one
   * that had to be fetched from Takeout. The message is re-emitted several
   * times for the same session, which overwrites itself in the database.
   */
  WATCH_RECORD: 'history:record',

  /** The whole history, in a single shape whatever its origin. */
  HISTORY_EXPORT: 'history:export',

  // Watch history imported from Takeout
  HISTORY_IMPORT: 'history:import',
  HISTORY_STATS: 'history:stats',
  HISTORY_SUMMARY: 'history:summary',
  HISTORY_CLEAR: 'history:clear',
  /** Videos suspected of being tabs left open rather than watched. */
  HISTORY_SUSPECTS: 'history:suspects',
  /** Detailed record of a channel, and directory for the search. */
  HISTORY_CHANNEL: 'history:channel',
  HISTORY_CHANNEL_LIST: 'history:channels',
  /**
   * What the channels themselves do: cadence, volume, views, durations.
   * Read from the feed index and not from the history, which knows nothing of
   * a video one has not watched.
   */
  HISTORY_CHANNEL_FACTS: 'history:channelFacts',
  /** The videos behind a displayed theme or topic. */
  HISTORY_VIDEOS: 'history:videos',
  /**
   * One day of history, row by row.
   *
   * The bounds travel as milliseconds rather than as a date: the day is a local
   * one, and computing it in the worker would make it depend on where the worker
   * thinks it is rather than on the calendar the reader is looking at.
   */
  HISTORY_DAY: 'history:day',

  /**
   * Enriching the history with durations.
   *
   * The analysis runs in an extension page, which has neither the cookies nor
   * YouTube's internal configuration: it cannot query the API itself. The work
   * is therefore pulled by a YouTube tab, which claims its batches from the
   * service worker and sends the results back. Split this way, it survives the
   * death of the worker and resumes where it left off.
   */
  HISTORY_ENRICH_START: 'history:enrich:start',
  HISTORY_ENRICH_STOP: 'history:enrich:stop',
  HISTORY_ENRICH_STATE: 'history:enrich:state',
  HISTORY_ENRICH_NEXT: 'history:enrich:next',
  HISTORY_ENRICH_PUT: 'history:enrich:put',
  /** Order addressed to a YouTube tab: start enriching. */
  HISTORY_ENRICH_RUN: 'history:enrich:run',

  /**
   * Completing the history from YouTube's own history page.
   *
   * A Takeout export does not always go back as far as that page does —
   * measured on one real account in August 2026, 12 764 viewings from May 2024
   * against 44 349 from March 2020. What the page gives is coarser: a date
   * heading, no hour, no second viewing of the same video on the same day. So
   * it completes Takeout, it never replaces it.
   *
   * Same split as the enrichment, and for the same reason: the page is served
   * only to the signed in session, which an extension page does not have.
   */
  HISTORY_SCRAPE_START: 'history:scrape:start',
  HISTORY_SCRAPE_STOP: 'history:scrape:stop',
  HISTORY_SCRAPE_STATE: 'history:scrape:state',
  HISTORY_SCRAPE_PUT: 'history:scrape:put',
  /** Order addressed to a YouTube tab: start collecting. */
  HISTORY_SCRAPE_RUN: 'history:scrape:run',

  /**
   * Applying a list of channels to the account, in batches.
   *
   * The worker only supplies the context — current subscriptions and date of
   * the last backup. The calls to YouTube go out from the tab, which alone has
   * the session; the same split as for triage.
   */
  BULK_CONTEXT: 'bulk:context',

  // Subscription triage
  /** The figures at the bottom of the Triage and History tabs, in one round trip. */
  POPUP_HIGHLIGHTS: 'popup:highlights',

  TRIAGE_CHANNELS: 'triage:channels',
  TRIAGE_VIDEOS: 'triage:videos',
  TRIAGE_PROGRESS: 'triage:progress',

  // Enrichment from YouTube's native feed
  NATIVE_HARVEST: 'native:harvest',

  // Completeness audit
  AUDIT_RUN: 'audit:run',
  AUDIT_REVERSE_RUN: 'audit:reverse-run',
  AUDIT_NATIVE_SOURCE: 'audit:native-source',
  AUTH_SWEEP_RUN: 'sync:authenticated-run',
  AUTH_SWEEP_CHANNEL: 'sync:authenticated-channel',
  AUTH_SWEEP_PROGRESS: 'sync:authenticated-progress',
  AUTH_SWEEP_DONE: 'sync:authenticated-done',
  AUTO_SYNC_NUDGE: 'sync:auto-nudge',
});

/**
 * Sends a message to the service worker.
 *
 * `chrome.runtime.sendMessage` rejects when no recipient is listening — a
 * commonplace case if the service worker has just been killed. We return a
 * structured error rather than let an unhandled exception escape.
 *
 * @param {string} type
 * @param {object} [payload]
 */
export async function send(type, payload = {}, { retry = true } = {}) {
  // Reloading the extension orphans the scripts already injected into the open
  // pages: `chrome.runtime` survives as an object but loses its `id`, and every
  // call throws "Extension context invalidated". The tab cannot recover on its
  // own — no message will ever reach the worker again — so the only useful
  // thing to do is say which gesture repairs it. Chrome's own sentence, in
  // English and shown raw, said nothing to anybody.
  if (!chrome.runtime?.id) return { ok: false, error: 'err.reloaded' };

  try {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    return res ?? { ok: false, error: 'err.emptyreply' };
  } catch (err) {
    const message = String(err?.message ?? err);

    // The service worker can be killed mid-processing: the work happened, but
    // the reply is lost on the way. Chrome signals this with a closed port or
    // a missing recipient. A single retry is enough — the message replays it —
    // and without it the caller believes in a failure although the database was
    // indeed modified.
    // The invalidation can also land between the check above and the call: the
    // extension may be reloaded at any instant, including this one.
    if (/Extension context invalidated/i.test(message)) return { ok: false, error: 'err.reloaded' };

    const transient = /message (?:port|channel) closed|Receiving end does not exist|Extension context/i.test(message);
    if (retry && transient) {
      await new Promise((r) => setTimeout(r, 300));
      return send(type, payload, { retry: false });
    }
    return { ok: false, error: message };
  }
}

/**
 * Broadcasts a message without waiting for a reply and without failing if there
 * is nobody to hear it.
 * @param {string} type
 * @param {object} [payload]
 */
export function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => { /* no recipient */ });
}

/**
 * Installs a message router. Each handler may be asynchronous; its return value
 * is wrapped in `{ok: true, ...}`.
 *
 * @param {Record<string, (payload: any, sender: chrome.runtime.MessageSender) => any>} handlers
 */
export function route(handlers) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = handlers[msg?.type];
    if (!handler) return false; // not for us

    Promise.resolve()
      .then(() => handler(msg, sender))
      .then((result) => sendResponse({ ok: true, ...(result ?? {}) }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));

    return true; // asynchronous reply
  });
}
