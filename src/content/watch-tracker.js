/**
 * Watch tracking.
 *
 * Without it, the feed never knows what has been watched: you open a video from
 * the grid, watch it through, come back — and it is still there, to be hidden
 * by hand. Yet this feed is supposed to be the list of what is left to see.
 *
 * YouTube's API has not exposed watch history since 2016. The only possible
 * source is therefore local observation: we read the playback position from the
 * page's `<video>` element.
 *
 * That observation serves two things, not to be confused:
 *
 *  - marking the video as watched in the feed, which it has always done;
 *  - keeping a history, which it does now. Where the Takeout export can only
 *    say "this video was opened at this time", the on site measurement knows
 *    the length of the video, the time actually spent on it and whether
 *    playback went to the end. That is what makes the export progressively
 *    useless: after a few months, everything it would bring is already here,
 *    better.
 *
 * What this module follows is **the player**, not the address of the page. The
 * distinction is not theoretical: in miniplayer mode, playback continues while
 * you browse the rest of the site, and the address no longer carries any trace
 * of the video. Clinging to the URL meant losing the session at the exact
 * moment the user was still watching.
 */

import { MSG, send } from '../lib/messages.js';
import { t } from '../lib/i18n.js';
import { log } from './../lib/log.js';
import { activeAccountKey } from './active-account.js';

/**
 * Share of the video actually covered beyond which we call it watched.
 *
 * Adjustable from the popup: ninety per cent suits whoever skips the end
 * credits, but someone who watches everything to the last shot will want a
 * higher threshold, and someone who often drops out will want a lower one.
 */
const DEFAULT_WATCHED_RATIO = 0.9;
let watchedRatio = DEFAULT_WATCHED_RATIO;

/**
 * Is history recording active?
 *
 * It starts only after the user enables it in onboarding or settings.
 * An unset preference records no viewing sessions. When disabled,
 * the extension keeps marking videos as watched in the feed without recording
 * anything about what was watched.
 */
let historyEnabled = false;

/** Re-reads the settings. An absurd value falls back to the default. */
async function loadSettings() {
  const stored = await chrome.storage.local.get('ytfeed:settings');
  const settings = stored?.['ytfeed:settings'] ?? {};

  const percent = Number(settings.watchedPercent);
  watchedRatio = Number.isFinite(percent) && percent >= 10 && percent <= 100
    ? percent / 100
    : DEFAULT_WATCHED_RATIO;

  historyEnabled = settings.liveHistory === true;
}

/**
 * How often a session is saved during playback.
 *
 * Ten seconds, and not fifteen: between two writes, everything measured exists
 * only in the page and disappears if the tab is closed abruptly. The cost of a
 * report is that of one message and one indexed write on an existing key, which
 * is to say nothing.
 */
const REPORT_MS = 10_000;

/**
 * Delay of the very first report of a session.
 *
 * It is short because that is where views get lost: a video opened then left
 * after ten seconds left no trace as long as the first report only arrived
 * after fifteen.
 */
const FIRST_REPORT_MS = 6_000;

/** How often we check what the player is playing. */
const PROBE_MS = 3_000;

/** Beyond this, we ask the player again even without having seen anything move. */
const PROBE_SAFETY_MS = 30_000;

/** Below this, progress means nothing: the page has just been opened. */
const MIN_MEANINGFUL_RATIO = 0.02;

/**
 * Playback time from which the session enters the history.
 *
 * The history counts views, not positions: the threshold is therefore in
 * seconds and not a proportion, otherwise one minute spent on a three hour talk
 * would leave no trace although Takeout would have noted the opening. Five
 * seconds are enough to rule out the mistaken click and the next video cut off
 * straight away.
 */
const MIN_HISTORY_SECONDS = 5;

/**
 * Largest gap between two `timeupdate` events counted as normal playback.
 *
 * The event fires about four times per second of real time. At normal speed the
 * gap is therefore ~0.25 s, and it grows in proportion to the playback rate:
 * ~0.5 s at ×2. The threshold has to account for that, otherwise watching at
 * speed would reject time that was genuinely watched.
 *
 * The margin is wide because a background tab receives its events less often —
 * better to accept slightly too much than to lose tracking.
 *
 * @param {number} rate  current playback rate
 */
const maxPlaybackStep = (rate) => Math.max(2, (rate || 1) * 2.5);

/** Position from which we consider the end reached. */
const NEAR_END_POSITION = 0.98;

/** Minimum coverage required when concluding from the final position. */
const NEAR_END_MIN_COVERAGE = 0.5;

/**
 * The main player of the page.
 *
 * The id is the anchor point of the whole module. YouTube's other players carry
 * their own — `inline-player` for the hover preview of a thumbnail,
 * `shorts-player` for Shorts, `c4-player` for a channel trailer — and none of
 * them must count: hovering a thumbnail is not a view, and Shorts enter nowhere
 * in this extension.
 */
const player = () => document.getElementById('movie_player');

/** The media element of the main player, if it exists. */
const media = () => player()?.querySelector('video') ?? null;

/**
 * Is an advertisement playing right now?
 *
 * It occupies the same `<video>` element as the video, with its own duration
 * and its own position. Confusing the two does not merely add extra time: a
 * fifteen second ad watched to the end looks exactly like a video watched in
 * full, and is enough to declare watched a video that has only just been
 * opened.
 */
const adPlaying = () => Boolean(player()?.classList.contains('ad-showing'));

/** Shorts enter no record at all, whichever player is used. */
const onShorts = () => location.pathname.startsWith('/shorts');

/**
 * Has the extension context died under the feet of the page?
 *
 * Reloading the extension — which happens on every new version during testing —
 * cuts the link between already open pages and the service worker. The page's
 * code keeps running, but nothing it sends arrives any more: the views of those
 * tabs are lost without the slightest message. `chrome.runtime.id` disappears
 * in that case, and it is the only signal available before trying to write.
 */
const orphaned = () => !chrome.runtime?.id;

let installed = false;

/** The orphan tab banner only appears once. */
let orphanReported = false;

/** Access to the MAIN world: it alone knows which video the player has loaded. */
let askPlayer = null;

/** The current session, or `null` if nothing is playing. */
let session = null;

let probeTimer = null;
let reportTimer = null;
let lastProbe = 0;
let probeRequested = true;
let probing = false;

/**
 * Opens a session for the video the player has just loaded.
 *
 * The opening instant is fixed once and for all: it is what identifies the
 * session in the database, and if it followed the clock on every report a one
 * hour video would leave two hundred history rows instead of one. Reopening the
 * same video later gives a new timestamp, hence a new session — exactly what
 * Takeout does, which notes every opening.
 */
function openSession(videoId, details) {
  session = {
    videoId,
    startedAt: Date.now(),
    /** Playback time actually elapsed, seek jumps excluded. */
    watchedSeconds: 0,
    lastTime: null,
    reachedEnd: false,
    lastReported: 0,
    lastRecorded: 0,
    details: details?.videoId === videoId ? details : null,
    /**
     * Last duration and last position seen **for this video**.
     *
     * Re-reading the `<video>` element at write time would be a mistake:
     * YouTube reuses the same element from one video to the next, and the
     * closing write arrives precisely when the next one is already loaded. We
     * would then attribute to the ending session the duration of the one
     * starting, and a barely opened video would pass for fully watched.
     */
    duration: null,
    position: 0,
  };

  // The settings are re-read on every video: a change must apply without
  // reloading the page.
  loadSettings().catch(() => { watchedRatio = DEFAULT_WATCHED_RATIO; });

  // The title and the channel are looked up right away, and not on the first
  // write: by the time the page is being left it is too late to wait for an
  // answer, and a session written without them is a session the analysis will
  // leave out of all its rankings.
  resolveDetails();
  setTimeout(resolveDetails, 1500);
  setTimeout(resolveDetails, 5000);

  scheduleReport(FIRST_REPORT_MS);
  log.debug(`Session opened on ${videoId}`);
}

/** Closes the current session after one last write. */
async function closeSession() {
  if (!session) return;
  const finished = session;
  await write(true).catch((err) => log.debug('Session not written', err));
  if (session === finished) session = null;
  clearTimeout(reportTimer);
  reportTimer = null;
}

/**
 * Fills in the title, the channel and the duration of the current session.
 *
 * Retried several times: the player's data arrives slightly late on an internal
 * navigation, and the channel id later still than the title.
 */
async function resolveDetails() {
  const s = session;
  if (!s || !askPlayer) return;
  if (s.details?.channelId && s.details?.title) return;

  const read = (await askPlayer().catch(() => null))?.details;
  if (!read || read.videoId !== s.videoId || session !== s) return;

  // A merge and not a replacement: one source may bring the title without the
  // channel, another the opposite.
  s.details = {
    videoId: s.videoId,
    title: read.title ?? s.details?.title ?? null,
    channelId: read.channelId ?? s.details?.channelId ?? null,
    channelTitle: read.channelTitle ?? s.details?.channelTitle ?? null,
    durationSec: read.durationSec ?? s.details?.durationSec ?? null,
  };
}

/** What the current session amounts to, in the shape the database expects. */
function snapshot() {
  const s = session;
  if (!s) return null;

  const known = s.details?.durationSec;
  const duration = s.duration
    ?? (Number.isFinite(known) && known > 0 ? known : null);
  const position = duration ? Math.min(1, s.position / duration) : 0;
  const coverage = duration ? Math.min(1, s.watchedSeconds / duration) : 0;

  // Three signals, each covering a blind spot of the others:
  //  - playback went all the way to the end (the surest);
  //  - the time actually covered accounts for most of the video;
  //  - we are at the very end after having seen at least half — the case of
  //    someone who skips the intro then watches the rest, where coverage alone
  //    would stay under the threshold on a short video.
  // A simple drag of the scrubber to the end satisfies none of the three, since
  // it accumulates no time.
  const completed = s.reachedEnd
    || (duration !== null && coverage >= watchedRatio)
    || (duration !== null && position >= NEAR_END_POSITION && coverage >= NEAR_END_MIN_COVERAGE);

  return { s, duration, position, completed };
}

/** The history message corresponding to the current session. */
function historyMessage({ s, duration, completed }) {
  return {
    type: MSG.WATCH_RECORD,
    videoId: s.videoId,
    watchedAt: s.startedAt,
    title: s.details?.title ?? null,
    channelId: s.details?.channelId ?? null,
    channelTitle: s.details?.channelTitle ?? null,
    // The player's duration is authoritative: it is exact and free, where
    // enrichment has to ask YouTube video by video.
    durationSec: duration,
    watchedSec: Math.round(s.watchedSeconds),
    completed: Boolean(completed),
    // A view recorded under an account other than the one owning the database
    // does not enter it: the history would then be used to measure streaks and
    // habits that would be nobody's.
    key: activeAccountKey(),
  };
}

/**
 * Records the session and updates the feed.
 *
 * The history row is rewritten on every report rather than appended: the key is
 * that of the session, so the database always keeps the most complete
 * measurement. We only rewrite if the watched time has moved appreciably — a
 * paused tab has nothing new to tell.
 */
async function write(force = false) {
  const view = snapshot();
  if (!view) return;
  const { s, duration, position, completed } = view;

  if (historyEnabled
      && s.watchedSeconds >= MIN_HISTORY_SECONDS
      && (force || s.watchedSeconds - s.lastRecorded >= 10)) {
    s.lastRecorded = s.watchedSeconds;
    // One last attempt at resolution before writing: a slightly delayed write
    // beats a session with no channel.
    if (!s.details?.channelId) await resolveDetails();
    const { type, ...payload } = historyMessage({ s, duration, completed });
    await send(type, payload);
  }

  // The history does not care about the position; the feed cares about nothing
  // else. Opening a three hour talk and watching two minutes of it is still a
  // view, without the thumbnail having to change state.
  if (duration === null) return;
  if (position < MIN_MEANINGFUL_RATIO && !completed) return;
  if (!force && position - s.lastReported < 0.05) return;
  s.lastReported = position;

  await send(MSG.SET_WATCHED, {
    id: s.videoId,
    // The position feeds the red bar on the thumbnail…
    progress: position,
    // …but only the time actually covered decides the "watched" status.
    completed,
  });
}

/**
 * The last second write, as the page goes away.
 *
 * Nothing is awaited here, not even a detail resolution: from `pagehide`
 * onwards, anything going through a promise stands a good chance of never
 * getting control back. The messages are therefore posted as is, on data
 * already in memory. That is also why the title and the channel are looked up
 * when the session opens and not here.
 */
function writeOnLeave() {
  if (orphaned()) return;
  const view = snapshot();
  if (!view) return;
  const { s, duration, position, completed } = view;

  const quiet = () => { /* the page is leaving: nobody to hear the answer */ };

  if (historyEnabled && s.watchedSeconds >= MIN_HISTORY_SECONDS) {
    try {
      chrome.runtime.sendMessage(historyMessage({ s, duration, completed }))?.catch?.(quiet);
    } catch { quiet(); }
  }

  if (duration !== null && (position >= MIN_MEANINGFUL_RATIO || completed)) {
    try {
      chrome.runtime.sendMessage({
        type: MSG.SET_WATCHED, id: s.videoId, progress: position, completed,
      })?.catch?.(quiet);
    } catch { quiet(); }
  }
}

function scheduleReport(delay = REPORT_MS) {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(async () => {
    await write().catch((err) => log.debug('Playback report failed', err));
    if (session) scheduleReport();
  }, delay);
}

/**
 * Asks the player what it is playing, and opens or closes the session
 * accordingly.
 *
 * This is the only place that decides on a change of video. Everything else
 * merely raises the flag: a `loadstart`, an internal navigation, playback
 * resuming with no session open.
 */
async function checkPlayer() {
  if (probing) return;
  probing = true;
  lastProbe = Date.now();
  probeRequested = false;

  try {
    if (onShorts() || !media()) { await closeSession(); return; }

    const info = await askPlayer?.().catch(() => null);
    let videoId = info?.videoId ?? null;

    // Fallback when the MAIN world does not answer: on a `/watch` page, the URL
    // tells the truth. Elsewhere — in miniplayer mode notably — it says
    // nothing, and opening nothing beats opening the wrong session.
    if (!videoId && location.pathname.startsWith('/watch')) {
      videoId = new URL(location.href).searchParams.get('v');
    }

    if (!videoId) { await closeSession(); return; }
    if (session?.videoId === videoId) return;

    await closeSession();
    openSession(videoId, info?.details ?? null);
  } finally {
    probing = false;
  }
}

/** Notes that the player will have to be asked again, without doing it now. */
function requestProbe() {
  probeRequested = true;
}

/**
 * Warns that this tab no longer counts, and offers to repair it.
 *
 * Without this banner, an update of the extension leaves behind tabs that look
 * normal but where no view is recorded any more. It is the worst kind of
 * failure: silent, and contrary to the promise made to the user that their
 * history builds itself.
 *
 * The style is written here and not in a stylesheet: the extension's resources
 * are no longer reachable from an orphaned page.
 */
function reportOrphan() {
  if (orphanReported) return;
  orphanReported = true;

  clearInterval(probeTimer);
  clearTimeout(reportTimer);
  session = null;
  log.debug('Extension context invalidated: tracking stopped');

  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;'
    + 'display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;'
    + 'background:#07070e;color:#e9e9f5;border:1px solid #25253c;'
    + 'font:500 13px/1.4 Roboto,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4)';

  const text = document.createElement('span');
  text.textContent = t('watch.orphan');
  bar.append(text);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = t('watch.orphan.reload');
  button.style.cssText = 'cursor:pointer;border:0;border-radius:8px;padding:6px 12px;'
    + 'background:#e9e9f5;color:#07070e;font:500 13px Roboto,Arial,sans-serif';
  button.addEventListener('click', () => location.reload());
  bar.append(button);

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.setAttribute('aria-label', t('watch.orphan.close'));
  close.style.cssText = 'cursor:pointer;border:0;background:none;color:#9a9ab0;'
    + 'font-size:14px;padding:0 2px';
  close.addEventListener('click', () => bar.remove());
  bar.append(close);

  document.body?.append(bar);
}

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

/**
 * Playback events, listened for on the document in the capture phase.
 *
 * `timeupdate` and its kin do not bubble, but capture sees them on the way
 * down, and YouTube's `<video>` element is replaced often enough that a
 * listener placed on it would be lost without warning. The trade off is that we
 * also see the page's other players, hence the filtering on the main player's
 * element.
 */
function onTimeUpdate(event) {
  const el = media();
  if (!el || event.target !== el) return;

  if (!session) { requestProbe(); return; }

  // For the length of an ad, the counter is simply suspended: resuming with the
  // old position would make an enormous gap, which the seek jump guard would
  // discard anyway.
  if (adPlaying()) { session.lastTime = null; return; }

  const now = el.currentTime;
  if (session.lastTime !== null) {
    const delta = now - session.lastTime;
    if (delta > 0 && delta <= maxPlaybackStep(el.playbackRate)) session.watchedSeconds += delta;
  }
  session.lastTime = now;

  // Read while the element is still playing that particular video: it is the
  // only window in which the question has a reliable answer.
  session.position = now;
  if (Number.isFinite(el.duration) && el.duration > 0) session.duration = el.duration;
}

function onLoad(event) {
  if (event.target !== media()) return;
  // The next video is already loading: the current session has nothing left to
  // measure, and we need to know which one takes its place.
  requestProbe();
  checkPlayer().catch(() => {});
}

function onEnded(event) {
  if (event.target !== media() || adPlaying()) return;
  if (session) session.reachedEnd = true;
  write(true).catch(() => {});
}

function onVisibility() {
  // A hidden tab has its timers throttled: we write before, not after.
  if (document.visibilityState === 'hidden') writeOnLeave();
}

/**
 * Installs tracking for this tab. Called once, and not on every page.
 *
 * @param {{readPlayer?: () => Promise<{videoId: string | null,
 *   details: object | null} | null>}} [bridges]
 *   Access to the MAIN world, where the id of the playing video, the title, the
 *   channel and the duration come from. Passed as a parameter rather than
 *   imported: the module that exposes it imports this one.
 */
export function installWatchTracking({ readPlayer = null } = {}) {
  if (installed) return;
  installed = true;
  askPlayer = readPlayer;

  document.addEventListener('timeupdate', onTimeUpdate, true);
  document.addEventListener('loadstart', onLoad, true);
  document.addEventListener('emptied', onLoad, true);
  document.addEventListener('ended', onEnded, true);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', writeOnLeave);

  probeTimer = setInterval(() => {
    if (orphaned()) { reportOrphan(); return; }
    const el = media();
    // Three reasons to ask again: something changed, playback is running with
    // no session open, or the safety net has come due.
    const needed = probeRequested
      || (!session && el && !el.paused)
      || (session && Date.now() - lastProbe > PROBE_SAFETY_MS);
    if (needed) checkPlayer().catch(() => {});
  }, PROBE_MS);

  checkPlayer().catch(() => {});
  log.debug('Watch tracking installed');
}

/**
 * Signals an internal navigation.
 *
 * A navigation closes nothing by itself: leaving `/watch` while playback
 * continues in the miniplayer must leave the session open. It merely makes the
 * question interesting.
 */
export function nudgeWatchTracking() {
  requestProbe();
  checkPlayer().catch(() => {});
}

/** Closes the current session, without uninstalling the listeners. */
export function stopWatchTracking() {
  closeSession().catch(() => {});
}
