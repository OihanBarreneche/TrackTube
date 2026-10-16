/**
 * Popup: three modes, one main action per mode, everything else under the cog.
 *
 * The old version showed everything at once — import, synchronisation, triage,
 * filters, API key, backup, audit — each with its own paragraph of
 * explanation. That was a debugging console, not an interface. Splitting it
 * into modes matches what the extension actually does: repair the feed, sort
 * the subscriptions, and later analyse the history.
 */

import { MSG, send } from '../lib/messages.js';
import { UI_SNAPSHOT } from '../lib/ui-snapshot.js';
import { formatAuditReport, formatReverseAuditReport } from '../lib/audit-format.js';
import { parseSubscriptionsCsv } from '../lib/subscriptions-csv.js';
import { t, initLocale, saveLocale, getLocale, LOCALES, bcp47 } from '../lib/i18n.js';
import { translateDom } from '../lib/i18n-dom.js';

const $ = (id) => document.getElementById(id);

/** Shared reporting area, inside the settings panel. */
function report(text, id = 'report') {
  const el = $(id);
  el.hidden = false;
  el.textContent = text;
  el.scrollIntoView({ block: 'nearest' });
}

/** The backup block answers under itself, not at the foot of the panel. */
const reportBackup = (text) => report(text, 'backup-report');

/**
 * Wraps a click handler so that no error goes unnoticed. Without this, an
 * exception inside an `async` handler ends up as an unhandled rejection and the
 * button looks like it does nothing.
 */
function onClick(buttonId, fn) {
  const button = $(buttonId);
  if (!button) { console.error(`[tracktube] button not found: ${buttonId}`); return; }

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await fn({ button });
    } catch (err) {
      console.error('[tracktube]', err);
      report(t('pop.err.unexpected', { error: err?.message ?? err }));
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const MODES = ['feed', 'history', 'triage'];

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

/**
 * The language is a setting, not a property of the browser.
 *
 * `chrome.i18n` would follow Chrome's language with no way to change it:
 * someone whose browser is in English would have no way to put their feed in
 * French. Hence the in house catalogue of `lib/i18n.js`, and this selector.
 *
 * The change applies immediately in open tabs, through the storage listener on
 * the feed side.
 */
async function initLanguage() {
  await initLocale();
  $('set-lang').value = getLocale();
}

$('set-lang').addEventListener('change', async (e) => {
  const code = LOCALES.includes(e.target.value) ? e.target.value : 'fr';
  await saveLocale(code);
  retranslate();
  // No confirmation line. The whole window changes language under the cursor,
  // which says it better than a sentence — and `report()` scrolls its own
  // element into view: since that element sits at the very bottom of the
  // settings sheet, saying "language saved" threw the panel down to the
  // bottom and one had to scroll back up to where one was.
});

/**
 * Puts the whole popup back into the current language.
 *
 * The markup covers the delivered document; the rest is rebuilt by the display
 * functions, all of which a `refresh()` calls again. Without it, changing
 * language would leave the figures and the button labels behind.
 */
function retranslate() {
  document.documentElement.lang = getLocale();
  translateDom();
  showPulse();
  refreshPulse().catch(() => {});
  refresh().catch(() => {});
}

function showMode(mode) {
  for (const name of MODES) $(`mode-${name}`).hidden = name !== mode;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.mode === mode);
    tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  // Switching tabs closes whichever panel is open. Without this, clicking
  // "History" from the settings left the settings on screen: the bottom tab
  // changed state without anything else moving, and the click felt lost. We
  // come looking for the tab's home, not for the same sheet.
  tab.addEventListener('click', () => { openPanel(null); showMode(tab.dataset.mode); });
}

// The two panels are mutually exclusive: opening the help over the settings
// would leave no way of telling which one is being closed.
let panelReturnFocus = null;
function openPanel(name) {
  if (name && !panelReturnFocus) panelReturnFocus = document.activeElement;
  $('settings').hidden = name !== 'settings';
  $('docs').hidden = name !== 'docs';
  for (const mode of MODES) $(`mode-${mode}`).inert = Boolean(name);
  document.querySelector('body > header').inert = Boolean(name);
  if (name) $(name).querySelector('button')?.focus();
  else { panelReturnFocus?.focus(); panelReturnFocus = null; }
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && (!$('settings').hidden || !$('docs').hidden)) openPanel(null);
});

$('btn-settings').addEventListener('click', () => openPanel('settings'));
$('btn-settings-close').addEventListener('click', () => openPanel(null));
$('btn-docs').addEventListener('click', () => openPanel('docs'));
$('btn-docs-close').addEventListener('click', () => openPanel(null));

// ---------------------------------------------------------------------------
// Service worker kept awake
// ---------------------------------------------------------------------------

/** Real messages on the port keep a long manual operation active. Merely
 *  opening the port does not reset Chrome's service worker idle timer. */
let keepAlive = null;
let keepAliveTimer = null;
const holdServiceWorkerAwake = () => {
  keepAlive ??= chrome.runtime.connect({ name: 'ytfeed:keepalive' });
  keepAliveTimer ??= setInterval(() => { try { keepAlive?.postMessage({ ping: true }); } catch {} }, 20_000);
};
const releaseServiceWorker = () => {
  clearInterval(keepAliveTimer); keepAliveTimer = null;
  keepAlive?.disconnect(); keepAlive = null;
};

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

async function refresh() {
  const res = await send(MSG.SYNC_STATE);
  if (!res.ok) { $('footer').textContent = t('pop.err.worker', { error: t(res.error) }); return; }

  paintState(res);
  refreshFeedCounts().catch(() => {});
  refreshTriage(res.stats.activeChannels ?? 0).catch(() => {});
}

function paintState(res) {
  const { state, stats, cost, cadence, harvest, lastHarvest, channelWindow } = res;
  const subscriptions = stats.activeChannels ?? 0;

  // The count stays hidden as long as there is nothing to count: a "0
  // subscriptions" against the title says nothing the import page just below
  // does not already say.
  $('stat-channels').textContent = t('pop.channels', { n: subscriptions });
  $('stat-channels').hidden = subscriptions === 0;
  updateDependencies();

  // The number of hidden videos counted work already done; what is missing is
  // what has arrived since yesterday and the views one actually goes to.
  // With no subscription, only one thing makes sense: importing some. Offering
  // to open an empty feed, or to synchronise nothing, leads nowhere.
  $('onboarding').hidden = subscriptions > 0;
  $('feed-ready').hidden = subscriptions === 0;

  $('sync-line').textContent = state.lastTickAt
    ? t('pop.sync.last', {
      time: new Date(state.lastTickAt).toLocaleTimeString(bcp47(), { hour: '2-digit', minute: '2-digit' }),
    })
    : t('pop.sync.never');

  if (state.uulfAlarm?.raised) {
    const alarm = $('alarm');
    alarm.hidden = false;
    alarm.textContent = t('pop.alarm.uulf');
  }

  updateCadence(cadence, cost);

  // The technical detail goes down into the diagnostics: useful to understand
  // an anomaly, beside the point the rest of the time.
  const lines = [];
  // First, because it is the figure that was missing when a bad subscription
  // read left 116 channels active out of 592 real subscriptions, and the feed
  // simply went quiet.
  // Followed against known is the one glance that shows it.
  lines.push(t('diag.channels', {
    active: stats.activeChannels ?? 0, total: stats.channelCount ?? 0,
  }));
  // And when that followed count was last compared with YouTube's own list,
  // because nothing else switches a channel off. "Never" is the answer that
  // explains a feed full of channels the reader left, and it is the one nobody
  // could read anywhere before 1.4.3.
  lines.push(stats.lastListAt
    ? t('diag.subsList', {
      n: stats.lastListSize ?? 0,
      date: new Date(stats.lastListAt).toLocaleString(bcp47(), { dateStyle: 'short', timeStyle: 'short' }),
    })
    : t('diag.subsList.never'));
  lines.push(channelWindow ? t('diag.channelWindow', {
    days: channelWindow.windowDays ?? 7, checked: channelWindow.checked ?? 0, total: channelWindow.total ?? 0,
    date: new Date(channelWindow.at).toLocaleString(bcp47(), { dateStyle: 'short', timeStyle: 'short' }),
    status: t(channelWindow.partial ? 'diag.channelWindow.partial' : 'diag.channelWindow.complete'),
  }) : t('diag.channelWindow.never'));
  lines.push(harvest
    ? t('diag.harvest', {
      n: harvest.count,
      date: new Date(harvest.oldestPublishedAt).toLocaleDateString(bcp47()),
    })
    : t('diag.harvest.never'));
  if (lastHarvest) {
    // Zero links read is its own diagnosis and deserves saying so plainly: the
    // page was there and nothing was extracted, which is a broken reader, not
    // an empty feed. It is how a whole collection source went unnoticed.
    lines.push(lastHarvest.linksFound ? t('diag.harvest.last', {
      links: lastHarvest.linksFound,
      enriched: lastHarvest.enrichedByPolymer,
    }) : t('diag.harvest.blind'));
    if (lastHarvest.created) {
      lines.push(t('diag.harvest.created', {
        n: lastHarvest.created.inserted ?? 0,
        deferred: lastHarvest.created.deferred ?? 0,
        shorts: lastHarvest.created.shorts ?? 0,
      }));
    }
  }
  if (state.rateLimitedUntil > Date.now()) {
    lines.push(t('diag.paused', {
      time: new Date(state.rateLimitedUntil).toLocaleTimeString(bcp47()),
    }));
  }
  if (cost?.requestsPerDay) {
    lines.push(t('diag.cost', {
      n: cost.requestsPerDay,
      mb: (cost.bytesPerDay / 1e6).toFixed(0),
    }));
  }
  $('footer').textContent = lines.join('\n');
}

/**
 * The last figures known, kept so the tab is never blank.
 *
 * `HISTORY_SUMMARY` reads every measured session to date: measured on a store
 * of fifty seven thousand rows, that pass alone costs about 700 ms, and the
 * service worker is usually cold on top of it — it is killed after some thirty
 * seconds idle, so nearly every popup opening pays for its start. The tab
 * showed two dashes for several seconds and looked broken.
 *
 * The key is written by the **worker**, on every answer it gives, and not by
 * this page: it must be there even for a popup that was closed before its
 * refresh finished. Nothing about those two figures needs to be to the second —
 * they are a volume and a span — so the last known values are drawn at once and
 * replaced when the fresh answer lands.
 */

/** Draws the two counters and the tracked line. Shared by the cache and the reply. */
function paintHistory(res) {
  const s = res?.summary;
  // The figures pulse until something real is known. Two dashes alone said
  // "nothing to show" when they meant "not read yet".
  $('hist-stats').classList.remove('loading');
  updateTracked(res);

  if (!s?.count) {
    $('hist-count').textContent = '0';
    $('hist-span').textContent = '—';
    $('btn-history').textContent = t('pop.hist.import');
    return;
  }

  const days = Math.max(1, Math.round((s.to - s.from) / 86_400_000));
  $('hist-count').textContent = new Intl.NumberFormat(bcp47()).format(s.count);
  $('hist-span').textContent = spanText(days);
  $('btn-history').textContent = t('pop.hist.btn');
}

/** Volume and span of the imported history, without opening the page. */
async function refreshHistory() {
  const res = await send(MSG.HISTORY_SUMMARY);

  // A failed call must not turn a real history into a zero. What was cached
  // stays on screen; with nothing cached, the empty state is drawn so the
  // figures stop pulsing on a wait that will not end.
  if (!res?.ok) {
    if (!$('hist-stats').classList.contains('loading')) return;
    paintHistory(null);
    return;
  }

  paintHistory(res);
}

/**
 * The span of the history, said the way one says it out loud.
 *
 * "2.6 years" asks for a mental conversion only to teach nothing more than "2
 * years 7 months". Under a month the count stays in days: at that scale it is
 * the day that makes the difference.
 *
 * @param {number} days
 */
function spanText(days) {
  if (days < 31) return t('pop.hist.days', { n: days });

  const months = Math.round(days / 30.44);
  const years = Math.floor(months / 12);
  const rest = months % 12;

  if (!years) return t('pop.hist.months', { n: months });
  if (!rest) return t('pop.hist.years', { n: years });
  return t('pop.hist.ym', { a: years, m: rest });
}

/**
 * What the extension has tracked on its own.
 *
 * This line replaces the old "from a Takeout export" mention, which became
 * false with the very first measured video: from then on there are two sources,
 * and the one that grows by itself is the more precise of the two.
 */
function updateTracked(res) {
  const n = res?.liveSessions ?? 0;
  const since = res?.liveSince ?? 0;

  if (!n || !since) {
    $('hist-measured').textContent = t('pop.releve.none');
    return;
  }

  const date = new Date(since).toLocaleDateString(bcp47(),
    { day: 'numeric', month: 'long', year: 'numeric' });
  $('hist-measured').textContent = t('pop.releve.since', {
    n: new Intl.NumberFormat(bcp47()).format(n),
    date,
  });
}

/**
 * The numbered highlights at the bottom of the Triage and History tabs.
 *
 * One at a time, drawn at random on opening, and a click moves to the next.
 * Showing them all would make one more dashboard; showing a single one,
 * different from one time to the next, gives a reason to come back.
 */
const highlights = { 'acc-hist': [] };
const highlightIndex = { 'acc-hist': 0 };

async function refreshHighlights() {
  const res = await send(MSG.POPUP_HIGHLIGHTS);
  if (!res?.ok) return;
  paintHighlights(res);
}

function paintHighlights(res) {
  setTriageFigures(res.triage);
  setHighlights('acc-hist', res.history ?? []);
}

/**
 * The four figures at the bottom of the Triage tab.
 *
 * "Never watched" may be `null`: on a fresh install no channel has any tracked
 * viewing yet and the number would describe the extension, not the
 * subscriptions. A dash is more honest than the total.
 */
function setTriageFigures(triage) {
  if (!triage) return;
  const nf = new Intl.NumberFormat(bcp47());
  for (const [id, n] of [
    ['triage-week', triage.perWeek], ['triage-silent', triage.silent],
    ['triage-never', triage.neverWatched], ['triage-hidden', triage.mostlyHidden],
  ]) {
    $(id).textContent = typeof n === 'number' ? nf.format(n) : '—';
  }
}

function setHighlights(id, list) {
  highlights[id] = list;
  highlightIndex[id] = list.length ? Math.floor(Math.random() * list.length) : 0;
  showHighlight(id);
}

function showHighlight(id) {
  const el = $(id);
  const a = highlights[id][highlightIndex[id]];
  el.hidden = !a;
  if (!a) return;

  el.querySelector('b').textContent = new Intl.NumberFormat(bcp47()).format(a.n);
  el.querySelector('span').textContent = t(a.key, {
    n: a.n,
    text: a.text ?? '',
    hour: a.hour ?? 0,
    next: ((a.hour ?? 0) + 1) % 24,
    date: a.at
      ? new Date(a.at).toLocaleDateString(bcp47(), { day: 'numeric', month: 'long', year: 'numeric' })
      : '',
  });
  // A lone highlight is not something one leafs through: the cursor must not
  // promise a second figure that does not exist.
  el.style.cursor = highlights[id].length > 1 ? 'pointer' : 'default';
}

for (const id of Object.keys(highlights)) {
  $(id).addEventListener('click', () => {
    if (highlights[id].length < 2) return;
    highlightIndex[id] = (highlightIndex[id] + 1) % highlights[id].length;
    showHighlight(id);
  });
}

/** Triage progress, so the tab says where one stands without opening it. */
async function refreshTriage(total) {
  const res = await send(MSG.TRIAGE_PROGRESS, {});
  const sorted = Object.keys(res?.progress?.decided ?? {}).length;

  $('triage-done').textContent = sorted;
  $('triage-left').textContent = Math.max(0, total - sorted);
  $('btn-triage').textContent = t(sorted ? 'pop.triage.resume' : 'pop.triage.btn');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Starts the import inside a YouTube tab.
 *
 * A tab opened before the extension was installed — or reloaded — has no active
 * script: the message never reaches it. That is the most common case right
 * after an installation, and the failure went unnoticed, leaving the impression
 * that the button did nothing.
 */
async function startImport() {
  await chrome.storage.local.set({ 'ytfeed:pendingImport': true });
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });

  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.RUN_IMPORT });
      await chrome.storage.local.remove('ytfeed:pendingImport');
      await chrome.tabs.update(tab.id, { active: true });
      window.close();
      return;
    } catch { /* tab with no active script: try the next one */ }
  }

  await chrome.tabs.create({ url: 'https://www.youtube.com/feed/subscriptions' });
  setTimeout(() => window.close(), 800);
}

onClick('btn-import', startImport);
onClick('btn-reimport', startImport);

/**
 * Feed view counts, on the shortcuts.
 *
 * An empty view has no business being offered: the button disables itself
 * rather than opening a screen with nothing to see.
 */
async function refreshFeedCounts() {
  const res = await send(MSG.GET_FEED_COUNTS, { periods: [1, 7, 30], withViews: true });
  if (!res.ok) return;

  paintFeedCounts(res);
}

function paintFeedCounts(res) {
  const { byPeriod, starred, inProgress, hidden } = res.counts;
  $('stat-day').textContent = byPeriod[1] ?? 0;
  $('stat-week').textContent = byPeriod[7] ?? 0;
  $('stat-month').textContent = byPeriod[30] ?? 0;

  const views = { starred, inprogress: inProgress, hidden };
  for (const [view, n] of Object.entries(views)) {
    $(`short-${view}`).textContent = n ?? 0;
    $(`short-${view}`).closest('.shortcut').disabled = !n;
  }
}

// ---------------------------------------------------------------------------
// Pulse carousel
// ---------------------------------------------------------------------------

/**
 * Three views of the published volume, leafable.
 *
 * Nothing here helps decide anything: this is the bottom of the window, which
 * was empty, and a figure one looks at is better than a blank. The data comes
 * from a single thirty day scan on the service worker side.
 */
const PULSE_VIEWS = [
  { title: 'pulse.perday', render: renderPulseDays },
  { title: 'pulse.top7', render: (p) => renderPulseTop(p.topWeek) },
  { title: 'pulse.top30', render: (p) => renderPulseTop(p.topMonth) },
];

let pulseIndex = 0;
let pulseData = null;

/** Day initials taken from the current language, rather than a frozen table. */
function shortDay(date) {
  return date.toLocaleDateString(bcp47(), { weekday: 'short' }).replace('.', '');
}

/**
 * Histogram of the last seven days, bars proportional to the maximum.
 *
 * The bar is placed absolutely inside a track, and not stacked with the figure
 * and the day initial: as a flex item it got shaved by `flex-shrink` as soon as
 * its height exceeded the remaining room, so that everything above two thirds
 * rendered at the same height.
 */
function renderPulseDays(pulse) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    days.push({ label: shortDay(d), n: pulse.perDay[key] ?? 0 });
  }

  // A maximum of at least 1: without it, an empty week would divide by zero and
  // the bars would go NaN.
  const max = Math.max(1, ...days.map((j) => j.n));

  const block = document.createElement('div');
  block.className = 'bars';
  for (const day of days) {
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.innerHTML = `<b>${day.n}</b>`
      + `<span class="bar-track"><i style="height:${Math.round((day.n / max) * 100)}%"></i></span>`
      + `<span class="bar-day">${day.label}</span>`;
    block.append(col);
  }
  return block;
}

/** Channel ranking, horizontal bars. */
function renderPulseTop(list) {
  if (!list?.length) {
    const empty = document.createElement('p');
    empty.className = 'hint centered';
    empty.textContent = t('pulse.empty');
    return empty;
  }

  const max = Math.max(...list.map((e) => e.count));
  const block = document.createElement('div');
  block.className = 'rank';
  for (const entry of list) {
    const row = document.createElement('div');
    row.className = 'rank-row';
    row.innerHTML = `<span class="rank-name"></span>`
      + `<i style="width:${Math.round((entry.count / max) * 100)}%"></i>`
      + `<b>${entry.count}</b>`;
    // The title comes from YouTube: set as text, never as HTML.
    row.querySelector('.rank-name').textContent = entry.title || t('hist.ch.unknown');
    block.append(row);
  }
  return block;
}

function showPulse() {
  const view = PULSE_VIEWS[pulseIndex];
  $('pulse-title').textContent = t(view.title);
  $('pulse-body').replaceChildren(pulseData ? view.render(pulseData) : document.createTextNode(''));
}

async function refreshPulse() {
  const res = await send(MSG.GET_FEED_PULSE, { days: 30 });
  // A failed call leaves the figures of the previous opening in place: they say
  // more than an empty carousel.
  if (!res.ok) { if (!pulseData) $('pulse').hidden = true; return; }
  pulseData = res.pulse;
  $('pulse').hidden = false;
  showPulse();
}

const flip = (step) => {
  pulseIndex = (pulseIndex + step + PULSE_VIEWS.length) % PULSE_VIEWS.length;
  showPulse();
};

$('pulse-prev').addEventListener('click', () => flip(-1));
$('pulse-next').addEventListener('click', () => flip(1));

/**
 * Opens the feed, possibly straight onto one of its views.
 *
 * The view travels through the URL fragment: that is the only way to aim at an
 * already open tab without reloading it — the feed listens to `hashchange` and
 * switches in place.
 */
async function openFeed(view = null) {
  const base = 'https://www.youtube.com/feed/subscriptions';
  const url = view ? `${base}#ytfeed=${view}` : base;

  const [tab] = await chrome.tabs.query({ url: '*://www.youtube.com/feed/subscriptions*' });
  if (tab) await chrome.tabs.update(tab.id, { active: true, url });
  else await chrome.tabs.create({ url });
  window.close();
}

for (const button of document.querySelectorAll('.shortcut')) {
  button.addEventListener('click', () => openFeed(button.dataset.view));
}

for (const button of document.querySelectorAll('[data-opens-feed]')) {
  button.addEventListener('click', () => openFeed());
}

onClick('btn-onboarding', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  window.close();
});

onClick('btn-history', async () => {
  // A full page rather than the popup: a channel ranking and two histograms do
  // not fit in 320 pixels.
  await chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  window.close();
});

onClick('btn-journal', async () => {
  // The day is computed here, in a page that knows the reader's timezone, and
  // travels as a date rather than as an instant: the journal reads it as a
  // local day, and an instant would have to be converted twice.
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await chrome.tabs.create({ url: chrome.runtime.getURL(`journal.html#jour=${day}`) });
  window.close();
});

onClick('btn-triage', async () => {
  // Triage opens over /feed/channels, the natural page for it.
  await chrome.storage.local.set({ 'ytfeed:pendingTriage': true });
  await chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels' });
  window.close();
});

let syncProgressId = null;
let syncProgressPct = 0;
let syncCompletion = null;

function waitForSyncCompletion(progressId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('pop.sync.timeout'))), 180_000);
    syncCompletion = { progressId, resolve, timer };
  });
}

onClick('btn-sync', async ({ button }) => {
  const progress = $('progress');
  syncProgressId = crypto.randomUUID();
  syncProgressPct = 0;
  button.textContent = t('pop.sync.running');
  progress.hidden = false;
  progress.querySelector('.label').textContent = t('pop.sync.starting');

  holdServiceWorkerAwake();
  try {
    const completion = waitForSyncCompletion(syncProgressId);
    completion.catch(() => {});
    const res = await send(MSG.SYNC_NOW, { quick: true, full: true, progressId: syncProgressId });
    if (!res.ok) { report(t('pop.sync.failed', { error: t(res.error) })); return; }
    const finished = res.result?.started ? await completion : null;
    if (finished?.failed) { report(t('pop.sync.failed', { error: t(finished.error) })); return; }
    const r = finished?.result ?? res.result ?? {};
    const partial = finished?.partial || r.directUnavailable || r.errors || r.deferred || r.aborted;
    progress.querySelector('.label').textContent = t(partial ? 'pop.sync.partial' : 'pop.sync.result',
      { checked: r.checked ?? 0, inserted: r.inserted ?? 0 });
  } finally {
    clearTimeout(syncCompletion?.timer); syncCompletion = null;
    syncProgressId = null;
    releaseServiceWorker();
    button.textContent = t('set.resync');
    await refresh();
  }
});

$('csv-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = ''; // lets the same file be imported again
  if (!file) return;

  report(t('pop.file.reading', { name: file.name }));
  try {
    const { channels, skipped } = parseSubscriptionsCsv(await file.text());
    if (!channels.length) {
      report(t('pop.csv.none', { n: skipped }));
      return;
    }

    const res = await send(MSG.IMPORT_SUBSCRIPTIONS, { channels });
    if (!res.ok) { report(t('pop.csv.failed', { error: t(res.error) })); return; }

    const r = res.result ?? {};
    report(t('pop.csv.done', {
      n: channels.length,
      added: r.added ?? 0,
      known: r.updated ?? 0,
      off: r.deactivated ?? 0,
    }));
    await refresh();
  } catch (err) {
    console.error('[tracktube]', err);
    report(t('pop.file.unreadable', { error: err?.message ?? err }));
  }
});

/**
 * Prepares applying a list to the account.
 *
 * The popup only reads the file and opens the screen: the calls to YouTube go
 * out from a tab, which alone has the session. Nothing is applied here, and the
 * file dropped in storage only becomes an action after confirmation in that
 * screen.
 */
$('batch-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  report(t('pop.file.reading', { name: file.name }));
  try {
    const { channels, skipped } = parseSubscriptionsCsv(await file.text());
    if (!channels.length) {
      report(t('pop.lot.none', { n: skipped }));
      return;
    }

    await chrome.storage.local.set({
      'ytfeed:lotFichier': { nom: file.name, channels, skipped },
      'ytfeed:pendingLot': true,
    });
    await chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels' });
    window.close();
  } catch (err) {
    console.error('[tracktube]', err);
    report(t('pop.file.unreadable', { error: err?.message ?? err }));
  }
});

onClick('btn-export', async () => {
  reportBackup(t('pop.export.preparing'));
  holdServiceWorkerAwake();
  let res;
  try {
    res = await send(MSG.EXPORT_DATA);
  } finally {
    releaseServiceWorker();
  }
  if (!res.ok) { reportBackup(t('pop.failed', { error: t(res.error) })); return; }

  const { channels, videos, history, durations } = res.data;
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(res.data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // A link rather than `chrome.downloads`, which is what the triage, the
  // analysis page and the retrospective already do: it needs no permission, and
  // `downloads` was in the manifest for this one call.
  const link = document.createElement('a');
  link.href = url;
  link.download = `tracktube-sauvegarde-${stamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // The URL must outlive the start of the download, hence the delay.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  reportBackup(t('pop.export.done', {
    channels: channels.length,
    states: videos.length,
    history: history.length,
    durations: durations.length,
    // Megabytes now: a backup that carries the history is no longer counted in
    // kilobytes, and "4212 ko" says nothing to anyone.
    mb: (blob.size / 1048576).toFixed(1),
  }));
});

$('restore-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  const bar = $('restore-progress');
  reportBackup(t('pop.file.reading', { name: file.name }));

  try {
    const data = JSON.parse(await file.text());

    bar.hidden = false;
    bar.querySelector('.bar i').style.width = '0%';
    bar.querySelector('.label').textContent = t('pop.restore.starting');

    // A restore writes tens of thousands of records: without this the worker
    // can be killed halfway, and the answer that never comes back looks like a
    // restore that finished.
    holdServiceWorkerAwake();
    let res;
    try {
      res = await send(MSG.IMPORT_DATA, {
        data, withSettings: $('restore-settings').checked,
      });
    } finally {
      releaseServiceWorker();
    }
    if (!res.ok) {
      bar.hidden = true;
      reportBackup(t('pop.failed', { error: t(res.error) }));
      return;
    }

    const r = res.result ?? {};
    bar.querySelector('.bar i').style.width = '100%';
    bar.querySelector('.label').textContent = t('pop.restore.finished');

    const lines = [t('pop.restore.done', {
      channels: r.channels ?? 0,
      videos: (r.videos ?? 0) + (r.created ?? 0),
      history: r.history ?? 0,
      durations: r.durations ?? 0,
    })];
    // A version 1 file cannot restore what it never held. Saying so is the
    // difference between a restore that failed and a backup that was partial.
    if (r.version === 1) lines.push(t('pop.restore.old'));
    if (r.settings) lines.push(t('pop.restore.settings'));
    if (r.pending) lines.push(t('pop.restore.deferred', { n: r.pending }));
    lines.push(t('pop.restore.reload'));

    reportBackup(lines.join('\n\n'));
    await refresh();
  } catch (err) {
    console.error('[tracktube]', err);
    bar.hidden = true;
    reportBackup(t('pop.file.badjson', { error: err?.message ?? err }));
  }
});

onClick('btn-audit', async () => {
  report(t('pop.audit.running'));
  const res = await send(MSG.AUDIT_RUN, { windowDays: Number($('audit-window').value) || 2 });
  report(res.ok ? formatAuditReport(res.report) : t('pop.failed', { error: t(res.error) }));
});

onClick('btn-audit-reverse', async () => {
  report(t('pop.audit.running'));
  const res = await send(MSG.AUDIT_REVERSE_RUN, { windowDays: Number($('audit-window').value) || 2 });
  report(res.ok ? formatReverseAuditReport(res.report) : t('pop.failed', { error: t(res.error) }));
});

// ---------------------------------------------------------------------------
// Feed settings
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'ytfeed:settings';

/**
 * The feed switch, at the top of the popup.
 *
 * It does not go through the field table: this is not a setting one goes
 * looking for in the options panel, it is the state of the extension. One wants
 * to be able to flip it without opening anything, and its effect is immediate
 * in open tabs, through the storage listener on the feed side.
 */
function updateToggle(enabled) {
  $('feed-toggle').setAttribute('aria-checked', enabled ? 'true' : 'false');
}

$('feed-toggle').addEventListener('click', async () => {
  const button = $('feed-toggle');
  const enabled = button.getAttribute('aria-checked') !== 'true';
  updateToggle(enabled);

  const settings = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] ?? {};
  settings.feedEnabled = enabled;
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  report(t(enabled ? 'pop.toggle.on' : 'pop.toggle.off'));
});

/**
 * Mapping between a setting and its control.
 *
 * A table rather than a hand written enumeration: this is exactly the kind of
 * list where one adds a field on one side and forgets the other — that bug has
 * already cost dearly on the feed options.
 */
const FIELDS = {
  hideWatched: { id: 'set-hide-watched', type: 'bool', fallback: false },
  liveHistory: { id: 'set-live-history', type: 'bool', fallback: false },
  watchedPercent: { id: 'set-watched-percent', type: 'int', fallback: 70 },
  inProgressMinSec: { id: 'set-inprogress-min', type: 'int', fallback: 60 },
  hideLives: { id: 'set-hide-lives', type: 'bool', fallback: false },
  hideReplays: { id: 'set-hide-replays', type: 'bool', fallback: false },
  hideUpcoming: { id: 'set-hide-upcoming', type: 'bool', fallback: false },
  alarmMinutes: { id: 'set-alarm-minutes', type: 'int', fallback: 3 },
  sweepMinutes: { id: 'set-sweep-minutes', type: 'int', fallback: 10 },
  slowDormant: { id: 'set-slow-dormant', type: 'bool', fallback: true },
  syncLives: { id: 'set-sync-lives', type: 'bool', fallback: true },
  bgSweep: { id: 'set-bg-sweep', type: 'bool', fallback: true },
  minDurationSec: { id: 'set-min-duration', type: 'int', fallback: 0 },
  maxAgeDays: { id: 'set-max-age', type: 'int', fallback: 0 },

  showHideButton: { id: 'set-show-hide-button', type: 'bool', fallback: true },
  showStarButton: { id: 'set-show-star-button', type: 'bool', fallback: true },
  showSelection: { id: 'set-show-selection', type: 'bool', fallback: true },
  showViewAll: { id: 'set-show-view-all', type: 'bool', fallback: true },
  showViewStarred: { id: 'set-show-view-starred', type: 'bool', fallback: true },
  showViewHidden: { id: 'set-show-view-hidden', type: 'bool', fallback: true },
  showViewInProgress: { id: 'set-show-view-inprogress', type: 'bool', fallback: true },
  showSearch: { id: 'set-show-search', type: 'bool', fallback: true },
  showColumns: { id: 'set-show-columns', type: 'bool', fallback: true },
  showPreview: { id: 'set-show-preview', type: 'bool', fallback: true },
};

async function loadSettingsIntoForm() {
  await initLanguage();

  const stored = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] ?? {};

  updateToggle(stored.feedEnabled ?? true);

  for (const [key, field] of Object.entries(FIELDS)) {
    const value = stored[key] ?? field.fallback;
    const el = $(field.id);
    if (field.type === 'bool') el.checked = Boolean(value);
    else el.value = String(value);
  }
  updateDependencies();
}

async function saveSettings() {
  // We start from storage rather than from a blank slate: `feedEnabled` lives
  // in the header, outside the form, and a full rebuild would wipe it on every
  // ticked box.
  const settings = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] ?? {};
  for (const [key, field] of Object.entries(FIELDS)) {
    const el = $(field.id);
    if (field.type === 'bool') settings[key] = el.checked;
    else if (field.type === 'text') settings[key] = el.value;
    else settings[key] = Number(el.value) || 0;
  }

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  updateDependencies();
  // The feed listens to storage: open tabs update on their own, without a
  // reload.
  //
  // No status message here. "Settings applied" showed up at the very bottom of
  // the panel, and `report` scrolls down to it: ticking a box at the top
  // teleported the view to the end of the list. The switch flipping already
  // says the setting was taken.
  //
  // The effective cadence has just been recomputed on the service worker side:
  // we read it back rather than guessing it here, so that the figure displayed
  // is exactly the one driving collection.
  refresh().catch(() => {});
}

/**
 * Settings that only make sense conditionally.
 *
 * A "watched" threshold means nothing without the removal of watched videos.
 */
function updateDependencies() {
  const watched = $('set-hide-watched').checked;
  $('row-watched-percent').style.opacity = watched ? '1' : '.45';
  $('set-watched-percent').disabled = !watched;
}

/**
 * What the collection setting gives concretely, in one line.
 *
 * The re-read period is self explanatory, but not what it costs: the volume
 * depends entirely on the number of subscriptions, which the user alone knows
 * and alone can judge acceptable.
 */
function updateCadence(cadence, cost) {
  const el = $('cadence-line');
  if (!el) return;
  if (!cadence?.channels) { el.textContent = ''; return; }

  // Three sentences rather than one enumeration: tacked onto the rest, "of
  // which N broadcast live" read as though live streams followed the median
  // cadence, whereas they are picked up as their own channel comes round.
  const lines = [t('cad.channels', { n: cadence.channels })];
  if (cadence.medianIntervalMs) {
    lines.push(t('cad.interval', { d: shortDuration(cadence.medianIntervalMs) }));
  }
  if (cost?.requestsPerDay) {
    lines.push(t('cad.cost', {
      n: cost.requestsPerDay,
      mb: (cost.bytesPerDay / 1e6).toFixed(0),
    }));
  }
  if (cadence.withLives) lines.push(t('cad.lives', { n: cadence.withLives }));

  el.textContent = lines.join(' ');
}

/** A duration in milliseconds, said the way one would say it out loud. */
function shortDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('dur.min', { n: minutes });
  const hours = minutes / 60;
  return t('dur.hour', {
    n: hours < 10 ? hours.toLocaleString(bcp47(), { maximumFractionDigits: 1 }) : Math.round(hours),
  });
}

for (const field of Object.values(FIELDS)) {
  $(field.id).addEventListener('change', saveSettings);
}

/**
 * The two extremes of the toolbar, in one click.
 *
 * "Hide everything" is the minimalist mode that was asked for: unticking the
 * nine boxes one by one to get there was an absurd gesture, and the bar tucks
 * itself away once empty, which raises the grid by that much.
 */
const showAll = (visible) => async () => {
  for (const [key, field] of Object.entries(FIELDS)) {
    if (key.startsWith('show')) $(field.id).checked = visible;
  }
  await saveSettings();
};

onClick('btn-hide-hud', showAll(false));
onClick('btn-reset-hud', showAll(true));

// Progress broadcast by the sync engine.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.RESTORE_PROGRESS) {
    const bar = $('restore-progress');
    if (bar.hidden) return;
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
    bar.querySelector('.bar i').style.width = `${pct}%`;
    // The step is named: on twenty thousand records, a bar that only moves says
    // nothing about what is being written.
    bar.querySelector('.label').textContent =
      `${t(`pop.restore.step.${msg.step}`)} ${msg.done}/${msg.total}`;
    return;
  }
  if (msg?.type !== MSG.SYNC_PROGRESS) return;
  const progress = $('progress');
  if (progress.hidden) return;
  if (msg.progressId !== syncProgressId) return;
  if (msg.finished && syncCompletion?.progressId === msg.progressId) {
    clearTimeout(syncCompletion.timer); syncCompletion.resolve(msg);
  }
  const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
  syncProgressPct = Math.max(syncProgressPct, pct);
  progress.querySelector('.bar i').style.width = `${syncProgressPct}%`;
  progress.querySelector('.label').textContent = `${msg.done}/${msg.total}`;
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// The popup always opens on the feed. Reopening the last visited tab brings us
// back days later on triage or history, whereas what one comes to see when
// opening the extension is the feed — the other two are detours one chooses
// each time.

// The version lives in both panels, where one looks for it when something is
// off, and not against the home title.
for (const el of document.querySelectorAll('.version')) {
  el.textContent = `v${chrome.runtime.getManifest().version}`;
}

// Everything displayed goes through the catalogue, including what `refresh()`
// builds: startup therefore waits for the saved language to be read. Without
// that wait, the first opening would be written in the browser's language then
// correct itself before one's eyes.
Promise.all([
  loadSettingsIntoForm(),
  chrome.storage.local.get(Object.values(UI_SNAPSHOT)).catch(() => ({})),
]).then(([, cached]) => {
  showMode('feed');
  document.documentElement.lang = getLocale();
  translateDom();
  // Before anything is asked of the worker: a storage read is immediate, and
  // both tabs are then already filled when one clicks on them.
  if (cached[UI_SNAPSHOT.state]?.stats) paintState(cached[UI_SNAPSHOT.state]);
  if (cached[UI_SNAPSHOT.counts]?.counts) paintFeedCounts(cached[UI_SNAPSHOT.counts]);
  if (cached[UI_SNAPSHOT.history]?.summary) paintHistory(cached[UI_SNAPSHOT.history]);
  if (cached[UI_SNAPSHOT.highlights]) paintHighlights(cached[UI_SNAPSHOT.highlights]);
  if (cached[UI_SNAPSHOT.pulse]?.pulse) {
    pulseData = cached[UI_SNAPSHOT.pulse].pulse;
    showPulse();
  }
  refreshHighlights().catch(() => {});
  refreshPulse().catch(() => {});
  // Beside `refresh()` and not inside it: the two History figures used to wait
  // behind the sync state, the feed counts and the triage, four round trips to
  // a worker that is usually starting up. They only wait for their own call now.
  refreshHistory().catch(() => {});
  refresh();
});

// Tells the guard the module did start.
window.dispatchEvent(new Event('ytfeed:popup-ready'));

/**
 * Shows the repository link, when the manifest names a real one.
 *
 * `homepage_url` is the standard field, so there is one address to change and
 * Chrome already shows it on the extensions page. While it still names the
 * placeholder the link stays hidden: a dead link in a help panel is worse than
 * no link at all.
 */
function wireRepoLink() {
  const url = chrome.runtime.getManifest().homepage_url || '';
  if (!url || url.includes('your-account')) return;
  for (const link of document.querySelectorAll('.repo-link')) {
    link.href = url;
    link.hidden = false;
  }
}

wireRepoLink();
