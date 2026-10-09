/**
 * History analysis page: import of the Takeout file, then statistics over a
 * chosen range.
 *
 * The file is read and parsed here, in the page: a history export commonly
 * weighs several megabytes, and passing it as is to the service worker would
 * serve no purpose. Only the normalised entries are handed over.
 *
 * The statistics, on the other hand, are computed on the worker side: that is
 * where the database lives, and loading fifteen thousand entries into the page
 * on every range change would be a waste.
 */

import { MSG, send } from '../lib/messages.js';
import { UI_SNAPSHOT } from '../lib/ui-snapshot.js';
import {
  parseWatchHistory, rangeBounds, coveredYears, formatDuration, formatDelay, variation,
  extractThemes, MIN_MEAN_SAMPLE, TOPIC_KEYS,
} from '../lib/history.js';
import { t, initLocale, getLocale, bcp47, LANG_KEY } from '../lib/i18n.js';
import { translateDom } from '../lib/i18n-dom.js';
import { wireRetro, openRetro } from './retro.js';
import { wireGame, openGame } from './duel-game.js';
import { wireTournament, openTournament } from './tournament.js';

const $ = (id) => document.getElementById(id);
const formatNumber = (n) => new Intl.NumberFormat(bcp47()).format(n);
const date = (ms) => new Date(ms).toLocaleDateString(bcp47(), { day: 'numeric', month: 'short', year: 'numeric' });
// The space before the percent sign is a French rule: English sticks the sign on.
const percent = (r) => t('hist.pct', { n: Math.round(r * 100) });

/**
 * The page's tooltip: a single box, placed under the mouse.
 *
 * It serves the charts and the tables, and no headline figure. Each of those
 * used to hover a whole paragraph, and a block whose meaning has to be hovered
 * for is a block that has not been named properly: what those paragraphs said
 * is written on the page now, under the figure or in the reliability lines.
 * What is left is a reading no cell could hold — a bar's label and its count,
 * how many openings a mean averages, why a dash is a dash — and it is set from
 * the script, never written into the markup.
 *
 * Reserved for reading a value off a chart, and nothing else. It used to sit on
 * table cells and badges as well, which meant a box opening under the cursor on
 * nearly every row of the channel ranking — what those boxes said is written
 * once under each table instead, and only when the table holds the case it
 * describes. Any element carrying `data-info` triggers it, an SVG shape included. It is
 * `fixed`, so never clipped by a table or a scrolling list, and it sits above
 * its target, or below when there is no room. The anchor can be a child marked
 * `data-anchor`: on a chart, the box then aims at the reading rather than at the
 * invisible column that catches the mouse.
 */
let tip = null;

function showTip(target) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    document.body.append(tip);
  }
  tip.textContent = target.dataset.info;
  tip.classList.add('shown');

  const anchor = target.querySelector('[data-anchor]') || target;
  const r = anchor.getBoundingClientRect();
  const b = tip.getBoundingClientRect();
  const left = Math.min(
    Math.max(r.left + (r.width - b.width) / 2, 8),
    Math.max(8, window.innerWidth - b.width - 8),
  );
  const top = r.top - b.height - 8;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top < 8 ? r.bottom + 8 : top)}px`;
}

function hideTip() {
  tip?.classList.remove('shown');
}

const tipHost = (n) => (n instanceof Element ? n.closest('[data-info]') : null);

document.addEventListener('pointerover', (e) => {
  const target = tipHost(e.target);
  if (target?.dataset.info) showTip(target);
});

document.addEventListener('pointerout', (e) => {
  if (tipHost(e.relatedTarget) !== tipHost(e.target)) hideTip();
});

// A `fixed` box does not follow what scrolls beneath it: rather than leave it
// pointing beside its target, we erase it.
window.addEventListener('scroll', hideTip, true);

/** Days of the week, Monday to Sunday. */
const weekdayNames = () => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  .map((j) => t(`hist.wd.${j}`));

/** Their initials, for the histogram axis. */
const weekdayInitials = () => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  .map((j) => t(`hist.wd1.${j}`));

/**
 * Duration of one viewing, which can be very short.
 *
 * `formatDuration` is cut out for totals and rounds to the minute: a video left
 * after twenty seconds would show "0 min" there, which reads as an absence of
 * measurement when it is in fact a measurement.
 */
const shortDuration = (s) => (s < 60 ? t('dur.s', { n: Math.round(s) }) : formatDuration(Math.round(s)));

/** Current range. `name` is `custom` when both dates are typed in. */
let range = { name: '365j', from: 0, to: 0 };

/** Column the ranking is sorted on, and in which direction. */
const topSort = { field: 'count', dir: -1 };

/**
 * Which of the two figures the gauge and the concentration speak of.
 *
 * It used to be a switch of its own, next to the title, and that switch is gone:
 * with the columns sortable there were two controls for one question, and
 * clicking one left the other lying. It now follows the sorted column, and keeps
 * its last value when the table is sorted on something these two cannot express
 * — the name, the share watched — rather than emptying.
 */
let channelSort = 'count';
let averageBase = 'perCoveredDay';
let knownBounds = { from: null, to: null };
/** Last statistics received, to redraw without going back to the worker. */
let lastResponse = null;
/** Channel shown as a report, or `null` for the overview. */
let openChannel = null;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Signals that a computation is under way.
 *
 * Everything this page does goes through the worker and covers the whole
 * history: none of these computations is instant, and with no marker one cannot
 * tell a page that is working from a page that has stopped responding. The
 * duration cannot be announced — it depends on the imported volume and on what
 * Chrome kept in memory — hence no progress bar, just a state.
 *
 * A counter rather than a boolean: the range and the channel report can overlap,
 * and the first computation to finish must not erase the second one's marker.
 */
let pendingComputations = 0;

function busy(on, text = t('hist.busy')) {
  pendingComputations = Math.max(0, pendingComputations + (on ? 1 : -1));
  const active = pendingComputations > 0;
  if (on) $('loading-text').textContent = text;
  $('loading').hidden = !active;
  // Only the views are dimmed: the range bar and the search stay bright and
  // clickable, otherwise changing your mind during a computation would mean
  // waiting for the very one you want to replace.
  $('view-global').classList.toggle('computing', active);
  $('view-channel').classList.toggle('computing', active);
}

/** Wraps a computation in the loading marker, whatever happens next. */
async function during(text, work) {
  busy(true, text);
  try { return await work(); } finally { busy(false); }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

$('file-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  // Two places carry the import: the steps shown while the history is empty,
  // and the settings block for whoever comes back with a fresher export. Both
  // point at the same hidden file field, so both have to be told how it went.
  const say = (message) => {
    for (const el of document.querySelectorAll('.import-status')) el.textContent = message;
  };
  say(t('hist.imp.reading', { name: file.name, mb: (file.size / 1e6).toFixed(1) }));

  try {
    const { entries, deleted, ignored, unresolved } = parseWatchHistory(JSON.parse(await file.text()));

    if (!entries.length) {
      say(t('hist.imp.empty'));
      return;
    }

    say(t('hist.imp.read', { n: formatNumber(entries.length) }));

    // In batches: a single message of several tens of thousands of entries goes
    // past what Chrome's messaging accepts comfortably.
    const BATCH = 5000;
    let inserted = 0;
    let duplicates = 0;
    let superseded = 0;

    for (let i = 0; i < entries.length; i += BATCH) {
      const res = await send(MSG.HISTORY_IMPORT, { entries: entries.slice(i, i + BATCH) });
      if (!res.ok) { say(t('hist.failed', { error: t(res.error) })); return; }
      inserted += res.result.inserted;
      duplicates += res.result.duplicates;
      superseded += res.result.superseded ?? 0;
      say(`${formatNumber(Math.min(i + BATCH, entries.length))} / ${formatNumber(entries.length)}…`);
    }

    const details = [t('hist.imp.saved', { n: formatNumber(inserted) })];
    if (duplicates) details.push(t('hist.imp.dup', { n: formatNumber(duplicates) }));
    // Without this figure, an import that inserts almost nothing looks like a
    // failure, when it is the sign that the extension's own record already
    // covers everything.
    if (superseded) details.push(t('hist.imp.measured', { n: formatNumber(superseded) }));
    if (unresolved) details.push(t('hist.imp.gone', { n: formatNumber(unresolved) }));
    if (deleted) details.push(t('hist.imp.deleted', { n: formatNumber(deleted) }));
    if (ignored) details.push(t('hist.imp.other', { n: formatNumber(ignored) }));
    say(`${details.join(' · ')}.`);

    await refresh();

    // Offered here rather than left to be found: the import has just shown how
    // far back the export goes, and that is the one moment where completing it
    // from YouTube's own page is a question worth putting.
    offerScrape(Math.min(...entries.map((e) => e.watchedAt)));
  } catch (err) {
    console.error('[tracktube]', err);
    say(t('hist.imp.unreadable', { error: err?.message ?? err }));
  }
});


// ---------------------------------------------------------------------------
// Completing the history from YouTube's own page
// ---------------------------------------------------------------------------

/** Poll of the collection under way. */
let scrapeTimer = null;

function sayScrape(message) {
  for (const el of document.querySelectorAll('.scrape-status')) el.textContent = message;
}

/**
 * Reports on the collection while it runs.
 *
 * No progress bar, and that is not an omission: nothing here knows how many
 * pages remain — YouTube hands out one continuation at a time and never says
 * how many are left. A bar would have to invent its own total, which is exactly
 * the dishonest kind. What does advance, visibly and without inventing
 * anything, is the count and the date being walked back to.
 */
async function updateScrapeState() {
  const res = await send(MSG.HISTORY_SCRAPE_STATE);
  if (!res?.ok) return;

  const { running, inserted, covered, oldest, done, completedAt } = res;
  $('btn-scrape').hidden = running;
  $('btn-scrape-stop').hidden = !running;

  // A run that finished puts a floor under the next one, and a figure whose
  // reach is limited has to say so: without this line, a collection that comes
  // back after four seconds instead of four minutes reads as a failure.
  const seen = Number.isFinite(completedAt);
  const since = document.querySelector('.scrape-since');
  if (since) {
    if (seen) since.textContent = t('hist.scr.since', { date: date(completedAt) });
    since.hidden = !seen || running;
  }
  $('btn-scrape-full').hidden = running || !seen;

  const reached = Number.isFinite(oldest) ? date(oldest) : null;

  if (running) {
    sayScrape(reached
      ? t('hist.scr.running', { n: formatNumber(inserted), date: reached })
      : t('hist.scr.start'));
    scrapeTimer = setTimeout(updateScrapeState, 2000);
    return;
  }

  clearTimeout(scrapeTimer);
  scrapeTimer = null;

  if (!done) {
    sayScrape(t('hist.scr.stopped', { n: formatNumber(inserted) }));
  } else if (inserted) {
    sayScrape(t('hist.scr.done', {
      n: formatNumber(inserted), c: formatNumber(covered), date: reached ?? '',
    }));
  } else {
    sayScrape(t('hist.scr.none'));
  }

  if (inserted) await refresh();
}

/**
 * Points at the collection once an import is done.
 *
 * The settings panel is opened and scrolled to rather than a second button
 * planted next to the import: one option, one place, one implementation. What
 * is said there is tied to the import that just ran — the date it starts at —
 * because the offer is only worth anything if YouTube keeps more than that, and
 * nothing here can know whether it does before trying.
 */
function offerScrape(oldest) {
  if (!Number.isFinite(oldest)) return;
  const note = document.querySelector('.scrape-after-import');
  if (!note) return;

  note.textContent = t('hist.scr.after', { date: date(oldest) });
  note.hidden = false;
  $('settings-panel').open = true;
  $('scrape-block').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * One collection, either picking up where the last stopped or starting over.
 *
 * @param {boolean} full  walk the whole page again, ignoring the last run's date
 */
async function startScrape(full) {
  sayScrape(t('hist.scr.start'));
  // Resumes rather than starts over when a previous run was interrupted: the
  // token is held by the worker, and redoing two hundred pages to reach the
  // same place would cost four minutes for nothing. Asking for everything is
  // asking for a new run, so it never resumes.
  const state = await send(MSG.HISTORY_SCRAPE_STATE);
  const resume = !full && Boolean(state?.ok && state.token && !state.done);

  const res = await send(MSG.HISTORY_SCRAPE_START, { resume, full });
  if (!res?.ok) { sayScrape(t('hist.failed', { error: t(res?.error) })); return; }
  if (!res.started) { sayScrape(t(res.reason ?? 'hist.enr.notab')); return; }

  await updateScrapeState();
}

$('btn-scrape').addEventListener('click', () => startScrape(false));
$('btn-scrape-full').addEventListener('click', () => startScrape(true));

$('btn-scrape-stop').addEventListener('click', async () => {
  await send(MSG.HISTORY_SCRAPE_STOP);
  await updateScrapeState();
});


// ---------------------------------------------------------------------------
// How the time is counted
// ---------------------------------------------------------------------------

// This one setting lives here rather than in the popup because it holds for one
// page only: nothing outside the analysis counts a duration.
const SETTINGS_KEY = 'ytfeed:settings';

async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return stored?.[SETTINGS_KEY] ?? {};
}

/** Read then write, because the popup owns the rest of that same object. */
async function writeSettings(patch) {
  const current = await readSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}

/** A threshold only means something to the model that has one to cross. */
function showThreshold() {
  document.querySelector('.time-threshold').hidden = $('time-model').value !== 'auto';
}

async function loadTimeModel() {
  const s = await readSettings();
  $('time-model').value = s.timeModel === 'auto' ? 'auto' : 'mixed';
  $('time-threshold').value = String(Number(s.realThreshold) || 90);
  showThreshold();
}

$('time-model').addEventListener('change', async () => {
  showThreshold();
  await writeSettings({ timeModel: $('time-model').value });
  await showStats();
});

$('time-threshold').addEventListener('change', async () => {
  // Clamped here rather than trusted: the field accepts anything typed, and a
  // zero would make every range read as measured while nothing was measured.
  const pct = Math.min(100, Math.max(1, Math.round(Number($('time-threshold').value) || 90)));
  $('time-threshold').value = String(pct);
  await writeSettings({ realThreshold: pct });
  await showStats();
});


/**
 * Downloads the whole history in a single shape.
 *
 * The file grows with every video watched, and that is the point: it is the only
 * copy of what the extension measures that lives outside the browser.
 */
$('btn-download').addEventListener('click', async () => {
  $('export-status').textContent = t('hist.exp.prep');
  try {
    const res = await send(MSG.HISTORY_EXPORT);
    if (!res?.ok) throw new Error(res?.error ?? t('hist.exp.badreply'));
    const entries = res.entries ?? [];
    if (!entries.length) { $('export-status').textContent = t('hist.exp.nothing'); return; }

    const blob = new Blob([JSON.stringify({
      format: 'tracktube-historique',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: entries.length,
      entries,
    }, null, 2)], { type: 'application/json' });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = t('hist.exp.filename', { date: new Date().toISOString().slice(0, 10) });
    link.click();
    URL.revokeObjectURL(url);

    $('export-status').textContent = t('hist.exp.done', { n: formatNumber(entries.length) });
  } catch (err) {
    $('export-status').textContent = t('hist.failed', { error: err?.message ?? err });
  }
});

/**
 * Erasing, behind a dialogue whose buttons name what they do.
 *
 * `window.confirm` offers "OK" and "Cancel": the button that destroys years of
 * measurements said nothing about what it destroyed, and the browser dialogue is
 * anonymous enough to be dismissed without reading. The page's own dialogue also
 * lets the keeping choice take focus, so a stray Enter keeps the data.
 */
$('btn-clear').addEventListener('click', () => {
  $('confirm-erase').showModal();
  $('erase-cancel').focus();
});

$('erase-cancel').addEventListener('click', () => $('confirm-erase').close());

$('erase-go').addEventListener('click', async () => {
  $('confirm-erase').close();
  await send(MSG.HISTORY_CLEAR);
  await refresh();
});

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * Builds the range chips.
 *
 * Calendar years are derived from the real history: offering 2019 to someone
 * whose export starts in 2024 would only show an empty screen.
 */
function buildRanges() {
  const base = [
    ['7j', t('hist.r.7d')], ['30j', t('hist.r.30d')],
    ['90j', t('hist.r.90d')], ['365j', t('hist.r.12m')],
  ];
  const years = coveredYears(knownBounds.from, knownBounds.to)
    .map((a) => [String(a), String(a)]);

  $('ranges').replaceChildren(...[...base, ...years, ['tout', t('hist.r.all')]].map(([name, text]) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.range = name;
    b.textContent = text;
    b.addEventListener('click', () => selectRange(name));
    return b;
  }));
}

/**
 * The two dates a chip would show in the fields.
 *
 * Used both ways: to fill the fields when the chip is clicked, and to recognise
 * the chip when the dates are typed by hand. The second direction requires going
 * through the same function as the first, otherwise the comparison would fail on
 * the clamping to the bounds of the known history.
 */
function fieldsForRange(name) {
  const { from, to } = rangeBounds(name);
  return {
    start: isoDay(Math.max(from, knownBounds.from ?? from)),
    end: isoDay(Math.min(to, Date.now())),
  };
}

/**
 * The chip that covers exactly these two dates, or "custom".
 *
 * A hand-typed range that lands right on a chip must light that chip up: without
 * this, choosing "7 d" then retyping the same dates turned everything off, and
 * two identical states were shown differently.
 */
function matchingRange(start, end) {
  for (const c of document.querySelectorAll('.chip')) {
    const fields = fieldsForRange(c.dataset.range);
    if (fields.start === start && fields.end === end) return c.dataset.range;
  }
  return 'custom';
}

function selectRange(name) {
  const { from, to } = rangeBounds(name);
  range = { name, from, to };
  markActiveRange();
  // The date fields follow the chip: you see what it covers, and can adjust from
  // there rather than starting over.
  const fields = fieldsForRange(name);
  $('date-from').value = fields.start;
  $('date-to').value = fields.end;
  render();
}

function markActiveRange() {
  for (const c of document.querySelectorAll('.chip')) {
    c.classList.toggle('is-active', c.dataset.range === range.name);
  }
}

// The retrospective picks its own period internally: it only needs to know how
// far the history goes so it offers real years alone.
wireRetro(() => knownBounds);
$('btn-retro').addEventListener('click', () => openRetro());

// The game draws its questions from the directory, which the page already loads
// for the search: handing it the reader avoids a second copy in memory.
// The games draw from the whole directory, not from the fifteen rows on
// screen: their channels' pictures have to be claimed too, otherwise a duel
// between two channels one is not subscribed to shows two initials.
wireGame(() => directoryWithAvatars());
$('btn-game').addEventListener('click', () => openGame());

// The tournament reads the same directory, but for the opposite purpose: the
// game quizzes the figures, the tournament ignores them until the final ranking.
wireTournament(() => directoryWithAvatars());
$('btn-tournament').addEventListener('click', () => openTournament());

/**
 * What is wrong with the typed range, or nothing.
 *
 * An impossible range used to be plainly ignored: the fields showed one thing,
 * the page showed another, and nothing said which of the two was authoritative.
 * One word is enough to lift the ambiguity.
 */
function invalidRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'hist.range.bad';
  if (start > end) return 'hist.range.order';
  // Tomorrow has nothing to show. The end bound is at 23:59: it is the day after
  // today's date that starts being in the future.
  if (start > Date.now()) return 'hist.range.future';
  return null;
}

for (const field of ['date-from', 'date-to']) {
  // The native picker already refuses days to come: the check below is there
  // only for keyboard entry, which bypasses the calendar.
  $(field).max = isoDay(Date.now());

  $(field).addEventListener('change', () => {
    // Moving the start slides the window instead of stretching it: we look at
    // "the seven days following 3 March", not "from 3 March until today". The
    // length kept is the one shown before the entry, whether it comes from a
    // chip or from a range built by hand. Moving the end, conversely,
    // deliberately redefines the window and drags nothing along.
    if (field === 'date-from') {
      const newStart = Date.parse(`${$('date-from').value}T00:00:00`);
      if (Number.isFinite(newStart) && Number.isFinite(range.from)) {
        const span = Math.max(0, range.to - range.from);
        $('date-to').value = isoDay(Math.min(newStart + span, Date.now()));
      }
    }

    const start = Date.parse(`${$('date-from').value}T00:00:00`);
    const end = Date.parse(`${$('date-to').value}T23:59:59`);

    const problem = invalidRange(start, end);
    $('range-error').hidden = !problem;
    if (problem) { $('range-error').textContent = t(problem); return; }

    // The end runs past the current day on a range that goes up to today: no
    // point counting days to come in the averages.
    // An entry that lands back on a chip must give exactly the same screen as a
    // click on that chip: we take its bounds rather than the typed dates, which
    // are pinned to midnight and would shift the averages.
    const name = matchingRange($('date-from').value, $('date-to').value);
    range = name === 'custom'
      ? { name, from: start, to: Math.min(end, Date.now()) }
      : { name, ...rangeBounds(name) };
    markActiveRange();
    render();
  });
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

async function refresh() {
  const res = await send(MSG.HISTORY_SUMMARY);
  if (!res?.ok) return;
  paintSummary(res);
  await Promise.all([loadBlacklist(), loadSuspects(), updateEnrichState()]);
  loadDirectory().catch(() => {});
  const state = await send(MSG.HISTORY_ENRICH_STATE);
  if (state?.ok && !state.running) await startEnrich();
}

function paintSummary(res) {
  const s = res?.summary;

  // The boot screen has played its part as soon as we know what to show.
  $('startup').hidden = true;

  if (!s?.count) {
    statsRequest += 1;
    cachedStats = null;
    lastResponse = null;
    $('status').textContent = t('hist.none');
    $('results').hidden = true;
    $('home').hidden = false;
    return;
  }

  knownBounds = { from: s.from, to: s.to };
  $('status').textContent = t('hist.state', { n: formatNumber(s.count), from: date(s.from), to: date(s.to) });
  $('home').hidden = true;
  $('results').hidden = false;

  buildRanges();
  selectRange(range.name);
}

// A response for an earlier range must not replace the range now on screen.
let statsRequest = 0;
let cachedStats = null;
function statsScope() {
  return JSON.stringify([range.name,
    range.name === 'custom' ? [range.from, range.to] : null,
    $('time-model').value, $('time-threshold').value]);
}
async function showStats({ quiet = false } = {}) {
  const request = ++statsRequest;
  const cacheScope = statsScope();
  const cached = cachedStats?.cacheScope === cacheScope;
  if (cached) paintStats(cachedStats);
  const ask = () => send(MSG.HISTORY_STATS, { from: range.from, to: range.to, topN: 15, cacheScope });
  // Fetching the durations takes hours and only moves the figures at the margin.
  // Signalling each of its refreshes would amount to showing "computing" for
  // ever on a perfectly usable page.
  const res = quiet || cached ? await ask() : await during(t('hist.busy.stats'), ask);
  if (!res?.ok || request !== statsRequest || cacheScope !== statsScope() || openChannel || openDuel) return;
  cachedStats = { ...res, cacheScope };
  paintStats(res);
}

function paintStats(res) {

  lastRenderAt = Date.now();

  lastResponse = res;
  const { stats: s, previous, streaks, themes, topics, subscriptions, withoutAvatar,
    delays, sessions, rewatches, dropoff } = res;

  $('s-videos').textContent = formatNumber(s.total);
  $('s-channels').textContent = formatNumber(s.distinctChannels);
  $('s-days').textContent = formatNumber(s.activeDays);
  $('s-hours').textContent = s.totalSeconds ? formatDuration(s.totalSeconds) : '—';
  updateTimeMeasure(s);

  delta('d-hours', s.totalSeconds, previous.totalSeconds);
  delta('d-videos', s.total, previous.total);
  delta('d-channels', s.distinctChannels, previous.distinctChannels);
  delta('d-days', s.activeDays, previous.activeDays);
  delta('d-share-watched', s.meanWatchedShare, previous.meanWatchedShare);

  // A subtitle more useful than the comparison when there is no comparison to
  // make.
  if (!previous.total) {
    const fallback = (id, text) => {
      $(id).textContent = text;
    };
    fallback('d-videos', t('hist.uniques', { n: formatNumber(s.uniqueVideos) }));
    fallback('d-channels', t('hist.newchannels', { n: formatNumber(s.newChannels) }));
    fallback('d-days', t('hist.overdays', { n: formatNumber(s.coveredDays) }));
  }

  reliability(s);
  fillAverages(s);
  fillTop(s);
  fillStreaks(streaks);
  $('card-themes').hidden = !themes?.length;
  fillThemes(themes);
  fillTopics(topics);
  fillSubscriptions(subscriptions, s);

  histogram($('hours'), s.perHour, (i) => (i % 3 === 0 ? t('hist.hour.axis', { n: i }) : ''),
    (i) => t('hist.hour.range', { a: i, b: i + 1 }));
  // Said only when it is true: with no line collected from YouTube's own page,
  // the curve covers everything and there is nothing to qualify.
  const noClock = s.total - s.withClock;
  $('hours-scope').hidden = noClock <= 0;
  $('hours-scope').textContent = noClock > 0
    ? t('hist.hour.scope', { n: formatNumber(s.withClock), m: formatNumber(noClock) })
    : '';
  weekdayHistogram($('days'), s.perWeekday, $('rhythm-grid'));
  trendCurve(s.dailySeries);

  rhythmSummary(s);
  fillSessions(sessions);
  fillDelays(delays);
  fillRewatches(rewatches);
  fillDropoff(dropoff, { value: 's-dropoff', of: 'd-dropoff', card: 'card-dropoff' });
  // After the fills and not before: two of the eight figures hide themselves
  // when nothing was measured, and the row is laid out on what is left.
  layoutFigures($('figures'));

  // Channels shown without a picture are claimed from the enrichment: one
  // request each, and only for those actually on screen.
  if (withoutAvatar?.length) missingAvatars = [...new Set([...missingAvatars, ...withoutAvatar])];
}

/**
 * Averages.
 *
 * A range's totals cannot be compared from one range to the next: seven days and
 * twelve months do not share a denominator. Three bases are offered rather than
 * one imposed, because they answer three questions — how much of a life this
 * takes, how long a day spent watching lasts, and what an ordinary week looks
 * like.
 */
function fillAverages(s) {
  const m = s.averages?.[averageBase];
  if (!m) return;

  // A weekly average over a range shorter than a week does not exist: the
  // divisor is floored at one week, so four videos in three days came out as
  // "4 videos a week", a figure nothing in the data supports. Three dashes say
  // the measure has no meaning here, which is not the same as saying zero.
  if (averageBase === 'perWeek' && s.rangeDays < 7) {
    for (const id of ['m-hours', 'm-videos', 'm-channels']) $(id).textContent = '—';
    return;
  }

  $('m-hours').textContent = m.seconds >= 60 ? formatDuration(Math.round(m.seconds)) : '—';
  $('m-videos').textContent = rounded(m.videos);
  $('m-channels').textContent = rounded(m.channels);
}

/** One decimal while the figure stays small: "0 video a day" would be false. */
function rounded(n) {
  if (!Number.isFinite(n)) return '—';
  // The decimal separator follows the language: `toFixed` would write a dot
  // everywhere.
  return n >= 10
    ? formatNumber(Math.round(n))
    : n.toLocaleString(bcp47(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/**
 * Says, in two words, what the hours total measures.
 *
 * The page switches by itself between two definitions of time depending on the
 * range being looked at, and reading "42 h" without knowing which one is in
 * force teaches nothing. The figure's label says it, and that is now all it
 * says: the tooltip that repeated the coverage in a full sentence was removed,
 * the reliability block just above states it once and better.
 *
 * What tooltips are left on this page carry a count and nothing else. A
 * sentence hovering over a figure is read twice — once here, once in the block
 * that already explains it — and it is the second reading that is worth
 * something.
 */
function updateTimeMeasure(s) {
  const measure = t(`hist.time.${s.timeMode}`);
  $('e-hours').textContent = measure;
  // The same words over the average. It is the figure that gets quoted, and it
  // was the only one on the page not to say what it counted.
  $('m-hours-caption').textContent = measure;

  const share = s.meanWatchedShare;
  $('card-share-watched').hidden = share === null;
  if (share !== null) {
    $('s-share-watched').textContent = percent(share);
  }
}

/**
 * Change against the equivalent preceding period.
 *
 * The line always exists, even when it has nothing to say: the five cards are
 * lined up side by side, and a single one without a comparison pushed its value
 * up a line relative to the others. When the previous period gives nothing to
 * compare against — most often because the extension was not installed yet — we
 * write it, rather than "+0 %", which would assert a stability we did not
 * observe.
 */
function delta(id, current, before) {
  const el = $(id);
  // `null` means "not measurable", not "zero": without this guard, an unknown
  // watched share showed up as a hundred percent drop.
  const v = Number.isFinite(current) ? variation(current, before) : null;
  el.className = 'delta';
  if (v === null) {
    el.classList.add('flat');
    el.textContent = t('hist.delta.none');
    return;
  }
  const sign = v >= 0 ? '+' : '−';
  el.classList.add(v >= 0 ? 'up' : 'down');
  el.textContent = t('hist.delta', { sign, n: Math.abs(Math.round(v * 100)) });
}

/**
 * Says why the time shown is an estimate.
 *
 * Two quite distinct approximations overlap, and conflating them was the defect
 * of the previous version. The first corrects itself over time, the second never
 * will — so the interface must separate them, not sum them up in one vague
 * warning.
 */
function reliability(s) {
  const el = $('reliability');
  el.replaceChildren();

  if (!s.total) { el.textContent = t('hist.rel.empty'); return; }

  const line = (title, text) => {
    const p = document.createElement('p');
    const b = document.createElement('b');
    b.textContent = `${title} `;
    p.append(b, text);
    return p;
  };

  // 1. The video's duration. Recoverable, and being recovered.
  const known = s.withExactDuration + s.withEstimate;
  el.append(line(t('hist.rel.dur.b'),
    s.totalSeconds
      ? t('hist.rel.dur.p', {
        total: formatNumber(s.countedVideos),
        exact: formatNumber(s.withExactDuration),
        // The share of the total resting on a real length rather than on a
        // channel average. It sits inside this sentence rather than under the
        // figure it qualifies: as a third line in the hours card it made that
        // card taller than the four beside it, and left a hole in the row.
        pct: percent(s.countedVideos ? s.withExactDuration / s.countedVideos : 0),
        estimated: formatNumber(s.withEstimate),
        unknown: formatNumber(s.countedVideos - known),
      })
      : t('hist.rel.dur.none')));

  // 2. Which of the two measures of time carries the range. Two sentences: the
  //    figure's badge already says the essential, this gives the reason.
  if (s.timeMode === 'mixed') {
    el.append(line(t('hist.rel.mixed.b'), t('hist.rel.mixed.p', {
      measured: formatDuration(Math.round(s.watchedSeconds)),
      n: formatNumber(s.measuredOpens),
      estimated: formatDuration(Math.round(s.extraSeconds)),
      m: formatNumber(s.extraVideos),
    })));
  } else {
    el.append(s.timeMode === 'real'
      ? line(t('hist.rel.real.b'), t('hist.rel.real.p', {
        pct: percent(s.measuredCoverage), duration: formatDuration(s.contentSeconds),
      }))
      : line(t('hist.rel.assumed.b'), t('hist.rel.assumed.p', {
        n: formatNumber(s.measuredOpens), total: formatNumber(s.total),
      })));
  }

  // 2 bis. Where the viewings of the range came from, whenever some of them the
  //        extension did not see itself. This is the answer to "the extension
  //        was running all week, so what escaped it": a phone, a television,
  //        another browser, or this one before it was installed. A scraped line
  //        carries a day and no hour, so nothing can ever be measured on it —
  //        collecting them lowers the measured share for good.
  const untraced = (s.bySource?.takeout ?? 0) + (s.bySource?.yt ?? 0);
  if (untraced > 0) {
    el.append(line(t('hist.rel.sources.b'), t('hist.rel.sources.p', {
      live: formatNumber(s.bySource.live),
      takeout: formatNumber(s.bySource.takeout),
      yt: formatNumber(s.bySource.yt),
      total: formatNumber(s.total),
    })));
  }

  // 3. The direct consequence of point 2 on reopened videos. Only under the
  //    uniform assumption: measured openings each count their own time, so a
  //    reopening is not lost there.
  const reopened = s.total - s.countedVideos;
  if (reopened > 0 && s.timeMode === 'content') {
    el.append(line(t('hist.rel.reopen.b'), t('hist.rel.reopen.p', { n: formatNumber(reopened) })));
  }

  if (s.unresolved) {
    el.append(line(t('hist.rel.gone.b'), t('hist.rel.gone.p', { n: formatNumber(s.unresolved) })));
  }
}

/**
 * Summary of the rhythm, in sentences that say what they measure.
 *
 * The previous version lined up "1,745 sessions, 2 videos median, 68 maximum"
 * without ever defining a session or saying what 2 and 68 were the count of.
 * Three numbers without a unit are worth no more than none at all.
 */
function rhythmSummary(s) {
  if (!s.total) { $('rhythm-summary').replaceChildren(); $('streak').textContent = ''; return; }

  const peakHour = s.perHour.indexOf(Math.max(...s.perHour));
  const peakDay = weekdayName(s.perWeekday.indexOf(Math.max(...s.perWeekday)));

  const p = (text) => Object.assign(document.createElement('p'), { textContent: text });

  $('rhythm-summary').replaceChildren(
    p(t('hist.rhy.peak', { a: peakHour, b: peakHour + 1, day: peakDay })),
    p(t('hist.rhy.sessions', {
      // `n` drives the plural, `mean` carries the formatted number: in French
      // "1,1 vidéo" stays singular, the break happening at two.
      n: s.sessions.videosPerSession,
      mean: rounded(s.sessions.videosPerSession),
      median: formatNumber(s.sessions.median),
      max: formatNumber(s.sessions.max),
    })),
    p(t('hist.rhy.count', { n: formatNumber(s.sessions.count) })),
  );

  const flame = s.longestStreak >= 7 ? '🔥 ' : '';
  $('streak').textContent = flame + t('hist.rhy.streak', {
    max: formatNumber(s.longestStreak),
    active: formatNumber(s.activeDays),
    covered: formatNumber(s.coveredDays),
    rewatched: formatNumber(s.rewatches),
  });
}

function fillTop(s) {
  const body = $('top').querySelector('tbody');
  updateArrows($('top'), topSort);

  // The gauge and the concentration only know how to speak of these two. Sorted
  // by name or by share watched, they keep what they were saying: a bar that
  // emptied on a sort that changed no data would read as a loss of data.
  if (topSort.field === 'count' || topSort.field === 'seconds') channelSort = topSort.field;

  const channels = s.topChannels.slice().sort(compareBy(topSort.field, topSort.dir));
  const max = Math.max(1, ...channels.map((c) => (channelSort === 'seconds' ? c.seconds : c.count)));

  body.replaceChildren(...channels.map((c, i) => {
    const tr = document.createElement('tr');

    const rank = document.createElement('td');
    rank.className = 'rank';
    rank.textContent = String(i + 1);

    const name = document.createElement('td');
    const header = document.createElement('div');
    header.className = 'channel-name';
    header.append(avatarOf(c));

    // The name leads to the internal report, not to YouTube: the link to the
    // site is one click away, whereas nothing else leads to the channel's
    // analysis.
    if (c.channelId) {
      const link = document.createElement('a');
      link.href = channelHref(c.channelId);
      link.textContent = readableName(c.title);
      header.append(link);
    } else {
      header.append(readableName(c.title));
    }

    // The streak lives here rather than only in its own section: it is while
    // looking at the ranking that one wonders whether a channel is really
    // followed.
    if (c.streak >= 3) {
      const flame = document.createElement('span');
      flame.className = 'mini-streak';
      flame.textContent = `🔥 ${formatNumber(c.streak)}${c.streakCapped ? '+' : ''}`;
      // An `aria-label` and not a `data-info`: this badge sits on every row of a
      // long table, and a box opening under the cursor on each of them is what
      // made the page unpleasant to read. The flame and its number say enough
      // to the eye; the full sentence stays available to a screen reader.
      flame.setAttribute('aria-label', t(c.streakCapped ? 'hist.top.streak.max' : 'hist.top.streak',
        { n: c.streak }));
      header.append(flame);
    }

    name.append(header);
    const gauge = document.createElement('div');
    gauge.className = 'gauge';
    gauge.style.width = `${((channelSort === 'seconds' ? c.seconds : c.count) / max) * 100}%`;
    name.append(gauge);

    const views = document.createElement('td');
    views.className = 'num';
    views.textContent = formatNumber(c.count);

    const time = document.createElement('td');
    time.className = 'num';
    time.textContent = c.seconds ? formatDuration(c.seconds) : '—';
    // Flag when a channel's time rests mostly on its mean: without that, an
    // extrapolated value reads as a measured one.
    if (c.seconds && c.exact < c.withTime / 2) time.classList.add('approx');

    // Share of the video actually watched. It only holds for the openings
    // measured by the extension: a channel whose every row comes from Takeout
    // has nothing to say here, and must not show 100 %.
    const watched = document.createElement('td');
    watched.className = 'num col-share-watched';
    watched.textContent = c.watchedShare === null ? '—' : percent(c.watchedShare);

    tr.append(rank, name, views, time, watched);
    return tr;
  }));

  // Column hidden as long as no channel in the ranking has been measured: a
  // column full of dashes teaches nothing and steals room from the name.
  $('top').classList.toggle('no-share-watched', !channels.some((c) => c.watchedShare !== null));

  // What a greyed figure means, written once under the table rather than
  // repeated in a box on every row. It only appears when the table actually
  // holds one: a legend for a case that is not on screen is noise.
  const greyed = channels.some((c) => c.seconds && c.exact < c.withTime / 2);
  $('top-note').textContent = greyed ? t('hist.top.note') : '';

  // The concentration follows the switch: computed on views when the table sorts
  // by videos, on time when it sorts by time. A percentage that did not move
  // described a ranking that was no longer on screen.
  const byTime = channelSort === 'seconds';
  const list = byTime ? s.concentrationByTime : s.concentration;
  const c10 = list?.find((p) => p.n === 10);
  const c100 = list?.find((p) => p.n === 100);

  $('concentration').textContent = c10
    ? t(byTime ? 'hist.conc.time' : 'hist.conc.views', { pct: percent(c10.share) })
      + (c100 ? t('hist.conc.100', { pct: percent(c100.share) }) : '')
      + t('hist.conc.once', {
        n: formatNumber(s.seenOnce), total: formatNumber(s.distinctChannels),
      })
    : '';
}

function fillStreaks(streaks) {
  const useful = streaks.filter((x) => x.streak >= 3).slice(0, 24);

  $('card-streaks').hidden = !useful.length;
  $('streaks').replaceChildren(...useful.map((x) => {
    const el = document.createElement('div');
    el.className = 'streak-token';

    const flame = document.createElement('span');
    flame.textContent = x.streak >= 20 ? '🔥' : '✦';

    const name = document.createElement('a');
    name.href = channelHref(x.channelId);
    name.textContent = readableName(x.title);

    const n = document.createElement('b');
    n.textContent = formatNumber(x.streak);

    el.append(flame, name, n);

    // A video released two days ago and not yet opened no longer breaks the
    // streak, but the page says so: otherwise a large number on a channel whose
    // latest video is unwatched would look like a mistake.
    if (x.pending) {
      const a = document.createElement('span');
      a.className = 'capped attente';
      a.textContent = t('hist.streak.pending', { n: formatNumber(x.pending) });
      el.append(a);
    }

    // A streak equal to the number of known videos is a floor: YouTube returns
    // no more than that, so there is no way to know how far it goes.
    if (x.capped) {
      const p = document.createElement('span');
      p.className = 'capped';
      p.textContent = t('hist.streak.max');
      el.append(p);
    }
    return el;
  }));
}

/**
 * The channel's avatar, or a monogram.
 *
 * Avatars are known only for current subscriptions — the history, for its part,
 * cites thousands of channels we know nothing about. Rather than one request per
 * channel to fill the gap, a badge with the initial: it takes the same room and
 * the row does not shift depending on what we know.
 */
function avatarOf(c) {
  if (c.avatarUrl) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = c.avatarUrl;
    img.alt = '';
    img.loading = 'lazy';
    return img;
  }
  const circle = document.createElement('span');
  circle.className = 'avatar avatar-initial';
  circle.textContent = (c.title ?? '?').trim().charAt(0).toUpperCase() || '?';
  return circle;
}

function fillTopics(topics) {
  $('card-topics').hidden = !topics?.topics?.length;
  if (!topics?.topics?.length) return;

  const max = Math.max(...topics.topics.map((s) => s.count));
  $('topics').replaceChildren(...topics.topics.map((s) => {
    const row = document.createElement('div');
    row.className = 'topic cliquable';

    const name = document.createElement('button');
    name.className = 'topic-link';
    // The topic's name is translated, its identifier is not: the identifier is
    // what we send back to the worker to find the videos again.
    const label = t(TOPIC_KEYS[s.name] ?? s.name);
    name.textContent = label;
    name.addEventListener('click', () => openVideos({ title: label, topic: s.name }));

    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('i');
    fill.style.width = `${(s.count / max) * 100}%`;
    track.append(fill);

    const val = document.createElement('span');
    val.className = 'value';
    val.textContent = `${formatNumber(s.count)} · ${percent(s.share)}`;

    row.append(name, track, val);
    return row;
  }));

  // Without this figure, the split would read as exhaustive when it only covers
  // what the dictionary knows. And a video can belong to two topics, so the
  // shares do not add up to a hundred.
  const share = topics.total ? topics.classified / topics.total : 0;
  $('topics-coverage').textContent = t('hist.topics.cov', {
    pct: percent(share), n: formatNumber(topics.classified), total: formatNumber(topics.total),
  });
}

function fillSubscriptions(a, s) {
  $('card-subscriptions').hidden = !a?.total;
  if (!a?.total) return;

  const share = s.subscriptionShare;
  $('spread').replaceChildren();
  for (const [cls, value, text] of [
    ['inside', share, t('hist.subs.in', { pct: percent(share) })],
    ['outside', 1 - share, t('hist.subs.out', { pct: percent(1 - share) })],
  ]) {
    if (value <= 0.001) continue;
    const block = document.createElement('div');
    block.className = `share ${cls}`;
    block.style.width = `${value * 100}%`;
    block.textContent = text;
    $('spread').append(block);
  }

  $('never-title').textContent =
    t('hist.subs.never', { n: formatNumber(a.neverWatched), total: formatNumber(a.total) });

  // Two columns side by side: twelve names on one side and two on the other, and
  // the block tilts. We align on the shorter one, give or take three rows, which
  // still shows there are more without deforming the card.
  const cap = Math.min(12, Math.min(a.examples.length, a.candidates.length) + 3);
  const examples = a.examples.slice(0, cap);
  const candidates = a.candidates.slice(0, cap);

  $('never').replaceChildren(...examples.map((c) => {
    const row = channelRow(c);
    const info = document.createElement('small');
    info.textContent = c.lastSeen
      ? t('hist.subs.lastseen', { date: date(c.lastSeen) })
      : t('hist.subs.neverseen');
    row.append(info);
    return row;
  }));

  $('candidates').replaceChildren(...(candidates.length
    ? candidates.map((c) => {
      const row = channelRow(c);
      const info = document.createElement('small');
      info.textContent = t('hist.subs.cand', { n: formatNumber(c.count) });
      row.append(info);
      return row;
    })
    : [Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: t('hist.subs.cand.none'),
    })]));
}

function channelRow(c) {
  const row = document.createElement('div');
  row.className = 'channel-row';
  const link = document.createElement('a');
  link.href = channelHref(c.channelId);
  link.textContent = readableName(c.title);
  row.append(link);
  return row;
}

/** Every mention of a channel points here: an internal route, not YouTube. */
function channelHref(channelId) {
  return `#chaine=${channelId}`;
}

/**
 * Never an identifier in place of a name.
 *
 * Some channels have no recorded name — a subscription spotted by the feed
 * before any import, a channel renamed since. Falling back on `UC…` gave an
 * unreadable string of letters that could be attached to nothing; saying we do
 * not know the name is more honest, and the link leads to its report anyway.
 */
function readableName(title) {
  return title && !/^UC[\w-]{22}$/.test(title) ? title : t('hist.noname');
}

function fillThemes(themes, host = $('themes'), channelId = null) {
  host.replaceChildren(...(themes ?? []).map((theme) => themeChip(theme, channelId)));
}

/**
 * A theme is a button, not a label.
 *
 * Reading "rocket league — 463" immediately makes one want to see the 463, and
 * until now nothing happened. The counting is done on the whole words of the
 * title, and the list opened on click applies exactly the same rule: the two
 * figures coincide.
 */
function themeChip(theme, channelId) {
  const el = document.createElement('button');
  el.className = theme.expression ? 'theme expression' : 'theme';
  const b = document.createElement('b');
  b.textContent = theme.text;
  el.append(b, ` ${formatNumber(theme.n)}`);
  el.addEventListener('click', () => openVideos({
    title: theme.text, term: theme.text, channelId,
  }));
  return el;
}

/**
 * The days of the week to show, as a sliding window over the range.
 *
 * The axis ran from Monday to Sunday whatever the day the page was looked at: on
 * "the last seven days", today ended up in the middle of the chart and the week
 * read as cut in two. It now ends on the range's last day, like the popup's
 * publications per day, and shortens when the range is under a week — down to a
 * single bar for a one day range.
 *
 * @returns {number[]} `Date.getDay()` indices, oldest to most recent
 */
function weekdayWindow() {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = midnight(new Date(Math.min(range.to ?? Date.now(), Date.now())));

  // "All" has no start known in advance: the whole week applies.
  const start = Number.isFinite(range.from) && range.from > 0
    ? midnight(new Date(range.from)) : null;
  const days = start
    // `round` and not `floor`: a daylight saving change shifts the gap by an hour
    // and would make a day disappear twice a year.
    ? Math.max(1, Math.min(7, Math.round((end - start) / 864e5) + 1))
    : 7;

  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push((end.getDay() - i + 7) % 7);
  return out;
}

/** `Date.getDay()` starts on Sunday; the labels start on Monday. */
const weekdayName = (g) => weekdayNames()[(g + 6) % 7];
const weekdayInitial = (g) => weekdayInitials()[(g + 6) % 7];

/**
 * Lays the sliding window into a histogram, and gives back to the hours block
 * the width the days no longer take up.
 */
function weekdayHistogram(host, perWeekday, grid) {
  const days = weekdayWindow();
  histogram(host, days.map((g) => perWeekday[g]),
    (i) => weekdayInitial(days[i]), (i) => weekdayName(days[i]));

  // Twenty-four bars on one side, one to seven on the other: the days column
  // shrinks with its content instead of keeping a seventh of the width for a
  // single bar. The floor prevents a twenty pixel chart.
  if (grid) {
    grid.style.gridTemplateColumns = `2.2fr ${Math.max(0.34, days.length / 7).toFixed(2)}fr`;
  }
}

/**
 * Histogram.
 *
 * The scale is carried by an axis column on the left: without it, one sees which
 * slice dominates but not by how much, and the only way to read a value was to
 * wait for the browser's tooltip.
 *
 * The label takes a fixed height even when empty, otherwise the bars without a
 * label reach lower than the others and the baseline ripples.
 */
/**
 * A delay in milliseconds, said the way one says it out loud.
 *
 * `formatDuration` counts in hours and would answer "8 760 h" for a year, which
 * is exact and unreadable. Past the day the unit changes, and the figure is
 * rounded: a median delay is not a measurement to the minute.
 */
/**
 * The label of each slice of the delay chart, by the id the computation returns.
 *
 * Written out one by one rather than composed from the unit and the figure: a
 * key built at runtime cannot be found by searching the catalogue, and the
 * scales are few enough that spelling them out costs nothing.
 */
const DELAY_LABELS = {
  h1: 'hist.delay.h1',
  h6: 'hist.delay.h6',
  h24: 'hist.delay.h24',
  d1: 'hist.delay.d1',
  d7: 'hist.delay.d7',
  d30: 'hist.delay.d30',
  d365: 'hist.delay.d365',
  later: 'hist.delay.later',
};

function fillDelays(delays) {
  // Nothing to draw when the feed index knows none of the videos of the range:
  // an empty chart with a sentence explaining its emptiness teaches less than
  // no chart at all.
  $('card-delays').hidden = !delays?.known;
  $('card-delay-median').hidden = !delays?.known;
  if (!delays?.known) return;

  const label = (i) => t(DELAY_LABELS[delays.buckets[i].id]);
  histogram($('delays'), delays.buckets.map((b) => b.n), label, label);

  $('delays-scope').textContent = t('hist.delay.scope', {
    n: formatNumber(delays.known),
    total: formatNumber(delays.total),
  });

  $('s-delay').textContent = formatDelay(delays.median);
  $('d-delay').textContent = t('hist.delay.on', {
    n: delays.known, v: formatNumber(delays.known),
  });
}

function fillSessions(sessions) {
  // One row is one sitting, which says nothing: the figure starts to mean
  // something from a handful of them.
  $('sessions').hidden = !sessions || sessions.count < 3;
  if ($('sessions').hidden) return;

  layoutFigures($('session-figures'));
  $('s-sessions').textContent = rounded(sessions.perActiveDay);

  // A sitting whose rows were never measured has no length, and a dash is the
  // honest rendering of that: the sentence below says how many of them are in
  // that case rather than letting a zero pass for a measurement.
  $('s-session-median').textContent = sessions.medianSpan === null
    ? '—' : formatDuration(Math.round(sessions.medianSpan / 1000));
  $('s-session-longest').textContent = sessions.longest
    ? formatDuration(Math.round(sessions.longest.span / 1000)) : '—';
  $('s-session-longest-day').textContent = sessions.longest ? date(sessions.longest.from) : '';

  // Said always and not only when rows are missing: unlike the hourly curve,
  // whose scope only narrows on a scraped history, a sitting is a construction
  // and the reader is owed both the rule and what it was applied to.
  const scope = t('hist.sess.scope', {
    n: formatNumber(sessions.count),
    rows: formatNumber(sessions.rows),
    total: formatNumber(sessions.total),
  });
  $('sessions-scope').textContent = sessions.timed < sessions.count
    ? `${scope} ${t('hist.sess.timed', { n: formatNumber(sessions.timed) })}`
    : scope;
}

function fillRewatches(rewatches) {
  $('card-rewatch').hidden = !rewatches?.videos?.length;
  $('card-rewatched').hidden = $('card-rewatch').hidden;
  if ($('card-rewatch').hidden) return;

  $('s-rewatched').textContent = formatNumber(rewatches.total);
  $('d-rewatched').textContent = t('hist.again.of', {
    n: rewatches.distinct, v: formatNumber(rewatches.distinct),
  });

  const body = $('rewatch').querySelector('tbody');
  body.replaceChildren(...rewatches.videos.map((v, i) => {
    const tr = document.createElement('tr');

    const rank = document.createElement('td');
    rank.className = 'rank';
    rank.textContent = String(i + 1);

    const title = document.createElement('td');
    const link = document.createElement('a');
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = v.title || v.videoId;
    const channel = document.createElement('span');
    channel.className = 'caption';
    channel.textContent = v.channelTitle || '';
    title.append(link, channel);

    const times = document.createElement('td');
    times.className = 'num';
    times.textContent = formatNumber(v.opens);

    const span = document.createElement('td');
    span.className = 'num';
    // A same day rewatch has a span of zero, which reads as missing data: it is
    // said in words rather than shown as a dash.
    span.textContent = v.last - v.first < 864e5
      ? t('hist.again.sameday')
      : formatDelay(v.last - v.first);

    tr.append(rank, title, times, span);
    return tr;
  }));

  $('rewatch-scope').textContent = t('hist.again.scope', {
    n: formatNumber(rewatches.total),
    opens: formatNumber(rewatches.opens),
  });
}

/**
 * The drop off point, on the overall view or on a channel.
 *
 * The same three element shape serves both, because the figure is the same one
 * asked of a different set of rows.
 */
function fillDropoff(dropoff, { value, of, card }) {
  $(card).hidden = !dropoff?.n;
  if ($(card).hidden) return;

  $(value).textContent = formatDuration(Math.round(dropoff.medianSec));
  $(of).textContent = t('hist.drop.of', {
    pct: percent(dropoff.medianShare),
    n: formatNumber(dropoff.n),
  });
}

/**
 * What a channel publishes, over each window, as figures.
 *
 * Asked of one channel and of one channel only. The same block stood over the
 * whole subscription list too, and there it answered a question nobody had:
 * "966 videos over thirty days" is a property of the list's size, and the rate
 * that went under it, "32 a day", was read as a second and contradictory answer
 * rather than as the average of the first.
 *
 * Which is why the window carries its count alone now. On a channel the two
 * lines had the same defect at a smaller scale: "6" over "1.4 a week" reads as
 * two figures disagreeing, when the question asked was how many videos came out
 * in the last thirty days.
 *
 * A window reaching further back than the feed index is not drawn at all: the
 * count would be exact and the period wrong, which is the one thing worse than
 * no figure. The line underneath says where the index begins, so the absence is
 * explained rather than merely noticed.
 */
function fillPublishing(publishing, { host, scope, card }) {
  const covered = publishing?.windows?.filter((w) => w.covered) ?? [];
  $(card).hidden = !covered.length;
  if (!covered.length) return;

  const figure = (caption, value) => {
    const el = document.createElement('div');
    el.className = 'figure';
    el.append(
      Object.assign(document.createElement('span'), { className: 'caption', textContent: caption }),
      Object.assign(document.createElement('b'), { textContent: value }),
    );
    return el;
  };

  const cards = covered.map((w) => figure(
    t('hist.pub.win', { v: formatNumber(w.days) }), formatNumber(w.count)));

  // The total closes the row rather than opening it: the windows are read from
  // the narrowest out, and "since the index began" is the widest of them.
  cards.push(figure(t('hist.pub.total'), formatNumber(publishing.total)));

  const el = $(host);
  el.replaceChildren(...cards);
  layoutFigures(el);
  $(scope).textContent = t('hist.pub.scope', { since: date(publishing.since) });
}

/**
 * How many columns a row of figures takes.
 *
 * Left to `auto-fit`, a row filled itself and left the overflow alone on a line
 * of its own: eight figures came out as five and three, and the second line read
 * as an afterthought. The count is chosen so the last line is full whenever a
 * divisor allows it, and four is the ceiling — beyond that the figures grow
 * narrower than their own captions.
 */
function layoutFigures(host) {
  const n = [...host.children].filter((el) => !el.hidden).length;
  const cols = [4, 5, 3].find((c) => n % c === 0) ?? Math.min(n, 4);
  host.style.setProperty('--cols', String(Math.max(1, cols)));
}

function histogram(host, values, label, fullName = label) {
  const max = Math.max(1, ...values);

  const axis = document.createElement('div');
  axis.className = 'axis-y';
  for (const share of [1, 0.5, 0]) {
    const tick = document.createElement('span');
    tick.textContent = formatNumber(Math.round(max * share));
    axis.append(tick);
  }

  const bars = document.createElement('div');
  bars.className = 'bars-body';
  bars.append(...values.map((v, i) => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.dataset.info = t('hist.bar.info', { label: fullName(i), n: v });

    const fill = document.createElement('i');
    fill.style.height = `${Math.round((v / max) * 100)}%`;

    const legend = document.createElement('span');
    legend.textContent = label(i);

    bar.append(fill, legend);
    return bar;
  }));

  host.replaceChildren(axis, bars);
}

/**
 * Trend curve.
 *
 * One point a day as long as the range allows it, then grouped into weeks and
 * months. Monthly bars gave a single column over seven days — a chart that shows
 * nothing — and melted the troughs into averages that were too wide on long
 * ranges.
 *
 * In SVG, drawn by hand: no library enters a project without a build step, and a
 * polyline works out in ten lines.
 */
function trendCurve(series, host = $('evolution'), stepLabel = $('trend-step')) {
  if (!series?.length) { host.replaceChildren(); stepLabel.textContent = ''; return; }

  const { points, step } = groupSeries(series);
  stepLabel.textContent = t('hist.step', { step: t(`hist.step.${step}`) });

  const L = 860;
  const H = 150;
  const bottom = 22;   // room for the date labels
  const left = 38;     // room for the ordinate axis
  const right = 10;
  const max = Math.max(1, ...points.map((p) => p.value));

  const x = (i) => (points.length === 1
    ? (left + L - right) / 2
    : left + (i / (points.length - 1)) * (L - left - right));
  const y = (v) => (H - bottom) - (v / max) * (H - bottom - 8);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${L} ${H}`);
  svg.setAttribute('class', 'curve');
  svg.setAttribute('preserveAspectRatio', 'none');

  const el = (name, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // Three horizontal markers are enough to give the scale without a full grid.
  for (const share of [0, 0.5, 1]) {
    const vy = y(max * share);
    svg.append(el('line', { x1: left, x2: L, y1: vy, y2: vy, class: 'gridlines' }));
    const tick = el('text', { x: left - 6, y: vy + 4, class: 'axis', 'text-anchor': 'end' });
    tick.textContent = formatNumber(Math.round(max * share));
    svg.append(tick);
  }

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  svg.append(el('path', {
    d: `${path} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`,
    class: 'area',
  }));
  svg.append(el('path', { d: path, class: 'line' }));

  // The readings are shown as they are when there are few of them: a smooth
  // curve suggests a continuous measurement, when we sample one point a day, a
  // week or a month depending on the range.
  if (points.length <= 40) {
    for (const [i, p] of points.entries()) {
      svg.append(el('circle', { cx: x(i), cy: y(p.value), r: 2.2, class: 'measured' }));
    }
  }

  // Hovering designates the point, not a slice.
  //
  // The previous version painted the sensitive area grey: one believed one was
  // reading a histogram, and the lit rectangle corresponded to nothing measured.
  // The area stays — it is what catches the mouse — but it is invisible, and
  // what lights up is the reading itself, with its vertical marker.
  const width = (L - left - right) / Math.max(1, points.length - 1);
  for (const [i, p] of points.entries()) {
    const group = el('g', { class: 'hover-zone' });

    group.append(el('line', {
      x1: x(i), x2: x(i), y1: 8, y2: H - bottom, class: 'crosshair',
    }));
    group.append(el('circle', {
      cx: x(i), cy: y(p.value), r: 4, class: 'point', 'data-anchor': '',
    }));
    group.append(el('rect', {
      x: x(i) - width / 2, y: 0, width: Math.max(width, 2), height: H - bottom, class: 'hit-area',
    }));

    // The page's own box, not the SVG's `<title>`: the latter is rendered by the
    // browser, with the delay and the look of its own tooltips.
    group.setAttribute('data-info', t('hist.bar.info', { label: p.label, n: p.value }));
    svg.append(group);
  }

  // The ticks follow the calendar, not an arbitrary step: over twelve months one
  // wants to read the months, over three months the Mondays, over a week the
  // days. A label every six points gave "17/10" and "19/12", dates that
  // correspond to nothing for the reader.
  let lastX = -Infinity;
  for (const i of tickIndices(points, step)) {
    if (x(i) - lastX < 44) continue;
    lastX = x(i);
    const tick = el('text', { x: x(i), y: H - 6, class: 'axis', 'text-anchor': 'middle' });
    tick.textContent = points[i].short;
    svg.append(tick);
  }

  host.replaceChildren(svg);
}

/** Picks the step from the range's length, and aggregates accordingly. */
function groupSeries(series) {
  if (series.length <= 92) {
    return {
      step: 'day',
      points: series.map(([day, n]) => ({
        value: n, iso: day, label: dayLabel(day),
        short: `${day.slice(8)}/${day.slice(5, 7)}`,
      })),
    };
  }

  const byWeek = series.length <= 400 * 2;
  const size = byWeek ? 7 : 30;
  const points = [];

  for (let i = 0; i < series.length; i += size) {
    const slice = series.slice(i, i + size);
    const total = slice.reduce((s, [, n]) => s + n, 0);
    const start = slice[0][0];
    points.push({
      value: total,
      iso: start,
      label: t(byWeek ? 'hist.week.of' : 'hist.from.date', { date: dayLabel(start) }),
      short: byWeek ? shortMonth(start) : shortMonth(start),
    });
  }

  return { step: byWeek ? 'week' : 'month', points };
}

/**
 * Indices carrying a date label, chosen on the calendar.
 *
 * Each range has its natural graduation: days over a week, Mondays over three
 * months, months over a year. The markers land on dates the reader recognises,
 * instead of sampling the series every N points.
 */
function tickIndices(points, step) {
  const n = points.length;
  const out = [];

  if (step === 'day') {
    if (n <= 10) return points.map((_, i) => i);
    if (n <= 40) {
      // Backwards from the last day: the right bound is the date just chosen in
      // the range bar, it has to be readable.
      for (let i = n - 1; i >= 0; i -= 3) out.unshift(i);
      return out;
    }
    for (const [i, p] of points.entries()) if (isMonday(p.iso)) out.push(i);
    return out;
  }

  if (step === 'week') {
    let previousMonth = null;
    for (const [i, p] of points.entries()) {
      const month = p.iso.slice(0, 7);
      if (month !== previousMonth) { out.push(i); previousMonth = month; }
    }
    return out;
  }

  // One point a month: all of them while they fit, then one quarter in two.
  const gap = n <= 14 ? 1 : Math.ceil(n / 12);
  for (let i = 0; i < n; i += gap) out.push(i);
  return out;
}

function isMonday(iso) {
  return new Date(`${iso}T12:00:00`).getDay() === 1;
}

function dayLabel(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(bcp47(),
    { day: 'numeric', month: 'short', year: 'numeric' });
}

function shortMonth(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.getMonth() === 0
    ? String(d.getFullYear())
    : d.toLocaleDateString(bcp47(), { month: 'short' });
}

// Sorting only changes the display: redrawing from the last response avoids a
// half second recomputation over fifteen thousand entries for a click that
// changes no data.
wireSort($('top'), topSort, () => { if (lastResponse) fillTop(lastResponse.stats); });

$('averages-base').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  averageBase = b.dataset.base;
  for (const x of $('averages-base').children) x.classList.toggle('is-active', x === b);
  if (lastResponse) fillAverages(lastResponse.stats);
});

// ---------------------------------------------------------------------------
// Hidden channels
// ---------------------------------------------------------------------------

async function loadBlacklist() {
  const { histoBlacklist = [] } = await chrome.storage.local.get('histoBlacklist');

  $('bl-list').replaceChildren(...histoBlacklist.map((name) => {
    const el = document.createElement('span');
    el.className = 'token';
    el.append(name);

    const x = document.createElement('button');
    x.textContent = '×';
    x.setAttribute('aria-label', t('hist.bl.restore', { name }));
    x.addEventListener('click', () => updateBlacklist(histoBlacklist.filter((n) => n !== name)));

    el.append(x);
    return el;
  }));

  // The most watched channels as suggestions: that is where the one to hide will
  // be, and nobody remembers a `UC…` identifier.
  const res = await send(MSG.HISTORY_STATS, { from: 0, to: Date.now(), topN: 60 });
  if (res?.ok) {
    $('bl-suggestions').replaceChildren(...res.stats.topChannels.map((c) => {
      const o = document.createElement('option');
      o.value = c.title;
      return o;
    }));
  }
}

async function updateBlacklist(list) {
  await chrome.storage.local.set({ histoBlacklist: [...new Set(list)] });
  await loadBlacklist();
  await render();
}

/**
 * Every channel the history knows, keyed by lowercased name and by identifier.
 *
 * Built on demand and only once: it is asked for at the moment something is
 * typed, never on page load, because the full ranking is a few thousand entries
 * and nobody opens the settings panel.
 */
let knownChannels = null;

async function loadKnownChannels() {
  if (knownChannels) return knownChannels;
  const res = await send(MSG.HISTORY_STATS, { from: 0, to: Date.now(), topN: 100_000 });
  knownChannels = new Map();
  for (const c of res?.stats?.topChannels ?? []) {
    if (c.title) knownChannels.set(c.title.toLowerCase(), c.title);
    if (c.channelId) knownChannels.set(c.channelId.toLowerCase(), c.channelId);
  }
  return knownChannels;
}

/**
 * Hiding is matched on the exact name or the exact identifier.
 *
 * A misspelt name was therefore accepted, sat in the list as a token, and hid
 * nothing at all — with no way of telling that from a channel that simply has
 * no viewing on the current range. What is typed is now checked against the
 * history, and matched case insensitively: whoever types "arte" means Arte.
 */
$('bl-add').addEventListener('click', async () => {
  const value = $('bl-input').value.trim();
  $('bl-error').textContent = '';
  if (!value) return;

  const known = await loadKnownChannels();
  const exact = known.get(value.toLowerCase());
  if (!exact) {
    $('bl-error').textContent = t('hist.set.hidden.unknown', { name: value });
    return;
  }

  const { histoBlacklist = [] } = await chrome.storage.local.get('histoBlacklist');
  $('bl-input').value = '';
  await updateBlacklist([...histoBlacklist, exact]);
});

$('bl-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('bl-add').click();
});

// ---------------------------------------------------------------------------
// Tabs left open
// ---------------------------------------------------------------------------

/**
 * The videos seen more than five times, presented with what grounds the
 * suspicion.
 *
 * They are excluded by default because the normal case really is the forgotten
 * tab, but the decision stays with the user: a video genuinely studied again, or
 * played on a loop, would produce the same count.
 */
async function loadSuspects() {
  const res = await send(MSG.HISTORY_SUSPECTS, { minViews: 11 });
  const suspects = res?.suspects ?? [];

  const { histoExcludedVideos, histoSuspectsVus } = await chrome.storage.local.get(
    ['histoExcludedVideos', 'histoSuspectsVus']);

  // First pass: the default is applied once, then the user's choice is never
  // touched again — otherwise every new import would re-exclude what they had
  // just put back.
  if (!histoSuspectsVus) {
    await chrome.storage.local.set({
      histoExcludedVideos: suspects.map((s) => s.videoId),
      histoSuspectsVus: true,
    });
    return loadSuspects();
  }

  const excluded = new Set(histoExcludedVideos ?? []);

  $('suspects').replaceChildren(...suspects.map((s) => {
    const row = document.createElement('label');
    row.className = 'suspect';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = excluded.has(s.videoId);
    box.addEventListener('change', async () => {
      if (box.checked) excluded.add(s.videoId);
      else excluded.delete(s.videoId);
      await chrome.storage.local.set({ histoExcludedVideos: [...excluded] });
      await render();
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.append(s.title || t('hist.video.gone'));
    const sub = document.createElement('small');
    sub.textContent = s.channelTitle || '—';
    name.append(sub);

    const reason = document.createElement('span');
    reason.className = 'why';
    reason.textContent = t('hist.susp.motif', {
      views: formatNumber(s.views),
      gap: s.medianGapDays.toLocaleString(bcp47(), {
        minimumFractionDigits: 1, maximumFractionDigits: 1,
      }),
      spread: formatNumber(s.spanDays),
    });
    // Visible, because this is the whole decision the row asks for: tick it or
    // leave it. An explanation that has to be hovered for is an explanation
    // that has not been written.
    const verdict = document.createElement('small');
    verdict.textContent = t(s.oneADay && s.regular
      ? 'hist.susp.regular' : 'hist.susp.irregular');
    reason.append(verdict);

    row.append(box, name, reason);
    return row;
  }));

  if (!suspects.length) $('suspects').textContent = t('hist.susp.none');
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

let enrichTimer = null;

/**
 * Channels shown without an avatar, accumulated over the ranges consulted.
 *
 * The ranking changes with the range and with the videos/time switch, so the
 * list grows with use rather than being guessed in advance. It stays small — a
 * few dozen channels — for one request each.
 */
let missingAvatars = [];

/** Timestamp of the last render, to space out background refreshes. */
let lastRenderAt = 0;
/** Channels handled at the last render: with no change, nothing to redraw. */
let enrichedAtLastRender = -1;

const BACKGROUND_INTERVAL_MS = 60_000;

async function updateEnrichState() {
  const res = await send(MSG.HISTORY_ENRICH_STATE);
  if (!res?.ok) return;

  const { running, stalled, enriched } = res;

  // Nothing is written anywhere about it. The fetch used to have a state line
  // and a pair of buttons in the settings, which offered nothing to decide and
  // suggested a task running in the background at all times. It runs only in an
  // open YouTube tab, it starts on its own once the subscriptions are imported,
  // and it now ends. What is missing at the end is stated with figures in "What
  // these numbers are worth".
  //
  // The state is still read, because it is what paces the redrawing below.

  // The YouTube tab disappeared along the way: we restart rather than wait on
  // progress nobody is making any more.
  if (stalled) { startEnrich(); return; }

  clearTimeout(enrichTimer);
  if (!running) return;

  // The fetch advances by a few channels a minute and only moves the totals by
  // fractions of a percent. Redrawing on every result made the page flicker
  // without teaching anything: we redraw once a minute at most, and only if
  // something actually changed.
  const changed = enriched !== enrichedAtLastRender;
  const ripe = Date.now() - lastRenderAt > BACKGROUND_INTERVAL_MS;
  if (changed && ripe && !openChannel) {
    enrichedAtLastRender = enriched;
    await showStats({ quiet: true });
  }

  enrichTimer = setTimeout(updateEnrichState, 15_000);
}

/**
 * Starts the enrichment without asking.
 *
 * This is not an option: the durations govern the time shown, the accuracy of
 * the per-channel means and the streaks, and fetching them costs one request per
 * channel on a site that is already open. Making it a checkbox amounted to
 * letting the page show crude approximations by default.
 */
async function startEnrich() {
  const res = await send(MSG.HISTORY_ENRICH_START, {
    max: 800,
    avatarsFor: missingAvatars.slice(0, 100),
  });

  // No open YouTube tab: nothing to say and nothing to do. The fetch will be
  // asked for again at the next opening of the page, and the durations already
  // held are enough to show something in the meantime.
  if (res?.ok && !res.started) return;
  await updateEnrichState();
}

// ---------------------------------------------------------------------------
// A channel's report
// ---------------------------------------------------------------------------

/**
 * Routing by anchor.
 *
 * An anchor rather than a second page: the two views share the chosen range, the
 * browser history works with no effort — back arrow included — and nothing is
 * reloaded. A real extension page would have asked the service worker for
 * fifteen thousand entries again on every round trip.
 */
function router({ draw = true } = {}) {
  const id = /^#chaine=(UC[\w-]{22})$/.exec(location.hash)?.[1] ?? null;
  const duel = /^#comparer=(UC[\w-]{22}),(UC[\w-]{22})$/.exec(location.hash);

  openChannel = id;
  openDuel = duel ? [duel[1], duel[2]] : null;

  $('view-global').hidden = Boolean(id || duel);
  $('view-channel').hidden = !id;
  $('view-comparison').hidden = !duel;
  // The previous report is cleared straight away. Without that, clicking a
  // channel left the previous one on screen for the whole computation — one
  // thought one had misclicked, or worse, read another channel's figures.
  if (id) clearReport(id);
  // On the first pass the range is not resolved yet: it is `refresh` that will
  // trigger the render, once the history's bounds are known.
  if (draw) { window.scrollTo(0, 0); render(); }

  // `#import` opens the page straight onto the import.
  //
  // The onboarding's "Import my history" button used to land on the analysis
  // and nothing else: with a history already in place the steps at the top are
  // hidden, so the button appeared to do nothing. The anchor unfolds the
  // settings and brings their import block into view.
  if (location.hash === '#import') {
    $('settings-panel').open = true;
    $('settings-panel').scrollIntoView({ block: 'start' });
  }
}

/**
 * Blanks the report, with the channel's name if we already know it.
 *
 * The search directory, once loaded, gives the name without waiting for the
 * worker: showing "Arte — loading" right away beats an anonymous screen, if only
 * to confirm one clicked where one thought.
 */
function clearReport(channelId) {
  currentReport = null;
  const known = directory?.find((c) => c.channelId === channelId);

  $('ch-avatar').replaceChildren(known ? avatarOf(known) : document.createTextNode(''));
  $('ch-name').textContent = known ? readableName(known.title) : t('hist.loading');
  $('ch-sub').textContent = t('hist.busy.card');
  $('ch-link').href = `https://www.youtube.com/channel/${channelId}`;

  for (const id of ['ch-hours', 'ch-videos', 'ch-days', 'ch-rank', 'ch-coverage', 'ch-delay']) {
    $(id).textContent = '—';
  }
  for (const id of ['ch-share-time', 'ch-distinct', 'ch-share-views', 'ch-rank-of',
    'ch-relation', 'ch-coverage-of', 'ch-delay-of', 'ch-trend-step', 'ch-videos-count']) $(id).textContent = '';

  for (const id of ['ch-track', 'ch-evolution', 'ch-hours-hist', 'ch-days-hist', 'ch-themes']) {
    $(id).replaceChildren();
  }
  $('ch-list').querySelector('tbody').replaceChildren();
  $('ch-more').hidden = true;
}

window.addEventListener('hashchange', () => router());
$('back').addEventListener('click', () => { location.hash = ''; });
// Back to the first channel's report rather than a `history.back()`: a
// comparison opened straight from an address has no previous page, and the
// button would take you out of the extension.
$('back-from-comparison').addEventListener('click', () => {
  location.hash = openDuel ? `chaine=${openDuel[0]}` : '';
});

/** Draws the current view, whichever it is. */
async function render() {
  if (openDuel) await showComparison(...openDuel);
  else if (openChannel) await showChannel(openChannel);
  else await showStats();
}

let shownVideos = 30;
/** The report on screen, kept to unroll the list without recomputing. */
let currentReport = null;

async function showChannel(channelId) {
  const res = await during(t('hist.busy.card'), () =>
    send(MSG.HISTORY_CHANNEL, { channelId, from: range.from, to: range.to }));

  // A reply that arrives after one has changed one's mind must not be shown: on
  // computations of several seconds, two close clicks leave in the right order
  // but come back in any order at all.
  if (openChannel !== channelId) return;

  const f = res?.report;

  if (!f) {
    $('ch-name').textContent = t('hist.ch.unknown');
    $('ch-sub').textContent = t('hist.ch.unknown.p');
    return;
  }

  $('ch-avatar').replaceChildren(avatarOf({ ...f, avatarUrl: f.avatarUrl }));
  $('ch-name').textContent = readableName(f.title);
  $('ch-link').href = `https://www.youtube.com/channel/${f.channelId}`;

  const states = [t(f.subscribed ? 'hist.ch.sub' : 'hist.ch.nosub')];
  if (f.hidden) states.push(t('hist.ch.hidden'));
  $('ch-sub').textContent = states.join(' · ');

  $('ch-hours').textContent = f.seconds ? formatDuration(Math.round(f.seconds)) : '—';
  $('ch-share-time').textContent = f.timeShare
    ? t('hist.ch.oftime', { pct: percent(f.timeShare) }) : '';
  $('ch-videos').textContent = formatNumber(f.opens);
  $('ch-distinct').textContent = t('hist.ch.distinct', { n: formatNumber(f.distinctVideos) });
  $('ch-days').textContent = formatNumber(f.activeDays);
  $('ch-share-views').textContent = f.viewShare
    ? t('hist.ch.ofviews', { pct: percent(f.viewShare) }) : '';
  $('ch-rank').textContent = f.rank ? t('hist.ch.no', { n: formatNumber(f.rank) }) : '—';
  $('ch-rank-of').textContent = f.rank
    ? t('hist.ch.outof', { n: formatNumber(f.rangeChannels) }) : '';

  // The card only exists if the extension measured openings of this channel: on
  // a range coming from Takeout, there is nothing to say about it.
  $('ch-card-share-watched').hidden = f.watchedShare === null;
  if (f.watchedShare !== null) {
    $('ch-share-watched').textContent = percent(f.watchedShare);
    $('ch-share-watched-of').textContent = t('hist.ch.measured', { n: f.measuredOpens });
  }

  fillDropoff(f.dropoff, { value: 'ch-dropoff', of: 'ch-dropoff-of', card: 'ch-card-dropoff' });

  channelRelationship(f);
  channelTiming(f);
  layoutFigures($('ch-figures'));
  fillPublishing(f.publishing,
    { host: 'ch-publishing', scope: 'ch-publishing-scope', card: 'ch-card-publishing' });

  trendCurve(f.dailySeries, $('ch-evolution'), $('ch-trend-step'));
  histogram($('ch-hours-hist'), f.perHour,
    (i) => (i % 3 === 0 ? t('hist.hour.axis', { n: i }) : ''),
    (i) => t('hist.hour.range', { a: i, b: i + 1 }));
  weekdayHistogram($('ch-days-hist'), f.perWeekday);

  shownVideos = 30;
  currentReport = f;
  videoList(f);

  // The themes are computed here and not in the worker: the report already
  // carries every title of the range, so the round trip would bring nothing.
  const themes = extractThemes(f.videos.map((v) => ({ videoId: v.videoId, title: v.title })), { topN: 20, minCount: 2 });
  $('ch-card-themes').hidden = !themes.length;
  fillThemes(themes, $('ch-themes'), f.channelId);
}

/**
 * The two figures the feed index alone can give: how much of the channel has
 * been watched, and how fast its videos are opened.
 *
 * Both hide rather than approximate. The index starts at the installation and
 * holds only the followed channels, so a channel one is not subscribed to, or
 * one whose videos were all watched before the extension existed, shows neither.
 *
 * The coverage was a bar among the streaks, under a title promising a
 * relationship: it is one of the two numbers this page is opened for, and it now
 * sits with the other figures.
 */
function channelTiming(f) {
  $('ch-card-coverage').hidden = f.coverage === null;
  if (f.coverage !== null) {
    $('ch-coverage').textContent = percent(f.coverage);
    $('ch-coverage-of').textContent = t('hist.ch.lastn', { n: formatNumber(f.knownUploads) });
  }

  $('ch-card-delay').hidden = !f.delays?.known;
  if (f.delays?.known) {
    $('ch-delay').textContent = formatDelay(f.delays.median);
    $('ch-delay-of').textContent = t('hist.delay.on', {
      n: f.delays.known, v: formatNumber(f.delays.known),
    });
  }
}

/**
 * The relationship to the channel, over the whole history and not over the
 * range.
 *
 * Knowing since when one has followed someone makes no sense recomputed over the
 * last thirty days: the question is about duration, not about the current
 * window.
 */
function channelRelationship(f) {
  const years = (f.lastSeen - f.firstSeen) / 31_536_000_000;
  const duration = years >= 1
    ? t('hist.years', { n: rounded(years) })
    : t('hist.days', { n: Math.round((f.lastSeen - f.firstSeen) / 86_400_000) });

  $('ch-relation').textContent = t('hist.ch.rel', {
    first: date(f.firstSeen),
    last: date(f.lastSeen),
    duration,
    opens: formatNumber(f.totalOpens),
    videos: formatNumber(f.totalVideos),
  });

  const track = $('ch-track');
  track.replaceChildren();

  if (f.coverage === null) {
    track.append(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: t('hist.ch.norecall'),
    }));
    return;
  }

  const row = (text, value, share) => {
    const el = document.createElement('div');
    el.className = 'topic';
    el.append(Object.assign(document.createElement('span'), { textContent: text }));
    const bar = document.createElement('div');
    bar.className = 'track';
    const i = document.createElement('i');
    i.style.width = `${Math.min(1, share) * 100}%`;
    bar.append(i);
    el.append(bar, Object.assign(document.createElement('span'),
      { className: 'value', textContent: value }));
    return el;
  };

  // The coverage bar used to open this list. It is a figure among the figures
  // now, and printing it twice on the same screen only made the reader look for
  // a difference between the two.

  // Both streaks always show here, zero included. On the home page a small
  // streak teaches nothing and would drown the ranking; on one channel's report
  // it is exactly the question being asked — and "no streak under way" is an
  // answer, not a blank.
  const flame = f.streak >= 20 ? '🔥' : f.streak > 0 ? '✦' : '·';
  track.append(row(
    `${flame} ${t('hist.ch.streak')}`,
    f.streak
      ? t(f.streakCapped ? 'hist.ch.inrow.max' : 'hist.ch.inrow', { n: formatNumber(f.streak) })
      : t('hist.ch.nostreak'),
    f.streak / Math.max(1, f.knownUploads)));

  // No point repeating the same bar twice when the current streak is the best —
  // which is the case of every channel followed without interruption.
  if (f.streakMax > f.streak) {
    track.append(row(
      `★ ${t('hist.ch.beststreak')}`,
      t('hist.ch.inrow', { n: formatNumber(f.streakMax) }),
      f.streakMax / Math.max(1, f.knownUploads)));
  }
}

/**
 * Sorting shared by the two video tables.
 *
 * Text reads A to Z, numbers and dates from largest to smallest: in both cases
 * that is the direction expected on the first click, and imposing one or the
 * other everywhere would mean clicking twice every time.
 */
function compareBy(field, dir) {
  return (a, b) => {
    const va = a[field];
    const vb = b[field];
    if (typeof va === 'string' || typeof vb === 'string') {
      return (va ?? '').localeCompare(vb ?? '', bcp47(), { sensitivity: 'base' }) * dir;
    }
    return ((va ?? 0) - (vb ?? 0)) * dir;
  };
}

const defaultDir = (field) => (/title|nom/i.test(field) ? 1 : -1);

function wireSort(table, state, redraw) {
  for (const button of table.querySelectorAll('.sort')) {
    button.addEventListener('click', () => {
      const field = button.dataset.field;
      if (state.field === field) state.dir = -state.dir;
      else { state.field = field; state.dir = defaultDir(field); }
      redraw();
    });
  }
}

function updateArrows(table, state) {
  for (const button of table.querySelectorAll('.sort')) {
    const active = button.dataset.field === state.field;
    button.classList.toggle('active', active);
    button.dataset.dir = active ? (state.dir < 0 ? '↓' : '↑') : '';
  }
}

const videoSort = { field: 'last', dir: -1 };
wireSort($('ch-list'), videoSort, () => { if (currentReport) videoList(currentReport); });

function videoList(f) {
  const body = $('ch-list').querySelector('tbody');
  updateArrows($('ch-list'), videoSort);

  const sorted = [...f.videos].sort(compareBy(videoSort.field, videoSort.dir));
  const visible = sorted.slice(0, shownVideos);

  body.replaceChildren(...visible.map((v) => {
    const tr = document.createElement('tr');

    const title = document.createElement('td');
    const link = document.createElement('a');
    link.href = `https://www.youtube.com/watch?v=${v.videoId}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = v.title || t('hist.notitle');
    title.append(link);

    const n = document.createElement('td');
    n.className = 'num';
    n.textContent = formatNumber(v.opens);

    const duration = document.createElement('td');
    duration.className = 'num';
    duration.textContent = v.seconds ? formatDuration(v.seconds) : '—';
    // Say what the estimate rests on, and not merely that there is one: a
    // surprising mean can only be judged if one knows what it averages. Above
    // the threshold it is what was watched of the channel, below it the mean of
    // its recent uploads, Shorts set aside.
    if (v.seconds && !v.exact) duration.classList.add('approx');

    // Time actually spent on the video, facing its duration. This is the only
    // place where the two read side by side, and therefore the only place where
    // one sees that a twenty minute video was abandoned after three.
    const watched = document.createElement('td');
    watched.className = 'num col-watched';
    if (v.watchedSeconds === null) {
      watched.textContent = '—';
      watched.classList.add('approx');
    } else {
      const share = v.seconds ? Math.min(1, v.watchedSeconds / v.seconds) : null;
      watched.textContent = shortDuration(v.watchedSeconds)
        + (share === null ? '' : ` · ${percent(share)}`);
    }

    const when = document.createElement('td');
    when.className = 'num';
    when.textContent = date(v.last);

    tr.append(title, n, duration, watched, when);
    return tr;
  }));

  // Column hidden as long as nothing has been measured on this channel: a whole
  // column of dashes would take the room of the title, which is short already.
  $('ch-list').classList.toggle('no-watched', !f.videos.some((v) => v.watchedSeconds !== null));

  // Same rule as the ranking: one line under the table, only when the table
  // holds a case it describes.
  $('ch-list-note').textContent = f.videos.some((v) => (v.seconds && !v.exact)
    || v.watchedSeconds === null) ? t('hist.ch.note') : '';

  $('ch-videos-count').textContent = t('hist.ch.shown', {
    n: formatNumber(visible.length), total: formatNumber(f.videos.length),
  });
  $('ch-more').hidden = visible.length >= f.videos.length;
  $('ch-card-videos').hidden = !f.videos.length;
}

// The report on screen already carries all its videos: asking the worker for
// another copy just to show a hundred more would restart a full computation.
$('ch-more').addEventListener('click', () => {
  if (!currentReport) return;
  shownVideos += 100;
  videoList(currentReport);
});

// ---------------------------------------------------------------------------
// Comparing two channels
// ---------------------------------------------------------------------------

/** The two channels being compared, or `null` outside the comparison view. */
let openDuel = null;

$('ch-compare').addEventListener('click', async () => {
  $('duel-search').value = '';
  $('duel-dialog').showModal();
  fillDuelChoices('');
  $('duel-search').focus();
});

$('duel-close').addEventListener('click', () => $('duel-dialog').close());
$('duel-search').addEventListener('input', () =>
  fillDuelChoices($('duel-search').value.trim().toLowerCase()));

/**
 * Offers the opponent. With no input, the most watched channels: comparing one's
 * first channel to one's second is the most likely move, and doing it must not
 * require knowing how to spell its name.
 */
async function fillDuelChoices(q) {
  const list = (await loadDirectory())
    .filter((c) => c.channelId !== openChannel)
    .filter((c) => !q || c.title.toLowerCase().includes(q))
    .sort((a, b) => {
      if (!q) return b.count - a.count;
      const da = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const db = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      return da - db || b.count - a.count;
    })
    .slice(0, 20);

  $('duel-results').replaceChildren(...list.map((c) => {
    const a = document.createElement('button');
    a.className = 'result';
    a.append(avatarOf(c));

    const text = document.createElement('span');
    text.className = 'result-name';
    text.append(readableName(c.title));
    const sub = document.createElement('small');
    sub.textContent = t('hist.nvideos', { n: formatNumber(c.count) })
      + (c.seconds ? ` · ${formatDuration(Math.round(c.seconds))}` : '');
    text.append(sub);

    a.append(text);
    a.addEventListener('click', () => {
      $('duel-dialog').close();
      location.hash = `comparer=${openChannel},${c.channelId}`;
    });
    return a;
  }));
}

async function showComparison(idA, idB) {
  const [ra, rb] = await during(t('hist.busy.compare'), () => Promise.all([
    send(MSG.HISTORY_CHANNEL, { channelId: idA, from: range.from, to: range.to }),
    send(MSG.HISTORY_CHANNEL, { channelId: idB, from: range.from, to: range.to }),
  ]));

  if (openDuel?.[0] !== idA || openDuel?.[1] !== idB) return;

  const a = ra?.report;
  const b = rb?.report;
  if (!a || !b) {
    $('duel-rows').replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: t('hist.cmp.missing'),
    }));
    return;
  }

  for (const [host, f] of [[$('duel-a'), a], [$('duel-b'), b]]) {
    host.querySelector('.duel-avatar').replaceChildren(avatarOf(f));
    host.querySelector('.duel-name').textContent = readableName(f.title);
    host.querySelector('.duel-sub').textContent = t(f.subscribed ? 'hist.sub' : 'hist.nosub');
  }

  // Each row is a split: the bar shows who takes which share of the two's total,
  // which reads at a glance where two figures side by side call for a mental
  // division.
  const rows = [
    [t('hist.cmp.time'), a.seconds, b.seconds, (v) => (v ? formatDuration(Math.round(v)) : '—')],
    [t('hist.cmp.opened'), a.opens, b.opens, formatNumber],
    [t('hist.cmp.distinct'), a.distinctVideos, b.distinctVideos, formatNumber],
    [t('hist.cmp.days'), a.activeDays, b.activeDays, formatNumber],
    [t('hist.cmp.streak'), a.streak, b.streak, formatNumber],
    [t('hist.cmp.best'), a.streakMax, b.streakMax, formatNumber],
    [t('hist.cmp.cov'), a.coverage ?? 0, b.coverage ?? 0, (v) => (v ? percent(v) : '—')],
    // Seniority is measured the other way round: the older first sighting wins.
    [t('hist.cmp.since'), Date.now() - a.firstSeen, Date.now() - b.firstSeen,
      (v) => t('hist.years', { n: rounded(v / 31_536_000_000) })],
  ];

  $('duel-rows').replaceChildren(...rows.map(([title, va, vb, format]) =>
    duelRow(title, va, vb, format)));

  doubleCurve(a, b);
}

function duelRow(title, va, vb, format) {
  const total = va + vb;
  const shareA = total ? va / total : 0.5;

  const el = document.createElement('div');
  el.className = 'duel-row';

  const left = document.createElement('span');
  left.className = `duel-value${va > vb ? ' won' : ''}`;
  left.textContent = format(va);

  const name = document.createElement('span');
  name.className = 'duel-label';
  name.textContent = title;

  const right = document.createElement('span');
  right.className = `duel-value right${vb > va ? ' won' : ''}`;
  right.textContent = format(vb);

  const track = document.createElement('div');
  track.className = 'duel-track';
  const ia = document.createElement('i');
  ia.className = 'a';
  ia.style.width = `${shareA * 100}%`;
  const ib = document.createElement('i');
  ib.className = 'b';
  ib.style.width = `${(1 - shareA) * 100}%`;
  track.append(ia, ib);

  el.append(left, name, right, track);
  return el;
}

/** The two daily series on a single axis, at the same step. */
function doubleCurve(a, b) {
  const host = $('duel-evolution');
  const sa = groupSeries(a.dailySeries ?? []);
  const sb = groupSeries(b.dailySeries ?? []);
  if (!sa.points.length) { host.replaceChildren(); return; }

  $('duel-trend-step').textContent = t('hist.step', { step: t(`hist.step.${sa.step}`) });

  const L = 860;
  const H = 150;
  const bottom = 22;
  const left = 38;
  const right = 10;
  const max = Math.max(1, ...sa.points.map((p) => p.value), ...sb.points.map((p) => p.value));

  const x = (i, n) => (n === 1
    ? (left + L - right) / 2
    : left + (i / (n - 1)) * (L - left - right));
  const y = (v) => (H - bottom) - (v / max) * (H - bottom - 8);

  const ns = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const n = document.createElementNS(ns, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${L} ${H}`);
  svg.setAttribute('class', 'curve');
  svg.setAttribute('preserveAspectRatio', 'none');

  for (const share of [0, 0.5, 1]) {
    const vy = y(max * share);
    svg.append(el('line', { x1: left, x2: L, y1: vy, y2: vy, class: 'gridlines' }));
    const tick = el('text', { x: left - 6, y: vy + 4, class: 'axis', 'text-anchor': 'end' });
    tick.textContent = formatNumber(Math.round(max * share));
    svg.append(tick);
  }

  for (const [points, cls] of [[sa.points, 'line-a'], [sb.points, 'line-b']]) {
    if (!points.length) continue;
    const d = points
      .map((p, i) => `${i ? 'L' : 'M'}${x(i, points.length).toFixed(1)},${y(p.value).toFixed(1)}`)
      .join(' ');
    svg.append(el('path', { d, class: `line ${cls}` }));
  }

  let lastX = -Infinity;
  for (const i of tickIndices(sa.points, sa.step)) {
    if (x(i, sa.points.length) - lastX < 44) continue;
    lastX = x(i, sa.points.length);
    const tick = el('text', { x: lastX, y: H - 6, class: 'axis', 'text-anchor': 'middle' });
    tick.textContent = sa.points[i].short;
    svg.append(tick);
  }

  host.replaceChildren(svg);

  // The legend doubles as a switch: two curves that cross are unreadable, and
  // keeping only one is the first thing anyone tries.
  $('duel-key').replaceChildren(...[[a.title, 'a'], [b.title, 'b']].map(([name, c]) => {
    const s = document.createElement('button');
    s.className = `key ${c}`;
    s.textContent = readableName(name);
    s.setAttribute('aria-label', t('hist.cmp.hide'));
    s.addEventListener('click', () => {
      const stroke = svg.querySelector(`.trait-${c}`);
      const off = stroke.classList.toggle('erased');
      s.classList.toggle('muted-out', off);
    });
    return s;
  }));
}

// ---------------------------------------------------------------------------
// The videos behind a theme or a topic
// ---------------------------------------------------------------------------

/**
 * @param {object} q
 * @param {string} q.title       what was clicked, as it stands
 * @param {string} [q.term]      literal phrase found in the titles
 * @param {string} [q.topic]     name of a category of the dictionary
 * @param {string} [q.channelId] restricts to one channel, from its report
 */
async function openVideos({ title, term = '', topic = '', channelId = null }) {
  const dlg = $('videos-dialog');
  $('videos-title').textContent = title;
  $('videos-sub').textContent = t('hist.searching');
  $('videos-list').querySelector('tbody').replaceChildren();
  dlg.showModal();
  dlg.focus();

  const res = await send(MSG.HISTORY_VIDEOS, {
    term, topic, channelId, from: range.from, to: range.to,
  });
  termVideos = res?.videos ?? [];
  const videos = termVideos;

  // The worker caps at three hundred: past that the list stops being readable,
  // and saying so avoids the impression that the theme's count was wrong.
  const capped = videos.length >= 300;
  $('videos-sub').textContent = videos.length
    ? (capped ? t('hist.vids.capped') : t('hist.vids.count', { n: videos.length }))
    : t('hist.vids.none');

  drawTermVideos();
}

/** The dialog's videos, kept to re-sort without asking the worker again. */
let termVideos = [];
const termSort = { field: 'last', dir: -1 };
wireSort($('videos-list'), termSort, () => drawTermVideos());

function drawTermVideos() {
  const dlg = $('videos-dialog');
  updateArrows($('videos-list'), termSort);

  const videos = [...termVideos].sort(compareBy(termSort.field, termSort.dir));

  $('videos-list').querySelector('tbody').replaceChildren(...videos.map((v) => {
    const tr = document.createElement('tr');

    const titleCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = `https://www.youtube.com/watch?v=${v.videoId}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = v.title || t('hist.notitle');
    titleCell.append(link);

    // The channel leads to its report: the dialog closes, otherwise one ends up
    // with a report hidden behind a list that no longer concerns it.
    const channel = document.createElement('td');
    if (v.channelId) {
      const a = document.createElement('a');
      a.href = channelHref(v.channelId);
      a.textContent = readableName(v.channelTitle);
      a.addEventListener('click', () => dlg.close());
      channel.append(a);
    } else {
      channel.textContent = v.channelTitle || '—';
    }

    const n = document.createElement('td');
    n.className = 'num';
    n.textContent = formatNumber(v.opens);

    const when = document.createElement('td');
    when.className = 'num';
    when.textContent = date(v.last);

    tr.append(titleCell, channel, n, when);
    return tr;
  }));
}

$('videos-close').addEventListener('click', () => $('videos-dialog').close());
// Clicking in the void around the dialog closes it, as everywhere else.
$('videos-dialog').addEventListener('click', (e) => {
  if (e.target === $('videos-dialog')) $('videos-dialog').close();
});

// ---------------------------------------------------------------------------
// Channel search
// ---------------------------------------------------------------------------

/** Full directory, loaded once: it does not depend on the range. */
let directory = null;

/**
 * The directory, plus a request for the pictures it is missing.
 *
 * The enrichment only fetches an avatar for the channels actually displayed —
 * one request each, so it is not spent blindly. The games display two hundred,
 * hence this claim. It arrives for the next opening, not for this one: the
 * request goes through a YouTube tab.
 */
async function directoryWithAvatars() {
  const [list, facts] = await Promise.all([loadDirectory(), loadChannelFacts()]);
  for (const c of list) Object.assign(c, facts[c.channelId] ?? {});
  const missing = list
    .filter((c) => !c.avatarUrl && c.channelId && c.count >= 3)
    .map((c) => c.channelId);
  if (missing.length) {
    missingAvatars = [...new Set([...missingAvatars, ...missing])];
    startEnrich().catch(() => {});
  }
  return list;
}

/**
 * What the channels themselves do, loaded once for the games.
 *
 * Kept apart from the directory: the search does not need it, and the figures
 * come from a full sweep of the feed index, which is not worth paying on every
 * keystroke.
 */
let channelFacts = null;

async function loadChannelFacts() {
  if (channelFacts) return channelFacts;
  const res = await send(MSG.HISTORY_CHANNEL_FACTS);
  channelFacts = res?.facts ?? {};
  return channelFacts;
}

async function loadDirectory() {
  if (directory) return directory;
  const res = await send(MSG.HISTORY_CHANNEL_LIST);
  directory = res?.channels ?? [];
  return directory;
}

$('search').addEventListener('input', async () => {
  const q = $('search').value.trim().toLowerCase();
  const box = $('search-results');

  if (q.length < 2) { box.hidden = true; box.replaceChildren(); return; }

  const list = await loadDirectory();
  // Channels whose name starts with the input first: searching for "arte" must
  // offer Arte before a channel that has "arte" in the middle of its name.
  const found = list
    .filter((c) => c.title.toLowerCase().includes(q))
    .sort((a, b) => {
      const da = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const db = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      return da - db || b.count - a.count;
    })
    .slice(0, 12);

  box.hidden = false;
  if (!found.length) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted', textContent: t('hist.search.none'),
    }));
    return;
  }

  box.replaceChildren(...found.map((c) => {
    const a = document.createElement('a');
    a.className = 'result';
    a.href = channelHref(c.channelId);
    a.append(avatarOf(c));

    const text = document.createElement('span');
    text.className = 'result-name';
    text.append(readableName(c.title));
    const sub = document.createElement('small');
    sub.textContent = t('hist.nvideos', { n: formatNumber(c.count) })
      + (c.seconds ? ` · ${formatDuration(Math.round(c.seconds))}` : '')
      + (c.subscribed ? ` · ${t('hist.sub')}` : '');
    text.append(sub);

    a.append(text);
    a.addEventListener('click', () => {
      $('search').value = '';
      box.hidden = true;
    });
    return a;
  }));
});

// Close by clicking elsewhere: a list of results that stays open over the page
// is more of a nuisance than a help.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) $('search-results').hidden = true;
});

// ---------------------------------------------------------------------------

/** `2026-08-15` in local time, for the `<input type="date">` fields. */
function isoDay(ms) {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Retranslates the whole page.
 *
 * The `data-i18n` markup covers the HTML as delivered; everything this script
 * writes is redone by redrawing the current view, which is in any case the only
 * way to retranslate a table built row by row.
 */
function retranslate() {
  document.documentElement.lang = getLocale();
  translateDom();
  buildRanges();
  markActiveRange();
  loadBlacklist();
  loadSuspects();
  updateEnrichState();
  render();
}

// The view is chosen before the first render: opening the page on a channel's
// anchor — a reopened tab, a bookmark — must lead straight to its report rather
// than show the overview and then switch.
//
// The language comes before everything else: the first screen is already
// catalogue text, and correcting it before the user's eyes would be worse than
// waiting for it.
(async function start() {
  const [, , cached] = await Promise.all([
    initLocale(), loadTimeModel(),
    chrome.storage.local.get([UI_SNAPSHOT.history, UI_SNAPSHOT.stats]).catch(() => ({})),
  ]);
  document.documentElement.lang = getLocale();
  translateDom();

  router({ draw: false });
  cachedStats = cached[UI_SNAPSHOT.stats] ?? null;
  if (cached[UI_SNAPSHOT.history]?.summary) paintSummary(cached[UI_SNAPSHOT.history]);
  await refresh();

  // The language can change from the popup while this page is open.
  chrome.storage.onChanged.addListener(async (changes, zone) => {
    if (zone !== 'local' || !changes[LANG_KEY]) return;
    await initLocale();
    retranslate();
  });
})();
