import { factsFromVideosTab } from '../lib/innertube-parse.js';
import { pool, DAY } from '../lib/util.js';

// A complete current page is insufficient: a hole can be on the next page,
// even after a known id. Scan a time window in both of YouTube's channel tabs.
// One extra day absorbs the uncertainty of relative publication labels.
export async function collectChannelWindow(channels, {
  fetchTab, fetchUploads, fetchFacts, persist, progress = async () => {},
  now = Date.now(), windowDays = 7, concurrency = 8,
}) {
  const since = now - (windowDays + 1) * DAY;
  const tally = { ok: true, total: channels.length, checked: 0, inserted: 0,
    updated: 0, errors: 0, deferred: 0, partial: 0, windowDays };
  let done = 0;
  const jobs = await pool(channels, concurrency, async (channel) => {
    try {
      let videos = await fetchTab(channel.id, { max: 1200, since, includeAvatar: true });
      let partial = videos.partial === true || videos.coveredWindow !== true;
      if (!videos.ok) {
        videos = await fetchUploads(channel.id, { kind: 'long', max: 100 });
        partial = true; // A bounded synthetic playlist proves no time coverage.
      }
      let live = null;
      if (channel.includeLives !== false) {
        live = await fetchTab(channel.id, { kind: 'lives', max: 1200, since });
        if (!live.ok) {
          live = await fetchUploads(channel.id, { kind: 'lives', max: 100 });
          partial = true;
        } else if (live.partial || !live.coveredWindow) partial = true;
      }
      const entries = new Map((videos.videos ?? []).map((video) => [video.id, video]));
      for (const video of live?.videos ?? []) {
        if (!entries.has(video.id)) entries.set(video.id, { ...video, wasLive: true });
      }
      const known = new Set(channel.knownIds ?? []);
      const verified = [];
      for (const video of entries.values()) {
        // Keep the boundary page for chronology, but do not enrich years of old
        // fallback playlist entries that already have complete local records.
        if (known.has(video.id) && !video.membersOnly) continue;
        const tabFacts = factsFromVideosTab(video);
        // A short duration is only a verification priority, never a verdict.
        // UULF and the Videos tab can briefly disagree with /shorts/ canonical.
        const needsPlayer = !tabFacts || (video.durationSec > 0 && video.durationSec <= 200);
        const playerFacts = video.membersOnly ? null : needsPlayer ? await fetchFacts(video.id) : null;
        verified.push({ ...video, authenticatedFacts: needsPlayer ? playerFacts : tabFacts });
      }
      const sourceFailed = !videos.ok;
      if (partial) tally.partial++;
      const result = await persist({
        channelId: channel.id, videos: verified, sourceFailed,
        avatarUrl: videos.avatarUrl ?? null,
        // The checkpoint is scoped to this window, never the whole catalogue.
        coverage: { since, checkedAt: now, partial, videosOk: videos.ok === true,
          livesOk: live ? live.ok === true : null, reason: videos.reason ?? 'playlist-fallback' },
      });
      if (!result?.ok) throw new Error(result?.error ?? 'persistence-failed');
      tally.checked++;
      tally.inserted += result.inserted ?? 0;
      tally.updated += result.updated ?? 0;
      tally.deferred += result.deferred ?? 0;
      if (sourceFailed || (live && !live.ok)) tally.errors++;
    } finally {
      await progress({ done: ++done, total: channels.length });
    }
  });
  // pool isolates failures; count them instead of returning an apparently
  // successful sweep when a worker rejected before persisting its channel.
  tally.errors += jobs.filter((job) => !job.ok).length;
  return tally;
}
