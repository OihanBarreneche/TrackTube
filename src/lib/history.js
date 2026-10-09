/**
 * Watch history from Google Takeout.
 *
 * Why Takeout and nothing else: YouTube closed API access to the history in
 * 2016, and nothing replaced it. The extension knows what is watched *since it
 * was installed*; everything before that exists only in the export.
 *
 * This module is deliberately pure — no IndexedDB, no extension API — so that
 * parsing and computations are testable without a browser.
 *
 * Three limits to keep in mind, and which the interface must state rather than
 * hide:
 *
 * - **The history contains no durations.** It records that a video was opened,
 *   not how long it was watched. Giving up after ten seconds is
 *   indistinguishable from watching it all the way through. Any total in hours
 *   is therefore a ceiling, not a measurement.
 * - **Opening is not watching.** Tabs restored when the browser starts produce
 *   genuine history entries without anyone having watched anything. See
 *   `detectAutoOpened`.
 * - **Deleted or private videos** appear without a title or a channel. They are
 *   counted separately, never silently ignored.
 */

import { t, bcp47 } from './i18n.js';

const RE_VIDEO_URL = /[?&]v=([\w-]{11})/;
const RE_CHANNEL_URL = /\/channel\/(UC[\w-]{22})/;

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Reading the export
// ---------------------------------------------------------------------------

/**
 * Does this viewing know what time of day it happened?
 *
 * Everything Takeout exports and everything the extension measures does. What
 * is read off YouTube's own history page does not: that page groups its items
 * under a date heading and gives nothing finer, so those rows all sit at local
 * noon. Counting them in an hourly distribution would put a spike at midday
 * that nobody ever watched — which is why they are left out of it, and why the
 * page says how many viewings the curve was actually drawn on.
 */
function hasClock(entry) {
  return entry.source !== 'yt';
}

/**
 * Reads a Takeout `watch-history.json`.
 *
 * The HTML format of the same export is deliberately unsupported: it is a soup
 * of tags with no stable structure, expensive to parse and fragile. Takeout lets
 * you pick JSON per product, and that is what to do.
 *
 * @param {unknown} json  the already deserialised content
 * @returns {{entries: Array<{videoId: string, watchedAt: number, title: string,
 *   channelId: string | null, channelTitle: string, nonResolue: boolean}>,
 *   deleted: number, ignored: number, unresolved: number}}
 */
export function parseWatchHistory(json) {
  if (!Array.isArray(json)) throw new Error(t('hist.imp.badformat'));

  const entries = [];
  let deleted = 0;
  let ignored = 0;
  let unresolved = 0;

  for (const raw of json) {
    if (!raw || typeof raw !== 'object') { ignored++; continue; }

    const watchedAt = Date.parse(raw.time ?? '');
    if (!Number.isFinite(watchedAt)) { ignored++; continue; }

    const videoId = RE_VIDEO_URL.exec(raw.titleUrl ?? '')?.[1] ?? null;
    if (!videoId) {
      // Video deleted, gone private, or an entry that is not a viewing (a
      // search, for instance, if the user exported both).
      if (/regard|watched/i.test(raw.title ?? '')) deleted++;
      else ignored++;
      continue;
    }

    // The title is prefixed by YouTube: "Vous avez regardé Real title".
    const rawTitle = String(raw.title ?? '');
    const title = rawTitle.replace(/^(Vous avez regardé|Watched)\s+/i, '').trim();

    const sub = Array.isArray(raw.subtitles) ? raw.subtitles[0] : null;
    const channelTitle = String(sub?.name ?? '').trim();

    // When Google can no longer resolve the video — deleted, private,
    // restricted — it puts the URL in place of the title and gives no channel.
    // Those entries are still genuine viewings, but grouping them under an
    // "unknown channel" created a phantom channel that took first place in the
    // ranking. They are therefore marked and counted separately.
    //
    // The `nonResolue` flag keeps its French name: it is written to disk on
    // every history row, and renaming it would orphan every existing profile.
    const nonResolue = !channelTitle && /^https?:\/\//.test(title);
    if (nonResolue) unresolved++;

    entries.push({
      videoId,
      watchedAt,
      title: nonResolue ? '' : title,
      channelId: RE_CHANNEL_URL.exec(sub?.url ?? '')?.[1] ?? null,
      channelTitle,
      nonResolue,
    });
  }

  return { entries, deleted, ignored, unresolved };
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * Bounds of a named range.
 *
 * Sliding ranges (`30j`) answer "and right now?", calendar years answer "what
 * did 2025 look like?". Both are useful and neither replaces the other, hence
 * the two families.
 *
 * @param {string} name  `7j` `30j` `90j` `365j` `tout`, or a year (`2025`)
 * @param {number} [now]
 * @returns {{from: number, to: number}}
 */
export function rangeBounds(name, now = Date.now()) {
  if (/^\d{4}$/.test(String(name))) {
    const year = Number(name);
    return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime() - 1 };
  }
  const sliding = { '7j': 7, '30j': 30, '90j': 90, '365j': 365 };
  const days = sliding[name];
  return { from: days ? now - days * DAY : 0, to: now };
}

/**
 * The range of the same length immediately preceding this one.
 *
 * This is what gives the big numbers a meaning: "61 h" says nothing, "61 h,
 * +8 %" is understood at a glance.
 */
export function previousRange({ from, to }) {
  const span = to - from;
  return { from: from - span - 1, to: from - 1 };
}

/** The calendar years the history covers, most recent first. */
export function coveredYears(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const out = [];
  for (let y = new Date(to).getFullYear(); y >= new Date(from).getFullYear(); y--) out.push(y);
  return out;
}

// ---------------------------------------------------------------------------
// Tabs left open
// ---------------------------------------------------------------------------

/**
 * Spots the videos that are probably tabs reopened on every browser start
 * rather than actual viewings.
 *
 * Measured on a real export of 15,400 entries: those videos do **not** form
 * bursts at startup, because the browser only loads a restored tab when you
 * click on it. Each video therefore re-records itself alone, and the signature
 * is elsewhere — one view a day, never two, with a median gap of about a day,
 * for months on end. A video genuinely studied again has irregular gaps: a
 * course followed 39 times showed a median gap of 3.8 days, a tab opened 94
 * times a gap of 1.13 days.
 *
 * The view threshold alone is enough to raise the suspicion; the regularity
 * measures are there to explain it to the user, who decides. We do not decide
 * for them: a music channel played on a loop would produce the same signature.
 *
 * The threshold is deliberately high. Rewatching a video ten times stays
 * plausible when studying it over a week; beyond that, the mechanical
 * explanation becomes the most likely one.
 *
 * @param {Array<{videoId: string, watchedAt: number, title: string, channelTitle: string}>} entries
 * @param {{minViews?: number}} [opts]
 * @returns {Array<{videoId: string, title: string, channelTitle: string, views: number,
 *   days: number, spanDays: number, medianGapDays: number, oneADay: boolean, regular: boolean}>}
 */
export function detectAutoOpened(entries, { minViews = 11 } = {}) {
  const byVideo = new Map();
  for (const e of entries) {
    let l = byVideo.get(e.videoId);
    if (!l) byVideo.set(e.videoId, (l = []));
    l.push(e);
  }

  const out = [];
  for (const [videoId, views] of byVideo) {
    if (views.length < minViews) continue;
    views.sort((a, b) => a.watchedAt - b.watchedAt);

    const days = new Set(views.map((e) => localDay(e.watchedAt)));
    const gaps = [];
    for (let i = 1; i < views.length; i++) {
      gaps.push((views[i].watchedAt - views[i - 1].watchedAt) / DAY);
    }
    const medianGapDays = median(gaps);
    const spanDays = Math.round((views.at(-1).watchedAt - views[0].watchedAt) / DAY) + 1;

    out.push({
      videoId,
      title: views[0].title,
      channelTitle: views[0].channelTitle,
      views: views.length,
      days: days.size,
      spanDays,
      medianGapDays,
      // The two markers that separate the mechanical from the human, shown as a
      // justification rather than applied as a filter.
      oneADay: days.size === views.length,
      regular: medianGapDays > 0 && medianGapDays <= 1.5,
    });
  }

  return out.sort((a, b) => b.views - a.views);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Share of measured openings above which the page switches to time actually
 * watched.
 *
 * Nine out of ten: beyond that, what remains from Takeout is a fringe, and
 * treating it as complete viewing no longer moves the totals visibly. Below it,
 * the export's assumption is kept for everyone — better an acknowledged ceiling
 * than a total half measured and half estimated.
 */
export const REAL_TIME_THRESHOLD = 0.9;

/**
 * Number of known durations above which the mean of what was watched of a
 * channel takes precedence over the mean of its uploads.
 *
 * Three: below that, a single long form watched by chance on a clip channel
 * would give an absurd mean. Above it, the sample describes a habit, and it is
 * precisely a habit we are trying to extrapolate.
 */
export const MIN_MEAN_SAMPLE = 3;

/**
 * The mean duration to use per channel, to estimate videos whose exact duration
 * is missing.
 *
 * The mean of a channel's uploads answers a different question from the one
 * being asked. We want the probable duration **of a video we watched**, and a
 * channel that publishes a hundred Shorts and twenty hour-long documentaries has
 * an upload mean of a few minutes even though only the documentaries were ever
 * watched. In a real case, the report announced nine minutes for a channel none
 * of whose watched videos went below half an hour.
 *
 * We therefore prefer the mean of the videos of that channel actually opened and
 * whose duration is known: same unit, same selection, no network request. The
 * upload mean now only serves as a fallback, for channels with too few known
 * durations.
 *
 * @param {Array<object>} all  the whole history
 * @param {Map<string, number>} durations  known exact durations
 * @param {Map<string, number>} uploadMeans  fallback, per channel
 * @returns {Map<string, number>}
 */
export function refineChannelMeans(all, durations, uploadMeans = new Map()) {
  const totals = new Map();
  const seen = new Set();

  for (const e of all) {
    if (!e.channelId || seen.has(e.videoId)) continue;
    const exact = durations.get(e.videoId);
    if (!Number.isFinite(exact) || exact <= 0) continue;
    seen.add(e.videoId);

    const c = totals.get(e.channelId) ?? { total: 0, n: 0 };
    c.total += exact;
    c.n++;
    totals.set(e.channelId, c);
  }

  const means = new Map(uploadMeans);
  for (const [channelId, c] of totals) {
    if (c.n >= MIN_MEAN_SAMPLE) means.set(channelId, c.total / c.n);
  }
  return means;
}

/** The video's duration, exact if known, otherwise its channel's mean. */
function knownDuration(e, durations, channelMeans) {
  const exact = durations.get(e.videoId);
  if (Number.isFinite(exact) && exact > 0) return exact;
  const mean = e.channelId ? channelMeans.get(e.channelId) : undefined;
  return Number.isFinite(mean) && mean > 0 ? mean : 0;
}

/**
 * Statistics over a range.
 *
 * Receives **the whole** history, not just the slice asked for: knowing that a
 * channel is a discovery requires knowing what precedes the range. The filtering
 * therefore happens here. At 15,000 entries it is instant.
 *
 * @param {Array<object>} all  the whole known history
 * @param {object} [opts]
 * @param {number} [opts.from]
 * @param {number} [opts.to]
 * @param {number} [opts.topN]
 * @param {Map<string, number>} [opts.durations]     exact durations, in seconds
 * @param {Map<string, number>} [opts.channelMeans]  mean duration per channel
 * @param {Set<string>} [opts.blacklist]             excluded channels (id or title)
 * @param {Set<string>} [opts.excludedVideos]        excluded videos (open tabs)
 * @param {Set<string>} [opts.subscribed]            identifiers of the current subscriptions
 * @param {'mixed'|'auto'} [opts.timeModel]          how the hours are counted
 * @param {number} [opts.realThreshold]              coverage above which `auto`
 *   speaks of real time, between 0 and 1
 */
export function computeStats(all, {
  from = 0, to = Infinity, topN = 10,
  durations = new Map(), channelMeans = new Map(),
  blacklist = new Set(), excludedVideos = new Set(),
  subscribed = new Set(),
  timeModel = 'mixed', realThreshold = REAL_TIME_THRESHOLD,
} = {}) {
  const keep = (e) => !excludedVideos.has(e.videoId) && !isExcluded(e, blacklist);

  const kept = all.filter(keep);
  const inRange = kept.filter((e) => e.watchedAt >= from && e.watchedAt <= to);

  // First appearance of every channel across **the whole** history: that is what
  // distinguishes a discovery from a habit.
  const firstSeen = new Map();
  for (const e of kept) {
    if (e.nonResolue) continue;
    const key = channelKey(e);
    const known = firstSeen.get(key);
    if (known === undefined || e.watchedAt < known) firstSeen.set(key, e.watchedAt);
  }

  const byChannel = new Map();
  const perHour = new Array(24).fill(0);
  /** How many of the viewings on the range carried an hour. See `hasClock`. */
  let withClock = 0;
  const perWeekday = new Array(7).fill(0);
  const perMonth = new Map();
  const videoViews = new Map();
  const days = new Set();
  /** Daily detail, for the averages: `day → {videos, seconds, channels}`. */
  const daily = new Map();

  let exactSeconds = 0;
  let withExactDuration = 0;
  let estimatedSeconds = 0;
  let withEstimate = 0;
  let unresolved = 0;

  // The time really spent in front of the screen, when it is known.
  //
  // It counts per opening and not per distinct video: reopening a video, here,
  // really is more time spent.
  let watchedSeconds = 0;
  let measuredOpens = 0;
  // Cumulative duration of the measured openings alone: this is the denominator
  // of the mean share watched, and it cannot be the range's total, which also
  // contains openings we know nothing about.
  let measuredDuration = 0;

  // A video only counts its time once per range, whatever the number of
  // openings. The history cannot tell a genuine rewatch from a reopened tab,
  // and counting two hours three times for the same video is enough to tip a
  // whole channel's ranking. The number of openings, on the other hand, stays
  // counted in full: that is a measurement, not an extrapolation.
  const timeCounted = new Set();

  /**
   * Videos of the range at least one opening of which was measured.
   *
   * The mixed model needs it and cannot decide as it goes: a video opened three
   * times may only have been measured on the third row, and by then its length
   * has already been counted. So the length of every distinct video is set aside
   * with the day and the channel it belongs to, and the ones that turned out to
   * be measured are dropped once the walk is over.
   */
  const measuredVideos = new Set();
  /** videoId → what its length would add, and where. */
  const contentOf = new Map();

  let subscriptionViews = 0;

  for (const e of inRange) {
    const d = new Date(e.watchedAt);
    const day = localDay(e.watchedAt);
    if (hasClock(e)) { perHour[d.getHours()]++; withClock++; }
    perWeekday[d.getDay()]++;
    days.add(day);
    perMonth.set(localMonth(e.watchedAt), (perMonth.get(localMonth(e.watchedAt)) ?? 0) + 1);
    videoViews.set(e.videoId, (videoViews.get(e.videoId) ?? 0) + 1);

    let dd = daily.get(day);
    if (!dd) {
      dd = { videos: 0, seconds: 0, content: 0, real: 0, extra: 0, channels: new Set() };
      daily.set(day, dd);
    }
    dd.videos++;
    if (e.channelId) dd.channels.add(e.channelId);

    // Before sorting out the unresolved ones: a measured session is still time
    // spent even if the video has since been deleted.
    const measured = Number.isFinite(e.watchedSec) && e.watchedSec > 0;
    if (measured) {
      watchedSeconds += e.watchedSec;
      measuredOpens++;
      measuredVideos.add(e.videoId);
      dd.real += e.watchedSec;
      const duration = knownDuration(e, durations, channelMeans);
      if (duration) measuredDuration += duration;
    }

    if (e.nonResolue) { unresolved++; continue; }
    if (e.channelId && subscribed.has(e.channelId)) subscriptionViews++;

    const key = channelKey(e);
    let c = byChannel.get(key);
    if (!c) {
      c = {
        channelId: e.channelId,
        title: e.channelTitle || '',
        // Two figures, and the difference matters. `count` is the number of
        // *distinct* videos of the channel seen in the range, `opens` the
        // number of times one was opened. A channel with ten videos showed
        // twenty two under a "Videos" heading because reopenings were counted:
        // the number contradicted the time next to it, which has always been
        // saturated per video. Whatever is labelled "videos" now counts videos;
        // whatever is labelled "opened" counts openings.
        count: 0,
        opens: 0,
        seconds: 0,
        contentSeconds: 0,
        realSeconds: 0,
        /** Length of the videos of this channel no opening of which was
         *  measured. The mixed model adds it to `realSeconds`. */
        extra: 0,
        // Numerator and denominator of the share watched, kept apart: averaging
        // each video's percentage would give as much weight to a two minute clip
        // as to an hour-long documentary.
        measuredDuration: 0,
        measured: 0,
        exact: 0,
        withTime: 0,
        isNew: (firstSeen.get(key) ?? 0) >= from,
        subscribed: Boolean(e.channelId && subscribed.has(e.channelId)),
      };
      byChannel.set(key, c);
    }
    c.opens++;

    if (measured) {
      c.realSeconds += e.watchedSec;
      c.measured++;
      const duration = knownDuration(e, durations, channelMeans);
      if (duration) c.measuredDuration += duration;
    }

    if (timeCounted.has(e.videoId)) continue;
    timeCounted.add(e.videoId);
    c.count++;

    // Three levels of certainty, never mixed in the same counter: the video's
    // exact duration, failing that its channel's mean, failing that nothing at
    // all. We do not invent a global mean — mixing a two hour podcast and a
    // three minute clip produces no useful number.
    const exact = durations.get(e.videoId);
    if (Number.isFinite(exact) && exact > 0) {
      exactSeconds += exact;
      c.contentSeconds += exact;
      c.exact++;
      c.withTime++;
      withExactDuration++;
      dd.content += exact;
      contentOf.set(e.videoId, { seconds: exact, dd, c });
    } else {
      const mean = e.channelId ? channelMeans.get(e.channelId) : undefined;
      if (Number.isFinite(mean) && mean > 0) {
        estimatedSeconds += mean;
        c.contentSeconds += mean;
        c.withTime++;
        withEstimate++;
        dd.content += mean;
        contentOf.set(e.videoId, { seconds: mean, dd, c });
      }
    }
  }

  // What the mixed model adds on top of the measurements: the length of the
  // videos of the range no opening of which the extension saw. A video measured
  // even once is described by its measurement, and its length is dropped —
  // otherwise the same viewing would be counted twice, once as time spent and
  // once as content opened.
  let extraSeconds = 0;
  let extraVideos = 0;
  for (const [videoId, item] of contentOf) {
    if (measuredVideos.has(videoId)) continue;
    extraSeconds += item.seconds;
    extraVideos++;
    item.dd.extra += item.seconds;
    item.c.extra += item.seconds;
  }

  // ---------------------------------------------------------------------
  // Which measure of time the page carries
  // ---------------------------------------------------------------------
  //
  // Three ways of counting hours now, and only one must come out of here.
  //
  // `mixed` is the default since September 2026, and it is the closest to the
  // truth: every opening the extension measured counts what was actually
  // watched of it, and a video no opening of which could be measured counts its
  // length, once. Nothing is extrapolated — the middle ground that was ruled
  // out, and rightly, was applying the observed completion rate to the rows we
  // know nothing about, which invents hours indistinguishable from observed
  // ones. Here every second either was measured or is the video's own length.
  //
  // The two others are the earlier behaviour, kept under `auto` for whoever
  // wants one unit throughout: as long as a sizeable share of the range comes
  // from an import, the export's assumption holds — every video opened was
  // watched in full. Wrong in detail, but wrong the same way for every row,
  // which is what makes channels comparable with each other. Above the
  // threshold, the real measurement takes over.
  //
  // What made the default change: the history page collection adds viewings
  // that can never be measured, so it pushes any range under the threshold for
  // good. A week the extension had measured almost entirely went from three
  // hours a day to eleven, with nothing on screen saying the unit had changed.
  const measuredCoverage = inRange.length ? measuredOpens / inRange.length : 0;
  const timeMode = timeModel === 'mixed'
    ? 'mixed'
    : (measuredCoverage >= realThreshold ? 'real' : 'content');

  const pick = (real, content, mixed) => (
    timeMode === 'real' ? real : timeMode === 'mixed' ? mixed : content);

  for (const c of byChannel.values()) {
    c.seconds = pick(c.realSeconds, c.contentSeconds, c.realSeconds + c.extra);
    c.watchedShare = c.measuredDuration ? Math.min(1, c.realSeconds / c.measuredDuration) : null;
  }
  for (const dd of daily.values()) {
    dd.seconds = pick(dd.real, dd.content, dd.real + dd.extra);
  }

  const channels = [...byChannel.values()];
  const ranking = channels.slice().sort((a, b) => b.count - a.count);
  const coveredDays = boundsInDays(from, to, inRange);
  const rangeDays = spanInDays(from, to, inRange);

  return {
    from,
    to,
    total: inRange.length,
    uniqueVideos: videoViews.size,
    rewatches: [...videoViews.values()].reduce((s, n) => s + (n - 1), 0),
    activeDays: days.size,
    coveredDays,
    first: inRange.length ? inRange.reduce((m, e) => Math.min(m, e.watchedAt), Infinity) : null,
    last: inRange.length ? inRange.reduce((m, e) => Math.max(m, e.watchedAt), -Infinity) : null,

    // Time
    exactSeconds,
    estimatedSeconds,
    contentSeconds: exactSeconds + estimatedSeconds,
    totalSeconds: pick(
      watchedSeconds, exactSeconds + estimatedSeconds, watchedSeconds + extraSeconds),
    // The two halves of the mixed total, so the page can say what rests on a
    // measurement and what rests on a length.
    extraSeconds,
    extraVideos,
    withExactDuration,
    withEstimate,
    watchedSeconds,
    measuredOpens,
    measuredCoverage,
    timeMode,
    timeModel,
    realThreshold,
    // Where the viewings of the range came from. This is the answer to "what
    // could the extension not trace, and why": `live` is what it measured
    // itself, `takeout` what an export supplied, `yt` what was read off
    // YouTube's own history page — a phone, a television, another browser, or
    // this one before the extension was installed. A line that only carries a
    // day can never be measured, so collecting them lowers the coverage rate
    // for good, and that is worth saying rather than letting a total quietly
    // change meaning.
    bySource: inRange.reduce((acc, e) => {
      // A row with no source at all predates the field and comes from an
      // import: it is filed with Takeout, the same way `hasClock` credits it
      // with an hour. Reading it as scraped would blame the collection for
      // lines that were there before it existed.
      acc[e.source === 'live' ? 'live' : e.source === 'yt' ? 'yt' : 'takeout']++;
      return acc;
    }, { live: 0, takeout: 0, yt: 0 }),
    // Mean share of a video actually watched, weighted by duration. `null` and
    // not zero when nothing is measured: the absence of a measurement is not a
    // rate of zero percent.
    meanWatchedShare: measuredDuration
      ? Math.min(1, watchedSeconds / measuredDuration)
      : null,
    // Related to the number of distinct videos, since that is what the time is
    // computed on: relating them to the openings would give a false coverage
    // rate.
    countedVideos: timeCounted.size,
    withoutDuration: timeCounted.size - withExactDuration - withEstimate,

    // Rhythm
    perHour,
    withClock,
    perWeekday,
    perMonth: [...perMonth.entries()].sort(([a], [b]) => a.localeCompare(b)),
    dailySeries: dailySeries(inRange, from, to),
    longestStreak: longestRun(days),
    sessions: countSessions(inRange, { durations, channelMeans }),
    rangeDays,
    averages: averages({ daily, rangeDays, activeDays: days.size }),

    // Subscriptions
    subscriptionViews,
    subscriptionShare: inRange.length ? subscriptionViews / inRange.length : 0,

    // Channels
    topChannels: ranking.slice(0, topN),
    // The same chart, ordered by time. It does not follow from the previous one:
    // a channel of two hour podcasts weighs more than thirty five-minute videos,
    // and so falls outside the top fifteen by count.
    topChannelsByTime: channels.slice().sort((a, b) => b.seconds - a.seconds).slice(0, topN),
    distinctChannels: channels.length,
    newChannels: channels.filter((c) => c.isNew).length,
    seenOnce: channels.filter((c) => c.count === 1).length,
    concentration: concentration(channels, 'count'),
    concentrationByTime: concentration(channels, 'seconds'),

    // Heavily watched channels one is not subscribed to. Computed here and not
    // by the caller: they are looked for in the whole ranking, of which only the
    // first fifteen rows leave the service worker.
    unsubscribedCandidates: ranking
      .filter((c) => !c.subscribed && c.channelId && c.count >= 3)
      .slice(0, 12)
      .map((c) => ({ channelId: c.channelId, title: c.title, count: c.count, seconds: c.seconds })),

    unresolved,
  };
}

/**
 * Share held by the top N channels — the measure of diversity.
 *
 * Computed on both quantities: the displayed ranking switches between number of
 * videos and time, and a concentration figure that did not follow the switch
 * would describe a ranking that is no longer on screen.
 */
function concentration(channels, field) {
  const ranking = channels.slice().sort((a, b) => b[field] - a[field]);
  const total = ranking.reduce((s, c) => s + c[field], 0);
  const steps = [1, 5, 10, 25, 50, 100];
  const out = [];
  let running = 0;
  let i = 0;
  for (const n of steps) {
    if (n > ranking.length) break;
    while (i < n) running += ranking[i++][field];
    out.push({ n, share: total ? running / total : 0 });
  }
  return out;
}

/**
 * Groups views into sessions: a run of videos watched back to back without a
 * pause.
 *
 * The cut is made on **idle time**, not on the raw gap between two openings.
 * Watching an hour and a half podcast then moving on to something else leaves a
 * gap of an hour and a half, which a raw threshold would have split into two
 * sessions when nothing was interrupted.
 *
 * When the previous video's duration is unknown, we lend it thirty minutes: the
 * effective threshold becomes an hour of gap, which is still fairer than
 * assuming an instantaneous video.
 */
function countSessions(entries, { durations, channelMeans, pauseMin = 30, defaultSec = 1800 } = {}) {
  if (!entries.length) return { count: 0, median: 0, max: 0, videosPerSession: 0 };

  const sorted = entries.slice().sort((a, b) => a.watchedAt - b.watchedAt);
  const sizes = [];
  let current = 1;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const duration = durations?.get(prev.videoId)
      ?? (prev.channelId ? channelMeans?.get(prev.channelId) : undefined)
      ?? defaultSec;
    const idle = (sorted[i].watchedAt - prev.watchedAt) / 1000 - duration;

    if (idle <= pauseMin * 60) current++;
    else { sizes.push(current); current = 1; }
  }
  sizes.push(current);

  return {
    count: sizes.length,
    median: median(sizes),
    max: Math.max(...sizes),
    videosPerSession: sorted.length / sizes.length,
  };
}

/**
 * Averages per day and per week.
 *
 * Two denominators coexist and conflating them would mislead: related to the
 * days of the range, the figure describes a way of life; related to the days
 * something was actually watched, it describes the intensity of a sitting. Both
 * are returned, the interface picks.
 */
function averages({ daily, rangeDays, activeDays }) {
  const days = [...daily.values()];
  const weeks = new Map();
  for (const [key, d] of daily) {
    const w = weekOf(key);
    let s = weeks.get(w);
    if (!s) { s = { videos: 0, seconds: 0, channels: new Set() }; weeks.set(w, s); }
    s.videos += d.videos;
    s.seconds += d.seconds;
    for (const c of d.channels) s.channels.add(c);
  }

  const sum = (list, field) => list.reduce((s, x) => s + x[field], 0);
  const totalVideos = sum(days, 'videos');
  const totalSeconds = sum(days, 'seconds');

  const weekCount = Math.max(1, rangeDays / 7);
  const weekList = [...weeks.values()];
  const span = Math.max(1, rangeDays);

  return {
    perCoveredDay: {
      seconds: totalSeconds / span,
      videos: totalVideos / span,
      channels: days.reduce((s, d) => s + d.channels.size, 0) / span,
    },
    perActiveDay: {
      seconds: activeDays ? totalSeconds / activeDays : 0,
      videos: activeDays ? totalVideos / activeDays : 0,
      channels: activeDays ? days.reduce((s, d) => s + d.channels.size, 0) / activeDays : 0,
    },
    perWeek: {
      seconds: totalSeconds / weekCount,
      videos: totalVideos / weekCount,
      // The distinct channels of a week are counted, not added up: the same
      // channel seen on Monday and on Thursday is still just one.
      channels: weekList.length
        ? weekList.reduce((s, x) => s + x.channels.size, 0) / weekList.length
        : 0,
    },
  };
}

/** Week key "2026-W33", Monday as the first day. */
function weekOf(isoDay) {
  const d = new Date(`${isoDay}T00:00:00`);
  const weekday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - weekday);
  return localDayOf(d);
}

/**
 * Number of videos per day, without gaps.
 *
 * Dense — empty days are zero and not "nothing" — because the curve has to show
 * the troughs. A sparse series would make them disappear, and two days separated
 * by three weeks of inactivity would end up side by side.
 */
function dailySeries(inRange, from, to) {
  if (!inRange.length) return [];

  const counts = new Map();
  for (const e of inRange) counts.set(localDay(e.watchedAt), (counts.get(localDay(e.watchedAt)) ?? 0) + 1);

  const start = new Date(Number.isFinite(from) && from > 0
    ? from
    : Math.min(...inRange.map((e) => e.watchedAt)));
  const end = new Date(Math.min(Number.isFinite(to) ? to : Date.now(), Date.now()));

  const out = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  // Safeguard: beyond twenty years the range is nonsensical, and the loop would
  // stand no chance of producing a readable graph.
  for (let i = 0; cursor <= end && i < 7500; i++) {
    const key = localDayOf(cursor);
    out.push([key, counts.get(key) ?? 0]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** The longest run of consecutive days with at least one video. */
function longestRun(activeDays) {
  if (!activeDays.size) return 0;
  const sorted = [...activeDays].sort();
  let max = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    const dayBefore = new Date(`${sorted[i]}T00:00:00`);
    dayBefore.setDate(dayBefore.getDate() - 1);
    if (localDayOf(dayBefore) === sorted[i - 1]) current++;
    else current = 1;
    if (current > max) max = current;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Per-channel streaks
// ---------------------------------------------------------------------------

/**
 * How many of a channel's latest videos were watched, without missing one.
 *
 * This is the only definition of a per-channel streak that means anything:
 * counting consecutive days makes no sense when it is the channel, not the
 * viewer, that sets the pace — a channel on a break would break a streak without
 * anyone having changed a thing.
 *
 * The measure is **capped by what was fetched** (200 videos per channel). A
 * streak equal to the number of known uploads is therefore a floor, not a total:
 * `capped` signals it so the interface can say so instead of implying a maximum.
 *
 * @param {Array<{videoId: string}>} entries  the retained history
 * @param {Map<string, string[]>} uploadsByChannel  upload ids, most recent first
 * @returns {Array<{channelId: string, streak: number, known: number, capped: boolean}>}
 */

/**
 * How many brand new uploads may wait without breaking a streak.
 *
 * A video released this morning is not a missed video. Without this tolerance, a
 * channel followed without missing one for years showed zero on the day of its
 * next release — the exact symptom that motivated this guard.
 *
 * The cap prevents the opposite effect: on an abandoned channel that publishes
 * every day, skipping everything recent would resurrect a dead streak.
 */
const RECENT_TOLERATED = 3;

export function computeChannelStreaks(entries, uploadsByChannel, { recent = new Set() } = {}) {
  const seen = new Set(entries.map((e) => e.videoId));
  const out = [];

  for (const [channelId, uploads] of uploadsByChannel) {
    if (!Array.isArray(uploads) || !uploads.length) continue;

    // Uploads from the last few days that have not been opened yet are set
    // aside, not counted as missed. Only those whose publication date is known —
    // the followed channels, which the feed synchronises — get the grace period:
    // elsewhere, nothing says they are recent.
    let start = 0;
    while (start < uploads.length && start < RECENT_TOLERATED
      && !seen.has(uploads[start]) && recent.has(uploads[start])) start++;

    let streak = 0;
    while (start + streak < uploads.length && seen.has(uploads[start + streak])) streak++;
    if (!streak) continue;

    out.push({
      channelId,
      streak,
      // What the streak is waiting on: the page says it, otherwise a "42" on a
      // channel whose latest video is unwatched would look wrong.
      pending: start,
      known: uploads.length,
      capped: start + streak === uploads.length,
    });
  }

  return out.sort((a, b) => b.streak - a.streak);
}

// ---------------------------------------------------------------------------
// A channel's report
// ---------------------------------------------------------------------------

/**
 * Everything the history knows about a single channel.
 *
 * Two horizons deliberately coexist. The consumption figures — time, openings,
 * rhythm — cover the chosen range, as everywhere else on the page. The
 * relationship to the channel — first seen, seniority, current streak — covers
 * **the whole** history: knowing one has followed someone for two years makes no
 * sense if it is recomputed over the last thirty days.
 *
 * @param {Array} all               the whole history, already stripped of exclusions
 * @param {object} opts
 * @param {string} opts.channelId
 * @param {Map<string, number>} [opts.durations]
 * @param {Map<string, number>} [opts.channelMeans]
 * @param {string[]} [opts.uploads]  the channel's latest known videos, most recent first
 */
export function computeChannelReport(all, {
  channelId, from = 0, to = Infinity,
  durations = new Map(), channelMeans = new Map(), uploads = [],
} = {}) {
  const its = all.filter((e) => e.channelId === channelId && !e.nonResolue);
  if (!its.length) return null;

  const inRange = its.filter((e) => e.watchedAt >= from && e.watchedAt <= to);
  const mean = channelMeans.get(channelId);

  // One row per video, not per opening: this is the list of what was watched,
  // and thirty identical rows for a tab left open would have taught nothing.
  const byVideo = new Map();
  for (const e of inRange) {
    let v = byVideo.get(e.videoId);
    if (!v) {
      const exact = durations.get(e.videoId);
      v = {
        videoId: e.videoId,
        title: e.title,
        opens: 0,
        first: e.watchedAt,
        last: e.watchedAt,
        seconds: Number.isFinite(exact) && exact > 0 ? exact : (mean ?? 0),
        exact: Number.isFinite(exact) && exact > 0,
        // Time really spent on this video, all openings together. `null` until
        // an opening has been measured: zero would suggest the video was opened
        // without being watched at all.
        watchedSeconds: null,
        measured: 0,
      };
      byVideo.set(e.videoId, v);
    }
    v.opens++;
    v.first = Math.min(v.first, e.watchedAt);
    v.last = Math.max(v.last, e.watchedAt);

    if (Number.isFinite(e.watchedSec) && e.watchedSec > 0) {
      v.watchedSeconds = (v.watchedSeconds ?? 0) + e.watchedSec;
      v.measured++;
    }
  }

  const videos = [...byVideo.values()].sort((a, b) => b.last - a.last);
  const perHour = new Array(24).fill(0);
  /** How many of the viewings on the range carried an hour. See `hasClock`. */
  let withClock = 0;
  const perWeekday = new Array(7).fill(0);
  const days = new Set();
  // Weighted by duration, like the global figure: a channel whose clips are
  // watched in full and whose long forms are watched halfway must not show the
  // average of the two percentages, but the real share of the time offered.
  let watchedSeconds = 0;
  let measuredDuration = 0;
  for (const e of inRange) {
    const d = new Date(e.watchedAt);
    if (hasClock(e)) { perHour[d.getHours()]++; withClock++; }
    perWeekday[d.getDay()]++;
    days.add(localDay(e.watchedAt));

    if (Number.isFinite(e.watchedSec) && e.watchedSec > 0) {
      watchedSeconds += e.watchedSec;
      measuredDuration += knownDuration(e, durations, channelMeans);
    }
  }

  // Coverage: what share of the channel's known videos was opened, one day or
  // another. Related to the whole history, not to the range — otherwise a seven
  // day range would always give zero.
  const everSeen = new Set(its.map((e) => e.videoId));
  const knownSeen = uploads.filter((id) => everSeen.has(id)).length;

  let streak = 0;
  while (streak < uploads.length && everSeen.has(uploads[streak])) streak++;

  // The best streak is not the current one, and the gap between the two is
  // precisely what one wants to see: having followed thirty videos in a row then
  // missed the latest resets the counter to zero without saying anything about
  // the relationship.
  let streakMax = 0;
  let current = 0;
  for (const id of uploads) {
    if (everSeen.has(id)) { current++; if (current > streakMax) streakMax = current; }
    else current = 0;
  }

  return {
    channelId,
    title: its[its.length - 1].channelTitle || '',

    // Over the range
    opens: inRange.length,
    distinctVideos: byVideo.size,
    seconds: videos.reduce((s, v) => s + v.seconds, 0),
    withExactDuration: videos.filter((v) => v.exact).length,
    watchedSeconds,
    measuredOpens: inRange.filter((e) => e.watchedSec > 0).length,
    watchedShare: measuredDuration ? Math.min(1, watchedSeconds / measuredDuration) : null,

    // Enough to check the estimate rather than having to trust it: the mean
    // duration used for this channel, and how many of its videos it rests on.
    // Above the threshold, those are the watched videos of this channel; below
    // it, the mean of its recent uploads.
    channelMean: channelMeans.get(channelId) ?? null,
    knownDurations: [...new Set(its.map((e) => e.videoId))]
      .filter((id) => durations.get(id) > 0).length,

    activeDays: days.size,
    perHour,
    withClock,
    perWeekday,
    dailySeries: dailySeries(inRange, from, to),
    videos,

    // Over the whole history
    firstSeen: Math.min(...its.map((e) => e.watchedAt)),
    lastSeen: Math.max(...its.map((e) => e.watchedAt)),
    totalOpens: its.length,
    totalVideos: everSeen.size,
    knownUploads: uploads.length,
    coverage: uploads.length ? knownSeen / uploads.length : null,
    streak,
    streakMax,
    streakCapped: uploads.length > 0 && streak === uploads.length,
  };
}

/**
 * Directory of the history's channels, for the search.
 *
 * Deliberately lightweight: a name, two counters, a picture. The detail is asked
 * for channel by channel — sending the full report of three thousand seven
 * hundred channels so one of them can be searched for would make no sense.
 */
export function listHistoryChannels(all, {
  durations = new Map(), channelMeans = new Map(), now = Date.now(),
} = {}) {
  const byChannel = new Map();
  const counted = new Set();

  // Two calendar windows, computed once: the current month and the current
  // year. The duel asks about them, and recomputing the bound per entry on a
  // fifteen thousand line history is the kind of thing one only notices when
  // the dialog takes a second to open.
  const ref = new Date(now);
  const monthFrom = new Date(ref.getFullYear(), ref.getMonth(), 1).getTime();
  const yearFrom = new Date(ref.getFullYear(), 0, 1).getTime();

  for (const e of all) {
    if (e.nonResolue || !e.channelId) continue;
    let c = byChannel.get(e.channelId);
    if (!c) {
      c = { channelId: e.channelId, title: e.channelTitle || '',
            count: 0, opens: 0, seconds: 0, lastSeen: 0, firstSeen: Infinity,
            // Same saturation as the totals: a video reopened this month
            // counts once here too, otherwise the two figures of a single card
            // would disagree.
            month: { count: 0, seconds: 0 }, year: { count: 0, seconds: 0 } };
      byChannel.set(e.channelId, c);
    }
    c.opens++;
    c.lastSeen = Math.max(c.lastSeen, e.watchedAt);
    c.firstSeen = Math.min(c.firstSeen, e.watchedAt);

    // Same saturation rule as everywhere else: a reopened video does not bring
    // its time in twice, otherwise the directory would contradict the ranking.
    if (counted.has(e.videoId)) continue;
    counted.add(e.videoId);
    c.count++;
    const exact = durations.get(e.videoId);
    const seconds = Number.isFinite(exact) && exact > 0
      ? exact
      : (channelMeans.get(e.channelId) ?? 0);
    c.seconds += seconds;

    // A video is filed under the window of its **first** viewing in the range,
    // which is the one just counted: watching it again in December does not
    // make it a December video.
    if (e.watchedAt >= yearFrom) {
      c.year.count++;
      c.year.seconds += seconds;
      if (e.watchedAt >= monthFrom) {
        c.month.count++;
        c.month.seconds += seconds;
      }
    }
  }

  for (const c of byChannel.values()) {
    if (!Number.isFinite(c.firstSeen)) c.firstSeen = 0;
  }

  return [...byChannel.values()].sort((a, b) => b.opens - a.opens || b.count - a.count);
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/**
 * The words and phrases that keep coming back in the titles.
 *
 * This is not a classification: YouTube gives no usable category, and raw
 * frequency does not produce a taxonomy. But on a real export the themes emerge
 * anyway — "rocket league" 463 times, "geoguessr" 274, "bitcoin" 199 — because
 * the titles of a single subject share their vocabulary. Two-word phrases are
 * kept first: they carry far more meaning than an isolated word.
 */
export function extractThemes(entries, { topN = 24, minCount = null } = {}) {
  // The threshold follows the volume. Frozen at four, it let almost nothing
  // through on a seven day range — a few hundred titles where no word appears
  // four times — when that is exactly where one wants to see what the week was
  // made of.
  const threshold = minCount ?? (entries.length >= 1500 ? 4 : entries.length >= 400 ? 3 : 2);
  // A phrase says more than a word, but it is also far more specific: at equal
  // thresholds, the list filled up with bits of titles seen three times that
  // designate no subject at all.
  const bigramThreshold = threshold + 1;

  // Videos, not openings. The figure shown next to the word is the one found by
  // clicking on it, and a series watched three times therefore does not count
  // triple: the count and the list told two different stories about the same
  // theme.
  /** @type {Map<string, Set<string>>} */
  const unigrams = new Map();
  /** @type {Map<string, Set<string>>} */
  const bigrams = new Map();
  const note = (index, key, videoId) => {
    let seen = index.get(key);
    if (!seen) { seen = new Set(); index.set(key, seen); }
    seen.add(videoId);
  };

  for (const e of entries) {
    if (e.nonResolue || !e.title) continue;
    const videoId = e.videoId ?? e.title;

    // The same splitting as `findVideosByTerm`, down to the character. That was
    // not the case: the two normalisations diverged on apostrophes, and a theme
    // containing one opened no video when clicked.
    const words = e.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
    const keep = (m) => m.length >= 3 && !STOP_WORDS.has(m) && !/^\d+$/.test(m);

    for (let i = 0; i < words.length; i++) {
      if (!keep(words[i])) continue;
      note(unigrams, words[i], videoId);
      // The two words have to follow each other in the original title. Taking
      // them from the already filtered list, "how to use rocket in league"
      // produced the phrase "rocket league", which no search could then find
      // again since it appears in no title.
      if (i + 1 < words.length && keep(words[i + 1])) {
        note(bigrams, `${words[i]} ${words[i + 1]}`, videoId);
      }
    }
  }

  // Two overlapping phrases tell the same story: "rocket league" and "league
  // highlights" came out side by side with the same count, drawn from the same
  // titles. The most frequent one takes its two words; those that reuse one
  // without doing better are dropped.
  const phrases = [];
  const takenWords = new Map();
  const byCount = [...bigrams.entries()]
    .map(([pair, seen]) => [pair, seen.size])
    .sort((a, b) => b[1] - a[1]);
  for (const [pair, n] of byCount) {
    if (n < bigramThreshold) continue;
    const [left, right] = pair.split(' ');
    if ((takenWords.get(left) ?? 0) >= n || (takenWords.get(right) ?? 0) >= n) continue;
    phrases.push([pair, n]);
    takenWords.set(left, Math.max(takenWords.get(left) ?? 0, n));
    takenWords.set(right, Math.max(takenWords.get(right) ?? 0, n));
  }

  // A word almost all of whose occurrences belong to a single phrase adds
  // nothing to it: "rocket" and "league" are absorbed by "rocket league".
  const absorbed = new Set();
  for (const [pair, n] of phrases) {
    for (const word of pair.split(' ')) {
      if (n >= (unigrams.get(word)?.size ?? 0) * 0.6) absorbed.add(word);
    }
  }

  const all = [
    ...phrases.map(([text, n]) => ({ text, n, expression: true })),
    ...[...unigrams.entries()]
      .map(([text, seen]) => [text, seen.size])
      .filter(([word, n]) => n >= threshold && !absorbed.has(word))
      .map(([text, n]) => ({ text, n, expression: false })),
  ];

  return all.sort((a, b) => b.n - a.n).slice(0, topN);
}

// ---------------------------------------------------------------------------
// One day, read row by row
// ---------------------------------------------------------------------------

/**
 * Mean share of a video actually watched, per channel, over the whole history.
 *
 * Weighted by duration and not by video: averaging percentages would give a two
 * minute clip the same say as an hour long documentary. Only the openings the
 * extension measured enter it, since they are the only ones that know how much
 * of a video was actually seen.
 *
 * @param {Array<object>} all   every viewing, not only the day being read
 * @param {Set<string>} only    the channels worth computing, to avoid sweeping
 *   thousands of them for a day that shows five
 * @returns {Map<string, {share: number, opens: number}>}
 */
function channelWatchShares(all, durations, channelMeans, only) {
  const acc = new Map();
  for (const e of all) {
    if (!e.channelId || !only.has(e.channelId)) continue;
    if (!(Number.isFinite(e.watchedSec) && e.watchedSec > 0)) continue;
    const duration = knownDuration(e, durations, channelMeans);
    if (!duration) continue;
    let a = acc.get(e.channelId);
    if (!a) { a = { watched: 0, duration: 0, opens: 0 }; acc.set(e.channelId, a); }
    a.watched += e.watchedSec;
    a.duration += duration;
    a.opens++;
  }
  const out = new Map();
  for (const [id, a] of acc) {
    out.set(id, { share: Math.min(1, a.watched / a.duration), opens: a.opens });
  }
  return out;
}

/**
 * One day of history, as it is read rather than as it is counted.
 *
 * The statistics answer "how much"; this answers "what, and when". It is also
 * the only view that shows a row for what it is — where it came from, whether it
 * carries an hour, how much of it was measured — which is what makes it the
 * first place to look when a figure elsewhere looks wrong.
 *
 * The rows come out in the order they happened. Rows with no clock all sit at
 * local noon and therefore land in the middle of the day: that is not a guess
 * about when they were watched, and the display says so rather than printing a
 * time nobody measured.
 *
 * @param {Array<object>} all  every viewing; the whole history is needed, not
 *   only the day, because the neighbouring days and the channel habits are read
 *   from it
 * @param {object} opts
 * @param {number} opts.from   first millisecond of the day, local
 * @param {number} opts.to     last millisecond of the day, local
 */
export function buildDayJournal(all, {
  from = 0, to = 0,
  durations = new Map(), channelMeans = new Map(),
  excludedVideos = new Set(), blacklist = new Set(),
} = {}) {
  const kept = all.filter((e) => !excludedVideos.has(e.videoId) && !isExcluded(e, blacklist));

  const entries = kept
    .filter((e) => e.watchedAt >= from && e.watchedAt <= to)
    .sort((a, b) => a.watchedAt - b.watchedAt)
    .map((e) => {
      const exact = durations.get(e.videoId);
      const exactDuration = Number.isFinite(exact) && exact > 0;
      const durationSec = exactDuration ? exact : (knownDuration(e, durations, channelMeans) || null);
      const watchedSec = Number.isFinite(e.watchedSec) && e.watchedSec > 0 ? e.watchedSec : null;
      return {
        key: e.key ?? `${e.videoId}|${e.watchedAt}`,
        videoId: e.videoId,
        title: e.title ?? '',
        channelId: e.channelId ?? null,
        channelTitle: e.channelTitle ?? '',
        watchedAt: e.watchedAt,
        hasClock: hasClock(e),
        // A row with no source at all predates the field and comes from an
        // import, exactly as `computeStats` reads it.
        source: e.source === 'live' ? 'live' : e.source === 'yt' ? 'yt' : 'takeout',
        watchedSec,
        completed: Boolean(e.completed),
        unresolved: Boolean(e.nonResolue),
        durationSec,
        exactDuration,
        // Capped at one: a real measurement can exceed the length it is compared
        // against when that length is only the channel's average.
        progress: watchedSec && durationSec ? Math.min(1, watchedSec / durationSec) : null,
      };
    });

  const channelIds = new Set(entries.map((e) => e.channelId).filter(Boolean));
  const shares = channelWatchShares(kept, durations, channelMeans, channelIds);
  for (const e of entries) {
    const s = e.channelId ? shares.get(e.channelId) : null;
    e.channelShare = s ? s.share : null;
    e.channelShareOpens = s ? s.opens : 0;
  }

  // The nearest day on either side that holds something. Stepping one day at a
  // time through a week away from home meant seven empty screens before finding
  // anything, and nothing on those screens said how far the next one was.
  let previous = null;
  let next = null;
  for (const e of kept) {
    if (e.watchedAt < from) previous = previous === null ? e.watchedAt : Math.max(previous, e.watchedAt);
    else if (e.watchedAt > to) next = next === null ? e.watchedAt : Math.min(next, e.watchedAt);
  }

  // The same arithmetic as the mixed model of `computeStats`, on one day: a
  // measured opening is worth its measurement, a video no opening of which was
  // measured is worth its length once, and nothing is worth both.
  const measuredVideos = new Set();
  const lengths = new Map();
  // Measured seconds per video, summed over that video's openings of the day: a
  // video opened three times is one video, and the coverage below compares it
  // against one length.
  const watchedPerVideo = new Map();
  let seconds = 0;
  let measured = 0;
  for (const e of entries) {
    if (e.watchedSec) {
      seconds += e.watchedSec;
      measured++;
      measuredVideos.add(e.videoId);
      watchedPerVideo.set(e.videoId, (watchedPerVideo.get(e.videoId) ?? 0) + e.watchedSec);
    }
    if (e.durationSec && !lengths.has(e.videoId)) lengths.set(e.videoId, e.durationSec);
  }
  for (const [videoId, length] of lengths) {
    if (!measuredVideos.has(videoId)) seconds += length;
  }

  // What is actually known, without the mixed model's assumption.
  //
  // That model credits a video no opening of which was measured with its whole
  // length, and on a day of four two hour videos merely opened it announced
  // eleven hours watched — which is how the figure was caught. It is the right
  // answer over a range of months, where the unmeasured openings average out;
  // it is a guess on one day, and this page exists to show what is not a guess.
  //
  // So the day also carries the plain arithmetic: how many of its videos have a
  // known length, what those lengths add up to, and how much of that was really
  // measured. Capped video by video, because a measurement can exceed a length
  // that is only the channel's average.
  const coverage = { videos: lengths.size, seconds: 0, watched: 0, unknown: 0 };
  for (const [videoId, length] of lengths) {
    coverage.seconds += length;
    coverage.watched += Math.min(length, watchedPerVideo.get(videoId) ?? 0);
  }
  for (const videoId of new Set(entries.map((e) => e.videoId))) {
    if (!lengths.has(videoId)) coverage.unknown++;
  }

  return {
    from,
    to,
    entries,
    previous,
    next,
    summary: {
      total: entries.length,
      videos: new Set(entries.map((e) => e.videoId)).size,
      channels: channelIds.size,
      seconds,
      measured,
      // Total of the measurements alone, nothing added and nothing assumed.
      measuredSeconds: [...watchedPerVideo.values()].reduce((a, b) => a + b, 0),
      coverage,
      first: entries.length ? entries[0].watchedAt : null,
      last: entries.length ? entries[entries.length - 1].watchedAt : null,
      bySource: entries.reduce((acc, e) => { acc[e.source]++; return acc; },
        { live: 0, takeout: 0, yt: 0 }),
    },
  };
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/**
 * Display name of each topic.
 *
 * The keys of `TOPICS` stay in French: they act as identifiers, including in the
 * messages exchanged with the worker when asking for a topic's videos. Changing
 * language must not change what is asked for, only what is read.
 */
export const TOPIC_KEYS = {
  'Jeux vidéo': 'topic.games',
  'IA et machine learning': 'topic.ai',
  'Développement': 'topic.dev',
  'Crypto et finance': 'topic.finance',
  'Science et vulgarisation': 'topic.science',
  'Tech et matériel': 'topic.tech',
  'Humour et divertissement': 'topic.fun',
  'Musique': 'topic.music',
  'Actualité et société': 'topic.news',
  'Sport': 'topic.sport',
};

/**
 * Topic → vocabulary dictionary.
 *
 * This is the "tag base": rather than hoping a taxonomy emerges from the
 * frequencies, we decide in advance what we are looking for and see what
 * matches. YouTube does expose a category per video, but it is declared by the
 * author, has about fifteen values of which "People & Blogs" catches half the
 * site, and it would take one request per video to get it. A dictionary costs
 * zero requests and stays correctable.
 *
 * Its limits must be shown, not hidden: it only knows what was put into it, it
 * is in French and English only, and a share of the videos will match nothing.
 * That is why `classifyTopics` always returns the number of unclassified videos.
 *
 * Multi-word terms are looked for in the whole title; the others must form a
 * complete word, otherwise "ia" would fire on "médIA".
 */
const TOPICS = {
  'Jeux vidéo': [
    'rocket league', 'geoguessr', 'minecraft', 'fortnite', 'valorant', 'league of legends',
    'speedrun', 'gameplay', 'gaming', 'jeu', 'jeux', 'game', 'games', 'boss', 'rpg', 'fps',
    'steam', 'nintendo', 'playstation', 'xbox', 'twitch', 'let\'s play', 'world record',
  ],
  'IA et machine learning': [
    'machine learning', 'deep learning', 'reinforcement learning', 'réseau de neurones',
    'neural network', 'intelligence artificielle', 'transformer', 'llm', 'gpt', 'chatgpt',
    'claude', 'mistral', 'stable diffusion', 'rag', 'embedding', 'dataset', 'pytorch',
    'tensorflow', 'ia', 'openai', 'agentic', 'prompt',
  ],
  'Développement': [
    'python', 'javascript', 'typescript', 'rust', 'golang', 'java', 'docker', 'kubernetes',
    'linux', 'git', 'github', 'api', 'framework', 'react', 'algorithme', 'algorithmie',
    'compilateur', 'programmation', 'coder', 'code', 'développeur', 'developer', 'tuto',
    'tutorial', 'arduino', 'raspberry', 'sql', 'base de données', 'devops', 'open source',
  ],
  'Crypto et finance': [
    'bitcoin', 'ethereum', 'crypto', 'blockchain', 'nft', 'trading', 'bourse', 'investir',
    'investissement', 'altcoin', 'defi', 'web3', 'token', 'wallet', 'binance', 'halving',
    'inflation', 'économie', 'finance',
  ],
  'Science et vulgarisation': [
    'science', 'physique', 'quantique', 'mathématiques', 'maths', 'astronomie', 'espace',
    'univers', 'biologie', 'chimie', 'évolution', 'relativité', 'théorème', 'expérience',
    'nasa', 'spacex', 'fusée', 'climat', 'énergie', 'nucléaire', 'histoire des sciences',
  ],
  'Tech et matériel': [
    'iphone', 'android', 'samsung', 'macbook', 'processeur', 'gpu', 'nvidia', 'amd', 'intel',
    'carte graphique', 'ssd', 'unboxing', 'benchmark', 'imprimante 3d', 'bambu lab',
    'impression 3d', 'setup', 'clavier', 'casque', 'smartphone', 'ordinateur', 'pc gamer',
  ],
  'Humour et divertissement': [
    'humour', 'sketch', 'parodie', 'prank', 'défi', 'challenge', 'réaction', 'reaction',
    'best of', 'compilation', 'blague', 'stand up', 'télé-réalité', 'podcast',
  ],
  'Musique': [
    'clip officiel', 'music video', 'album', 'concert', 'remix', 'cover', 'lyrics',
    'freestyle', 'instrumental', 'guitare', 'piano', 'playlist',
  ],
  'Actualité et société': [
    'actualité', 'politique', 'élection', 'président', 'gouvernement', 'guerre', 'ukraine',
    'géopolitique', 'débat', 'reportage', 'enquête', 'documentaire', 'interview', 'société',
  ],
  'Sport': [
    'football', 'basket', 'nba', 'tennis', 'formule 1', 'cyclisme', 'marathon', 'musculation',
    'fitness', 'entraînement', 'match', 'championnat', 'jeux olympiques',
  ],
};

/**
 * The videos behind a theme or a topic.
 *
 * The interface shows "rocket league — 463" without giving access to the 463
 * videos, which is the reader's first reflex. Two modes, because the two figures
 * are not computed the same way: a theme is a literal phrase found in the
 * titles, a topic is a category of the dictionary and covers dozens of terms.
 *
 * Matching is on whole words, as in the counting: searching for "ia" must not
 * bring back "biais" or "diagonale".
 *
 * @param {Array} all
 * @param {object} opts
 * @param {string} [opts.term]   literal phrase, for a theme
 * @param {string} [opts.topic]  category name, for a topic
 * @param {string} [opts.channelId]  restricts to one channel
 */
export function findVideosByTerm(all, {
  term = '', topic = '', channelId = null, from = 0, to = Infinity,
  durations = new Map(), channelMeans = new Map(), topics = TOPICS, max = 300,
} = {}) {
  const terms = topic
    ? (topics[topic] ?? []).map((x) => x.toLowerCase())
    : [term.toLowerCase().trim()].filter(Boolean);
  if (!terms.length) return [];

  const byVideo = new Map();

  for (const e of all) {
    if (e.nonResolue || !e.title) continue;
    if (e.watchedAt < from || e.watchedAt > to) continue;
    if (channelId && e.channelId !== channelId) continue;

    const title = ` ${e.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    if (!terms.some((x) => title.includes(` ${x} `))) continue;

    let v = byVideo.get(e.videoId);
    if (!v) {
      const exact = durations.get(e.videoId);
      v = {
        videoId: e.videoId,
        title: e.title,
        channelId: e.channelId ?? null,
        channelTitle: e.channelTitle ?? '',
        opens: 0,
        last: e.watchedAt,
        seconds: Number.isFinite(exact) && exact > 0
          ? exact
          : (channelMeans.get(e.channelId) ?? 0),
        exact: Number.isFinite(exact) && exact > 0,
      };
      byVideo.set(e.videoId, v);
    }
    v.opens++;
    v.last = Math.max(v.last, e.watchedAt);
  }

  return [...byVideo.values()].sort((a, b) => b.last - a.last).slice(0, max);
}

/**
 * Splits the viewings by topic.
 *
 * A video can belong to several topics — a Python tutorial about machine
 * learning legitimately belongs to both — and it is counted in each. The shares
 * therefore do not add up to a hundred percent, and the interface must say so
 * rather than imply a partition.
 *
 * @returns {{topics: Array<{name: string, count: number, share: number}>,
 *   classified: number, total: number}}
 */
export function classifyTopics(entries, { topics = TOPICS } = {}) {
  // An index prepared once: without it, the whole dictionary would be re-read
  // for each of the fifteen thousand entries.
  const byWord = new Map();
  const phrases = [];
  for (const [name, terms] of Object.entries(topics)) {
    for (const term of terms) {
      if (term.includes(' ')) phrases.push([term, name]);
      else {
        if (!byWord.has(term)) byWord.set(term, []);
        byWord.get(term).push(name);
      }
    }
  }

  const counts = new Map(Object.keys(topics).map((n) => [n, 0]));
  let classified = 0;
  let total = 0;

  for (const e of entries) {
    if (e.nonResolue || !e.title) continue;
    total++;

    const title = ` ${e.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    const found = new Set();

    for (const [term, name] of phrases) {
      if (title.includes(` ${term} `)) found.add(name);
    }
    for (const word of title.split(/\s+/)) {
      for (const name of byWord.get(word) ?? []) found.add(name);
    }

    if (found.size) classified++;
    for (const name of found) counts.set(name, counts.get(name) + 1);
  }

  return {
    topics: [...counts.entries()]
      .filter(([, n]) => n > 0)
      .map(([name, count]) => ({ name, count, share: total ? count / total : 0 }))
      .sort((a, b) => b.count - a.count),
    classified,
    total,
  };
}

/**
 * French and English stop words, plus the noise specific to YouTube titles.
 * Deliberately broad: a theme that surfaces because of "comment" teaches
 * nothing, whereas discarding a real one only costs a line of this list.
 */
const STOP_WORDS = new Set(`
le la les de des du un une et en au aux pour dans sur par avec ce cet cette ces
il elle ils elles nous vous que qui quoi dont est sont ete été etait était ont
avoir etre être mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs
pas plus tout tous toute toutes meme même aussi bien sans mais donc car ni or
comment pourquoi quand faire fait fais vais vraiment tres très trop peu deja déjà
c'est j'ai n'est d'un d'une l'on qu'il qu'on s'est
faut peut peux veut veux dois doit sais sait dit dire vois voir aller
après avant contre entre chez sous vers depuis pendant encore toujours
jamais rien quelque quelques chaque autre autres mieux moins beaucoup
voici voilà chose choses fois
the and for with you your this that from what how why not but are was were
have has had can will just all our their its out about into more most
been being does did doing get got getting make makes making use uses used
using need needs want wants know knows think thinks see sees look looks
new best worst good bad great big small first last next then than
one two three ten now here there when who whom whose which some any every
day days week weeks month months year years time times way ways thing things
video vidéo vidéos videos shorts short live replay partie part parties
episode épisode episodes épisodes saison season official officiel officielle
full complete clip clips feat prod
`.trim().split(/\s+/));

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** A channel is excluded by its identifier, or failing that by its title. */
function isExcluded(entry, blacklist) {
  if (!blacklist.size) return false;
  return (entry.channelId && blacklist.has(entry.channelId))
    || (entry.channelTitle && blacklist.has(entry.channelTitle));
}

/** Groups by identifier when there is one, otherwise by name. */
function channelKey(entry) {
  return entry.channelId ?? `nom:${entry.channelTitle}`;
}

/**
 * `2026-08-15` in **local** time.
 *
 * `toISOString()` switches to UTC: a video opened at 00:30 in Paris would fall
 * on the day before, which breaks the count of active days as much as the
 * streaks.
 */
function localDay(ts) {
  return localDayOf(new Date(ts));
}

function localDayOf(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

function localMonth(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Number of days the range actually covers, open bounds included. */
function boundsInDays(from, to, inRange) {
  if (!inRange.length) return 0;
  return Math.max(1, Math.round(spanInDays(from, to, inRange)) + 1);
}

/**
 * Length of the range in days, unrounded.
 *
 * Distinct from the count of calendar days: a seven day range touches eight
 * dates on the calendar, and dividing a total by eight instead of seven would
 * skew the average by more than ten percent. The calendar day count stays useful
 * for "seven active days out of eight"; the average, on the other hand, relates
 * to the time actually elapsed.
 */
function spanInDays(from, to, inRange) {
  if (!inRange.length) return 0;
  const start = Number.isFinite(from) && from > 0
    ? from
    : inRange.reduce((m, e) => Math.min(m, e.watchedAt), Infinity);
  const end = Number.isFinite(to) ? Math.min(to, Date.now()) : Date.now();
  return Math.max(1, (end - start) / DAY);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * "9,315 s" → "2 h 35". History durations are counted in hours.
 *
 * Thousands are separated: over a range of several years the total goes past
 * four digits, and "7020 h" reads far worse than "7 020 h". Minutes are dropped
 * beyond a hundred hours, where they no longer mean anything for a total that is
 * an estimate anyway.
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return t('dur.hour', { n: 0 });
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (!hours) return t('dur.min', { n: minutes });

  // The thousands separator follows the language: "7 020 h" in French,
  // "7,020h" in English.
  const h = hours.toLocaleString(bcp47());
  if (hours >= 100) return t('dur.hour', { n: h });
  return minutes
    ? t('dur.hm', { n: h, mm: String(minutes).padStart(2, '0') })
    : t('dur.hour', { n: h });
}

/** Relative change between two periods, `null` if the previous one is empty. */
export function variation(current, previous) {
  if (!Number.isFinite(previous) || previous <= 0) return null;
  return (current - previous) / previous;
}


// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Highlight
 * @property {string} key    translation key of the sentence
 * @property {number} n      the figure being put forward
 * @property {number} [at]   date to format on the page side, if the sentence cites one
 * @property {string} [text] untranslatable value, a channel name for instance
 * @property {number} [hour] hour of the day, from 0 to 23
 */

// ---------------------------------------------------------------------------
// How you watch: the delay, the sessions, the rewatches, the drop off
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

/**
 * The slices of the delay chart, from the narrowest range to the widest.
 *
 * The distribution has to be drawn on the range being read. Over seven days,
 * "within the month" is a slice nothing can fall into that "later" does not
 * already hold, and three bars out of four then answer the same question. Below
 * a week the useful unit is the hour: it is what separates someone who opens a
 * video as it goes up from someone who lets it wait until the evening. Past
 * three months a year long slice appears, because beyond a month "later" was
 * carrying half the history on its own.
 *
 * The ids travel to the page, which turns them into labels: this side returns
 * identifiers, never sentences.
 */
const DELAY_SCALES = [
  { upTo: 8 * DAY, ids: ['h1', 'h6', 'h24'], edges: [HOUR, 6 * HOUR, 24 * HOUR] },
  { upTo: 100 * DAY, ids: ['d1', 'd7', 'd30'], edges: [DAY, 7 * DAY, 30 * DAY] },
  { upTo: Infinity, ids: ['d1', 'd7', 'd30', 'd365'], edges: [DAY, 7 * DAY, 30 * DAY, 365 * DAY] },
];

/**
 * How long after publication you open a video.
 *
 * The page could say how much and when you watch, never whether you follow an
 * actuality or draw on a library. Those are two different uses of the same
 * subscription, and only the gap between the publication date and the viewing
 * date tells them apart.
 *
 * **The scope is narrower than the history** and the caller must say so on
 * screen. Publication dates come from the feed index, which starts at the
 * installation: a video watched in 2021 has none, and is simply not counted.
 * `known` against `total` is what the sentence under the chart is built from.
 *
 * @param {Array<object>} entries  the retained history
 * @param {Map<string, number>} published  videoId → publication date
 */
export function computeWatchDelays(entries, published, { from = 0, to = Date.now() } = {}) {
  const delays = [];
  let total = 0;

  for (const e of entries) {
    if (e.watchedAt < from || e.watchedAt > to) continue;
    total++;
    const at = published.get(e.videoId);
    if (!(at > 0)) continue;
    const delay = e.watchedAt - at;
    // A viewing dated before its publication is a broken row, not a fast
    // viewer: the scraped rows sit at local noon, so one collected on the very
    // day of publication can land hours before it.
    if (delay < 0) continue;
    delays.push(delay);
  }

  // The range and not the delays choose the scale: a seven day range holding one
  // video opened a year after its release would otherwise switch the whole chart
  // to the widest slices for that single row.
  const scale = DELAY_SCALES.find((s) => to - from <= s.upTo) ?? DELAY_SCALES.at(-1);
  const counts = new Array(scale.edges.length + 1).fill(0);
  for (const d of delays) {
    const rank = scale.edges.findIndex((limit) => d < limit);
    counts[rank === -1 ? counts.length - 1 : rank]++;
  }

  return {
    buckets: [...scale.ids, 'later'].map((id, i) => ({ id, n: counts[i] })),
    median: delays.length ? median(delays) : null,
    known: delays.length,
    total,
  };
}

/** Silence beyond which two viewings no longer belong to the same sitting.
 *  Half an hour: a break long enough to have got up, short enough that an
 *  episode followed by its sequel stays one sitting. */
const SESSION_GAP_MS = 30 * 60_000;

/**
 * Viewings gathered into sittings.
 *
 * At five hours a day, the total says nothing about the shape of the day: three
 * sittings of an hour and forty and twelve twenty minute snacks are two
 * different lives, and the hourly curve cannot separate them.
 *
 * **Only the rows that know their time of day are used**, and that is not a
 * detail. A row read off YouTube's history page sits at local noon, so a day
 * holding thirty of them would come out as one enormous midday sitting that
 * never happened. `rows` against `total` lets the page say what the figure rests
 * on, exactly as the hourly curve does.
 *
 * A sitting's end is its last viewing plus what was measured of it, so a single
 * unmeasured row gives a sitting of no length rather than an invented one.
 */
export function computeSessions(entries, { from = 0, to = Date.now(), gapMs = SESSION_GAP_MS } = {}) {
  const rows = entries
    .filter((e) => e.watchedAt >= from && e.watchedAt <= to && hasClock(e))
    .sort((a, b) => a.watchedAt - b.watchedAt);

  const total = entries.filter((e) => e.watchedAt >= from && e.watchedAt <= to).length;
  if (!rows.length) {
    return { count: 0, rows: 0, total, timed: 0, medianSpan: null, longest: null, perActiveDay: null };
  }

  const sessions = [];
  let current = null;
  for (const e of rows) {
    const end = e.watchedAt + (e.watchedSec > 0 ? e.watchedSec * 1000 : 0);
    if (current && e.watchedAt - current.end <= gapMs) {
      current.end = Math.max(current.end, end);
      current.videos++;
    } else {
      current = { from: e.watchedAt, end, videos: 1 };
      sessions.push(current);
    }
  }

  // A sitting of a single unmeasured row has an **unknown** length, not a zero
  // one, and the difference is the whole point: counting those zeros in dragged
  // the median to nothing on a history coming mostly from an export. Only the
  // sittings whose length is actually known feed the median, and `timed` says
  // how many that is so the page can qualify the figure.
  const spans = sessions.map((s) => s.end - s.from).filter((ms) => ms > 0);
  const longest = sessions.reduce((best, s) =>
    (s.end - s.from > best.end - best.from ? s : best), sessions[0]);
  const days = new Set(rows.map((e) => localDay(e.watchedAt)));

  return {
    count: sessions.length,
    rows: rows.length,
    total,
    timed: spans.length,
    medianSpan: spans.length ? median(spans) : null,
    perActiveDay: sessions.length / days.size,
    longest: longest.end > longest.from
      ? { from: longest.from, span: longest.end - longest.from, videos: longest.videos }
      : null,
  };
}

/**
 * The videos opened more than once over the range.
 *
 * What one goes back to is never what one watched most: the ranking by time
 * answers a question of volume, this one a question of attachment. Nothing on
 * the page said it, and the history has held it since the first import.
 *
 * The twin rows YouTube's history page produces are already removed on writing
 * — see `dropScrapedTwins` — so two rows here are two real openings.
 */
export function computeRewatches(entries, { from = 0, to = Date.now(), topN = 10 } = {}) {
  const byVideo = new Map();

  for (const e of entries) {
    if (e.watchedAt < from || e.watchedAt > to) continue;
    if (!e.videoId) continue;
    const known = byVideo.get(e.videoId);
    if (known) {
      known.opens++;
      known.first = Math.min(known.first, e.watchedAt);
      known.last = Math.max(known.last, e.watchedAt);
      known.title = known.title || e.title;
    } else {
      byVideo.set(e.videoId, {
        videoId: e.videoId,
        title: e.title ?? '',
        channelId: e.channelId ?? null,
        channelTitle: e.channelTitle ?? '',
        opens: 1,
        first: e.watchedAt,
        last: e.watchedAt,
      });
    }
  }

  const again = [...byVideo.values()].filter((v) => v.opens > 1);
  again.sort((a, b) => b.opens - a.opens || b.last - a.last);

  return {
    videos: again.slice(0, topN),
    total: again.length,
    opens: again.reduce((s, v) => s + v.opens, 0),
    // The videos of the range, counted once each: "312 videos watched again" is
    // a large figure on a thousand and a small one on twenty thousand, and the
    // headline figure needs the denominator to be worth reading.
    distinct: byVideo.size,
  };
}

/** Above this share of a video, one has not dropped off, one has finished.
 *  Deliberately below the "watched" threshold of the feed: credits and a last
 *  minute skipped are not an abandonment. */
const FINISHED_SHARE = 0.9;

/**
 * Where you stop, on the videos you do not finish.
 *
 * Only the openings the extension measured **and** whose exact duration is known
 * count: a channel mean would turn a percentage into an invention, and this
 * figure exists precisely to be exact. A range with no measurement returns
 * nulls, and the page hides the card rather than showing a dash.
 */
export function computeDropoff(entries, durations, { from = 0, to = Date.now() } = {}) {
  const shares = [];
  const seconds = [];

  for (const e of entries) {
    if (e.watchedAt < from || e.watchedAt > to) continue;
    if (!(e.watchedSec > 0)) continue;
    const length = durations.get(e.videoId);
    if (!(length > 0)) continue;
    const share = e.watchedSec / length;
    if (share >= FINISHED_SHARE) continue;
    shares.push(share);
    seconds.push(e.watchedSec);
  }

  return {
    n: shares.length,
    medianShare: shares.length ? median(shares) : null,
    medianSec: seconds.length ? median(seconds) : null,
  };
}

/**
 * How often a channel publishes, over several windows.
 *
 * Read from the feed index and from nothing else, which sets a hard limit: the
 * index starts at the installation. A window reaching further back than it does
 * would count our own silence as the channel's, so such a window is returned as
 * `covered: false` and the page drops it rather than print a lie.
 *
 * Counts, and no rate beside them: a window's count is the answer to the
 * question actually asked, and the average that used to sit under it was read
 * as a second figure contradicting the first.
 *
 * @param {Array<{channelId: string, publishedAt: number}>} uploads
 * @param {{channelId?: string|null, now?: number, windows?: number[]}} [opts]
 */
export function computeUploadRhythm(uploads, { channelId = null, now = Date.now(), windows = [30, 90, 365] } = {}) {
  const rows = channelId ? uploads.filter((u) => u.channelId === channelId) : uploads;
  if (!rows.length) return { since: null, total: 0, windows: [] };

  const since = rows.reduce((m, u) => Math.min(m, u.publishedAt), Infinity);

  return {
    since,
    total: rows.length,
    windows: windows.map((days) => {
      const start = now - days * DAY;
      if (since > start) return { days, count: 0, covered: false };
      return {
        days,
        count: rows.reduce((n, u) => n + (u.publishedAt >= start ? 1 : 0), 0),
        covered: true,
      };
    }),
  };
}

/**
 * A few striking figures drawn from the history.
 *
 * The tab used to show only a volume and a span: two exact, flat numbers. These
 * help with no decision, and that is accepted — they are there to make one want
 * to open the analysis, where the same data finally serves a purpose.
 *
 * A single pass over the history, unlike `computeStats`: the popup opens several
 * times a day and cannot pay for a full ranking every time.
 *
 * Every candidate carries a threshold below which it says nothing: "your longest
 * streak: 2 days" is an exact figure and a poor argument. Shorts arrive already
 * merged into the exclusions in `excludedVideos`.
 *
 * @param {Array<object>} all  the whole known history
 * @returns {Highlight[]}
 */
export function historyHighlights(all, {
  durations = new Map(), channelMeans = new Map(),
  blacklist = new Set(), excludedVideos = new Set(),
  now = Date.now(),
} = {}) {
  const perDay = new Map();
  const byChannel = new Map();
  const perHour = new Array(24).fill(0);
  /** `videoId → { entry, opens }`, so the time is only counted once. */
  const seen = new Map();

  for (const e of all) {
    if (excludedVideos.has(e.videoId) || isExcluded(e, blacklist)) continue;

    const day = localDay(e.watchedAt);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (hasClock(e)) perHour[new Date(e.watchedAt).getHours()]++;

    const v = seen.get(e.videoId);
    if (v) v.opens++;
    else seen.set(e.videoId, { entry: e, opens: 1 });

    if (e.nonResolue) continue;
    const key = channelKey(e);
    const c = byChannel.get(key);
    if (c) c.n++;
    else byChannel.set(key, { title: e.channelTitle || '', n: 1 });
  }

  const out = [];
  const push = (key, n, extra) => { if (n > 0) out.push({ key, n, ...extra }); };

  // The record day.
  let record = null;
  for (const [day, n] of perDay) if (!record || n > record.n) record = { day, n };
  if (record && record.n >= 5) {
    push('acc.hist.jour', record.n, { at: Date.parse(`${record.day}T12:00:00`) });
  }

  // The most watched channel.
  let top = null;
  for (const c of byChannel.values()) if (!top || c.n > top.n) top = c;
  if (top?.title && top.n >= 5) push('acc.hist.chaine', top.n, { text: top.title });

  // The favourite hour.
  let hour = 0;
  for (let h = 1; h < 24; h++) if (perHour[h] > perHour[hour]) hour = h;
  if (perHour[hour] >= 20) push('acc.hist.heure', perHour[hour], { hour });

  // The longest run of consecutive days.
  const run = longestRun(new Set(perDay.keys()));
  if (run >= 4) push('acc.hist.serie', run);

  // A year ago to the day. This is the candidate that makes the highlight change
  // by itself from one day to the next, without recomputing anything else.
  const aYearAgo = now - 365 * 86_400_000;
  push('acc.hist.anniversaire', perDay.get(localDay(aYearAgo)) ?? 0, { at: aYearAgo });

  // The cumulative time, stated in days: in hours it stops meaning anything past
  // a thousand.
  let seconds = 0;
  for (const { entry } of seen.values()) seconds += knownDuration(entry, durations, channelMeans);
  const days = Math.round(seconds / 86_400);
  if (days >= 2) push('acc.hist.temps', days);

  // The reopened videos.
  let rewatched = 0;
  for (const v of seen.values()) if (v.opens > 1) rewatched++;
  if (rewatched >= 5) push('acc.hist.revues', rewatched);

  // The channels crossed paths with.
  if (byChannel.size >= 20) push('acc.hist.chaines', byChannel.size);

  return out;
}
