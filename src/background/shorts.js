import { fetchVideoFacts, fetchUploadsDirect } from './innertube-direct.js';
import {
  getFeedPage, getActiveChannelIds, getVideosByIds, knownShortIds,
  recordVideoClassification, metaGet, metaSet,
} from '../lib/db.js';
import { MSG, broadcast } from '../lib/messages.js';
import { pool } from '../lib/util.js';
import { hasCurrentVideoVerdict, shortVerdictLifetime } from '../lib/short-policy.js';

const inFlight = new Map();
const channelRequests = new Map();
const CHANNEL_CACHE_MS = 60 * 60 * 1000;

export function announceGone(ids) {
  if (!ids.length || !globalThis.chrome?.runtime) return;
  broadcast(MSG.VIDEOS_GONE, { ids });
  chrome.tabs?.query({ url: '*://www.youtube.com/*' }).then((tabs) => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: MSG.VIDEOS_GONE, ids }).catch(() => {});
  }).catch(() => {});
}

// Used only when collection already needs a player record (dates/history).
// Display never calls this. Unknown metadata never excludes a video.
export function fetchScreenedVideoFacts(id) {
  if (inFlight.has(id)) return inFlight.get(id);
  const work = (async () => {
    if ((await knownShortIds([id])).has(id)) return { id, isShort: true, removed: 0 };
    const facts = await fetchVideoFacts(id);
    if (facts?.isShort === true) {
      const { removed } = await recordVideoClassification(id, true, Date.now());
      announceGone([id]);
      return { ...facts, removed };
    }
    if (facts?.isShort === false) {
      const at = Date.now();
      await recordVideoClassification(id, false, at, at + shortVerdictLifetime(facts.durationSec));
    }
    return facts;
  })();
  inFlight.set(id, work);
  work.finally(() => inFlight.delete(id)).catch(() => {});
  return work;
}

// One cached list per channel, not one player request per video. Only explicit
// membership in UUSH excludes an id: absence, duration and errors prove nothing.
export function refreshChannelShorts(channelId) {
  if (channelRequests.has(channelId)) return channelRequests.get(channelId);
  const work = (async () => {
    const key = 'shorts.list.' + channelId;
    const cached = await metaGet(key, {});
    if (cached.nextAt > Date.now()) return 0;
    const result = await fetchUploadsDirect(channelId, { kind: 'shorts' });
    if (!result) {
      await metaSet(key, { nextAt: Date.now() + 60000 });
      return 0;
    }
    // Generic lockups elsewhere in a response may be recommendations. Only a
    // Shorts renderer or an actual legacy playlist entry establishes membership.
    const ids = [...new Set(result.videos.filter((v) => v.isShort || v.playlistEntry).map((v) => v.id))];
    let removed = 0;
    for (const id of ids) {
      removed += (await recordVideoClassification(id, true, Date.now())).removed;
    }
    await metaSet(key, { nextAt: Date.now() + (result.partial ? 60000 : CHANNEL_CACHE_MS) });
    announceGone(ids);
    return removed;
  })();
  channelRequests.set(channelId, work);
  work.finally(() => channelRequests.delete(channelId)).catch(() => {});
  return work;
}

// Local re-read prevents enrichment from resurrecting a deleted row.
export async function verifiedFeedVideos(ids) {
  return [...(await getVideosByIds(ids)).values()];
}

// UUSH can lag behind the canonical watch record. Check stale displayed ids
// independently of playlist membership, including old publications. Errors do
// not establish a classification and are retried after a short cooldown.
const retryAfter = new Map();
export async function screenFeedVideos(ids) {
  const rows = await verifiedFeedVideos(ids);
  const now = Date.now();
  await pool(rows.filter((video) => !hasCurrentVideoVerdict(video, now)
    && (retryAfter.get(video.id) ?? 0) <= now), 4, async (video) => {
    retryAfter.set(video.id, now + 60_000);
    const facts = await fetchScreenedVideoFacts(video.id);
    if (facts?.isShort != null) retryAfter.delete(video.id);
  });
  // Only read rows still present: a concurrent list refresh may have removed
  // them. No enrichment or old non-Short response may resurrect a tombstone.
  return { items: await verifiedFeedVideos(ids) };
}

// Shorts screening does not get to weaken the caller's completeness rule. The
// main feed requires duration metadata; secondary views may deliberately
// ask for incomplete rows so the user can still find what they hid or starred.
export async function getScreenedFeedPage(options) {
  // Whose videos these are is settled here rather than trusted from the row.
  // A video outlives the subscription that brought it in: a channel left
  // since, or one woken by a repair, keeps filling the grid until something
  // prunes it, and "something prunes it" has already failed once. One key
  // read against the `by_active` index answers it for the whole page.
  return getFeedPage({ ...options, activeChannelIds: await getActiveChannelIds() });
}
