/**
 * YouTube Atom feeds: URL building, fetching, parsing.
 *
 * Two non obvious points:
 *
 * 1. `DOMParser` does not exist inside an MV3 service worker. The parsing is
 *    therefore done by hand. That is not a stopgap: the feed is machine
 *    generated, its format is perfectly regular, and a targeted scanner is
 *    faster than a generic XML parser over 500 feeds.
 *
 * 2. The `UULF` playlist prefix (undocumented by Google) filters Shorts out *at
 *    the source*. That is far more reliable than the duration based filtering
 *    used elsewhere, which became useless once Shorts grew to 3 minutes.
 */

import { decodeEntities } from './util.js';

const FEED_BASE = 'https://www.youtube.com/feeds/videos.xml';

/**
 * Playlist prefixes derived from the channel id (replacing `UC`).
 *   UU   = everything (videos + Shorts + lives)
 *   UULF = long form videos only     ← the main source of the feed
 *   UUSH = Shorts only               ← never queried for the feed
 *   UULV = lives and live replays
 *
 * `UULV` was long noted here as returning 404. That was wrong, and the
 * conclusion came from a channel that had never streamed live: the playlist
 * simply does not exist then, exactly as `UULF` does not exist for a channel
 * that only publishes Shorts. Verified in August 2026 on a channel that does
 * stream: `UULV…` returns a valid Atom feed of sixteen entries, disjoint from
 * `UULF…`. So it really is the source of lives, which the long form feed
 * ignores.
 */
export const FEED_MODES = /** @type {const} */ ({
  LONGFORM: 'UULF',
  LIVE: 'UULV',
  ALL: 'UU',
});

/**
 * Turns a channel id into an uploads playlist id.
 * @param {string} channelId  UC… format
 * @param {'UULF'|'UULV'|'UU'} mode
 */
export function uploadsPlaylistId(channelId, mode = FEED_MODES.LONGFORM) {
  if (!isChannelId(channelId)) throw new Error(`Invalid channel id: ${channelId}`);
  return mode + channelId.slice(2);
}

/** @param {string} id */
function isChannelId(id) {
  return typeof id === 'string' && /^UC[\w-]{22}$/.test(id);
}

/**
 * URL of a channel's Atom feed.
 * @param {string} channelId
 * @param {'UULF'|'UULV'|'UU'} mode
 */
export function feedUrl(channelId, mode = FEED_MODES.LONGFORM) {
  return mode === FEED_MODES.ALL
    ? `${FEED_BASE}?channel_id=${encodeURIComponent(channelId)}`
    : `${FEED_BASE}?playlist_id=${encodeURIComponent(uploadsPlaylistId(channelId, mode))}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Precompiled expressions: they run thousands of times per cycle.
const RE_ENTRY = /<entry>([\s\S]*?)<\/entry>/g;
const RE_VIDEO_ID = /<yt:videoId>([^<]*)<\/yt:videoId>/;
const RE_CHANNEL_ID = /<yt:channelId>([^<]*)<\/yt:channelId>/;
// `<title` cannot match `<media:title`: the prefix requires the angle bracket.
const RE_TITLE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/;
const RE_PUBLISHED = /<published>([^<]*)<\/published>/;
const RE_AUTHOR_NAME = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/;
const RE_THUMB = /<media:thumbnail[^>]*\surl="([^"]*)"/;
const RE_VIEWS = /<media:statistics[^>]*\sviews="(\d+)"/;

/**
 * @typedef {object} FeedEntry
 * @property {string} id
 * @property {string} channelId
 * @property {string} channelTitle
 * @property {string} title
 * @property {number} publishedAt  epoch ms
 * @property {string} thumbUrl
 * @property {number|null} views
 */

/**
 * Parses a YouTube Atom feed.
 *
 * Splitting on `</entry>` is safe: in well formed XML a literal `</entry>`
 * cannot appear inside text content — it would be escaped there.
 *
 * @param {string} xml
 * @returns {{feedTitle: string, channelId: string|null, entries: FeedEntry[]}}
 */
export function parseAtomFeed(xml) {
  const entries = [];

  // The block before the first entry carries the feed metadata.
  const firstEntry = xml.indexOf('<entry>');
  const header = firstEntry === -1 ? xml : xml.slice(0, firstEntry);
  const feedTitle = decodeEntities(match1(header, RE_TITLE)?.trim() ?? '');
  const feedChannelId = match1(header, RE_CHANNEL_ID);

  RE_ENTRY.lastIndex = 0;
  let m;
  while ((m = RE_ENTRY.exec(xml)) !== null) {
    const block = m[1];

    const id = match1(block, RE_VIDEO_ID);
    if (!id) continue; // malformed entry: skip it rather than fail

    const publishedRaw = match1(block, RE_PUBLISHED);
    const publishedAt = publishedRaw ? Date.parse(publishedRaw) : NaN;

    const viewsRaw = match1(block, RE_VIEWS);

    entries.push({
      id,
      channelId: match1(block, RE_CHANNEL_ID) ?? feedChannelId ?? '',
      channelTitle: decodeEntities(match1(block, RE_AUTHOR_NAME)?.trim() ?? feedTitle),
      title: decodeEntities(match1(block, RE_TITLE)?.trim() ?? ''),
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      thumbUrl: match1(block, RE_THUMB) ?? '',
      views: viewsRaw ? Number(viewsRaw) : null,
    });
  }

  return { feedTitle, channelId: feedChannelId, entries };
}

function match1(text, re) {
  const m = re.exec(text);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fingerprint of a feed's content, to detect "nothing has changed".
 *
 * Only the ids and the publication dates are hashed, not the whole feed: view
 * counters move constantly and would make any fingerprint of the raw body
 * different every single time.
 *
 * FNV-1a 32 bits — enough here, we compare a value against its own previous
 * version, there is no adversary.
 *
 * @param {FeedEntry[]} entries
 */
export function feedFingerprint(entries) {
  let hash = 0x811c9dc5;
  for (const e of entries) {
    const chunk = `${e.id}:${e.publishedAt};`;
    for (let i = 0; i < chunk.length; i++) {
      hash ^= chunk.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(36);
}

/**
 * @typedef {object} FetchResult
 * @property {'ok'|'not-found'|'rate-limited'|'error'} status
 * @property {number} httpStatus
 * @property {ReturnType<typeof parseAtomFeed>} [feed]
 * @property {string} [fingerprint]
 * @property {number} [ageSec]   age of the copy served by the CDN
 * @property {number|null} [retryAfterMs]
 * @property {string} [message]
 */

/**
 * Fetches a channel's Atom feed.
 *
 * Measured against YouTube's real servers (August 2026):
 *   Cache-Control: public, max-age=900
 *   no ETag, no Last-Modified — `If-Modified-Since` returns 200 + full body
 *   ~16 KB gzipped for 15 entries (~70 KB raw)
 *
 * Direct consequences for this function:
 *
 * - No conditional request: the server offers no validator at all. Change
 *   detection happens afterwards, by fingerprinting the content.
 * - `cache: 'default'` rather than `no-store`: the feeds are explicitly
 *   declared publicly cacheable for 15 min. Letting the browser's HTTP cache
 *   serve them makes any closely spaced re-fetch free, which guards against
 *   double queries with no extra code.
 * - `credentials: 'omit'`: the feed is public, no reason to send session
 *   cookies with every request.
 *
 * @param {string} channelId
 * @param {object} [opts]
 * @param {'UULF'|'UULV'|'UU'} [opts.mode]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<FetchResult>}
 */
export async function fetchChannelFeed(channelId, { mode = FEED_MODES.LONGFORM, signal } = {}) {
  let res;
  try {
    res = await fetch(feedUrl(channelId, mode), {
      method: 'GET',
      credentials: 'omit',
      cache: 'default',
      redirect: 'follow',
      signal,
    });
  } catch (err) {
    return { status: 'error', httpStatus: 0, message: String(err?.message ?? err) };
  }

  if (res.status === 404 || res.status === 410) {
    return { status: 'not-found', httpStatus: res.status };
  }

  if (res.status === 429 || res.status === 503) {
    return {
      status: 'rate-limited',
      httpStatus: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('Retry-After')),
    };
  }

  if (!res.ok) {
    return { status: 'error', httpStatus: res.status, message: `HTTP ${res.status}` };
  }

  const xml = await res.text();
  // A 200 response that is not Atom usually signals an error page or a consent
  // interstitial, not an empty feed.
  if (!xml.includes('<feed')) {
    return { status: 'error', httpStatus: res.status, message: 'Non Atom response' };
  }

  const feed = parseAtomFeed(xml);
  return {
    status: 'ok',
    httpStatus: res.status,
    feed,
    fingerprint: feedFingerprint(feed.entries),
    ageSec: Number(res.headers.get('Age')) || 0,
  };
}

/** `Retry-After` accepts either a delta in seconds or an HTTP date. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
