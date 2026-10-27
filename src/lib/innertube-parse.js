/**
 * Reading the responses of YouTube's internal API.
 *
 * These functions only inspect JSON: no request, no document access, no
 * dependency on the extension. They lived in the content script for as long as
 * it was the only caller of the API. Now that the service worker queries
 * playlists too, keeping them there would mean importing
 * `content/innertube.js`, which needs the MAIN world and `document` — that is,
 * writing the same parsers a second time, with two behaviours to keep in
 * agreement.
 *
 * The traversal is generic rather than driven by fixed paths: YouTube regularly
 * rearranges the depth of its responses, while the shape of its building blocks
 * barely moves.
 */

import { log } from './log.js';

export function readText(field) {
  if (typeof field === 'string') return field;
  if (field?.simpleText) return field.simpleText;
  if (Array.isArray(field?.runs)) return field.runs.map((r) => r.text ?? '').join('');
  return '';
}

export function parseDuration(text) {
  if (!text) return null;
  const parts = String(text).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findTimeText(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;

  for (const value of Object.values(node)) {
    if (typeof value === 'string') {
      if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(value)) return value;
    } else if (value && typeof value === 'object') {
      const found = findTimeText(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * What state is this broadcast in: live, scheduled, or over?
 *
 * The `UULV` playlist mixes all three, and the Atom feed does not separate
 * them. Yet they are three very different things on screen: a live you can join
 * right now, a replay among other videos, and an appointment that has not
 * happened yet — sometimes days away, and which therefore has no business in a
 * chronological timeline.
 *
 * In place of a duration, YouTube puts a badge on the thumbnail whose *style*
 * carries the word LIVE or UPCOMING. We read the style and not the text: the
 * text is translated, "EN DIRECT" here, something else elsewhere. Two templates
 * coexist, with two field names (`style` and `badgeStyle`), hence recognition
 * by content rather than by a fixed path.
 *
 * @returns {'live'|'upcoming'|null}
 */
function broadcastState(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;

  let found = null;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (key !== 'style' && key !== 'badgeStyle') continue;
      // A live wins over a scheduled slot: a thumbnail can carry both while
      // YouTube swaps its badges over at start time.
      if (/(?:^|_)LIVE(?:_NOW)?$/.test(value)) return 'live';
      if (/(?:^|_)UPCOMING$/.test(value)) found = 'upcoming';
    } else if (value && typeof value === 'object') {
      const inside = broadcastState(value, depth + 1);
      if (inside === 'live') return 'live';
      if (inside) found ??= inside;
    }
  }
  return found;
}

/**
 * Announced start time of a scheduled broadcast, in milliseconds.
 *
 * YouTube gives it in seconds, under a name that has been stable for years. It
 * is optional: without it we only know the broadcast is still ahead, which is
 * enough to keep it out of the chronological timeline.
 */
function announcedStart(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'startTime') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    } else if (value && typeof value === 'object') {
      const found = announcedStart(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function hasMembershipMarker(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10) return false;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      const text = value.trim();
      if ((key === 'style' || key === 'badgeStyle') && /MEMBER|SPONSOR/i.test(text)) return true;
      // Channel-tab requests use hl=en. Keep the fallback exact so a title or
      // channel name containing the word "member" cannot classify a video.
      if (/^(?:members?[- ]only|members? first|for members?)$/i.test(text)) return true;
    } else if (value && typeof value === 'object' && hasMembershipMarker(value, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** Explicit membership badge attached to a video card, never title heuristics. */
export function isMembersOnlyRenderer(renderer) {
  if (!renderer || typeof renderer !== 'object') return false;
  const lockupMeta = renderer.metadata?.lockupMetadataViewModel;
  return [
    renderer.badges,
    renderer.thumbnailOverlays,
    renderer.contentImage?.thumbnailViewModel?.overlays,
    lockupMeta?.metadata,
  ].some(hasMembershipMarker);
}

/**
 * Extracts the videos from a playlist response.
 *
 * Two templates coexist. The old one, `playlistVideoRenderer`, carries the
 * duration in a named field. The recent one, `lockupViewModel`, no longer
 * carries it anywhere by name: it lives in a badge laid over the thumbnail, as
 * plain text such as "33:51". Hence the search for the first text shaped like a
 * duration — aiming at a precise path inside that structure would mean
 * rewriting it after every redesign.
 */
export function extractPlaylistVideos(node, out = [], seen = new Set(), max = Infinity) {
  if (!node || typeof node !== 'object' || seen.has(node) || out.length >= max) return out;
  seen.add(node);

  const legacy = node.playlistVideoRenderer;
  // Current Shorts playlists use this template, not lockupViewModel. Read
  // the primary play command, never the /watch link inside the queue menu.
  const short = node.shortsLockupViewModel;
  const reel = node.reelItemRenderer;
  const shortId = short?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
    ?? reel?.videoId;
  if (typeof shortId === 'string' && /^[\w-]{11}$/.test(shortId)) {
    out.push({ id: shortId, title: short?.overlayMetadata?.primaryText?.content
      ?? readText(reel?.headline), durationSec: null, isShort: true });
    return out;
  }
  if (legacy?.videoId) {
    const state = broadcastState(legacy);
    out.push({
      id: legacy.videoId,
      playlistEntry: true,
      title: readText(legacy.title),
      durationSec: parseDuration(readText(legacy.lengthText)) ?? toNumber(legacy.lengthSeconds),
      isLive: state === 'live',
      isUpcoming: state === 'upcoming',
      // Looked up even when the badge says nothing: the absence of a duration
      // is what settles it, and the badge is missing more often than the start
      // time is.
      scheduledAt: state === 'live' ? null : announcedStart(legacy),
      membersOnly: isMembersOnlyRenderer(legacy),
    });
    if (out.length >= max) return out;
  }

  const lockup = node.lockupViewModel;
  if (lockup?.contentId && lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    const state = broadcastState(lockup);
    out.push({
      id: lockup.contentId,
      title: lockup.metadata?.lockupMetadataViewModel?.title?.content ?? '',
      durationSec: parseDuration(findTimeText(lockup)),
      isLive: state === 'live',
      isUpcoming: state === 'upcoming',
      scheduledAt: state === 'live' ? null : announcedStart(lockup),
      membersOnly: isMembersOnlyRenderer(lockup),
    });
    if (out.length >= max) return out;
  }

  for (const value of Object.values(node)) {
    if (out.length >= max) break;
    if (value && typeof value === 'object') extractPlaylistVideos(value, out, seen, max);
  }
  return out;
}

export function extractContinuation(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);

  const token = node.continuationItemRenderer?.continuationEndpoint
    ?.continuationCommand?.token;
  if (typeof token === 'string' && token) return token;

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = extractContinuation(value, seen);
      if (found) return found;
    }
  }
  return null;
}

function normalizedAvatarUrl(image) {
  const sources = image?.thumbnails ?? image?.sources ?? [];
  const urls = [
    ...(Array.isArray(sources) ? sources.map((source) => source?.url) : []),
    typeof image?.url === 'string' ? image.url : null,
    typeof image === 'string' ? image : null,
  ].filter((url) => /^https:\/\/yt3\.(?:ggpht\.com|googleusercontent\.com)\//.test(url ?? ''));
  const value = urls.at(-1);
  return value
    ? value.replace(/=s\d+(?:-c-k[\w-]*)?(?=\?|$)/, '=s176-c-k-c0x00ffffff-no-rj')
    : null;
}

/**
 * The channel owner's avatar, read only from structures that identify an owner.
 *
 * An authenticated browse response also contains the signed-in account's avatar
 * in its top bar. The former generic "first yt3 URL" traversal therefore wrote
 * the user's own face into hundreds of unrelated channel rows. Banner images
 * use the same host, too. Only channel metadata, page headers and explicit video
 * owners are admissible here.
 */
export function extractOwnerAvatar(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);

  const pageHeaderImage = node.pageHeaderViewModel?.image
    ?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image;
  const candidates = [
    node.channelMetadataRenderer?.avatar,
    node.c4TabbedHeaderRenderer?.avatar,
    pageHeaderImage,
    node.videoOwnerRenderer?.thumbnail,
    node.microformatDataRenderer?.thumbnail,
  ];
  for (const candidate of candidates) {
    const found = normalizedAvatarUrl(candidate);
    if (found) return found;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = extractOwnerAvatar(value, seen);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Is this player response the one of a Short?
 *
 * The need became clear after a Short appeared in the feed even though every
 * collection path reads `UULF`. None of the signals one would want to use holds
 * up: duration says nothing, since YouTube raised Shorts to three minutes;
 * aspect ratio says nothing either, the one observed was 16:9; and the
 * `#shorts` in the title is an author's habit, not a property.
 *
 * A single field settles it, and YouTube itself provides it:
 * `microformat.playerMicroformatRenderer.canonicalUrl`. It reads
 * `https://www.youtube.com/shorts/ID` for a Short and
 * `https://www.youtube.com/watch?v=ID` for everything else. Measured on the
 * TCHINIS channel in August 2026: the 18 second video missing from `UULF` and
 * present in `UUSH` carries the `/shorts/` URL, while two ordinary videos from
 * the same channel, 12 and 25 seconds long, carry the `/watch` URL. Duration
 * alone would therefore have classified all three the same way, and been wrong
 * two times out of three.
 *
 * Missing or unrecognised metadata is unknown, never a negative verdict.
 * @param {object} player  response from `youtubei/v1/player`
 * @param {string} [expectedId] video actually requested
 * @returns {boolean|null} true = Short, false = ordinary video, null = unknown
 */
export function isShort(player, expectedId = player?.videoDetails?.videoId) {
  const canonical = player?.microformat?.playerMicroformatRenderer?.canonicalUrl;
  if (typeof canonical !== 'string') return null;
  try {
    const url = new URL(canonical);
    if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
    const shortId = /^\/shorts\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    const watchId = url.pathname === '/watch' ? url.searchParams.get('v') : null;
    const id = shortId ?? watchId;
    if (!id || !/^[\w-]{11}$/.test(id) || (expectedId && id !== expectedId)) return null;
    if (expectedId && player?.videoDetails?.videoId && player.videoDetails.videoId !== expectedId) return null;
    return Boolean(shortId);
  } catch { return null; }
}

/**
 * Fields that belong to one exact player record. Kept here so the signed
 * YouTube-tab client and the anonymous service-worker fallback interpret the
 * response identically.
 */
export function extractPlayerFacts(player, expectedId = player?.videoDetails?.videoId) {
  if (!player || !/^[\w-]{11}$/.test(expectedId ?? '')) return null;
  const mf = player.microformat?.playerMicroformatRenderer;
  const det = player.videoDetails;
  if (det?.videoId && det.videoId !== expectedId) return null;

  const iso = mf?.publishDate ?? mf?.uploadDate;
  const publishedAt = iso ? Date.parse(iso) : NaN;
  const broadcast = mf?.liveBroadcastDetails;
  const seconds = Number(det?.lengthSeconds);
  const views = Number(det?.viewCount);
  const restriction = [
    player.playabilityStatus?.reason,
    ...(player.playabilityStatus?.messages ?? []),
  ].filter((value) => typeof value === 'string').join(' ');

  return {
    id: expectedId,
    title: det?.title ?? mf?.title?.simpleText ?? '',
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
    thumbUrl: `https://i.ytimg.com/vi/${expectedId}/hqdefault.jpg`,
    views: Number.isFinite(views) ? views : null,
    durationSec: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    isLive: Boolean(broadcast?.isLiveNow),
    isUpcoming: Boolean(broadcast && !broadcast.isLiveNow && !broadcast.endTimestamp),
    wasLive: Boolean(det?.isLiveContent),
    isShort: isShort(player, expectedId),
    membersOnly: /members?[- ]only|join (?:this|the) channel|available to members/i.test(restriction),
  };
}

/** Relative publication label requested from YouTube with `hl: en`. */
function parseEnglishRelativeTime(text, now = Date.now()) {
  const match = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(String(text ?? ''));
  if (!match) return null;
  const amount = Number(match[1]);
  const DAY = 86_400_000;
  const units = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: DAY,
    week: 7 * DAY,
    month: 30 * DAY,
    year: 365 * DAY,
  };
  return now - amount * units[match[2].toLowerCase()];
}

function stringsIn(node, out = [], depth = 0) {
  // Current lockupViewModel nests the publication label ten levels below the
  // card. Eight made every recent Caleb/Mastu card look undated.
  if (node == null || depth > 12) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node !== 'object') return out;
  for (const value of Object.values(node)) stringsIn(value, out, depth + 1);
  return out;
}

function channelIdIn(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return '';
  if (typeof node.browseId === 'string' && /^UC[\w-]{22}$/.test(node.browseId)) return node.browseId;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = channelIdIn(value, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

/**
 * Ordinary videos in the authenticated subscriptions feed. Dedicated Shorts
 * renderers are deliberately ignored; generic menu endpoints are never read.
 */
export function extractSubscriptionFeedVideos(node, now = Date.now()) {
  const out = [];
  const items = subscriptionFeedItems(node);
  for (const item of items) extractSubscriptionFeedItem(item, now, out);
  return out;
}

/** Joins the date-bearing grid card with its duration-bearing lockup. */
export function mergeVideoTabEntries(gridVideos, detailedVideos, max = Infinity) {
  const gridById = new Map((gridVideos ?? []).map((video) => [video.id, video]));
  const detailsById = new Map((detailedVideos ?? []).map((video) => [video.id, video]));
  // Only cards in the declared grid belong to the channel tab. A generic
  // recursive lockup search also finds unrelated recommendations.
  const ids = gridById.size ? [...gridById.keys()]
    : (detailedVideos ?? []).filter((video) => video.playlistEntry).map((video) => video.id);
  return [...new Set(ids)]
    .map((id) => ({
      ...(detailsById.get(id) ?? {}),
      ...(gridById.get(id) ?? {}),
      durationSec: detailsById.get(id)?.durationSec ?? gridById.get(id)?.durationSec ?? null,
      sourceKind: 'videos-tab',
    }))
    .slice(0, max);
}

/** Turns a complete Videos-tab card into the facts needed by the database. */
export function factsFromVideosTab(video) {
  if (!['videos-tab', 'lives-tab'].includes(video?.sourceKind)) return null;
  const publishedAt = video.isUpcoming && Number.isFinite(video.scheduledAt)
    ? video.scheduledAt
    : video.publishedAt;
  const hasDuration = video.durationSec > 0;
  if (!Number.isFinite(publishedAt) || (!hasDuration && !video.isLive && !video.isUpcoming)) return null;
  return {
    id: video.id,
    title: video.title ?? '',
    publishedAt,
    publishedAtApprox: !video.isUpcoming,
    thumbUrl: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
    views: Number.isFinite(video.views) ? video.views : null,
    durationSec: hasDuration ? video.durationSec : null,
    isLive: Boolean(video.isLive),
    isUpcoming: Boolean(video.isUpcoming),
    wasLive: Boolean(video.wasLive),
    // Tab membership is provisional: a short card is checked against player
    // metadata before insertion, and displayed rows are checked separately.
    isShort: false,
    membersOnly: false,
  };
}

// Channel requests may return Home when the requested tab does not exist.
// Never label Home's recommendations as Videos/Live. Continuations do not carry
// a tab list and keep their declared grid as the source.
//
// The Search tab is declared as an `expandableTabRenderer`, not a
// `tabRenderer`, and it closes the tab list of nearly every channel answer.
// Requiring every tab to be a `tabRenderer` therefore refused the whole
// response, and the deep read fell back on the upload playlist for almost every
// channel. Measured on the reader's profile on 27 October 2026: of 934 channel
// rows deep read since 14 October, 922 carried that fallback and 12 got
// through, answers that happened to come without the Search tab. A real Videos
// answer for Mister V that day: Home, Videos (selected, `richGridRenderer`),
// Shorts, Playlists, Posts, then Search as `expandableTabRenderer`. An unknown
// tab kind still refuses: "absent" certifies an empty window, which is only
// safe to say about a tab list that has been read entirely.
export function channelTabBody(response, kind = 'videos') {
  const tabs = response?.contents?.twoColumnBrowseResultsRenderer?.tabs;
  if (!Array.isArray(tabs)) return { body: response, absent: false };
  const renderers = tabs.map(tab => tab.tabRenderer ?? tab.expandableTabRenderer).filter(Boolean);
  if (renderers.length !== tabs.length) return { body: null, absent: false };
  const suffix = kind === 'lives' ? '/streams' : '/videos';
  const expected = renderers.find(tab =>
    tab.endpoint?.commandMetadata?.webCommandMetadata?.url?.split('?')[0].endsWith(suffix)
    || tab.title === (kind === 'lives' ? 'Live' : 'Videos'));
  if (!expected) return { body: null, absent: true };
  return { body: expected.selected ? expected.content : null, absent: false };
}

export function hasDeclaredVideoGrid(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.richGridRenderer?.contents)
    || Array.isArray(node.appendContinuationItemsAction?.continuationItems)) return true;
  return Object.values(node).some(value => value && typeof value === 'object' && hasDeclaredVideoGrid(value));
}

/** Only the main grid and the items appended to that grid by pagination. */
function subscriptionFeedItems(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);

  if (Array.isArray(node.richGridRenderer?.contents)) {
    out.push(...node.richGridRenderer.contents);
    return out;
  }
  if (Array.isArray(node.appendContinuationItemsAction?.continuationItems)) {
    out.push(...node.appendContinuationItemsAction.continuationItems);
    return out;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') subscriptionFeedItems(value, out, seen);
  }
  return out;
}

function extractSubscriptionFeedItem(item, now, out) {
  if (!item || typeof item !== 'object') return;
  // Shorts shelves are represented as whole rich sections. Nothing nested in
  // one is an ordinary card of the chronological subscriptions grid.
  if (item.richSectionRenderer || item.reelShelfRenderer || item.shortsLockupViewModel) return;

  const content = item.richItemRenderer?.content ?? item.content ?? item;
  const renderer = content.videoRenderer ?? content.gridVideoRenderer;
  if (renderer?.videoId && /^[\w-]{11}$/.test(renderer.videoId)) {
    const state = broadcastState(renderer);
    out.push({
      id: renderer.videoId,
      durationSec: parseDuration(readText(renderer.lengthText)),
      isLive: state === 'live',
      isUpcoming: state === 'upcoming',
      scheduledAt: announcedStart(renderer),
      title: readText(renderer.title),
      channelId: channelIdIn(renderer),
      channelTitle: readText(renderer.ownerText)
        || readText(renderer.longBylineText) || readText(renderer.shortBylineText),
      publishedAt: parseEnglishRelativeTime(readText(renderer.publishedTimeText), now),
      membersOnly: isMembersOnlyRenderer(renderer),
    });
    return;
  }

  const lockup = content.lockupViewModel;
  if (lockup?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO'
      && /^[\w-]{11}$/.test(lockup.contentId ?? '')) {
    const strings = stringsIn(lockup);
    const relative = strings.find((value) => /\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago/i.test(value));
    const state = broadcastState(lockup);
    out.push({
      id: lockup.contentId,
      durationSec: parseDuration(findTimeText(lockup)),
      isLive: state === 'live',
      isUpcoming: state === 'upcoming',
      scheduledAt: announcedStart(lockup),
      title: lockup.metadata?.lockupMetadataViewModel?.title?.content ?? '',
      channelId: channelIdIn(lockup),
      channelTitle: '',
      publishedAt: parseEnglishRelativeTime(relative, now),
      membersOnly: isMembersOnlyRenderer(lockup),
    });
    return;
  }

  // Some layouts wrap ordinary cards in one item section. Descend only through
  // that declared list, never through arbitrary response metadata or entity
  // updates, which also contain hundreds of unrelated lockup models.
  for (const child of content.itemSectionRenderer?.contents ?? []) {
    extractSubscriptionFeedItem(child, now, out);
  }
}

// ---------------------------------------------------------------------------
// The watch history page
// ---------------------------------------------------------------------------

const RE_CHANNEL = /^UC[\w-]{22}$/;

const DAY_MS = 86_400_000;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The sections of a `FEhistory` response, in the order the page shows them.
 *
 * The history is the one YouTube surface that groups its items under a date,
 * and that heading is the only date it gives: no entry carries a timestamp,
 * not even an hour. Reading the response section by section is therefore the
 * whole point — the generic sweep every other parser here does would return
 * the videos without ever knowing which day they belong to.
 *
 * The sections are still found by recursion rather than at a fixed path: the
 * first page nests them under `sectionListRenderer`, a continuation under
 * `appendContinuationItemsAction`, and both of those have moved before.
 *
 * Two templates coexist inside one and the same section, measured on 28 August
 * 2026: `lockupViewModel` for almost everything, `videoRenderer` for a handful.
 * Do not remove the older branch.
 *
 * @returns {Array<{label: string, entries: Array<{videoId: string, title: string,
 *   channelId: string | null, channelTitle: string}>}>}
 */
export function extractHistorySections(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);

  const section = node.itemSectionRenderer;
  if (section) {
    const entries = [];
    for (const item of section.contents ?? []) {
      const entry = readHistoryEntry(item);
      if (entry) entries.push(entry);
    }
    if (entries.length) {
      out.push({
        label: readText(section.header?.itemSectionHeaderRenderer?.title),
        entries,
      });
    }
    // A section holds no section: going down again would only cost time.
    return out;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') extractHistorySections(value, out, seen);
  }
  return out;
}

function readHistoryEntry(item) {
  const lockup = item?.lockupViewModel;
  if (lockup?.contentId && lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    const meta = lockup.metadata?.lockupMetadataViewModel;
    return {
      videoId: lockup.contentId,
      title: meta?.title?.content ?? '',
      channelId: findChannelId(lockup),
      // First part of the first row. The second one is the view count, written
      // in the interface's language and of no use here.
      channelTitle: meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]
        ?.metadataParts?.[0]?.text?.content ?? '',
    };
  }

  const legacy = item?.videoRenderer;
  if (legacy?.videoId) {
    return {
      videoId: legacy.videoId,
      title: readText(legacy.title),
      channelId: findChannelId(legacy),
      channelTitle: readText(legacy.ownerText ?? legacy.longBylineText ?? legacy.shortBylineText),
    };
  }

  return null;
}

/**
 * The channel's identifier, wherever the template hid it.
 *
 * In a `lockupViewModel` it appears exactly once, in the endpoint behind the
 * avatar; in a `videoRenderer` it sits under the byline. Taking the first
 * identifier that turns up is therefore safe here, and it survives the next
 * redesign, which aiming at the path would not.
 *
 * Measured on a real history in August 2026: 235 entries out of 40 000 carry
 * none at all. Those are the deleted channels, and they keep their title —
 * which is what `nonResolue` already describes for the Takeout import.
 */
function findChannelId(node, seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10 || seen.has(node)) return null;
  seen.add(node);

  for (const value of Object.values(node)) {
    if (typeof value === 'string') {
      if (RE_CHANNEL.test(value)) return value;
    } else if (value && typeof value === 'object') {
      const found = findChannelId(value, seen, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Local midnight of the day a timestamp falls in. */
function startOfDay(stamp) {
  const d = new Date(stamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `n` days before a local midnight, without going through milliseconds. */
function daysBefore(midnight, n) {
  const d = new Date(midnight);
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The day a history heading names.
 *
 * Five shapes, measured on 28 August 2026 with `hl: 'en'` forced on the call:
 * `Today`, `Yesterday`, a weekday name for the five days before those, `Aug 21`
 * inside the current year, and `Jan 26, 2025` beyond it. The language is forced
 * on the request precisely so this stays one table instead of one per interface
 * language: the heading is the only date the history gives, and reading it
 * wrong files a viewing under the wrong day.
 *
 * The answer is local **noon**, not midnight. The hour is unknown either way,
 * and midnight sits one second from the previous day, where the least rounding
 * drops the viewing into it.
 *
 * @returns {number | null} null when the heading is not a date at all
 */
export function parseHistoryDay(label, now = Date.now()) {
  const text = String(label ?? '').trim();
  if (!text) return null;

  const today = startOfDay(now);
  const noon = (midnight) => midnight + 12 * 3_600_000;
  const low = text.toLowerCase();

  if (low === 'today') return noon(today);
  if (low === 'yesterday') return noon(daysBefore(today, 1));

  // A weekday name is only ever used inside the last week, so the answer is the
  // most recent past day bearing it — two to seven days back, the two nearest
  // having names of their own.
  const weekday = WEEKDAYS.indexOf(low);
  if (weekday >= 0) {
    for (let back = 2; back <= 7; back++) {
      const day = daysBefore(today, back);
      if (new Date(day).getDay() === weekday) return noon(day);
    }
    return null;
  }

  // The shape is checked before the value, because `Date.parse` is lenient to a
  // fault: asked for `Playlists, 2026` it answers the first of January rather
  // than refusing, and a heading we cannot read would file a year of viewings
  // on New Year's Day. Two forms only: `Aug 21` and `Jan 26, 2025`.
  if (!/^[A-Za-z]{3,9}\.? \d{1,2}(, \d{4})?$/.test(text)) return null;

  const carriesYear = /\d{4}/.test(text);
  const stamp = Date.parse(carriesYear ? text : `${text}, ${new Date(today).getFullYear()}`);
  if (!Number.isFinite(stamp)) return null;

  let day = startOfDay(stamp);
  // A heading with no year means the current one — except in the first days of
  // January, where "Dec 30" belongs to the year before.
  if (!carriesYear && day > today) {
    const d = new Date(day);
    d.setFullYear(d.getFullYear() - 1);
    day = startOfDay(d.getTime());
  }
  return noon(day);
}

/**
 * Choosing a sound track in a player response, and the byte ranges it announces.
 *
 * Here rather than in `content/innertube.js`, where they were written, for the
 * reason this module exists: they only read JSON, and down there they sat
 * behind an import of `content/main.js`, which needs the MAIN world — so the
 * one thing worth locking down, the order the formats are offered in, could
 * not be asserted anywhere.
 */

/**
 * The lightest usable sound track.
 *
 * The preview stayed mute for a long while, and the reasoning held: a grid of
 * thumbnails that all start talking is unbearable. What was missing was not the
 * sound but the choice — mute by default, with a button to turn it on for the
 * thumbnail under the cursor.
 *
 * AAC LC in an mp4 container is preferred, then other original AAC formats.
 * It is a preview: the difference between 48 and 160 kbit is inaudible over a
 * few seconds, but decoding support matters before saving bytes on every
 * thumbnail passed over. Opus in WebM is still skipped, and no longer for the
 * reason first written: mixing containers in one `MediaSource` is accepted by
 * Chromium, measured on 7 October 2026 by opening an mp4 video buffer and a
 * WebM audio buffer on the same object. What stops it is the segment map — a
 * WebM track indexes itself with Matroska cues, not with an `sidx` box, and
 * `readSidx` cannot drive it. It was not needed either, see below.
 *
 * **The DRC twin is kept as a fallback, and excluding it was the mute preview.**
 * It is the same track compressed for listening in a noisy place, and it was
 * dropped as a duplicate bringing nothing: true of how it sounds, false of
 * whether it can be fetched. Measured on 7 October 2026 over thirteen videos,
 * three came out with no sound — `HR97H1yqgVc`, `vKOsWaEtf78`, `DRRCMe2JPq4` —
 * and on all three every original non DRC mp4 track failed at the network level
 * while **itag 140 DRC answered 200 with a readable segment map**. Allowing it
 * took the sample from three mute out of thirteen to none, and not one video
 * needed the WebM path.
 *
 * The rule to draw from it is not that the DRC form is better. Re measured
 * twenty minutes later, `HR97H1yqgVc` served its non DRC track and refused the
 * twin that had just worked, and `vKOsWaEtf78` did the reverse. **Which form the
 * edge serves moves from minute to minute**, so offering one of them is a coin
 * toss, and the answer is to offer every usable form in preference order and
 * let the probe find out. The dub stays excluded even as a last resort: English
 * over a French video is not a better preview than a silent one.
 *
 * The track is the original one, always. A dubbed video offers twenty three of
 * them, and taking the lightest across the whole list landed on whichever
 * language happened to compress best: Hindi, Tamil, Vietnamese. Which one is
 * original cannot be guessed from the bitrate, nor from the order, nor from
 * `audioTrack.audioIsDefault` — measured on `Qtl8lJwbd4g` on 28 August 2026, the
 * only format carrying `audioIsDefault: true` was the French dub, because the
 * call asks with `hl: 'fr'`. YouTube answers with the viewer's language, and the
 * viewer's language is not the video's.
 *
 * `xtags` is what says it. Base64url of a small protobuf holding `acont`, worth
 * either `original` or `dubbed`, and `lang`. A video with a single track carries
 * no `audioTrack` at all: it is original by construction.
 */
function isOriginalTrack(f) {
  if (!f.audioTrack) return true;
  const tags = decodeXtags(f.xtags);
  return tags ? /acont.{0,3}original/.test(tags) : false;
}

/** `xtags` as readable bytes, or null. Base64url, and unpadded. */
function decodeXtags(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch (err) {
    log.debug('xtags unreadable', err);
    return null;
  }
}

export function pickAudio(formats) {
  return audioCandidates(formats)[0] ?? null;
}

export function audioCandidates(formats) {
  if (!Array.isArray(formats)) return [];

  const usable = formats.filter((f) => (
    typeof f?.url === 'string'
    && typeof f.mimeType === 'string'
    && f.mimeType.startsWith('audio/mp4')
    && f.mimeType.includes('mp4a')
    && range(f.initRange) && range(f.indexRange)
    && (typeof MediaSource !== 'function' || MediaSource.isTypeSupported(f.mimeType))
  ));
  if (!usable.length) return [];

  // If nothing declares itself original — an unknown answer shape, a field
  // gone — the whole list is kept rather than no sound at all.
  const original = usable.filter(isOriginalTrack);
  const pool = original.length ? original : usable;

  // Prefer broadly decoded AAC LC, then the plain track over its compressed
  // twin, then the lightest. Every key is a preference and none of them is a
  // filter: the list that comes out is tried in order until one entry actually
  // serves, which is the whole point of ordering it rather than choosing.
  pool.sort((a, b) => Number(!a.mimeType.includes('mp4a.40.2')) - Number(!b.mimeType.includes('mp4a.40.2'))
    || Number(!!a.isDrc) - Number(!!b.isDrc)
    || (Number(a.bitrate) || 0) - (Number(b.bitrate) || 0));
  return pool.map(chosen => ({
    url: chosen.url,
    mime: chosen.mimeType,
    init: range(chosen.initRange),
    index: range(chosen.indexRange),
    size: Number(chosen.contentLength) || 0,
  }));
}

/** A byte range as the player announces them, as numbers. */
export function range(raw) {
  const start = Number(raw?.start);
  const end = Number(raw?.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { start, end }
    : null;
}
