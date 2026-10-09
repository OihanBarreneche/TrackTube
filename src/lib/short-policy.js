// A previous negative verdict is not permanent: YouTube can reclassify a
// video days later. Publication age must never exempt a displayed video.
const SHORT_VERDICT_FAST_MS = 15 * 60 * 1000;
const SHORT_VERDICT_SLOW_MS = 3 * 60 * 60 * 1000;

export function shortVerdictLifetime(durationSec) {
  return durationSec > 200 ? SHORT_VERDICT_SLOW_MS : SHORT_VERDICT_FAST_MS;
}

export function hasCurrentVideoVerdict(video, now = Date.now()) {
  return Number.isFinite(video?.shortVerifiedAt) && video.shortVerifiedAt > 0
    && video.shortVerifiedAt <= now
    && Number.isFinite(video.shortValidUntil) && video.shortValidUntil > now;
}
