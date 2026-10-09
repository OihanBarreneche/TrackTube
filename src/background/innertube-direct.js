/**
 * Reading a channel's uploads without going through YouTube's cache.
 *
 * Why a second path when the Atom feeds work perfectly well: they are served by
 * a CDN with `Cache-Control: public, max-age=900` and no validator — no ETag,
 * no Last-Modified. Re-requesting a feed read less than a quarter of an hour
 * ago therefore returns exactly the same bytes, and no conditional request can
 * do any better. That is a limit of the distribution, not of the format.
 *
 * `youtubei/v1/browse` is a POST. Measured over five channels: the response
 * carries no cache header at all, no `Cache-Control`, no `Age`, no `Expires`.
 * It is therefore always fresh, and sees a video published two minutes earlier.
 * It is literally the call YouTube's own page makes to paint a channel's Videos
 * tab.
 *
 * What it costs, measured side by side on the same channels:
 *
 * |                  | Atom   | InnerTube |
 * |------------------|--------|-----------|
 * | bytes on the wire| 10 KB  | 61 KB     |
 * | median latency   | 230 ms | 394 ms    |
 * | cache            | 15 min | none      |
 *
 * And in a burst, two hundred calls sixteen at a time: two hundred HTTP 200,
 * not a single 429, 35.8 requests per second. Extrapolated to nine hundred
 * channels, a full sweep fits in twenty five seconds for fifty six megabytes.
 *
 * Six times the volume of Atom: that is why this path serves the refresh button
 * and never the automatic collection. Every fifteen minutes, it would come to
 * five gigabytes a day.
 *
 * Finally, the call is made with no cookie and no session. The measurement was
 * taken from a blank client: these playlists are public, exactly like the Atom
 * feeds. The service worker can therefore handle it on its own, with no YouTube
 * tab open, and without the request being tied to the user's account.
 */

import { log } from '../lib/log.js';
import {
  extractPlaylistVideos, extractOwnerAvatar, extractContinuation, extractPlayerFacts,
} from '../lib/innertube-parse.js';

const ORIGIN = 'https://www.youtube.com';
const RE_CHANNEL_ID = /^UC[\w-]{22}$/;

// The worker has no page-world `ytcfg`. It reads YouTube's current public web
// configuration on demand instead of shipping a copied client key in TrackTube.
let webConfig = null;
let webConfigPending = null;

/**
 * Minimal client context.
 *
 * YouTube refuses a request without `context.client`. The version number does
 * not need to be current: it serves Google's rollout tracking, not validation.
 */
const CONTEXT = {
  client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' },
};

/** Read only the public client fields needed by anonymous InnerTube calls. */
export function parsePublicWebConfig(html) {
  const key = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([A-Za-z0-9_-]{20,120})"/)?.[1];
  if (!key) return null;
  const version = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([0-9.]{5,40})"/)?.[1];
  return {
    key,
    context: { client: { ...CONTEXT.client, clientVersion: version ?? CONTEXT.client.clientVersion } },
  };
}

async function getPublicWebConfig() {
  if (webConfig) return webConfig;
  if (!webConfigPending) {
    webConfigPending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`${ORIGIN}/`, {
          credentials: 'omit', cache: 'no-store', signal: controller.signal,
        });
        if (!res.ok) return null;
        return parsePublicWebConfig(await res.text());
      } catch (err) {
        if (err?.name !== 'AbortError') log.warn('YouTube web configuration unavailable', err);
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })();
  }
  const config = await webConfigPending;
  if (config) webConfig = config;
  webConfigPending = null;
  return config;
}

/** Long form videos only, as with the Atom feeds: never any Shorts. */
const PREFIX = { all: 'UU', long: 'UULF', shorts: 'UUSH', lives: 'UULV' };

/**
 * One call to the internal API. Returns `null` on failure, never throws.
 *
 * The fallback to Atom depends on that `null`: it is the only signal saying the
 * internal interface has changed under our feet.
 */
async function call(endpoint, body, signal) {
  if (signal?.aborted) return null;
  const config = await getPublicWebConfig();
  if (!config || signal?.aborted) return null;

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 10000);
  try {
    const res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?key=${config.key}&prettyPrint=false`, {
      method: 'POST',
      // Definitely not `include`: the request has nothing personal to ask for,
      // and sending it signed would tie a sweep of the entire subscription list
      // to the account.
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: config.context, ...body }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // A changed client key is re-read for the next attempt. The caller's
      // existing Atom fallback handles this request without stale credentials.
      if (res.status === 400 || res.status === 403) webConfig = null;
      log.warn(`Direct InnerTube: ${endpoint} → HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    if (err?.name !== 'AbortError') log.warn('Direct InnerTube unreachable', err);
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * A channel's latest long form videos, uncached.
 *
 * A single page: one hundred videos, well beyond the fifteen an Atom feed
 * returns. Following continuations would only make sense for a historical
 * backfill, which is not what a refresh button does.
 *
 * @param {string} channelId
 * @param {{kind?: 'long'|'lives', signal?: AbortSignal}} [opts]
 * @returns {Promise<{videos: Array<object>, avatarUrl: string|null} | null>}
 *   `null` if the API did not answer — to be told apart from a channel with no
 *   videos.
 */
export async function fetchUploadsDirect(channelId, { kind = 'long', signal } = {}) {
  if (!RE_CHANNEL_ID.test(channelId)) return null;

  const playlistId = `${PREFIX[kind] ?? 'UULF'}${channelId.slice(2)}`;
  const videos = [];
  let token = null, avatarUrl = null;
  // Shorts pages currently hold 30 entries. A few continuations cover the
  // recent collection without checking thousands of individual player records.
  for (let page = 0; page < (kind === 'shorts' ? 5 : 1); page++) {
    const res = await call('browse', token ? { continuation: token } : { browseId: `VL${playlistId}` }, signal);
    if (!res) return page ? { videos, avatarUrl, partial: true } : null;
    videos.push(...extractPlaylistVideos(res));
    avatarUrl ??= extractOwnerAvatar(res);
    token = extractContinuation(res);
    if (!token) break;
  }
  return { videos, avatarUrl, partial: Boolean(token) };
}

/**
 * A video's exact publication date, and what comes with it.
 *
 * The playlist carries no date at all: its items only show a relative "2 months
 * ago", measured and verified. Inserting a video into a chronological feed with
 * a date accurate to within two months would put it anywhere, so it has to be
 * fetched elsewhere.
 *
 * `youtubei/v1/player` gives it to the second, in its microformat:
 * `publishDate` read `2026-08-21T13:46:36-07:00` on a video published thirty
 * six minutes earlier. Eight kilobytes, 169 ms, and here too no cache header.
 * The playability status returned is `UNPLAYABLE` for lack of a session, which
 * does not matter: we are not playing the video, we are reading its record.
 *
 * One call per video, but only for those the database does not know — in normal
 * operation, zero to a handful per refresh.
 *
 * @returns {Promise<object|null>} fields ready for `upsertVideos`, without the
 *   `channelId` that only the caller knows reliably.
 */
export async function fetchVideoFacts(videoId, { signal } = {}) {
  const res = await call('player', { videoId }, signal);
  return res ? extractPlayerFacts(res, videoId) : null;
}
