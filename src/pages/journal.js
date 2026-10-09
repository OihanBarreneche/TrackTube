/**
 * The detailed history: one day of viewings, row by row.
 *
 * Everything on the analysis page aggregates. This page does the opposite: it
 * shows a row as it is stored — where it came from, whether it carries an hour,
 * how much of it was measured — next to what the feed index holds for the same
 * video. That pairing is what makes it the place to look when a figure
 * elsewhere looks wrong: a doubled row, a viewing attached to no channel, a
 * video counted at its channel's average rather than at its own length are all
 * invisible in a total and obvious here.
 *
 * The arithmetic lives in `buildDayJournal`, pure and tested, on the worker
 * side where the database is. This file only draws it.
 */

import { MSG, send } from '../lib/messages.js';
import { formatDuration } from '../lib/history.js';
import { t, initLocale, getLocale, bcp47, LANG_KEY } from '../lib/i18n.js';
import { translateDom } from '../lib/i18n-dom.js';

const $ = (id) => document.getElementById(id);
const formatNumber = (n) => new Intl.NumberFormat(bcp47()).format(n);
const percent = (r) => t('jou.pct', { n: Math.round(r * 100) });

const clock = (ms) => new Date(ms)
  .toLocaleTimeString(bcp47(), { hour: '2-digit', minute: '2-digit' });

const longDate = (ms) => new Date(ms).toLocaleDateString(bcp47(),
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The length of one viewing, which can be very short.
 *
 * `formatDuration` is cut out for totals and rounds to the minute: a video left
 * after twenty seconds would read "0 min" there, which looks like an absence of
 * measurement when it is in fact a measurement.
 */
const shortDuration = (s) => (s < 60 ? t('dur.s', { n: Math.round(s) }) : formatDuration(Math.round(s)));

/** `2026-08-15` in local time, the key the statistics group days by. */
function dayKey(ms) {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * First and last millisecond of a local day.
 *
 * Built from the calendar fields rather than by adding twenty four hours: on
 * the two days a year the clocks change, the offset lands an hour out and
 * viewings would show up under the wrong date.
 */
function dayBounds(key) {
  const [y, m, d] = key.split('-').map(Number);
  return {
    from: new Date(y, m - 1, d, 0, 0, 0, 0).getTime(),
    to: new Date(y, m - 1, d, 23, 59, 59, 999).getTime(),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The day on screen, `YYYY-MM-DD` local. */
let openDay = null;
/** The reply for that day, kept so a re-sort does not go back to the worker. */
let current = null;

/**
 * Column the list is sorted on, and in which direction.
 *
 * The hour, descending, is the day as it happened read backwards — which is the
 * order YouTube itself shows and the one a reader expects of a history.
 */
const sort = { field: 'watchedAt', dir: -1 };

function busy(on) {
  $('page').classList.toggle('computing', on);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function goToDay(key) { location.hash = `jour=${key}`; }

// The arrows land on the next day that actually holds something, which is the
// only useful step: walking a quiet week one day at a time meant seven empty
// screens in a row. The date field stays for whoever wants a precise day.
$('day-prev').addEventListener('click', () => {
  if (Number.isFinite(current?.previous)) goToDay(dayKey(current.previous));
});

$('day-next').addEventListener('click', () => {
  if (Number.isFinite(current?.next)) goToDay(dayKey(current.next));
});

$('day-today').addEventListener('click', () => goToDay(dayKey(Date.now())));

$('day-date').addEventListener('change', () => {
  if ($('day-date').value) goToDay($('day-date').value);
});

// The arrow keys, because reading day by day is a dozen steps and clicking the
// same button twelve times is not a reading. Ignored while a field has focus,
// the date picker just above included.
window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (event.key === 'ArrowLeft') $('day-prev').click();
  else if (event.key === 'ArrowRight') $('day-next').click();
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Orders the rows on screen.
 *
 * A row that has no value for the chosen field always sinks to the bottom,
 * whichever way the arrow points. Sorting on time watched otherwise filled the
 * top with the Takeout and history page rows, which carry no measurement at
 * all: their absence would have read as a measurement of zero.
 */
function sorted(entries) {
  const value = (e) => {
    const v = e[sort.field];
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  return entries.slice().sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return b.watchedAt - a.watchedAt;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * sort.dir;
  });
}

function updateSortButtons() {
  for (const button of document.querySelectorAll('.sort')) {
    const on = button.dataset.field === sort.field;
    button.classList.toggle('on', on);
    button.classList.toggle('up', on && sort.dir === 1);
  }
}

for (const button of document.querySelectorAll('.sort')) {
  button.addEventListener('click', () => {
    // Clicking the column already sorted flips it; clicking another starts on
    // the descending order, which is the one wanted first for every field here:
    // the most recent, the longest, the most watched.
    if (sort.field === button.dataset.field) sort.dir = -sort.dir;
    else { sort.field = button.dataset.field; sort.dir = -1; }
    updateSortButtons();
    if (current) drawList(current.entries);
  });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * A scale that ends on a round figure.
 *
 * Taken as read, the largest bar always touches the top and the axis reads
 * "7" — which says nothing about the next day, where it would read "23". Rising
 * to the next round step keeps a scale one can compare two days on, and gives a
 * half way mark worth writing.
 */
function ceiling(max) {
  // Under a dozen, the next even number: rounding a busiest hour of three up to
  // ten left the whole chart flat against the floor. Even, so that the half way
  // mark is a whole number rather than "1,5".
  if (max <= 10) return max % 2 ? max + 1 : max;

  const step = 10 ** Math.floor(Math.log10(max));
  for (const k of [2, 4, 5, 10]) {
    const candidate = k * step;
    if (candidate >= max) return candidate;
  }
  return 10 * step;
}

/**
 * One of the two hourly charts.
 *
 * Only the rows that carry an hour can enter it, which is why the caller states
 * underneath how many that was: a day made entirely of collected rows would
 * otherwise show an empty chart with nothing saying why.
 *
 * The vertical scale is written out and every bar carries its own figure,
 * revealed on hover. Without them the chart said which hour was the busiest and
 * nothing at all about how busy, which is half a chart.
 */
function drawChart(el, axisEl, hoursEl, values, format) {
  const top = ceiling(Math.max(...values, 1));

  axisEl.replaceChildren(...[top, top / 2, 0].map((v) => {
    const label = document.createElement('span');
    label.textContent = formatNumber(v);
    return label;
  }));

  el.replaceChildren(...values.map((value, hour) => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    // The hour belongs in the bubble as much as the figure: only one label in
    // six is written under the chart, so pointing at a bar between two of them
    // said "3 vidéos" without ever saying when.
    const label = t('jou.bar', { hour: String(hour), v: format(value) });
    bar.setAttribute('aria-label', label);
    const fill = document.createElement('i');
    fill.style.height = `${(value / top) * 100}%`;
    // Read by the hover bubble through `attr()`, so the figure is drawn by the
    // page and not by the browser's own tooltip. It sits on the fill and not on
    // the column because `attr()` only reads the element the pseudo-element
    // hangs from, and the bubble has to ride the top of its own bar.
    fill.dataset.v = label;
    bar.append(fill);
    return bar;
  }));

  // One label in six: twenty four numbers side by side on a half page are a
  // grey smear, and the quarters of the day are what is actually read.
  hoursEl.replaceChildren(...values.map((_, hour) => {
    const label = document.createElement('span');
    label.textContent = hour % 6 === 0 ? String(hour) : '';
    return label;
  }));
}

function drawCharts(entries) {
  const withClock = entries.filter((e) => e.hasClock);
  const measured = withClock.filter((e) => e.watchedSec > 0);

  const counts = new Array(24).fill(0);
  const seconds = new Array(24).fill(0);
  for (const e of withClock) counts[new Date(e.watchedAt).getHours()]++;
  for (const e of measured) seconds[new Date(e.watchedAt).getHours()] += e.watchedSec;

  // The raw number and not `formatNumber`: an hour holds at most a few dozen
  // videos or sixty minutes, so there is nothing to group, and a formatted
  // string would come back as `NaN` from the plural selection.
  drawChart($('chart-count'), $('axis-count'), $('hours-count'), counts,
    (n) => t('jou.opened', { n }));
  drawChart($('chart-time'), $('axis-time'), $('hours-time'), seconds.map((s) => Math.round(s / 60)),
    (n) => t('jou.minutes', { n }));

  $('chart-count-note').textContent = t('jou.chart.count.on', {
    n: formatNumber(withClock.length), total: formatNumber(entries.length),
  });
  $('chart-time-note').textContent = t('jou.chart.time.on', {
    n: formatNumber(measured.length), total: formatNumber(entries.length),
  });
}

/**
 * The one sentence that says what the day's figures rest on.
 *
 * "Of 10 videos whose length is known, 2 h 18 watched out of 8 h 05, that is
 * 29 %." The videos whose length is unknown are named at the end rather than
 * left out silently: they are the ones no percentage can speak for.
 */
function drawCoverage(summary) {
  const c = summary.coverage;
  const el = $('day-coverage');

  if (!c?.videos) {
    // A day made only of videos of unknown length: the sentence would have no
    // figures at all, so it says the one thing there is to say.
    el.textContent = c?.unknown ? t('jou.cov.none', { n: formatNumber(c.unknown) }) : '';
    return;
  }

  const main = t('jou.cov', {
    n: formatNumber(c.videos),
    watched: formatDuration(Math.round(c.watched)),
    total: formatDuration(Math.round(c.seconds)),
    pct: percent(c.seconds ? c.watched / c.seconds : 0),
  });

  el.textContent = c.unknown
    ? `${main} ${t('jou.cov.rest', { n: formatNumber(c.unknown) })}`
    : main;
}

/**
 * One row.
 *
 * Three lines, in decreasing order of what is looked for: the title, the
 * channel, then the figures. The measured time opens that third line and is the
 * only bold thing on it — it used to sit third in a grey run beginning with the
 * launch time, and the two were read for one another.
 */
function dayRow(e) {
  const watch = `https://www.youtube.com/watch?v=${e.videoId}`;
  const item = document.createElement('article');
  item.className = 'day-item';

  const thumb = document.createElement('a');
  thumb.className = 'day-thumb';
  thumb.href = watch;
  thumb.target = '_blank';
  thumb.rel = 'noreferrer';

  const img = document.createElement('img');
  img.src = `https://i.ytimg.com/vi/${e.videoId}/mqdefault.jpg`;
  img.alt = '';
  img.loading = 'lazy';
  // A deleted or private video has no thumbnail. The frame stays and stays
  // empty, rather than showing the browser's broken image icon.
  img.addEventListener('error', () => img.remove());
  thumb.append(img);

  if (e.progress !== null) {
    const bar = document.createElement('span');
    bar.className = 'day-bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(e.progress * 100)}%`;
    bar.append(fill);
    thumb.append(bar);
  }

  const body = document.createElement('div');
  body.className = 'day-body';

  const title = document.createElement('a');
  title.className = 'day-name';
  title.href = watch;
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.textContent = e.title || e.videoId;
  body.append(title);

  const channel = document.createElement('p');
  channel.className = 'day-channel';
  if (e.channelId) {
    const link = document.createElement('a');
    link.href = `history.html#chaine=${e.channelId}`;
    link.textContent = e.channelTitle || e.channelId;
    channel.append(link);
  } else {
    channel.append(document.createTextNode(e.channelTitle || t('jou.nochannel')));
  }
  // The channel's habit, and it says over what: read on the day alone, a channel
  // seen once would announce a hundred percent.
  if (e.channelShare !== null) {
    channel.append(document.createTextNode(' · '));
    channel.append(document.createTextNode(
      t('jou.chshare', { pct: percent(e.channelShare) })));
  }
  body.append(channel);

  const figures = document.createElement('p');
  figures.className = 'day-figures';
  const sep = () => {
    const s = document.createElement('span');
    s.className = 'sep';
    s.textContent = '·';
    return s;
  };
  const dim = (text) => {
    const s = document.createElement('span');
    s.className = 'dim';
    s.textContent = text;
    return s;
  };

  if (e.watchedSec && e.durationSec) {
    const strong = document.createElement('b');
    strong.textContent = shortDuration(e.watchedSec);
    figures.append(strong, document.createTextNode(
      t('jou.of', { total: shortDuration(e.durationSec), pct: percent(e.progress) })));
  } else if (e.watchedSec) {
    const strong = document.createElement('b');
    strong.textContent = shortDuration(e.watchedSec);
    figures.append(strong, document.createTextNode(t('jou.watchedonly')));
  } else if (e.durationSec) {
    figures.append(dim(t('jou.length', { total: shortDuration(e.durationSec) })));
  } else {
    figures.append(dim(t('jou.nolength')));
  }

  figures.append(sep());
  figures.append(dim(e.hasClock ? t('jou.at', { time: clock(e.watchedAt) }) : t('jou.noclock')));
  body.append(figures);

  const tags = document.createElement('p');
  tags.className = 'day-tags';
  const tag = (text, cls = '') => {
    const span = document.createElement('span');
    span.className = cls ? `day-tag ${cls}` : 'day-tag';
    span.textContent = text;
    tags.append(span);
  };

  tag(t(`jou.src.${e.source}`), `src-${e.source}`);
  // "Finished" and "marked watched" said the same thing twice: the feed marks a
  // video watched from the measurement that also sets this flag.
  if (e.completed) tag(t('jou.done'), 'ok');
  if (e.unresolved) tag(t('jou.gone'), 'warn');
  if (!e.exactDuration && e.durationSec) tag(t('jou.mean'), 'warn');
  if (e.feed?.hidden) tag(t('jou.hidden'));
  if (e.feed?.starred) tag(t('jou.starred'));
  if (!e.feed) tag(t('jou.outoffeed'));
  body.append(tags);

  item.append(thumb, body);
  return item;
}

function drawList(entries) {
  $('day-list').replaceChildren(...sorted(entries).map(dayRow));
}

async function showDay(key) {
  openDay = key;
  const { from, to } = dayBounds(key);
  $('day-date').value = key;
  $('day-title').textContent = longDate(from);

  busy(true);
  const res = await send(MSG.HISTORY_DAY, { from, to });
  busy(false);

  // A reply arriving after one has moved on must not be shown: two quick steps
  // leave in order and can come back in any order at all.
  if (openDay !== key || !res?.ok) return;

  current = res;
  const { entries, summary } = res;

  $('day-prev').disabled = !Number.isFinite(res.previous);
  $('day-next').disabled = !Number.isFinite(res.next);

  $('day-count').textContent = formatNumber(summary.total);
  $('day-channels').textContent = formatNumber(summary.channels);
  $('day-hours').textContent = summary.measuredSeconds
    ? formatDuration(Math.round(summary.measuredSeconds)) : '—';

  drawCoverage(summary);

  $('day-empty').hidden = summary.total > 0;
  $('charts').hidden = summary.total === 0;
  $('sorts').hidden = summary.total === 0;

  if (summary.total) {
    drawCharts(entries);
    drawList(entries);
  } else {
    $('day-list').replaceChildren();
  }
}

function router() {
  const key = /^#jour=(\d{4}-\d{2}-\d{2})$/.exec(location.hash)?.[1];
  if (key) showDay(key);
}

window.addEventListener('hashchange', router);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
//
// With no day in the address, the page opens on the most recent day that holds
// something rather than on today: someone whose last viewing is a week old
// would otherwise land on an empty screen and read it as a broken page.
(async function start() {
  await initLocale();
  document.documentElement.lang = getLocale();
  translateDom();
  updateSortButtons();

  if (!/^#jour=\d{4}-\d{2}-\d{2}$/.test(location.hash)) {
    const res = await send(MSG.HISTORY_SUMMARY);
    const last = res?.summary?.to;
    location.hash = `jour=${dayKey(Number.isFinite(last) ? last : Date.now())}`;
  }

  $('startup').hidden = true;
  $('page').hidden = false;
  router();

  // The language can change from the popup while this page is open.
  chrome.storage.onChanged.addListener(async (changes, zone) => {
    if (zone !== 'local' || !changes[LANG_KEY]) return;
    await initLocale();
    translateDom();
    updateSortButtons();
    if (current) { $('day-title').textContent = longDate(current.from); drawList(current.entries); drawCharts(current.entries); }
  });
})();
