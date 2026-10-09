/**
 * Client for YouTube's internal API, as the page itself uses it.
 *
 * Why this detour rather than the public Data v3 API: that one gives access to
 * nothing personal with a plain key. Reading your own subscriptions or dropping
 * them requires OAuth — hence a Google Cloud project, a consent screen, and
 * fifty quota units per unsubscription, that is two hundred a day at most. The
 * internal API, meanwhile, is already authenticated by the session open in the
 * browser: nothing to configure, no quota.
 *
 * What it replaces, measured on an account with 902 subscriptions:
 *
 * - the import used to unroll the `/feed/channels` page by scrolling it for a
 *   minute; it is now five requests and about one second;
 * - unsubscribing used to drive the interface in a background tab, which took
 *   some fifteen seconds per channel when it worked at all — YouTube does not
 *   build its menus in an unpainted tab; it is now a 150 ms call.
 *
 * The trade off is real: this API is undocumented and can change without
 * notice. But the solution it replaces depended on YouTube's DOM and
 * animations, which is strictly more fragile.
 *
 * The call goes out from the isolated world: it needs the page's cookies — same
 * origin, so `credentials: 'include'` is enough — and the right to talk to the
 * service worker. Only the configuration (`ytcfg`) lives in the MAIN world,
 * hence the round trip at startup.
 */

import { askMainWorld } from './main.js';
import { pickAudio, audioCandidates, range } from '../lib/innertube-parse.js';
import { log } from '../lib/log.js';
import { parseCompactCount } from '../lib/util.js';
import {
  readText, extractPlaylistVideos, extractContinuation, extractOwnerAvatar,
  mergeVideoTabEntries, channelTabBody, hasDeclaredVideoGrid,
  extractHistorySections, parseHistoryDay, extractSubscriptionFeedVideos, extractPlayerFacts,
} from '../lib/innertube-parse.js';

const ORIGIN = 'https://www.youtube.com';
const RE_CHANNEL_ID = /^UC[\w-]{22}$/;
const RE_VIDEO_ID = /^[\w-]{11}$/;
// Public calls use the current page's YouTube web-client configuration, but
// only its client fields and no account cookies or authentication headers.

/** Configuration read once per page. */
let config = null;

async function getConfig() {
  if (config) return config;
  const res = await askMainWorld('innertube-config');
  if (!res?.key || !res?.context) return null;
  config = res;
  return config;
}

/**
 * Authentication token the internal API expects.
 *
 * YouTube signs its own calls this way: the SHA-1 digest of
 * `timestamp space SAPISID space origin`. The cookie is readable from
 * youtube.com, so nothing is being bypassed here — we reproduce exactly what
 * the page does, with the same rights as the signed in user.
 */
async function authorization() {
  const sapisid = document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1]
    ?? document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1];
  if (!sapisid) return null;

  const seconds = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    'SHA-1', new TextEncoder().encode(`${seconds} ${sapisid} ${ORIGIN}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${seconds}_${hex}`;
}

/**
 * One call to the internal API. Returns `null` on failure, never throws.
 *
 * `hl` overrides the interface language for this call only. It exists for the
 * history, whose dates are given as prose in the heading of each section and
 * nowhere else; everywhere else the site's own language is the right one.
 */
async function call(endpoint, body, { hl = null, authenticated = true } = {}) {
  const cfg = await getConfig();
  if (!cfg) { log.warn('Innertube configuration not found'); return null; }

  const auth = authenticated ? await authorization() : null;
  if (authenticated && !auth) { log.warn('YouTube session not identifiable'); return null; }

  // Public channel pages need only the web-client context. Keeping account and
  // request fields while omitting the cookie can make Chromium variants reject
  // an otherwise public call as a malformed signed request.
  const publicClient = cfg.context.client ?? {};
  const baseContext = authenticated
    ? cfg.context
    : { client: {
      clientName: 'WEB', clientVersion: publicClient.clientVersion,
      hl: publicClient.hl ?? 'en', gl: publicClient.gl ?? 'US',
    } };
  const context = hl
    ? { ...baseContext, client: { ...baseContext.client, hl, gl: 'US' } }
    : baseContext;
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    headers.Authorization = auth;
    headers['X-Origin'] = ORIGIN;
    headers['X-Goog-AuthUser'] = String(cfg.sessionIndex ?? 0);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?key=${cfg.key}&prettyPrint=false`, {
      method: 'POST',
      credentials: authenticated ? 'include' : 'omit',
      headers,
      body: JSON.stringify({ context, ...body }),
      signal: controller.signal,
    });
    if (!res.ok) { log.warn(`Innertube ${endpoint}: HTTP ${res.status}`); return null; }
    return await res.json();
  } catch (err) {
    log.warn(`Innertube ${endpoint} unreachable`, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Is the internal API usable on this page? */
export async function innertubeAvailable({ authenticated = true } = {}) {
  if (!await getConfig()) return false;
  return !authenticated || Boolean(await authorization());
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Leaves a channel.
 * @returns {Promise<boolean>} true if YouTube accepted
 */
export async function unsubscribeChannel(channelId) {
  if (!RE_CHANNEL_ID.test(channelId)) return false;
  const res = await call('subscription/unsubscribe', { channelIds: [channelId], params: '' });
  return Boolean(res?.actions ?? res?.responseContext);
}

/**
 * Joins a channel. Used to undo an unsubscription — knowing that the original
 * subscription date and the notification setting are lost.
 */
export async function subscribeChannel(channelId) {
  if (!RE_CHANNEL_ID.test(channelId)) return false;
  const res = await call('subscription/subscribe', { channelIds: [channelId], params: '' });
  return Boolean(res?.actions ?? res?.responseContext);
}

/**
 * The whole subscription list, in a few requests.
 *
 * Walking the continuations is bounded: a pagination that stops making progress
 * must stop, not go round in circles.
 *
 * @param {(n: number) => void} [onProgress]
 * @returns {Promise<{channels: Array<{id: string, title: string, avatarUrl: string}>, complete: boolean}>}
 */
export async function listSubscriptions(onProgress) {
  const found = new Map();
  let token = null;
  let complete = false;

  for (let round = 0; round < 40; round++) {
    const res = await call('browse', token ? { continuation: token } : { browseId: 'FEchannels' });
    if (!res) break;

    for (const channel of extractChannels(res)) {
      if (!found.has(channel.id)) found.set(channel.id, channel);
    }
    onProgress?.(found.size);

    token = extractContinuation(res);
    if (!token) { complete = true; break; }
  }

  return { channels: [...found.values()], complete };
}

// ---------------------------------------------------------------------------
// Native subscriptions feed audit
// ---------------------------------------------------------------------------

/**
 * Reads the authenticated source used by YouTube to build the Subscriptions
 * page. It works from any open YouTube tab, including while TrackTube's grid is
 * covering that page, so the audit never needs to disable the extension.
 */
export async function fetchSubscriptionsFeed(windowDays = 7) {
  const now = Date.now();
  const since = now - Math.max(1, Number(windowDays) || 7) * 86_400_000;
  const found = new Map();
  let token = null;
  let coveredWindow = false;
  let complete = false;
  let boundaryUnknownCount = 0;

  for (let page = 0; page < 60; page++) {
    const response = await call(
      'browse',
      token ? { continuation: token } : { browseId: 'FEsubscriptions' },
      { hl: 'en' },
    );
    if (!response) return { ok: false, reason: 'source-unavailable', videos: [...found.values()] };

    const pageVideos = extractSubscriptionFeedVideos(response, now);
    const datedOnPage = pageVideos.filter((video) => Number.isFinite(video.publishedAt));
    const beyondWindow = pageVideos.filter(
      (video) => Number.isFinite(video.publishedAt) && video.publishedAt <= since,
    ).length;
    // Several boundary rows are required: one unusually old card must not stop
    // a chronological walk before the requested period is really covered.
    const reachesBoundary = datedOnPage.length
      && beyondWindow >= Math.min(3, datedOnPage.length);
    const accepted = reachesBoundary
      // On the boundary page, an undated card may be either side of the cut.
      // Excluding it beats calling a four month old video a weekly omission.
      ? pageVideos.filter((video) => Number.isFinite(video.publishedAt) && video.publishedAt >= since)
      : pageVideos;
    for (const video of accepted) {
      if (!found.has(video.id)) found.set(video.id, video);
    }

    if (reachesBoundary) {
      boundaryUnknownCount = pageVideos.filter((video) => !Number.isFinite(video.publishedAt)).length;
      coveredWindow = true;
      break;
    }

    token = extractContinuation(response);
    if (!token) { complete = true; coveredWindow = true; break; }
  }

  return {
    ok: true,
    videos: [...found.values()],
    coveredWindow,
    complete,
    boundaryUnknownCount,
  };
}

// ---------------------------------------------------------------------------
// Watch history
// ---------------------------------------------------------------------------

/**
 * The recently watched videos, as the History page shows them.
 *
 * This source was thought closed — the public API has not exposed it since
 * 2016, and a manual Takeout export was the only way. But YouTube's own
 * interface does display that history, so its internal API serves it: one
 * request, two hundred entries, less than a second. That is what makes it
 * possible to know a video has been watched **elsewhere** — on a phone, a TV,
 * another browser — without asking the user anything.
 *
 * The progress only comes with videos left partway through: YouTube only shows
 * a resume bar there. An entry without progress is therefore a video that went
 * to its end.
 *
 * @param {{max?: number}} [opts]
 * @returns {Promise<Array<{videoId: string, percent: number | null}>>}
 */
export async function listWatchHistory({ max = 200 } = {}) {
  const out = [];
  const seen = new Set();
  let token = null;

  for (let round = 0; round < 4 && out.length < max; round++) {
    const res = await call('browse', token ? { continuation: token } : { browseId: 'FEhistory' });
    if (!res) break;

    for (const v of extractHistoryVideos(res)) {
      if (seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      out.push(v);
    }

    token = extractContinuation(res);
    if (!token) break;
  }

  return out.slice(0, max);
}

function extractHistoryVideos(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);

  const lockup = node.lockupViewModel;
  if (lockup?.contentId && lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    out.push({ videoId: lockup.contentId, percent: findPercentWatched(lockup) });
  }

  const legacy = node.videoRenderer;
  if (legacy?.videoId) {
    out.push({ videoId: legacy.videoId, percent: findPercentWatched(legacy) });
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') extractHistoryVideos(value, out, seen);
  }
  return out;
}

/** Resume progress, when YouTube displays one. */
function findPercentWatched(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'percentDurationWatched' && Number.isFinite(Number(value))) return Number(value);
    if (value && typeof value === 'object') {
      const found = findPercentWatched(value, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * One page of the watch history, sections and headings kept together.
 *
 * The heading of a section is the only date the history gives: no entry there
 * carries a timestamp. That is why this function returns the sections rather
 * than a flat list, and why it asks for them **in English** — `hl` is forced on
 * this call and on no other. Reading "Mercredi", "Mittwoch" or "水曜日" would
 * mean one parsing table per interface language, for the one field the whole
 * operation depends on. Nothing else in the response is read as text.
 *
 * A section whose heading cannot be read is dropped whole rather than filed
 * under a guessed date: a viewing on the wrong day is worse than a viewing
 * missing. Measured on 28 August 2026, over a complete history — 2 495 sections
 * back to March 2020 — not one heading resisted.
 *
 * @param {string | null} token continuation, or null for the first page
 * @param {number} [now] reference for "Today", "Yesterday" and the weekdays
 * @returns {Promise<{entries: Array<object>, continuation: string | null,
 *   oldest: number | null, dropped: number} | null>}
 */
export async function fetchHistoryPage(token = null, now = Date.now()) {
  const res = await call(
    'browse',
    token ? { continuation: token } : { browseId: 'FEhistory' },
    { hl: 'en' },
  );
  if (!res) return null;

  const entries = [];
  let oldest = null;
  let dropped = 0;

  for (const section of extractHistorySections(res)) {
    const watchedAt = parseHistoryDay(section.label, now);
    if (watchedAt === null) { dropped += section.entries.length; continue; }
    for (const entry of section.entries) entries.push({ ...entry, watchedAt });
    if (oldest === null || watchedAt < oldest) oldest = watchedAt;
  }

  return { entries, continuation: extractContinuation(res), oldest, dropped };
}

// ---------------------------------------------------------------------------
// A channel's videos
// ---------------------------------------------------------------------------

/**
 * The videos of a channel's uploads playlist, with their duration.
 *
 * This is what makes the public API key useless for durations: one request
 * brings back a hundred videos at once, duration included, where the Data v3
 * API needed a key, a Google Cloud project and quota.
 *
 * The `UULF` prefix selects long form videos only — Shorts are ruled out at the
 * source, as with the Atom feeds. `UUSH` does the opposite and returns only
 * Shorts, which serves to know which ones to rule out elsewhere. `UULV` returns
 * live broadcasts and their replays, which `UULF` ignores.
 *
 * @param {string} channelId
 * @param {{max?: number, kind?: 'long'|'shorts'|'lives'|'all', stopAtIds?: string[], includeAvatar?: boolean}} [opts]
 * @returns {Promise<Array<{id: string, title: string, durationSec: number | null, isLive: boolean, isUpcoming: boolean, scheduledAt: number | null}>>}
 */
export async function listChannelUploads(channelId, opts = {}) {
  return (await fetchChannelUploads(channelId, opts)).videos;
}

/**
 * Undocumented playlist prefixes, which replace `UC` in the channel id: `UU`
 * for everything, `UULF` for long form videos, `UUSH` for Shorts. That is what
 * makes it possible to sort at the source rather than guess from the duration,
 * which no longer distinguishes anything now that Shorts run up to three
 * minutes.
 */
const PLAYLIST_PREFIX = { all: 'UU', long: 'UULF', shorts: 'UUSH', lives: 'UULV' };

// Endpoint used by YouTube's own Videos tab, sorted newest first. Unlike the
// synthetic uploads playlists, this asks the channel page for the exact tab the
// user sees. UULF remains available below as a compatibility fallback.
const CHANNEL_VIDEOS_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';
const CHANNEL_STREAMS_PARAMS = 'EgdzdHJlYW1z8gYECgJ6AA==';

/**
 * Reads a channel's real Videos/Live grid. Window scans continue past known
 * ids; only a wholly dated older page or the end of the grid proves a boundary.
 */
export async function fetchChannelVideosTab(
  channelId,
  { max = 100, stopAtIds = [], includeAvatar = false, since = 0, kind = 'videos' } = {},
) {
  if (!RE_CHANNEL_ID.test(channelId)) return { videos: [], avatarUrl: null, ok: false };

  const stopIds = new Set((Array.isArray(stopAtIds) ? stopAtIds : [])
    .filter((id) => RE_VIDEO_ID.test(id)));
  const out = [];
  const seen = new Set();
  let avatarUrl = null;
  let token = null;
  let ok = false;
  let coveredWindow = false;
  let reason = 'limit';
  const tokens = new Set();

  for (let round = 0; round < 40 && out.length < max; round++) {
    const res = await call('browse', token
      ? { continuation: token }
       : { browseId: channelId, params: kind === 'lives' ? CHANNEL_STREAMS_PARAMS : CHANNEL_VIDEOS_PARAMS }, { hl: 'en', authenticated: false });
    if (!res) { reason = 'request-failed'; break; }
    const selected = channelTabBody(res, kind);
    if (selected.absent) return { videos: [], avatarUrl, ok: true, coveredWindow: true, partial: false, reason: 'tab-absent' };
    if (!selected.body) { reason = 'unexpected-tab'; break; }
    if (includeAvatar) avatarUrl ??= extractOwnerAvatar(res);

    // Channel tabs currently use rich-grid videoRenderer/lockup cards, while
    // older responses used playlist renderers. Read the declared grid first;
    // retain the older parser as a compatibility path.
    const gridVideos = extractSubscriptionFeedVideos(selected.body);
    const detailedVideos = extractPlaylistVideos(selected.body, [], new Set(), max);
    if (!hasDeclaredVideoGrid(selected.body) && !detailedVideos.some(video => video.playlistEntry)) {
      reason = 'unrecognised-response'; break;
    }
    ok = true;
    // The grid parser owns the relative publication date; the lockup parser
    // owns the duration badge. Choosing one used to throw the other half away
    // and forced a fragile player request per video. Merge both views of the
    // very same declared Videos grid instead.
    const pageVideos = mergeVideoTabEntries(gridVideos, detailedVideos, max).map((video) =>
      kind === 'lives' ? { ...video, sourceKind: 'lives-tab', wasLive: true } : video);
    for (const video of pageVideos) {
      if (!seen.has(video.id)) {
        seen.add(video.id);
        out.push(video);
      }
    }
    // An overlap is insufficient to prove coverage: holes can be on later
    // pages. Explicit window scans continue through every page in that window.
    const dated = pageVideos.filter(video => !video.isUpcoming);
    if (since > 0 && dated.length > 0 && dated.every((video) => Number.isFinite(video.publishedAt)
      && video.publishedAt < since)) {
      coveredWindow = true; reason = 'boundary'; break;
    }
    token = extractContinuation(res);
    if (!token) { coveredWindow = true; reason = 'end'; break; }
    if (!since && pageVideos.some((video) => stopIds.has(video.id))) { reason = 'overlap'; break; }
    if (!pageVideos.length || tokens.has(token)) { reason = 'no-progress'; break; }
    tokens.add(token);
  }

  return { videos: out.slice(0, max), avatarUrl, ok, coveredWindow,
    partial: !coveredWindow, reason };
}

/**
 * The same, plus what the response says about the channel itself.
 *
 * The owner's avatar travels in the same response as the videos: picking it up
 * along the way avoids one request per channel to get it. The only images
 * served from `yt3` in a playlist page are avatars — video thumbnails come from
 * `i.ytimg.com` — hence recognition by host rather than by a path frozen into
 * the structure.
 *
 * `stopAtIds` contains recent ids already stored locally. The complete current
 * page is still returned, so a hole older than the first known item is repaired;
 * only the next continuation is skipped once an overlap has been established.
 *
 * @returns {Promise<{videos: Array<{id, title, durationSec}>, avatarUrl: string | null}>}
 */
export async function fetchChannelUploads(
  channelId,
  { max = 100, kind = 'long', stopAtIds = [], includeAvatar = true } = {},
) {
  if (!RE_CHANNEL_ID.test(channelId)) return { videos: [], avatarUrl: null };

  const playlistId = `${PLAYLIST_PREFIX[kind] ?? 'UULF'}${channelId.slice(2)}`;
  const stopIds = new Set((Array.isArray(stopAtIds) ? stopAtIds : [])
    .filter((id) => RE_VIDEO_ID.test(id)));
  const out = [];
  let avatarUrl = null;
  let token = null;
  let ok = false;

  // One page returns a hundred videos; beyond that the continuations have to be
  // followed, hence one request per hundred. The round cap stays wide so that
  // the effective bound is `max` and not the number of round trips.
  for (let round = 0; round < 8 && out.length < max; round++) {
    const res = await call('browse', token
      ? { continuation: token }
       : { browseId: `VL${playlistId}` }, { hl: 'en', authenticated: false });
    if (!res) break;
    ok = true;

    if (includeAvatar) avatarUrl ??= extractOwnerAvatar(res);
    const pageVideos = extractPlaylistVideos(res, [], new Set(), max);
    for (const video of pageVideos) {
      if (!out.some((v) => v.id === video.id)) out.push(video);
    }

    if (pageVideos.some((video) => stopIds.has(video.id))) break;
    token = extractContinuation(res);
    if (!token) break;
  }

  return { videos: out.slice(0, max), avatarUrl, ok };
}

/** Exact facts read with the same authenticated session as the channel tab. */
export async function fetchAuthenticatedVideoFacts(videoId) {
  if (!RE_VIDEO_ID.test(videoId)) return null;
  const res = (await innertubeAvailable()
    ? await call('player', { videoId }, { hl: 'en' }) : null)
    ?? await call('player', { videoId }, { hl: 'en', authenticated: false });
  return res ? extractPlayerFacts(res, videoId) : null;
}

/**
 * A channel's avatar through a dedicated request.
 *
 * Fallback for channels whose playlist page does not carry the image — a
 * channel with no long form upload, for instance. One call per channel, so to
 * be reserved for channels actually on display.
 */
export async function fetchChannelAvatar(channelId) {
  if (!RE_CHANNEL_ID.test(channelId)) return null;
  const res = await call('browse', { browseId: channelId }, { authenticated: false });
  return res ? extractOwnerAvatar(res) : null;
}

// ---------------------------------------------------------------------------
// Hover preview
// ---------------------------------------------------------------------------

/**
 * The six second animation YouTube plays inside its own thumbnails.
 *
 * It lives at `i.ytimg.com/an_webp/<id>/mqdefault_6s.webp`, but the bare URL
 * only returns a fixed 120 pixel placeholder: it is the `sqp`/`rs` signature
 * attached to the URL that unlocks the animation at 320 by 180. That signature
 * cannot be manufactured, it has to be read from an internal API response — and
 * a single endpoint carries it. `browse` on a channel's videos tab, like on the
 * uploads playlist, never returned a single `movingThumbnailRenderer`, nor did
 * the `ytInitialData` of the subscriptions page; `search` with the video id as
 * the query does.
 *
 * The call is deliberately anonymous, unlike every other one in this file:
 * without a cookie, the search does not land in the user's search history and
 * weighs on no recommendation. It therefore needs its own `fetch` rather than
 * `call`, and a minimal context — the key and the client version are enough to
 * get an answer.
 *
 * @param {string} videoId
 * @returns {Promise<string|null>} the signed URL, or `null` if this video has
 *   no animation — not all of them do, roughly three in four have one
 */
export async function fetchMovingThumbnail(videoId) {
  if (!RE_VIDEO_ID.test(videoId)) return null;
  const cfg = await getConfig();
  if (!cfg) return null;

  const client = cfg.context?.client ?? {};
  try {
    const res = await fetch(`${ORIGIN}/youtubei/v1/search?key=${cfg.key}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: client.clientVersion ?? '2.20240101.00.00',
            hl: client.hl ?? 'fr',
            gl: client.gl ?? 'FR',
          },
        },
        query: videoId,
      }),
    });
    if (!res.ok) return null;
    return extractMovingThumbnail(await res.json(), videoId);
  } catch (err) {
    log.warn('Moving thumbnail unreachable', err);
    return null;
  }
}

/**
 * The context of an iPhone, as the YouTube app presents itself.
 *
 * It is the only client tried that returns a playable stream, and it only does
 * so without a session. Measured, one by one: WEB, MWEB, ANDROID, the embedded
 * player and the TV one all answer `UNPLAYABLE` without a cookie; with a
 * cookie, the WEB client answers fine but its stream returns 403, for want of
 * the attestation token YouTube now demands of its own player. This one returns
 * direct URLs, unencrypted, valid as they are, and which honour range requests
 * — hence readable by a `video` element.
 */
const CLIENT_IOS = {
  clientName: 'IOS',
  clientVersion: '20.10.4',
  deviceMake: 'Apple',
  deviceModel: 'iPhone16,2',
  osName: 'iPhone',
  osVersion: '18.3.2.22D82',
};

/**
 * Everything needed for a video preview, in a single anonymous call.
 *
 * The response carries two things. The stream first, which the thumbnail
 * actually plays. Then the storyboards: the images YouTube shows when you sweep
 * its progress bar, one every five seconds across the whole duration. They are
 * instantaneous where moving playback requires a transfer, and that is what
 * makes sweeping fluid.
 *
 * The call carries no cookie, like the moving thumbnail one. It sends no
 * watch-history or recommendation feedback report. It is not a view for all
 * that — the view counter is filled by playback reports, which nothing here
 * sends.
 *
 * @param {string} videoId
 * @param {number} minHeight height below which a stream is not worth offering
 * @returns {Promise<{storyboard: object|null,
 *   stream: {url: string, width: number, height: number}|null,
 *   duration: number} | null>}
 */
export async function fetchPreview(videoId, minHeight = 360, { signal } = {}) {
  if (!RE_VIDEO_ID.test(videoId)) return null;
  const cfg = await getConfig();
  if (!cfg) return null;

  const client = cfg.context?.client ?? {};
  let res;
  try {
    const rep = await fetch(`${ORIGIN}/youtubei/v1/player?key=${cfg.key}&prettyPrint=false`, {
      method: 'POST',
      signal,
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { ...CLIENT_IOS, hl: client.hl ?? 'fr', gl: client.gl ?? 'FR' } },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!rep.ok) return null;
    res = await rep.json();
  } catch (err) {
    if (err?.name !== 'AbortError') log.warn('Preview unreachable');
    return null;
  }

  if (res?.playabilityStatus?.status !== 'OK') return null;

  const spec = res.storyboards?.playerStoryboardSpecRenderer?.spec;
  return {
    storyboard: typeof spec === 'string' ? parseStoryboard(spec) : null,
    stream: pickStream(res.streamingData?.adaptiveFormats, minHeight),
    audio: pickAudio(res.streamingData?.adaptiveFormats),
    // Four and not three since the twins came back into the list: it now holds
    // each track twice, so three entries no longer reach the twin of the second
    // codec, which is the last chance of having any sound at all.
    audios: audioCandidates(res.streamingData?.adaptiveFormats).slice(0, 4),
    streams: streamCandidates(res.streamingData?.adaptiveFormats, minHeight).slice(0, 3),
    duration: Number(res.videoDetails?.lengthSeconds) || 0,
  };
}

/**
 * The lightest stream that meets the requested height.
 *
 * Only H.264 mp4 is kept: it is the codec every device decodes, and a grid may
 * chain a lot of them as the cursor moves. YouTube's adaptive formats separate
 * picture from sound, so this one is picture only — see `pickAudio` for the
 * other half.
 *
 * Failing that, the tallest available: a video that only exists in 240p beats a
 * frozen thumbnail.
 */
function pickStream(formats, minHeight) {
  return streamCandidates(formats, minHeight)[0] ?? null;
}

function streamCandidates(formats, minHeight) {
  if (!Array.isArray(formats)) return [];

  const usable = formats.filter((f) => (
    typeof f?.url === 'string'
    && typeof f.mimeType === 'string'
    && f.mimeType.startsWith('video/mp4')
    && f.mimeType.includes('avc1')
    && Number(f.height) > 0
  ));
  if (!usable.length) return [];
  const supported = usable.filter(f => range(f.initRange) && range(f.indexRange)
    && (typeof MediaSource !== 'function' || MediaSource.isTypeSupported(f.mimeType)));
  const pool = supported.length ? supported : usable;
  pool.sort((a, b) => a.height - b.height);
  const preferred = pool.find(f => f.height >= minHeight) ?? pool[pool.length - 1];
  const ordered = [preferred, ...pool.filter(f => f !== preferred)];

  // The full type, codec included, and the two header ranges: that is what is
  // needed to fetch the video piece by piece instead of downloading it from the
  // beginning.
  return ordered.map(chosen => ({
    url: chosen.url,
    width: Number(chosen.width),
    height: Number(chosen.height),
    mime: chosen.mimeType,
    init: range(chosen.initRange),
    index: range(chosen.indexRange),
    size: Number(chosen.contentLength) || 0,
  }));
}

/**
 * Turns the storyboard specification into something usable.
 *
 * Its shape: a URL template, then one descriptor per quality level, separated
 * by vertical bars. The template carries two placeholders, `$L` for the level
 * and `$N` for the sheet name. Each descriptor gives, in order, the width and
 * the height of one image, the total number of images, the columns and the rows
 * of one sheet, the interval in milliseconds, the sheet name to substitute, and
 * the signature.
 *
 * That signature is appended as a `sigh` parameter, which the format says
 * nowhere: the field holds the value alone. Glued to the URL as is, it gives a
 * missing image — the first thing that failed.
 */
function parseStoryboard(spec) {
  const parts = spec.split('|');
  const template = parts.shift();
  const levels = parts
    .map((desc, i) => ({ i, fields: desc.split('#') }))
    .filter(({ fields }) => fields.length >= 8 && Number(fields[0]) > 0 && Number(fields[2]) > 0);
  if (!template || !levels.length) return null;

  // A card thumbnail is around 540 pixels wide, and YouTube only publishes its
  // storyboards at 320 by 180 at best: measured, over several videos. The image
  // is therefore scaled up by half, and there is nothing to be done about it.
  // The cap is still set higher, so as to take a finer level the day a video
  // offers one, without ever pulling oversized sheets for a grid cell.
  const usable = levels.filter(({ fields }) => Number(fields[0]) <= 640);
  const chosen = (usable.length ? usable : levels)
    .reduce((a, b) => (Number(b.fields[0]) > Number(a.fields[0]) ? b : a));

  const [width, height, count, columns, rows, intervalMs, name, signature] = chosen.fields;
  const perSheet = Number(columns) * Number(rows);
  if (!perSheet) return null;

  const urls = [];
  for (let sheet = 0; sheet < Math.ceil(Number(count) / perSheet); sheet++) {
    urls.push(
      template
        .replace('$L', String(chosen.i))
        .replace('$N', name.replace('$M', String(sheet)))
      + `&sigh=${signature}`,
    );
  }

  return {
    urls,
    count: Number(count),
    columns: Number(columns),
    rows: Number(rows),
    intervalMs: Number(intervalMs),
    width: Number(width),
    height: Number(height),
  };
}

/**
 * Finds the node of the right video in the response, and its animation.
 *
 * Searching by id returns the requested video, but rarely alone: suggestions,
 * videos from the same channel, assorted shelves. Hence checking the id on the
 * node itself, rather than taking the first animation that comes along.
 */
function extractMovingThumbnail(node, videoId, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);

  if (node.videoId === videoId) {
    const url = node.richThumbnail?.movingThumbnailRenderer
      ?.movingThumbnailDetails?.thumbnails?.[0]?.url;
    if (typeof url === 'string' && url) return url;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = extractMovingThumbnail(value, videoId, seen);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extracts the channels from a `browse` response.
 *
 * A generic traversal rather than a frozen path: the structure of these
 * responses is deep and YouTube rearranges it regularly, whereas the shape of a
 * `channelRenderer` — an id, a title, a thumbnail — barely moves.
 */
function extractChannels(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);

  const renderer = node.channelRenderer ?? node.gridChannelRenderer;
  if (renderer?.channelId && RE_CHANNEL_ID.test(renderer.channelId)) {
    out.push({
      id: renderer.channelId,
      title: readText(renderer.title) || '',
      avatarUrl: pickAvatar(renderer.thumbnail?.thumbnails),
      subscriberCount: readSubscriberCount(renderer),
      handle: readHandle(renderer),
    });
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') extractChannels(value, out, seen);
  }
  return out;
}

/**
 * Subscriber count of a channel in the list.
 *
 * Mind the field names: YouTube has swapped them. In this response,
 * `videoCountText` holds "1.07M subscribers" and `subscriberCountText` holds
 * "@1nonly". Trusting the name would therefore systematically give the handle
 * instead of the count — hence recognition by content.
 *
 * @returns {number | null} an order of magnitude, not an exact value: YouTube
 *   itself only displays "1.07M".
 */
function readSubscriberCount(renderer) {
  for (const field of [renderer.videoCountText, renderer.subscriberCountText]) {
    const parsed = parseCompactCount(readText(field));
    if (parsed !== null) return parsed;
  }
  return null;
}

/** The `@name` handle, in whichever of the two fields carries it. */
function readHandle(renderer) {
  for (const field of [renderer.subscriberCountText, renderer.videoCountText]) {
    const text = readText(field)?.trim() ?? '';
    if (text.startsWith('@')) return text;
  }
  return null;
}

/** The largest thumbnail on offer, completed to https if need be. */
function pickAvatar(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return '';
  const best = thumbnails.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
  const url = String(best?.url ?? '');
  if (!url) return '';
  return url.startsWith('//') ? `https:${url}` : url;
}
