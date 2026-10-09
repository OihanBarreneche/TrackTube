/**
 * Completeness audit.
 *
 * This is the test that confirms or refutes the premise of the project: does
 * YouTube really leave out videos from channels you are subscribed to?
 *
 * Method: two sets are compared over the same time window.
 *   - what the per channel Atom feeds gave us (supposed to be exhaustive);
 *   - what YouTube's native feed actually displayed, harvested by the content
 *     script and stamped with `seenNativeAt`.
 *
 * The difference is the list of videos the user would have missed.
 *
 * One methodological precaution: a video only counts as "missed" if the native
 * feed was harvested *beyond* it in time. Without that, everything simply older
 * than the point where the user stopped scrolling would count as missed — and
 * the audit would overstate massively.
 */

import {
  getVideosSince, getAllChannels, getNativeVideosSince, getVideosByIds,
  knownShortIds, metaGet, metaSet,
} from '../lib/db.js';
import { DAY, videoIncomplete } from '../lib/util.js';

const META_HARVEST = 'audit.nativeHarvest';

/**
 * Accumulates what the harvest passes have covered.
 *
 * Coverage builds up as the user scrolls: each pass only reports what it has
 * just marked. The oldest bound reached is what limits the audit, and the total
 * is what indicates the size of the sample.
 *
 * @param {object} batch
 * @param {number|null} batch.oldestPublishedAt  oldest video marked this round
 * @param {number} batch.count                   how many were marked this round
 */
export async function recordNativeCoverage({ oldestPublishedAt, count }) {
  if (!Number.isFinite(oldestPublishedAt)) {
    return metaGet(META_HARVEST, null);
  }

  const prev = await metaGet(META_HARVEST, null);
  const next = {
    oldestPublishedAt: prev ? Math.min(prev.oldestPublishedAt, oldestPublishedAt) : oldestPublishedAt,
    count: (prev?.count ?? 0) + Math.max(0, Number(count) || 0),
    at: Date.now(),
  };
  await metaSet(META_HARVEST, next);
  return next;
}

/**
 * Checks the opposite direction: every dated identifier observed in YouTube's
 * native subscriptions source must exist in TrackTube, or have an explicit
 * Short verdict. An observation without a reliable date is deliberately kept
 * outside the verdict: it may be months older than the requested window.
 *
 * **The verdict only covers channels TrackTube follows**, and that is a
 * correction, not a convenience. The whole premise of this project is that
 * YouTube mixes material into the subscriptions page that no subscription put
 * there; counting such a card as a video we failed to collect accuses the
 * collector of missing something it was never asked to fetch. Measured on
 * 8 October 2026, a seven day run reported two misses: one was a live replay
 * genuinely missed, the other came from a channel whose membership of the list
 * the report could not state either way, and neither the figure nor the reader
 * could tell them apart.
 *
 * Nothing is dropped, because dropping would hide the opposite failure. An
 * observation is filed under what we know of its channel:
 *
 * - **followed and active** — the only bucket the headline figure counts. A
 *   video here is a real hole in collection.
 * - **followed but deactivated** — reconciliation took this channel out of the
 *   sweep. If it is still subscribed on YouTube, that deactivation is the
 *   defect, and it is worth more than the video it cost.
 * - **not in the list at all** — either YouTube recommending something, which
 *   is the behaviour this extension exists to escape, or a subscription the
 *   import never brought back, which is a defect of its own. Only the reader
 *   can tell, so the report names the channels rather than ruling.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowDays]
 * @param {object} [opts.source] result of the direct authenticated source read
 */
export async function runReverseAudit({ windowDays = 7, source = null } = {}) {
  const requestedSince = Date.now() - windowDays * DAY;
  const native = await getNativeVideosSince(requestedSince);
  if (!native.videos.length && !native.undated.length) {
    return { ok: false, reason: 'no-reverse-harvest' };
  }
  const observations = [...new Map(
    native.videos
      .filter((video) => Number.isFinite(video.publishedAt) && video.publishedAt >= requestedSince)
      .map((video) => [video.id, video]),
  ).values()];
  const ids = observations.map((video) => video.id);
  const [trackTubeById, shorts, channels] = await Promise.all([
    getVideosByIds(ids),
    knownShortIds(ids),
    getAllChannels(),
  ]);
  const followed = new Map(channels.map((channel) => [channel.id, channel]));

  const excludedShorts = [];
  const missing = [];
  const missingInactive = [];
  const missingUnfollowed = [];
  const missingUnattributed = [];
  let presentCount = 0;
  let unresolvedCount = 0;
  for (const observation of observations) {
    if (shorts.has(observation.id)) {
      excludedShorts.push(observation);
      continue;
    }
    if (trackTubeById.has(observation.id)) {
      presentCount++;
      if (videoIncomplete(trackTubeById.get(observation.id))) unresolvedCount++;
      continue;
    }
    // A card YouTube rendered without an owner we could read. It cannot be
    // attributed, so it cannot be judged either way.
    if (!observation.channelId) { missingUnattributed.push(observation); continue; }
    const channel = followed.get(observation.channelId);
    if (!channel) missingUnfollowed.push(observation);
    else if (!channel.active) missingInactive.push(observation);
    else missing.push(observation);
  }

  const newestFirst = (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
  for (const list of [missing, missingInactive, missingUnfollowed, missingUnattributed]) {
    list.sort(newestFirst);
  }

  // Named rather than counted: "three videos from channels you do not follow"
  // says nothing, while the channel's name tells the reader at once whether it
  // is a recommendation to ignore or a subscription that never arrived.
  const namedChannels = (list) => [...new Map(list.map((video) => [
    video.channelId,
    { channelId: video.channelId, title: video.channelTitle || video.channelId },
  ])).values()];
  const dated = observations.filter((video) => Number.isFinite(video.publishedAt));
  const oldestObserved = dated.reduce(
    (oldest, video) => Math.min(oldest, video.publishedAt), Number.POSITIVE_INFINITY,
  );
  const coveredWindow = source?.coveredWindow !== false;

  return {
    ok: true,
    windowDays,
    coveredWindow,
    coveredDays: !coveredWindow && Number.isFinite(oldestObserved)
      ? Math.round((Date.now() - oldestObserved) / DAY * 10) / 10
      : null,
    total: observations.length,
    presentCount,
    unresolvedCount,
    excludedShortsCount: excludedShorts.length,
    missingCount: missing.length,
    missing: missing.slice(0, 100),
    missingInactiveCount: missingInactive.length,
    missingInactive: missingInactive.slice(0, 100),
    inactiveChannels: namedChannels(missingInactive),
    missingUnfollowedCount: missingUnfollowed.length,
    missingUnfollowed: missingUnfollowed.slice(0, 100),
    unfollowedChannels: namedChannels(missingUnfollowed),
    missingUnattributedCount: missingUnattributed.length,
    followedCount: followed.size,
    undatedCount: native.undated.length,
    boundaryUnknownCount: Math.max(0, Number(source?.boundaryUnknownCount) || 0),
  };
}

export async function getNativeCoverage() {
  return metaGet(META_HARVEST, null);
}

/**
 * Produces the audit report.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowDays]  how far back to analyse
 * @returns {Promise<AuditReport>}
 */
export async function runAudit({ windowDays = 7 } = {}) {
  const coverage = await getNativeCoverage();
  if (!coverage) {
    return { ok: false, reason: 'no-harvest' };
  }

  const requestedSince = Date.now() - windowDays * DAY;

  // We only judge the zone the harvest actually covered. If the user only
  // scrolled three days back, we only audit three days.
  const since = Math.max(requestedSince, coverage.oldestPublishedAt);
  const truncated = since > requestedSince;

  const videos = await getVideosSince(since);
  const channels = await getAllChannels();
  const channelById = new Map(channels.map((c) => [c.id, c]));

  const missed = [];
  let seenByYoutube = 0;

  for (const v of videos) {
    if (v.seenNativeAt) { seenByYoutube++; continue; }
    missed.push(v);
  }

  // Grouped by channel: a channel that is systematically absent is a stronger
  // signal than scattered omissions.
  const byChannel = new Map();
  for (const v of missed) {
    const entry = byChannel.get(v.channelId) ?? {
      channelId: v.channelId,
      title: channelById.get(v.channelId)?.title ?? v.channelTitle ?? v.channelId,
      missed: 0,
      videos: [],
    };
    entry.missed++;
    if (entry.videos.length < 5) {
      entry.videos.push({ id: v.id, title: v.title, publishedAt: v.publishedAt });
    }
    byChannel.set(v.channelId, entry);
  }

  const total = videos.length;
  const channelsAffected = [...byChannel.values()].sort((a, b) => b.missed - a.missed);

  return {
    ok: true,
    windowDays,
    since,
    truncated,
    truncatedTo: truncated ? Math.round((Date.now() - since) / DAY * 10) / 10 : null,
    total,
    seenByYoutube,
    missedCount: missed.length,
    missedRatio: total ? missed.length / total : 0,
    channelsAffected: channelsAffected.slice(0, 50),
    channelsAffectedCount: channelsAffected.length,
    harvest: coverage,
  };
}

/**
 * @typedef {object} AuditReport
 * @property {boolean} ok
 * @property {string} [reason]         identifier, turned into a sentence on display
 * @property {number} [total]            videos known over the window
 * @property {number} [seenByYoutube]    of which shown by the native feed
 * @property {number} [missedCount]      of which never shown
 * @property {number} [missedRatio]
 * @property {boolean} [truncated]       window narrowed for lack of a deep enough harvest
 */

// The rendering lives in lib/audit-format.js: the popup uses it without having
// to import the database layer.
export { formatAuditReport } from '../lib/audit-format.js';
