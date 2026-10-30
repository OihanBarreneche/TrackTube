/**
 * Replacement grid for the subscription feed.
 *
 * Rendered inside the YouTube page itself, in place of the native grid. The
 * thumbnails are real `/watch?v=` links: click, ctrl-click, middle click and
 * opening in a new tab all behave normally.
 *
 * The native grid is not removed, only hidden in CSS. It therefore loads its
 * first batch — which gives us the durations and the playback progress — but,
 * never being visible, its scroll observer never fires and it loads nothing
 * more.
 */

import { MSG, send } from '../lib/messages.js';
// Purging a channel's rows is destructive, so it carries the tab's account key
// like the other destructive paths rather than relying on the worker's
// "no key means we do not know" tolerance.
import { activeAccountKey } from './active-account.js';
import { relativeTime, formatViews, broadcastKind, videoIncomplete } from '../lib/util.js';
import { t, initLocale, setLocale, bcp47, LANG_KEY } from '../lib/i18n.js';
import { log } from '../lib/log.js';

const ROOT_ID = 'tracktube-root';
const PAGE_SIZE = 60;
const UNDO_MS = 8000;
const SEARCH_DEBOUNCE_MS = 250;

const COLUMNS_KEY = 'ytfeed:columns';
const SETTINGS_KEY = 'ytfeed:settings';

/**
 * Settings, shared with the popup.
 *
 * Two distinct families, and the distinction matters: what **enters** the feed
 * (filters) and what is **shown** around it (the interface). Someone who never
 * hides anything has no reason to put up with a hide button on every thumbnail
 * and two view buttons they never use.
 *
 * Everything is visible by default, except `hideWatched` — pulling a video you
 * have just watched out of the feed on your behalf is a strong stance, and must
 * be chosen — and replays and scheduled broadcasts, which drown the feed without
 * bringing anything to someone who does not follow streams.
 *
 * Videos marked as priorities escape the filters in any case.
 */
const DEFAULT_SETTINGS = {
  /**
   * Does the extension's feed replace YouTube's own?
   *
   * This replaced the switch that used to occupy the left corner of the bar. A
   * setting toggled once a month has no place next to the ones touched on every
   * visit: it now lives in the popup, at the top, where one already goes for
   * everything else.
   */
  feedEnabled: true,

  // -- what enters the feed
  hideWatched: false,
  /**
   * Share of the duration past which a video counts as watched.
   *
   * Seventy rather than ninety: the last tenth of a video is the credits, the
   * outro and the call to subscribe. Leaving at that point is finishing it, and
   * at ninety the video stayed in the feed as if it had not been seen.
   */
  watchedPercent: 70,
  minDurationSec: 0,
  maxAgeDays: 0,
  /**
   * Seconds actually watched past which a video counts as started.
   *
   * A minute: below that one has not started a video, one has looked at it. At
   * thirty seconds the "in progress" view filled up with videos abandoned after
   * the intro, which is exactly what one does not want to be reminded of.
   */
  inProgressMinSec: 60,
  // The three states of a broadcast are set separately: they have neither the
  // same worth nor the same volume. A live under way is the only one that loses
  // all interest if missed; a replay is a video like any other, only far more
  // numerous; a scheduled broadcast has nothing to show yet, and recurring ones
  // come back endlessly in the feed.
  //
  // None of the three is dropped by default. Deciding for someone that replays
  // are noise is deciding what they follow: for whoever subscribes to streamers
  // it is the whole of the channel. The three settings are there, one line
  // apart, for whoever finds otherwise.
  /** Drops lives under way. */
  hideLives: false,
  /** Drops replays of lives. */
  hideReplays: false,
  /** Drops scheduled broadcasts from the feed, as long as they have nothing to show. */
  hideUpcoming: false,
  // -- what is shown around it
  showHideButton: true,
  showStarButton: true,
  showSelection: true,
  showViewAll: true,
  showViewStarred: true,
  showViewHidden: true,
  showViewInProgress: true,
  showSearch: true,
  showColumns: true,
  /** Plays the video inside the thumbnail on hover, like YouTube's own feed. */
  showPreview: true,
};

const settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  Object.assign(settings, stored?.[SETTINGS_KEY] ?? {});
}

/** Settings that change the feed's content, and therefore force a reload. */
const FILTERS = [
  'hideWatched', 'minDurationSec', 'maxAgeDays', 'inProgressMinSec',
  'hideLives', 'hideReplays', 'hideUpcoming',
];

/**
 * Applies the display settings without rebuilding anything.
 *
 * Everything goes through classes on the root and the `hidden` attribute of a
 * few buttons: that is what lets a change made in the popup show immediately,
 * including on the hundreds of thumbnails already rendered.
 */
function applyHud() {
  if (!mounted) return;
  const { root } = mounted;

  root.classList.toggle('tracktube-no-hide', !settings.showHideButton);
  root.classList.toggle('tracktube-no-star', !settings.showStarButton);

  const show = (selecteur, visible) => {
    const el = root.querySelector(selecteur);
    if (el) el.hidden = !visible;
  };

  show('#tracktube-search', settings.showSearch);
  show('#tracktube-columns', settings.showColumns);
  show('#tracktube-all-toggle', settings.showViewAll);
  show('#tracktube-starred-toggle', settings.showViewStarred);
  show('#tracktube-inprogress-toggle', settings.showViewInProgress);
  show('#tracktube-hidden-toggle', settings.showViewHidden);
  show('#tracktube-select-toggle', settings.showSelection);
  show('#tracktube-promote', settings.showStarButton);

  // A preview under way when the setting is unticked must stop right there:
  // there will be no next hover to do it.
  if (!settings.showPreview) closePreview();

  updateEmptyBar();

  // A view just removed must not stay on screen.
  const viewRemoved = (state.view === 'starred' && !settings.showViewStarred)
    || (state.view === 'hidden' && !settings.showViewHidden)
    || (state.view === 'inprogress' && !settings.showViewInProgress);
  if (viewRemoved) setView('feed');
}

/**
 * Folds the toolbar away when nothing is left to show in it.
 *
 * Unticking everything left a sixty pixel empty band between YouTube's chrome
 * and the first row: the room was taken from the controls, not given back to
 * the page. Once the bar is gone, only the line below remains, the count on the
 * left and ⟳ on the right.
 */
function updateEmptyBar() {
  const bar = mounted?.root.querySelector('.tracktube-bar');
  if (!bar) return;

  const nothing = !settings.showSearch && !settings.showColumns && !settings.showSelection
    && !settings.showViewAll && !settings.showViewStarred
    && !settings.showViewInProgress && !settings.showViewHidden;

  // The selection controls live in that same bar: folding it away mid sort
  // would take "Hide (12)" and the selection with it.
  const empty = nothing && !state.selecting;
  bar.hidden = empty;
  mounted.root.classList.toggle('tracktube-bare', empty);
}

/**
 * Follows the settings changed from the popup.
 *
 * `chrome.storage.onChanged` avoids any message round trip: the content script
 * is notified directly. Without it, every ticked box called for a reload of the
 * YouTube page — and with a dozen settings, trying out a combination became
 * discouraging.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes[LANG_KEY]) {
    setLocale(changes[LANG_KEY].newValue);
    if (mounted) {
      // Full remount: the labels are set at build time, and picking them up one
      // by one would mean keeping a register of every translated node — for a
      // setting one touches once.
      unmountFeedView();
      onSubscriptions = true;
      mountFeedView().catch((err) => log.error(t('feed.error.mount'), err));
    }
    return;
  }

  if (!changes[SETTINGS_KEY]) return;

  const before = { ...settings };
  Object.assign(settings, DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue ?? {});

  // The popup's switch acts at once, with no reload: otherwise one would have to
  // close the popup, come back to the tab and refresh to see the effect of a
  // tick box.
  if (before.feedEnabled !== settings.feedEnabled && onSubscriptions) {
    if (settings.feedEnabled) {
      mountFeedView().catch((err) => log.error(t('feed.error.mount'), err));
    } else {
      const was = onSubscriptions;
      unmountFeedView();
      onSubscriptions = was;
    }
    return;
  }

  if (!mounted) return;
  applyHud();

  // A reload is only warranted if what enters the feed has changed.
  if (FILTERS.some((key) => before[key] !== settings[key])) reload();
});
/**
 * Below three columns the thumbnails grow huge for nothing: the 16/9 format is
 * made to be seen in a grid, not in a list. The automatic mode stays free to go
 * lower on a narrow window, where forcing three columns would be worse.
 */
const MIN_COLUMNS = 3;
// Eight columns broke the card: the "views • date" line wrapped with the
// separator leading, and the heights within one row diverged. At seven, a long
// title fits on three lines and stops there.
const MAX_COLUMNS = 7;

/** Three columns by default: "auto" gave five on a wide screen, which squeezes
 *  the titles for nothing. */
const DEFAULT_COLUMNS = 3;

/**
 * Where to find the native grid, from the most precise to the most tolerant.
 *
 * The CSS does not lean on this selector: a class set on the element actually
 * found is what drives the hiding. Otherwise, the day YouTube renames
 * something, the CSS and the JS would diverge and the page would show both
 * grids one below the other.
 */
const NATIVE_GRID_SELECTORS = [
  'ytd-browse[page-subtype="subscriptions"] ytd-rich-grid-renderer',
  'ytd-browse:not([hidden]) ytd-rich-grid-renderer',
  'ytd-rich-grid-renderer',
];
const NATIVE_GRID_CLASS = 'tracktube-native-grid';

/** @type {{root: HTMLElement, observer: IntersectionObserver, abort: AbortController} | null} */
let mounted = null;

/**
 * Are we on the subscriptions page?
 *
 * Distinct from `mounted`: one can be there without the grid being mounted,
 * when the user has turned it off. That is what lets the popup's switch make it
 * appear without reloading the page.
 */
let onSubscriptions = false;

/** Channel metadata (avatar, title), loaded once per mount. */
let channelsById = new Map();

const state = {
  cursor: null,
  loading: false,
  exhausted: false,
  rendered: 0,
  selecting: false,
  /** @type {Set<string>} */
  selected: new Set(),
  /** Anchor point for selecting a range with shift click. */
  anchorId: null,
  query: '',
  /** @type {string|null} */
  channelId: null,
  /**
   * Current view, exclusive: the feed, the priorities, or the bin.
   * One mode at a time — two filters active at once produced combinations
   * nobody asks for and an unreadable state.
   * @type {'feed'|'starred'|'hidden'|'inprogress'}
   */
  view: 'feed',
  /** 'auto', or a forced number of columns. */
  columns: 'auto',
  /**
   * Videos the guard holds back for want of a duration.
   *
   * The figure is shown: a video pulled from the feed with nothing to say so
   * would be indistinguishable from a video one had missed, which is exactly
   * the defect being repaired here.
   */
  withheld: 0,
  /**
   * Bumped on every change of view or filter. A page of results that lands
   * afterwards belongs to the previous query and must be thrown away —
   * otherwise it joins a grid already emptied and refilled, and one ends up
   * with the thumbnails of both views mixed together.
   */
  generation: 0,
};

const isFiltered = () => Boolean(state.query || state.channelId || state.view !== 'feed');

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export async function mountFeedView() {
  if (mounted) return;
  onSubscriptions = true;

  // Read before anything else: this setting decides whether we touch the page
  // at all. Loading it later, as was the case when only the bar depended on it,
  // would make our grid flash before handing back control.
  await Promise.all([loadSettings(), initLocale()]);
  if (!settings.feedEnabled) return;

  // The class is set before the wait, not after: otherwise YouTube's grid shows
  // for a fraction of a second then vanishes. It is removed if the mount fails,
  // so the page is never left empty.
  await injectStylesheet();
  document.documentElement.classList.add('tracktube-active');

  const nativeGrid = await waitForAny(NATIVE_GRID_SELECTORS, 10_000);
  if (!nativeGrid) {
    document.documentElement.classList.remove('tracktube-active');
    log.warn('Native grid not found — unexpected page structure, we leave YouTube to show its own');
    return;
  }
  nativeGrid.classList.add(NATIVE_GRID_CLASS);

  const root = document.createElement('div');
  root.id = ROOT_ID;
  nativeGrid.parentNode.insertBefore(root, nativeGrid);

  const abort = new AbortController();
  const { signal } = abort;

  root.append(buildToolbar(signal), buildStatsRow(signal));

  const grid = document.createElement('div');
  grid.className = 'tracktube-grid';
  root.append(grid);

  // In capture, so before the click reaches the link: that is what allows
  // clicking a thumbnail without opening the video while selection is on.
  grid.addEventListener('click', onGridClick, { capture: true, signal });

  const status = document.createElement('div');
  status.className = 'tracktube-status';
  status.textContent = t('feed.loading');
  root.append(status);

  document.addEventListener('keydown', onKeyDown, { signal });

  // The popup targets a view through the URL fragment. On a tab already open,
  // changing the address triggers no navigation: only `hashchange` says so, and
  // without it the shortcut would have worked from cold only.
  window.addEventListener('hashchange', () => applyFragment(), { signal });

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { rootMargin: '800px' });
  observer.observe(status);

  mounted = { root, observer, abort };

  resetPaging();
  applyHud();
  // At mount time the grid is not populated yet: we set the view without
  // triggering a reload, the mount's own takes care of it right after.
  applyFragment({ deferred: true });
  await restoreColumns();
  await loadChannels();
  await Promise.all([loadMore(), refreshStats()]);
  if (feedUpdatePending) scheduleFeedUpdate();
  // The grid only has a measurable width once populated.
  updateColumnLabel();
}

export function unmountFeedView() {
  clearTimeout(screenTimer);
  onSubscriptions = false;
  if (!mounted) return;
  mounted.observer.disconnect();
  mounted.abort.abort();
  closePreview();
  mounted.root.remove();
  document.querySelector(`.${NATIVE_GRID_CLASS}`)?.classList.remove(NATIVE_GRID_CLASS);
  document.querySelector('.tracktube-toast')?.remove();
  closeCardMenu();
  document.documentElement.classList.remove('tracktube-active', 'tracktube-selecting');
  mounted = null;
}

/** Views reachable from the popup, by their name in the URL fragment. */
const FRAGMENT_VIEWS = new Set(['feed', 'starred', 'inprogress', 'hidden']);

/**
 * Switches to the view asked for in the address, if there is one.
 *
 * The fragment is consumed then erased: left in place, a reload of the page
 * would bring the user back into a view they had left in the meantime, with no
 * way to understand why.
 */
function applyFragment({ deferred = false } = {}) {
  const view = location.hash.match(/^#ytfeed=(\w+)$/)?.[1];
  if (!view || !FRAGMENT_VIEWS.has(view)) return;

  history.replaceState(null, '', location.pathname + location.search);
  if (view === state.view) return;

  if (deferred) {
    state.view = view;
    syncViewChips();
  } else {
    setView(view);
  }
}

/** Resets the paging, without touching the filters or the preferences. */
function resetPaging() {
  state.cursor = null;
  state.loading = false;
  state.exhausted = false;
  state.rendered = 0;
  state.withheld = 0;
  state.selected.clear();
  state.anchorId = null;
}

/**
 * Injects the stylesheet and resolves once the browser has applied it.
 *
 * Waiting is the whole point. A `<link>` loads asynchronously: without the
 * wait, the toolbar and the cards were appended before the rules existed and
 * the page showed a second of raw HTML, square white buttons stacked against
 * one another. The file is packaged with the extension, so the wait is a few
 * milliseconds off the disk cache, not a network round trip. `error` resolves
 * too: a missing stylesheet must not leave the feed unmounted for good.
 */
function injectStylesheet() {
  const href = chrome.runtime.getURL('src/content/feed-view.css');
  const existing = document.querySelector(`link[href="${href}"]`);
  if (existing) return existing.sheet ? Promise.resolve() : once(existing);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  const ready = once(link);
  (document.head ?? document.documentElement).append(link);
  return ready;
}

function once(link) {
  return new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
  });
}

/**
 * Waits for one of the selectors to match — YouTube renders its page
 * asynchronously, and the element does not exist yet when we are injected.
 */
function waitForAny(selectors, timeoutMs) {
  const find = () => {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  const existing = find();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
    const observer = new MutationObserver(() => {
      const el = find();
      if (!el) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(el);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function buildToolbar(signal) {
  const bar = document.createElement('div');
  bar.className = 'tracktube-bar';

  // -- search, first and aligned on the text of the line below.
  // Takes the shape of YouTube's own search field — oval, magnifier on the
  // right — rather than inventing one: two search fields a hundred pixels apart
  // should at least look alike.
  const search = document.createElement('div');
  search.className = 'tracktube-search';
  search.id = 'tracktube-search';

  const input = document.createElement('input');
  input.className = 'tracktube-search-input';
  input.type = 'search';
  input.placeholder = t('feed.search.placeholder');
  input.setAttribute('aria-label', t('feed.search.placeholder'));

  const glass = document.createElement('span');
  glass.className = 'tracktube-search-icon';
  glass.textContent = '⌕';
  glass.setAttribute('aria-hidden', 'true');

  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = input.value.trim();
      reload();
    }, SEARCH_DEBOUNCE_MS);
  }, { signal });

  search.append(input, glass);
  bar.append(search);

  // -- views: a single exclusive set, of which "All" is the resting state.
  //
  // Without it, the default state had no name: no chip was pressed, and nothing
  // said one was indeed looking at the whole feed, nor how to come back to it
  // other than by re-clicking the chip already active.
  const viewChips = document.createElement('span');
  viewChips.className = 'tracktube-views';

  const allChip = chip(t('feed.view.all'), true);
  allChip.id = 'tracktube-all-toggle';
  allChip.addEventListener('click', () => setView('feed'), { signal });

  const starred = chip(t('feed.view.starred'), false);
  starred.id = 'tracktube-starred-toggle';
  starred.addEventListener('click', () => setView('starred'), { signal });

  const inProgress = chip(t('feed.view.inprogress'), false);
  inProgress.id = 'tracktube-inprogress-toggle';
  inProgress.addEventListener('click', () => setView('inprogress'), { signal });

  const hiddenToggle = chip(t('feed.view.hidden'), false);
  hiddenToggle.id = 'tracktube-hidden-toggle';
  hiddenToggle.addEventListener('click', () => setView('hidden'), { signal });

  viewChips.append(allChip, starred, inProgress, hiddenToggle);
  bar.append(viewChips);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  bar.append(spacer);

  // -- tools, on the right: these are not views but actions, and mixing them in
  // with the chips on the left made "Select" look like one more filter.
  // Back to a text button after a detour through a ☑ icon: reduced to a glyph,
  // nobody guessed what it did. It stays on the right, with the tools, because
  // it is rarely used — but it reads.
  const select = chip(t('feed.select'), false);
  select.id = 'tracktube-select-toggle';
  select.addEventListener('click', () => setSelecting(true), { signal });

  bar.append(buildColumnControl(signal), select);

  // Controls visible in selection mode only.
  const tools = document.createElement('span');
  tools.className = 'tracktube-selection-tools';

  // The same button both ways: once everything was ticked, there was no way back
  // without leaving the selection and entering it again.
  const all = chip(t('feed.selection.all'), false);
  all.id = 'tracktube-select-all';
  all.addEventListener('click', () => {
    if (state.selected.size >= state.rendered) deselectAll();
    else selectAllLoaded();
  }, { signal });

  // No blue accent: "hide" and "make a priority" are two equivalent outcomes of
  // the same gesture, and nothing warranted naming one of them the expected
  // action.
  const apply = chip(t('feed.selection.hide'), false);
  apply.id = 'tracktube-apply';
  apply.addEventListener('click', applySelection, { signal });

  // The selection only served to hide. Yet marking a batch of videos to watch
  // first is the same gesture in reverse — and until now the stars had to be
  // clicked one by one.
  const promote = chip(t('feed.selection.star'), false);
  promote.id = 'tracktube-promote';
  promote.addEventListener('click', starSelection, { signal });

  const cancel = chip(t('feed.selection.cancel'), false);
  cancel.addEventListener('click', () => setSelecting(false), { signal });

  tools.append(all, apply, promote, cancel);
  bar.append(tools);

  return bar;
}

/**
 * Column count setting.
 *
 * "Auto" lets the grid fill according to the available width; a forced value
 * makes it possible to go beyond what YouTube offers, for instance to sweep
 * many thumbnails at once in selection mode.
 */
function buildColumnControl(signal) {
  const wrap = document.createElement('span');
  wrap.className = 'tracktube-columns';
  wrap.id = 'tracktube-columns';

  const less = document.createElement('button');
  less.type = 'button';
  less.textContent = '−';
  less.setAttribute('aria-label', t('feed.columns.less'));

  const label = document.createElement('button');
  label.type = 'button';
  label.id = 'tracktube-columns-label';

  const more = document.createElement('button');
  more.type = 'button';
  more.textContent = '+';
  more.setAttribute('aria-label', t('feed.columns.more'));

  // The step always starts from the number of columns *actually shown*,
  // automatic mode included. Without that, "+" from Auto would land on an
  // arbitrary value unrelated to what is on screen.
  const step = (delta) => {
    const next = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, effectiveColumns() + delta));
    applyColumns(next);
    chrome.storage.local.set({ [COLUMNS_KEY]: next });
  };

  less.addEventListener('click', () => step(-1), { signal });
  more.addEventListener('click', () => step(1), { signal });
  label.addEventListener('click', () => {
    applyColumns('auto');
    chrome.storage.local.set({ [COLUMNS_KEY]: 'auto' });
  }, { signal });

  wrap.append(less, label, more);

  // In automatic mode the column count changes with the window's width: the
  // label has to follow.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (state.columns !== 'auto') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateColumnLabel, 150);
  }, { signal });

  return wrap;
}

/**
 * Forces a column count, or hands control back to the automatic grid.
 *
 * The number goes through `data-columns` on the root rather than an inline
 * style on the grid: several rules key off it — title size, avatar size, the
 * channel line — and they need to read it in the selector, not only in a
 * variable.
 */
function applyColumns(n) {
  state.columns = n === 'auto'
    ? 'auto'
    : Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Number(n) || DEFAULT_COLUMNS));

  const root = mounted?.root ?? document.getElementById(ROOT_ID);
  if (root) {
    if (state.columns === 'auto') {
      root.removeAttribute('data-columns');
      root.style.removeProperty('--tracktube-columns');
    } else {
      root.dataset.columns = String(state.columns);
      root.style.setProperty('--tracktube-columns', String(state.columns));
    }
  }
  updateColumnLabel();
}

/**
 * The number of columns actually on screen.
 *
 * In automatic mode it is written nowhere: we count it on the rendered grid, by
 * looking at how many tracks the browser created. It is the only figure that
 * matches what the user sees, and therefore the only one from which "one more
 * column" means anything.
 */
function effectiveColumns() {
  if (state.columns !== 'auto') return state.columns;

  const grid = (mounted?.root ?? document.getElementById(ROOT_ID))?.querySelector('.tracktube-grid');
  if (!grid) return DEFAULT_COLUMNS;

  const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, tracks);
}

function updateColumnLabel() {
  const label = (mounted?.root ?? document.getElementById(ROOT_ID))
    ?.querySelector('#tracktube-columns-label');
  if (!label) return;

  // The number alone, with no "auto" mention: it doubled the control's width for
  // a nuance the dimming of the figure carries well enough on its own.
  const n = effectiveColumns();
  label.textContent = String(n);
  label.classList.toggle('is-auto', state.columns === 'auto');
  label.setAttribute('aria-label',
    t(state.columns === 'auto' ? 'feed.columns.auto' : 'feed.columns.reset'));

  // At the bounds the sign fades out instead of greying: a button that stays
  // visible and does nothing lies about what it offers. `is-at-bound` sets
  // `visibility: hidden`, which keeps the room — the figure does not shift — and
  // kills the hover, without which the empty space would light up like a
  // button.
  const control = label.parentElement;
  control?.firstElementChild?.classList.toggle('is-at-bound', n <= MIN_COLUMNS);
  control?.lastElementChild?.classList.toggle('is-at-bound', n >= MAX_COLUMNS);
}

async function restoreColumns() {
  const stored = await chrome.storage.local.get(COLUMNS_KEY);
  applyColumns(stored?.[COLUMNS_KEY] ?? DEFAULT_COLUMNS);
}

function chip(label, pressed) {
  const b = document.createElement('button');
  b.className = 'tracktube-chip';
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('aria-pressed', String(pressed));
  return b;
}

// ---------------------------------------------------------------------------
// Statistics line
// ---------------------------------------------------------------------------

function buildStatsRow(signal) {
  const row = document.createElement('div');
  row.className = 'tracktube-substats';

  const stats = document.createElement('span');
  stats.id = 'tracktube-stats';

  const freshness = document.createElement('span');
  freshness.id = 'tracktube-freshness';
  freshness.className = 'tracktube-freshness';

  const refresh = document.createElement('button');
  refresh.id = 'tracktube-refresh';
  refresh.className = 'tracktube-refresh';
  refresh.type = 'button';
  // The glyph is kept separate so it can spin without dragging the progress
  // ring along, which has to stay readable.
  const glyph = document.createElement('span');
  glyph.className = 'tracktube-refresh-glyph';
  glyph.textContent = '⟳';
  refresh.append(glyph);
  refresh.setAttribute('aria-label', t('feed.refresh.title'));
  refresh.addEventListener('click', runManualRefresh, { signal });

  // The version number has left the bar: it served to rule out "an old build is
  // running" during development, which is nobody else's problem. It stays in the
  // popup.
  const filter = document.createElement('button');
  filter.id = 'tracktube-filter-chip';
  filter.className = 'tracktube-chip is-filter';
  filter.type = 'button';
  filter.hidden = true;
  filter.addEventListener('click', () => {
    state.channelId = null;
    reload();
  }, { signal });

  row.append(stats, filter, freshness, refresh);
  return row;
}

/**
 * Counts what is actually in the database, by age bracket.
 *
 * Showing the number of thumbnails loaded on screen would teach nothing: in an
 * infinite scrolling feed, that number only follows the scroll.
 */
async function refreshStats() {
  const el = mounted?.root.querySelector('#tracktube-stats');
  if (!el) return;

  if (isFiltered()) {
    el.textContent = state.exhausted
      ? t('feed.stats.results', { n: state.rendered })
      : t('feed.stats.loading', { n: state.rendered });
    return;
  }

  const res = await send(MSG.GET_FEED_COUNTS, { periods: [1, 7] });
  if (!res.ok || !mounted) return;

  const { byPeriod } = res.counts;
  updateFreshness(res.lastSyncAt);

  // Two windows, not four. The month almost always said the same thing as the
  // week, and the count of hidden videos tallied work already done: three
  // figures, two of which asked nothing of anyone.
  el.textContent = t('feed.stats.periods', { day: fmt(byPeriod[1]), week: fmt(byPeriod[7]) });
}

const fmt = (n) => new Intl.NumberFormat(bcp47()).format(n ?? 0);

/**
 * Date of the last collection.
 *
 * The grid is populated when the page loads and does not move afterwards, while
 * the collection carries on in the background. Without this marker, nothing says
 * whether what one is looking at is thirty seconds or an hour old.
 */
function updateFreshness(lastSyncAt) {
  const el = mounted?.root.querySelector('#tracktube-freshness');
  if (!el) return;

  if (!lastSyncAt) { el.textContent = ''; return; }

  const minutes = Math.floor((Date.now() - lastSyncAt) / 60_000);
  el.textContent = minutes < 1
    ? t('feed.fresh.now')
    : minutes < 60
      ? t('feed.fresh.minutes', { n: minutes })
      : t('feed.fresh.hours', { n: Math.floor(minutes / 60) });
}

function updateToolbar() {
  const all = mounted?.root.querySelector('#tracktube-select-all');
  if (all) {
    const allSelected = state.rendered > 0 && state.selected.size >= state.rendered;
    all.textContent = t(allSelected ? 'feed.selection.none' : 'feed.selection.all');
  }

  const apply = mounted?.root.querySelector('#tracktube-apply');
  if (apply) {
    apply.disabled = state.selected.size === 0;
    // In the bin, the batch is not hidden: it is recovered.
    const verb = t(state.view === 'hidden' ? 'feed.selection.restore' : 'feed.selection.hide');
    apply.textContent = state.selected.size ? `${verb} (${state.selected.size})` : verb;
  }

  // Making a video one is in the middle of recovering a priority makes no
  // sense: it is not even in the feed yet. And in the priorities view, the
  // reverse gesture is what one comes for — offering "make a priority" on videos
  // that already are one was the same defect as offering "hide" in the bin.
  const promote = mounted?.root.querySelector('#tracktube-promote');
  if (promote) {
    promote.hidden = state.view === 'hidden';
    const verb = t(state.view === 'starred' ? 'feed.selection.unstar' : 'feed.selection.star');
    promote.textContent = state.selected.size ? `${verb} (${state.selected.size})` : verb;
    promote.disabled = state.selected.size === 0;
  }

  const filter = mounted?.root.querySelector('#tracktube-filter-chip');
  if (filter) {
    const channel = state.channelId ? channelsById.get(state.channelId) : null;
    filter.hidden = !state.channelId;
    filter.textContent = channel
      ? t('feed.channel.filter', { name: channel.title })
      : t('feed.channel.filter.unknown');
    filter.setAttribute('aria-label', t('feed.channel.filter.clear'));
  }

  // In selection mode, the selection count takes precedence over the statistics.
  const stats = mounted?.root.querySelector('#tracktube-stats');
  if (stats && state.selecting) {
    stats.textContent = t('feed.selection.count', { n: state.selected.size, total: state.rendered });
  }

  updateEmptyBar();
}

const grid = () => mounted?.root.querySelector('.tracktube-grid');
const statusEl = () => mounted?.root.querySelector('.tracktube-status');
const cardFor = (id) => mounted?.root.querySelector(`.tracktube-card[data-video-id="${CSS.escape(id)}"]`);
/** The thumbnails actually visible: the folded away ones count for nothing. */
const allCards = () => [...(mounted?.root.querySelectorAll('.tracktube-card:not(.is-removed)') ?? [])];

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Switches the view. Clicking the view already active returns to the feed, which
 * makes both buttons reversible without adding a third one for "all".
 * @param {'feed'|'starred'|'hidden'} view
 */
function setView(view) {
  state.view = state.view === view ? 'feed' : view;
  // A selection does not survive a change of view: its thumbnails will no longer
  // be on screen, and the action that applies to them is no longer the same.
  if (state.selecting) {
    state.selected.clear();
    state.anchorId = null;
  }
  syncViewChips();
  reload();
}

function syncViewChips() {
  for (const [id, view] of [
    ['#tracktube-all-toggle', 'feed'],
    ['#tracktube-starred-toggle', 'starred'],
    ['#tracktube-hidden-toggle', 'hidden'],
    ['#tracktube-inprogress-toggle', 'inprogress'],
  ]) {
    mounted?.root.querySelector(id)?.setAttribute('aria-pressed', String(state.view === view));
  }

}

function setSelecting(on) {
  state.selecting = on;
  document.documentElement.classList.toggle('tracktube-selecting', on);
  mounted?.root.querySelector('#tracktube-select-toggle')?.setAttribute('aria-pressed', String(on));

  // The selection stays in the current view. It used to leave it for the plain
  // feed, on the grounds that "select all" would there cover only a subset — but
  // the cure was worse than the disease: asking to select from "Hidden" sent you
  // back to the feed without warning, where you found yourself ticking visible
  // videos in order to hide them, exactly the opposite of what you came for. It
  // is now the action, not the view, that adapts.
  if (!on) {
    for (const id of state.selected) cardFor(id)?.classList.remove('is-selected');
    state.selected.clear();
    state.anchorId = null;
    refreshStats();
  }
  updateToolbar();
}

/**
 * Intercepts the click before the link.
 *
 * In selection mode, clicking a thumbnail ticks it instead of opening the video.
 * Shift click extends the selection from the last thumbnail ticked, which makes
 * it possible to sweep a whole range in two clicks.
 */
function onGridClick(event) {
  if (!state.selecting) return;

  const card = event.target.closest?.('.tracktube-card');
  if (!card) return;

  event.preventDefault();
  event.stopPropagation();

  const id = card.dataset.videoId;

  if (event.shiftKey && state.anchorId && state.anchorId !== id) {
    selectRange(state.anchorId, id);
  } else {
    toggleSelection(id);
    state.anchorId = id;
  }

  updateToolbar();
}

function toggleSelection(id, force) {
  const card = cardFor(id);
  if (!card) return;
  const on = force ?? !state.selected.has(id);
  if (on) state.selected.add(id); else state.selected.delete(id);
  card.classList.toggle('is-selected', on);
}

function selectRange(fromId, toId) {
  const cards = allCards();
  const a = cards.findIndex((c) => c.dataset.videoId === fromId);
  const b = cards.findIndex((c) => c.dataset.videoId === toId);
  if (a === -1 || b === -1) return;
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    toggleSelection(cards[i].dataset.videoId, true);
  }
}

/** Unticks everything without leaving the selection: the outward leg of "Select
 *  all", which had no return leg. */
function deselectAll() {
  for (const id of [...state.selected]) toggleSelection(id, false);
  state.anchorId = null;
  updateToolbar();
}

function selectAllLoaded() {
  if (!state.selecting) setSelecting(true);
  for (const card of allCards()) toggleSelection(card.dataset.videoId, true);
  updateToolbar();
}

function onKeyDown(event) {
  if (event.key === 'Escape' && state.selecting) setSelecting(false);
}

// ---------------------------------------------------------------------------
// Manual refresh
// ---------------------------------------------------------------------------

let refreshing = false;
let refreshProgressId = null;
let refreshProgressRatio = 0;
let feedUpdateTimer = 0;
let feedUpdatePending = false;
let refreshCompletion = null;

function waitForRefreshCompletion(progressId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (refreshCompletion?.progressId !== progressId) return;
      refreshCompletion = null;
      resolve({ failed: true, error: 'err.sweepinterrupted' });
    }, 5 * 60_000);
    refreshCompletion = {
      progressId,
      timer,
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
    };
  });
}

/**
 * Looks for new videos and makes them appear **without reloading the page**.
 * That is the whole point of the button: without it, one may as well reload.
 */
async function runManualRefresh() {
  if (refreshing || !mounted) return;
  refreshing = true;
  refreshProgressId = crypto.randomUUID();

  const button = mounted.root.querySelector('#tracktube-refresh');
  const freshness = mounted.root.querySelector('#tracktube-freshness');
  button.classList.add('is-busy');
  button.disabled = true;
  setRefreshProgress(0);

  try {
    // The authenticated runner acknowledges immediately so Chrome never has to
    // keep a message channel alive for the whole sweep. Completion comes back
    // through the progress broadcast.
    const completion = waitForRefreshCompletion(refreshProgressId);
    const res = await send(MSG.SYNC_NOW, { quick: true, progressId: refreshProgressId });
    // The only message left: a failure must be seen. The normal course of things
    // reads in the ring, then in the thumbnails as they arrive.
    if (!res.ok) { freshness.textContent = t('toast.refresh.failed', { error: t(res.error) }); return; }

    // Deferrals are deliberately not in here. One video whose classification
    // has not settled is not a channel that could not be read, it resolves by
    // itself on the next pass, and warning about it after a sweep that covered
    // every channel teaches the reader to ignore the warning.
    let partial = Boolean(res.result?.directUnavailable || res.result?.errors || res.result?.aborted);
    // Kept so the message can give figures. "Partial collection, check the
    // diagnostics" sent the reader to a page to find out that one video out of
    // a hundred and sixteen covered channels was waiting on a classification —
    // a sentence that alarms without informing is worse than no sentence.
    let detail = res.result ?? null;
    if (res.result?.started) {
      const finished = await completion;
      partial = finished.channelsMissed === true;
      detail = finished.result ?? detail;
      if (finished.failed) {
        freshness.textContent = t('toast.refresh.failed', { error: t(finished.error) });
        return;
      }
    }

    // The same sweep refreshes owner avatars. Re-read them before painting so
    // cards already on screen lose a previously copied account avatar too.
    await loadChannels();
    await prependNewVideos();
    setRefreshProgress(1);
    await refreshStats();
    if (partial) {
      // The channels whose window was certified, not the channels read. It
      // printed `checked`, which counts a channel read through the fallback
      // too, and so said « Collecte partielle · 597/597 chaînes lues » on 30
      // October 2026: a warning and a figure that contradicted it.
      freshness.textContent = t('feed.sync.partial', {
        checked: Math.max(0, (detail?.checked ?? 0) - (detail?.partial ?? 0)),
        total: detail?.total ?? 0,
        days: detail?.windowDays ?? 7,
      });
    }
  } catch (err) {
    freshness.textContent = t('toast.refresh.failed', { error: err.message });
  } finally {
    if (refreshCompletion?.progressId === refreshProgressId) {
      clearTimeout(refreshCompletion.timer);
      refreshCompletion = null;
    }
    refreshing = false;
    refreshProgressId = null;
    button.classList.remove('is-busy');
    button.disabled = false;
    setRefreshProgress(null);
  }
}

/**
 * Share of the ring reserved for the network sweep.
 *
 * The rest covers rereading the page and inserting the thumbnails. Without that
 * reserve the ring reached a hundred percent while the button was still
 * spinning: the end seemed to drag on, when it was merely badly represented.
 */
const SWEEP_SHARE = 0.95;

/** Progress ring around the button. `null` clears it. */
function setRefreshProgress(ratio) {
  const button = mounted?.root.querySelector('#tracktube-refresh');
  if (!button) return;
  if (ratio == null) {
    refreshProgressRatio = 0;
    button.style.removeProperty('--tracktube-progress');
  } else {
    refreshProgressRatio = Math.max(refreshProgressRatio, ratio);
    button.style.setProperty('--tracktube-progress', `${Math.round(refreshProgressRatio * 100)}%`);
  }
}

/**
 * Inserts the videos that appeared since the render, without touching the rest.
 *
 * Reloading the whole grid would lose the scroll position and the selection
 * state — for a gesture the user expects to be inconsequential.
 */
async function prependNewVideos() {
  const generation = state.generation;
  // A channel that appeared since the mount would have neither title nor avatar.
  await loadChannels();
  if (!mounted || generation !== state.generation) return 0;

  const known = new Set(allCards().map((c) => c.dataset.videoId));
  const empty = !known.size;
  // Re-read the entire interval already traversed, not just the first 60 rows.
  // Otherwise late discoveries above the scroll cursor become unreachable:
  // refresh skips them and scrolling resumes below them.
  const since = state.exhausted ? 0 : (state.cursor?.publishedAt ?? 0);
  let after = null, added = 0;
  do {
    const res = await send(MSG.GET_FEED_PAGE, {
      limit: PAGE_SIZE, ...queryFilters(), since: empty ? 0 : since, after,
    });
    if (!res.ok) throw new Error(res.error || 'Feed refresh failed');
    if (!mounted || generation !== state.generation) return added;
    const loadedAvatars = await loadAvatars(res.items ?? []);
    if (!mounted || generation !== state.generation) return added;
    const runtimeWithheld = (res.items ?? [])
      .filter((video) => videoIncomplete(video, loadedAvatars));
    resolveWithheld([...(res.withheld ?? []), ...runtimeWithheld], generation);
    for (const video of res.items) {
      if (videoIncomplete(video, loadedAvatars)
          || known.has(video.id) || cardFor(video.id) || !paintable(video)) continue;
      const card = buildCard(video);
      const at = video.publishedAt ?? 0;
      const next = allCards().find((c) => Number(c.dataset.publishedAt) < at ||
        (Number(c.dataset.publishedAt) === at && c.dataset.videoId < video.id));
      if (next) next.before(card);
      else grid().append(card);
      known.add(video.id);
      added++;
      state.rendered++;
    }
    after = res.nextCursor;
    if (empty) {
      state.cursor = after;
      state.exhausted = !after;
      break;
    }
  } while (after);

  updateToolbar();
  updateStatus();
  screenVisibleShorts();
  return added;
}

/**
 * The service worker broadcasts its progress to the tabs. Content scripts do not
 * receive `chrome.runtime.sendMessage`, hence the explicit send from the
 * background through `chrome.tabs.sendMessage`.
 */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.VIDEOS_GONE) { dropCards(msg.ids ?? []); return; }
  if (msg?.type === MSG.FEED_UPDATED) {
    feedUpdatePending = true;
    scheduleFeedUpdate();
    return;
  }
  if (msg?.type !== MSG.SYNC_PROGRESS || !refreshing) return;
  if (msg.progressId !== refreshProgressId) return;
  if (msg.total) setRefreshProgress(Math.min(1, msg.done / msg.total) * SWEEP_SHARE);
  if (msg.finished && refreshCompletion?.progressId === msg.progressId) {
    const { resolve } = refreshCompletion;
    refreshCompletion = null;
    resolve(msg);
  }
});

/** Debounced repaint after an automatic background collection. */
function scheduleFeedUpdate() {
  clearTimeout(feedUpdateTimer);
  feedUpdateTimer = setTimeout(async () => {
    if (!feedUpdatePending || !mounted) return;
    if (refreshing || state.loading) { scheduleFeedUpdate(); return; }
    feedUpdatePending = false;
    try {
      await prependNewVideos();
      await refreshStats();
    } catch (err) {
      feedUpdatePending = true;
      log.debug('Automatic feed repaint deferred', err);
    }
  }, 300);
}

/**
 * Takes off the grid videos the database no longer holds.
 *
 * There is no undo and no toast: this is not something the user did, it is a
 * Short leaving a feed it should never have entered. The thumbnail fades out
 * like any other departure and the node goes, rather than being marked
 * `is-removed` the way an undoable removal is.
 *
 * @param {string[]} ids
 */
function dropCards(ids) {
  for (const id of ids) removedVideoIds.add(id);
  const cards = ids.map(cardFor).filter(Boolean);
  if (!cards.length) return;
  for (const card of cards) card.classList.add('is-leaving');
  setTimeout(() => { for (const card of cards) card.remove(); }, 160);
  state.rendered = Math.max(0, state.rendered - cards.length);
  updateToolbar();
}

let screenTimer = 0;
let screenDueAt = 0;
const removedVideoIds = new Set();

/** Coalescing delay after a paint, and the longest a burst may postpone a pass. */
const SCREEN_DEBOUNCE_MS = 400;
const SCREEN_MAX_WAIT_MS = 2000;

/**
 * Refresh channel lists after paint. Never hide a card while a request is
 * pending.
 *
 * The coalescing is kept, its postponement is not. Every page of the infinite
 * scroll calls this, and a single `clearTimeout` meant a reader who kept
 * scrolling re-armed the four hundred milliseconds indefinitely: the pass never
 * ran, and a row collected before its verdict existed stayed on screen for the
 * whole session instead of the moment it takes to answer. The first call of a
 * burst now fixes a ceiling, and the delay shrinks as that ceiling approaches,
 * so a continuous scroll delays the screening by two seconds and no longer by
 * however long it lasts.
 */
function screenVisibleShorts() {
  const now = Date.now();
  if (!screenTimer) screenDueAt = now + SCREEN_MAX_WAIT_MS;
  const delay = Math.min(SCREEN_DEBOUNCE_MS, Math.max(0, screenDueAt - now));
  clearTimeout(screenTimer);
  screenTimer = setTimeout(async () => {
    screenTimer = 0;
    if (!mounted) return;
    const generation = state.generation;
    const ids = allCards().map((c) => c.dataset.videoId);
    for (let start = 0; start < ids.length; start += 60) {
      if (!mounted || generation !== state.generation) return;
      await send(MSG.SCREEN_SHORTS, { ids: ids.slice(start, start + 60) });
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Current filters, gathered in one place.
 *
 * They used to be listed in two separate calls, which diverged. The preferences
 * (watched, minimum duration, age) come from the settings and only apply to the
 * main feed: in the bin or the priorities, one wants to see what one put there,
 * with no further filtering.
 */
function queryFilters() {
  const base = {
    query: state.query,
    channelId: state.channelId,
    onlyHidden: state.view === 'hidden',
    onlyStarred: state.view === 'starred',
    onlyInProgress: state.view === 'inprogress',
  };
  if (state.view !== 'feed') return base;

  return {
    ...base,
    hideWatched: settings.hideWatched,
    inProgressMinSec: settings.inProgressMinSec,
    minDurationSec: settings.minDurationSec,
    maxAgeDays: settings.maxAgeDays,
    hideLives: settings.hideLives,
    hideReplays: settings.hideReplays,
    hideUpcoming: settings.hideUpcoming,
    // The completeness guard: a video only enters the feed if we know how to
    // resolve its duration/broadcast state. Lives in progress
    // and announced premieres are the only duration-free exception because no
    // duration exists for them yet.
    //
    // On the feed only: in the bin or the priorities, one wants to find again
    // what one put there, duration or no duration.
    requireComplete: true,
  };
}

async function loadChannels() {
  const res = await send(MSG.GET_CHANNELS, {});
  if (!res.ok) return;
  const next = new Map(res.channels.map((c) => [c.id, c]));
  const changedAvatars = [];
  for (const [id, channel] of next) {
    const before = channelsById.get(id)?.avatarUrl ?? '';
    const after = channel.avatarUrl ?? '';
    if (before === after) continue;
    avatarLoads.delete(id);
    if (after) changedAvatars.push([id, after]);
  }
  channelsById = next;
  applyAvatars(changedAvatars);
}

/** Channels whose gaps are resolved in a single load. */
const WITHHELD_MAX_CHANNELS = 24;

/**
 * Fetches what the withheld videos are missing, then releases them into the grid
 * as soon as they are complete.
 *
 * A single request per channel is enough: the internal API's reply carries both
 * the playlist's durations and the owner's avatar. That is what makes it
 * possible to fill both gaps at once, where the old catch-up made two separate
 * round trips, at two different moments, on two different caps.
 *
 * Nothing is awaited before painting: the complete videos are already on screen,
 * and these ones slot into their chronological place when they arrive. Waiting
 * would have cost two seconds of blank screen, which the bench had already
 * measured back when only the durations were being caught up.
 *
 * @param {Array} withheld  videos set aside by the guard, returned by the query
 * @param {number} generation
 * @param {Set<string>} [seen]  channels already tried during this catch-up
 * @returns {Promise<number>} thumbnails actually placed
 */
async function withheldPass(withheld, generation, seen = new Set()) {
  if (!withheld?.length) return 0;

  const byChannel = new Map();
  for (const v of withheld) {
    if (!v.channelId) continue;
    if (!byChannel.has(v.channelId)) byChannel.set(v.channelId, []);
    byChannel.get(v.channelId).push(v);
  }

  const channelIds = [...byChannel.keys()].filter((id) => !seen.has(id)).slice(0, WITHHELD_MAX_CHANNELS);
  if (!channelIds.length) return 0;
  for (const id of channelIds) seen.add(id);

  try {
    const { fetchChannelUploads, innertubeAvailable } = await import(
      chrome.runtime.getURL('src/content/innertube.js'));
    if (!await innertubeAvailable({ authenticated: false })) return 0;

    const durations = [];
    const avatars = [];

    await Promise.all(channelIds.map(async (channelId) => {
      const expected = new Map(byChannel.get(channelId).map((v) => [v.id, v]));

      const read = async (kind) => {
        const { videos, avatarUrl } = await fetchChannelUploads(channelId, { max: 60, kind });
        // Same caution as elsewhere: an image is only displayed over https.
        if (avatarUrl?.startsWith('https://')) avatars.push([channelId, avatarUrl]);
        for (const upload of videos) {
          const target = expected.get(upload.id);
          if (target && upload.durationSec > 0) {
            target.durationSec = upload.durationSec;
            durations.push([upload.id, upload.durationSec]);
          }
        }
      };

      await read('long');
      // Broadcasts are not in the long videos playlist: two disjoint lists.
      // Without this second reading, a replay withheld for want of a duration
      // stayed withheld for ever, since we only looked for it where it cannot
      // be. The request is only made for channels that do have a broadcast
      // pending.
      const broadcastLeft = [...expected.values()]
        .some((v) => v.wasLive && !(v.durationSec > 0));
      if (broadcastLeft) await read('lives');
    }));

    // The database first: even if the view changed under our feet, the next load
    // will start from an already complete feed rather than redo everything.
    if (durations.length) await send(MSG.SET_DURATIONS, { durations });
    if (avatars.length) {
      send(MSG.SET_AVATARS, { avatars }).catch(() => {});
      for (const [id, url] of avatars) {
        const channelId = channelsById.get(id);
        if (channelId && !channelId.avatarUrl) channelId.avatarUrl = url;
      }
    }

    if (!mounted || generation !== state.generation) return 0;

    const knownIds = new Set(
      [...channelsById.values()].filter((c) => c.avatarUrl).map((c) => c.id),
    );
    // Same barrier as on the first paint: the address just received still has to
    // load. A channel whose fresh address fails too keeps its videos withheld
    // rather than releasing them with a stand-in badge.
    const loaded = await loadAvatars(withheld);
    if (!mounted || generation !== state.generation) return 0;

    // Never release the saved objects: enrichment can finish after the worker
    // has removed a Short. Ask for existing, verified rows immediately before
    // painting, even when the playlist supplied a perfectly valid duration.
    const verified = [];
    for (let offset = 0; offset < withheld.length; offset += 60) {
      const res = await send(MSG.SCREEN_SHORTS, { ids: withheld.slice(offset, offset + 60).map((v) => v.id) });
      if (!mounted || generation !== state.generation) return 0;
      verified.push(...(res.items ?? []));
    }
    const ready = verified.filter(
      (v) => !videoIncomplete(v, knownIds) && paintable(v, loaded),
    );
    if (!ready.length) return 0;

    // Each video joins its place in the feed, not the end of the grid: the scroll
    // position and the selection under way do not move.
    const alreadyThere = new Set(allCards().map((c) => c.dataset.videoId));
    let placed = 0;
    for (const video of ready) {
      if (alreadyThere.has(video.id)) continue;
      const card = buildCard(video);
      const at = video.publishedAt ?? 0;
      const next = allCards().find((c) => Number(c.dataset.publishedAt) < at);
      if (next) next.before(card);
      else grid().append(card);
      placed++;
    }
    if (!placed) return 0;

    state.rendered += placed;
    state.withheld = Math.max(0, state.withheld - placed);
    updateStatus();
    updateToolbar();
    screenVisibleShorts();
    return placed;
  } catch (err) {
    log.debug('Resolution of withheld videos interrupted', err);
    return 0;
  }
}

/**
 * Number of catch-up passes chained together. Twenty four channels per pass:
 * enough to cover almost three hundred withheld channels, well beyond what a
 * single page load can bring back.
 */
const WITHHELD_MAX_PASSES = 12;

/** One catch-up loop at a time, and the signal that another one knocked. */
let catchUpRunning = false;
let catchUpAgain = false;

/**
 * Loops until nothing is withheld any more.
 *
 * A single pass was not enough: it handles only twenty four channels, and the
 * rest waited for the next page load. That is exactly what was observed —
 * reloading the page completed the feed, the ⟳ button did not, because it only
 * triggered one pass over what it had just brought back.
 *
 * A channel is tried once per loop: if the internal API gave nothing for it,
 * querying it again straight away will give no more, and that is what would make
 * the loop spin for ever.
 *
 * @param {Array} withheld
 * @param {number} generation
 */
async function resolveWithheld(withheld, generation) {
  if (!withheld?.length) return;
  // A ⟳ during the loop brings videos the channels already tried did not have
  // yet: rather than lose the request, we reopen the turn for all of them. The
  // cap on passes, for its part, does not move.
  if (catchUpRunning) { catchUpAgain = true; return; }
  catchUpRunning = true;

  const seen = new Set();
  try {
    let remaining = withheld;
    for (let pass = 0; pass < WITHHELD_MAX_PASSES; pass++) {
      if (!mounted || generation !== state.generation) return;
      if (catchUpAgain) { catchUpAgain = false; seen.clear(); }
      if (!remaining.some((v) => v.channelId && !seen.has(v.channelId))) return;

      await withheldPass(remaining, generation, seen);

      // We ask for the list again rather than subtract what has just been
      // placed: the database moved in the meantime — the recovered durations are
      // written there — and it is what is authoritative on what stays withheld.
      const res = await send(MSG.GET_FEED_PAGE, { limit: PAGE_SIZE, ...queryFilters() });
      if (!res.ok || !mounted || generation !== state.generation) return;
      remaining = res.withheld ?? [];
    }
  } finally {
    catchUpRunning = false;
  }
}

/**
 * The foot of the grid: where we stand, and what the guard is holding back.
 *
 * The count of withheld videos is not a debugging detail: without it, a feed
 * shorter than expected cannot be told from an incomplete one.
 */
function updateStatus() {
  const el = statusEl();
  if (!el) return;
  const base = state.exhausted ? endMessage() : t('feed.loading');
  el.textContent = state.withheld
    ? `${base} · ${t('feed.withheld', { n: state.withheld })}`
    : base;
}

async function loadMore() {
  if (!mounted || state.loading || state.exhausted) return;
  state.loading = true;

  const generation = state.generation;
  const res = await send(MSG.GET_FEED_PAGE, { limit: PAGE_SIZE, after: state.cursor, ...queryFilters() });

  state.loading = false;
  // The view changed during the request: these results no longer concern what is
  // on screen.
  if (!mounted || generation !== state.generation) return;

  if (!res.ok) {
    statusEl().textContent = t('feed.error.load', { error: t(res.error) });
    state.exhausted = true;
    return;
  }

  const { items, nextCursor } = res;
  state.withheld += res.withheldCount ?? 0;

  // A recorded avatar URL is not enough: old YouTube image URLs expire. The
  // image must have loaded before any card of that channel is allowed through.
  const loadedAvatars = await loadAvatars(items);
  if (!mounted || generation !== state.generation) return;

  const runtimeWithheld = items.filter((video) => videoIncomplete(video, loadedAvatars));
  const painted = items.filter((video) =>
    !videoIncomplete(video, loadedAvatars) && paintable(video) && !cardFor(video.id));
  if (painted.length) {
    const fragment = document.createDocumentFragment();
    for (const video of painted) fragment.append(buildCard(video));
    grid().append(fragment);
    state.rendered += painted.length;
  }
  // What the query let through and the grid refuses anyway joins the withheld
  // ones: that is one video fewer on screen, not a video lost, and the catch-up
  // will go and fetch it.
  state.withheld += runtimeWithheld.length;

  // And, in parallel, what the guard set aside: one request per channel brings
  // duration metadata back, and the video joins the feed as soon as it
  // is complete.
  resolveWithheld([...(res.withheld ?? []), ...runtimeWithheld], generation);

  state.cursor = nextCursor;
  state.exhausted = !nextCursor;

  updateStatus();

  updateToolbar();
  screenVisibleShorts();
  if (isFiltered() || state.exhausted) refreshStats();
  // A page made entirely of rejected Shorts must not strand the cursor before
  // the next ordinary video. The observer may stay intersecting in this case.
  if (!painted.length && nextCursor) setTimeout(() => {
    if (generation === state.generation) loadMore();
  }, 0);
}

function endMessage() {
  if (state.rendered) return t(isFiltered() ? 'feed.end.results' : 'feed.end');
  if (state.query || state.channelId) return t('feed.empty.search');
  if (state.view === 'starred') return t('feed.empty.starred');
  if (state.view === 'hidden') return t('feed.empty.hidden');
  if (state.view === 'inprogress') return t('feed.empty.inprogress');
  return t('feed.empty.feed');
}

// ---------------------------------------------------------------------------
// Hover preview
// ---------------------------------------------------------------------------

/**
 * Replays the preview YouTube starts inside its own thumbnails: the video really
 * plays, muted, and carries on as long as the cursor stays there.
 *
 * Getting there went through two closed routes, both measured on the real page:
 *
 * - an `iframe` on `/embed/` answers "error 152" for any video, on
 *   `youtube.com` as on `youtube-nocookie.com`. An embed refuses to play in a
 *   page served by YouTube itself, including for videos that start without a
 *   murmur from any other site. Wrapped in an opaque origin document to change
 *   the referrer, it answers 153: an opaque origin sends none, and no policy
 *   gives it one;
 * - the stream `player` returns to the WEB client answers 403. It lacks the
 *   attestation token YouTube now requires of its own player.
 *
 * What works lies elsewhere: the same `player`, queried as an iOS client and
 * without cookies, returns direct URLs, unencrypted, tokenless, which honour
 * range requests and accept the `youtube.com` origin cross-site. The stream is
 * picture only, with no audio track: adaptive formats separate them, and a muted
 * preview has no use for sound.
 *
 * A tag given that address plays it in an ordinary page, but not in YouTube's,
 * and says nothing about it. Neither the page's directives, nor its service
 * worker, nor the request's origin explain it: all were measured and ruled out.
 * That is why the video is no longer wired to the address but to `MediaSource`,
 * fed by our own requests. This path no longer depends on anything in the page,
 * it only loads what is being watched, and it can say when it fails.
 *
 * Two resources come with it:
 *
 * - the six second WebP animation, 320 by 180, which arrives before the video
 *   and holds the thumbnail while it starts. Three videos out of four have one;
 *   those that do not keep their still for a second;
 * - the hover storyboards, the ones from YouTube's progress bar, one image every
 *   five seconds. They are instant where moving the playhead needs a transfer,
 *   and that is what makes scrubbing fluid.
 *
 * The gesture follows the player's. The bottom band, and it alone, scrubs the
 * video. A left click in that band does not open the page: it moves playback to
 * that instant, which then carries on. Middle click and modified clicks open the
 * video, at the point aimed at — the thumbnail's link address carries the
 * timestamp as long as the cursor stays on the band.
 *
 * Two precautions make the whole thing harmless:
 *
 * - `pointer-events: none` on everything laid over the thumbnail. Nothing ever
 *   takes the cursor, so the card keeps receiving hover and movement, and the
 *   one click that is captured is captured explicitly;
 * - a single preview at a time, armed after a delay, and two page-wide caches.
 *   Sweeping the grid with the mouse must trigger nothing, and leaving a
 *   thumbnail cuts the transfer under way.
 */
const PREVIEW_DELAY_MS = 600;

/**
 * Height of the bottom band, the one that drives the rail.
 *
 * A three pixel line cannot be aimed at with a mouse: the grab band is far
 * taller than the line it drives, as in YouTube's own player.
 *
 * It is that band, and only that band, that drives the scrubbing. A first
 * attempt engaged it as soon as the cursor moved horizontally anywhere over the
 * thumbnail: the picture then jumped from one end of the video to the other at
 * the slightest movement, and the preview became unreadable.
 */
const PREVIEW_RAIL_PX = 22;

/**
 * Minimum height of the stream requested.
 *
 * A grid thumbnail is around 540 pixels wide; 360p is 640, so the picture is
 * scaled down there rather than up. Going higher would not show and would cost
 * several times the transfer, for a video watched a few seconds only.
 */
const PREVIEW_MIN_HEIGHT = 360;

/**
 * Lead to keep buffered ahead of the playhead.
 *
 * Four seconds are enough to hide a network round trip, and that is little to
 * throw away when the cursor leaves, which happens all the time.
 */
const PREVIEW_LEAD_S = 4;

/** Beyond this, what has already played is given back rather than kept. */
const PREVIEW_BUFFER_S = 30;

/** Width of the hover box, the one that shows the instant aimed at. */
const PREVIEW_SHEET_PX = 158;

/**
 * How far an unattested stream is served, before anything has been measured.
 *
 * This is not a guess. Measured on 7 October 2026, binary searching the refusal
 * on the 360p picture of five videos: 60, 60, 60, 61 and 65 seconds, and on the
 * sound of the same ones 62 to 65. Measured again across every picture format of
 * one video, 144p to 1080p: 61, 60, 65, 65, 63, 62 seconds, while the byte
 * boundary went from 0.8 to 19.7 MB. The cap is a duration and not a byte
 * budget, so asking for a lighter format buys nothing — which is worth knowing
 * before anyone tries it again.
 *
 * Until this constant, the rail was drawn fully reachable and the boundary was
 * learnt from the first click that failed: the first attempt at the middle of a
 * video froze the picture, and only then did the shading appear to explain it.
 * The limit is now claimed from the first frame, and `noteReach` still narrows
 * it on refusal — it is a ceiling, never a promise.
 */
const PREVIEW_ASSUMED_REACH_S = 60;

/**
 * Formats one buffer may try before it gives up, sound or picture.
 *
 * Three until 0.94.0, raised with the return of the DRC twins to the sound list:
 * it holds each track twice now, and three attempts no longer reach the twin of
 * the second codec. See the header of `audioCandidates` for what that cost.
 */
const MAX_TRACK_PROBES = 4;

/** With no fine pointer there is no hover: on a touch screen, everything is one. */
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');

/**
 * Moving thumbnails are cached separately from expiring stream metadata.
 *
 * Failed metadata is retried after a short cooldown. Signed stream URLs expire,
 * so a subscriptions tab left open for days must periodically request new ones.
 */
const previewUrls = new Map();

/** @type {Map<string, object|null>} */
const previewInfos = new Map();
const PREVIEW_INFO_MS = 5 * 60_000;
const PREVIEW_FAILURE_MS = 5_000;

/**
 * The open preview, if there is one.
 *
 * @type {{
 *   card: HTMLElement, thumb: HTMLElement, videoId: string, duration: number,
 *   link: HTMLAnchorElement|null, hrefBase: string,
 *   img: HTMLImageElement|null, video: HTMLVideoElement|null, stream: object|null,
 *   source: object|null, scrub: HTMLElement, image: HTMLElement,
 *   time: HTMLElement, rail: HTMLElement, hover: HTMLElement,
 *   mark: HTMLElement, point: HTMLElement,
 *   storyboard: object|null, scrubbing: boolean, sheet: number, frac: number,
 *   instant: number
 * } | null}
 */
let preview = null;
let previewTimer = null;

/** Runs between leaving a card and putting its preview out. See `disarmPreview`. */
let previewGrace = null;

/**
 * The card whose preview is armed but not yet open.
 *
 * Without it, leaving a card cancelled whichever arming was pending, including
 * the one the card being entered had just set — and the grace, firing half a
 * second later, did it again. Travelling from one card to the next therefore
 * opened nothing at all, most visibly on the first row, which is where the
 * cursor arrives and where it moves along.
 */
let previewArming = null;

/**
 * Video whose preview is wanted right now.
 *
 * Both requests are asynchronous; the cursor does not wait for them. This marker
 * tells a late reply that it no longer interests anyone.
 */
let previewWanted = null;

/** Loaded on demand: most pages never open a preview at all. */
let previewClient = null;

function loadClient() {
  previewClient ??= import(chrome.runtime.getURL('src/content/innertube.js'));
  return previewClient;
}

function removePreview() {
  if (!preview) return;
  const a = preview;
  preview = null;
  a.controller?.abort();

  a.card.removeEventListener('pointermove', onPointerMove);
  a.card.removeEventListener('click', onPreviewClick, true);
  a.thumb.classList.remove('is-previewing', 'is-playing', 'is-scrubbing', 'is-aiming');
  // The thumbnail gets its ordinary link back: a timestamp only means something
  // while the cursor points at the place it corresponds to.
  if (a.link) a.link.setAttribute('href', a.hrefBase);
  stopVideo(a);
  a.img?.remove();
  a.scrub.remove();
  a.rail.remove();
}

/**
 * Cuts the video for good.
 *
 * Removing the node is not enough: Chrome carries on transferring for a detached
 * element as long as it has a source. Emptying it then calling `load` again
 * cancels the request, which matters when running across a grid with the mouse.
 */
function stopVideo(a) {
  const v = a.video;
  // The watch is called off in every case, video or not: a hover that leaves
  // during the round trip would otherwise have it fire on a dead preview.
  clearTimeout(a.stall);
  clearTimeout(a.retryTimer);
  a.retryTimer = null;
  a.stall = null;
  a.sound?.remove();
  a.sound = null;
  if (!v) return;
  a.video = null;
  // The fed stream goes with it: its requests under way no longer have a
  // recipient, and its object URL would leak without this.
  if (a.source) {
    a.source.controller?.abort();
    if (a.source.objectUrl) URL.revokeObjectURL(a.source.objectUrl);
    a.source = null;
  }
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.remove();
}

// One fresh metadata request per hover after a failure, never a retry loop.
function recoverPreview(a) {
  previewInfos.delete(a.videoId);
  stopVideo(a);
  if (preview !== a) return;
  if (a.retries) {
    previewInfos.set(a.videoId, { at: Date.now(), info: null });
    return;
  }
  a.retries = 1;
  a.retryTimer = setTimeout(() => {
    a.retryTimer = null;
    if (preview === a) loadPreview(a);
  }, 180);
}

/** Everything down: what is open, what is pending, what is waiting to close. */
function closePreview() {
  clearTimeout(previewTimer);
  clearTimeout(previewGrace);
  previewTimer = null;
  previewGrace = null;
  previewArming = null;
  previewWanted = null;
  removePreview();
}

/**
 * Lays down the preview's layers, then goes to fetch what fills them.
 *
 * The two resources each arrive at their own pace and do not depend on one
 * another: a video with no animation stays scrubbable, a video with no
 * storyboard keeps its animation.
 */
function openPreview(card, video) {
  const thumb = card.querySelector('.tracktube-thumb');
  if (!thumb || !card.isConnected || !card.matches(':hover')) return;

  removePreview();

  // The hover box: the frame aimed at and its instant, above the rail. On the
  // rail itself nothing follows the mouse, other than a lightening of the line up
  // to it; the red and its dot belong to playback alone.
  const scrub = document.createElement('div');
  scrub.className = 'tracktube-scrub';
  const image = document.createElement('i');
  const time = document.createElement('span');
  scrub.append(image, time);

  const rail = document.createElement('div');
  rail.className = 'tracktube-scrub-bar';
  const hover = document.createElement('u');
  const mark = document.createElement('i');
  const point = document.createElement('b');
  // Anchored to the right: it covers the tail the server refuses to serve, and
  // it stays at nothing as long as nothing has been refused.
  const reach = document.createElement('s');
  rail.append(reach, hover, mark, point);
  thumb.append(scrub, rail);

  const link = card.querySelector('.tracktube-link');

  preview = {
    card, thumb, videoId: video.id, duration: video.durationSec > 0 ? video.durationSec : 0,
    link, hrefBase: link ? link.getAttribute('href') : '',
    img: null, video: null, stream: null, audio: null, source: null, sound: null,
    scrub, image, time, rail, hover, mark, point, reach,
    storyboard: null, scrubbing: false, aiming: false,
    sheet: -1, frac: 0, instant: 0, stall: null,
    before: 0,
  };
  card.addEventListener('pointermove', onPointerMove);
  // In capture: the link wraps the thumbnail, and the decision to keep the click
  // has to be made before it has carried it off to the video's page.
  card.addEventListener('click', onPreviewClick, true);

  loadAnimation(preview);
  loadPreview(preview);
}

async function loadAnimation(a) {
  let url = previewUrls.get(a.videoId);
  if (url === undefined) {
    const { fetchMovingThumbnail } = await loadClient();
    url = await fetchMovingThumbnail(a.videoId);
    previewUrls.set(a.videoId, url);
  }
  if (preview !== a || !url) return;

  const img = document.createElement('img');
  img.className = 'tracktube-preview';
  img.alt = '';
  img.decoding = 'async';
  // Revealed only once the animation has loaded: otherwise the still would give
  // way to an empty rectangle for the length of the transfer.
  img.addEventListener('load', () => {
    if (preview?.img === img) img.classList.add('is-ready');
  }, { once: true });
  img.src = url;

  a.img = img;
  a.thumb.append(img);
  a.thumb.classList.add('is-previewing');
}

async function loadPreview(a) {
  const cached = previewInfos.get(a.videoId);
  let info = cached && Date.now() - cached.at < (cached.info?.stream ? PREVIEW_INFO_MS : PREVIEW_FAILURE_MS)
    ? cached.info : undefined;
  if (info === undefined) {
    const { fetchPreview } = await loadClient();
    if (preview !== a) return;
    a.controller ??= new AbortController();
    info = await fetchPreview(a.videoId, PREVIEW_MIN_HEIGHT, { signal: a.controller.signal }).catch(() => null);
    if (!a.controller.signal.aborted) previewInfos.set(a.videoId, { at: Date.now(), info });
  }
  if (preview !== a) return;
  if (!info) {
    if (info === null && cached && Date.now() - cached.at < PREVIEW_FAILURE_MS) return;
    recoverPreview(a);
    return;
  }
  a.streams = info.streams ?? [];
  a.audios = info.audios ?? [];

  // The card's duration comes from the Atom feed and is sometimes missing; this
  // one comes from the player, and is authoritative.
  if (info.duration > 0) a.duration = info.duration;

  if (info.storyboard) {
    a.storyboard = info.storyboard;
    // The first sheet is claimed in advance, otherwise the first scrubbing
    // movement would have nothing to show.
    if (info.storyboard.urls[0]) new Image().src = info.storyboard.urls[0];
  }
  // The rail only appears here: it announces that the thumbnail can be driven,
  // and it would lie as long as it cannot.
  if (a.storyboard || info.stream) a.rail.classList.add('is-ready');

  if (info.stream) {
    a.stream = info.stream;
    a.audio = info.audio || null;
    placeVideo(a);
  } else recoverPreview(a);
}

/**
 * Lays down the video and starts it.
 *
 * Muted, it starts without asking: that is the only permission Chrome grants
 * outright. Out loud, `play()` may be refused if the page has never been
 * clicked; the refusal is caught and the picture carries on silently rather
 * than stopping.
 */
function placeVideo(a) {
  const v = document.createElement('video');
  v.className = 'tracktube-video';
  // Muted at birth, and it stays muted until the button is pressed on this very
  // thumbnail. Two reasons beyond the asked for behaviour, and the second is the
  // one that cost time: a muted `play()` is the only one Chrome grants outright,
  // and at this point nobody knows yet whether there will be any sound at all —
  // the sound track's header has not been read.
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.disableRemotePlayback = true;

  v.addEventListener('loadeddata', () => {
    if (preview?.video === v) a.thumb.classList.add('is-playing');
  }, { once: true });

  // A click that landed before the video was ready is not lost: it was waiting
  // for the duration, the one thing missing to turn it into seconds.
  v.addEventListener('durationchange', () => {
    if (preview?.video !== v || !(a.instant > 0) || !(v.duration > 0)) return;
    if (v.currentTime < 0.5) v.currentTime = a.instant * v.duration;
  });

  // The rail's marker follows playback: that is what shows the video is moving
  // on, and not merely that it is there. It is also the heartbeat that claims
  // what comes next when the buffered lead runs out.
  v.addEventListener('timeupdate', () => {
    if (preview?.video !== v) return;
    placePlayhead(a, v);
    feedBuffer(a);
  });

  // A jump asked for with a click almost always lands outside what is buffered:
  // this is where the targeted segment is claimed.
  v.addEventListener('seeking', () => {
    if (preview?.video !== v) return;
    const s = a.source;
    if (s) {
      // A jump changes target: the tally of requests that came to nothing, which
      // guards against a loop on a barren fragment, no longer has any reason to
      // stand.
      for (const tr of s.tracks) { tr.last = -1; tr.failures = 0; }
      // A jump outside what is laid down leaves the buffer in pieces, one island
      // behind the target and nothing under it. Reading such a buffer is what
      // made a big jump behave differently from a small one — scrubbing a few
      // seconds ahead worked, clicking in the middle of the rail froze the
      // picture as if it were still loading. Clearing it makes the two the same
      // case: nothing buffered, one segment to fetch.
      if (!bufferedAround(v.buffered, v.currentTime)) clearBuffers(a);
    }
    armStallWatch(a, v);
    feedBuffer(a);
  });

  // The ordinary heartbeat is `timeupdate`, but it stops precisely when playback
  // stops for want of data. Without these two, a round trip missed after a jump
  // freezes the picture for good: nothing claims what comes next any more. That
  // is what froze the thumbnail on click.
  v.addEventListener('waiting', () => {
    if (preview?.video === v) { feedBuffer(a); armStallWatch(a, v); }
  });

  v.addEventListener('seeked', () => {
    if (preview?.video !== v) return;
    placePlayhead(a, v);
    feedBuffer(a);
    if (v.paused) v.play().catch(() => {});
  });

  // Playing again is the only proof the jump landed. The watch is called off
  // here and nowhere else.
  v.addEventListener('playing', () => {
    if (preview?.video === v) clearTimeout(a.stall);
  });

  // A hover rarely takes a video to its end, but if it does it starts over rather
  // than freeze on its last frame.
  v.addEventListener('ended', () => {
    if (preview?.video !== v) return;
    v.currentTime = 0;
    v.play().catch(() => {});
  });

  // An expired address, a refused format: the thumbnail keeps its animation and
  // its storyboards, which are enough to leave no hole.
  v.addEventListener('error', () => {
    if (preview?.video !== v) return;
    log.debug('Preview decode failed', v.error?.code);
    a.thumb.classList.remove('is-playing');
    recoverPreview(a);
  }, { once: true });

  a.video = v;
  a.thumb.append(v);
  wireStream(a, v);
}

/**
 * Turns the sound on, and puts the button up, once there really is sound.
 *
 * It used to be enough that the player had offered a sound track, and that is
 * the bug this replaced: the button appeared on every thumbnail, while the track
 * was quietly dropped further down whenever its header failed to come back or
 * the picture fell back on the direct address, which carries no sound. Some
 * previews therefore played mute under a button claiming otherwise, with nothing
 * separating them from the ones that worked — measured on twenty four real
 * videos on 29 August 2026, the choice of format was identical throughout, so
 * what differed could only be what happened afterwards.
 *
 * Called from one place only, the one that has just laid the sound track's
 * header into its buffer.
 */
function armSound(a, v) {
  if (preview?.video !== v || a.sound) return;
  // The video stays as `placeVideo` left it, muted. Nothing here turns the sound
  // on: the button is the only thing that does, and it does it for this
  // thumbnail alone. See its own header for why.
  placeSoundButton(a, v);
}

/**
 * The two speakers, drawn rather than written.
 *
 * An emoji was tried first and looked like an emoji: coloured, sized by the
 * font, different on every system. These are the shapes YouTube's own player
 * uses, in a single colour, sized by the box that holds them.
 */
const SOUND_OFF_PATH = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm'
  + '2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c'
  + '2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 '
  + '1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';
const SOUND_ON_PATH = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 '
  + '2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 '
  + '7-4.49 7-8.77s-2.99-7.86-7-8.77z';

/**
 * The button that turns the sound on, under the hiding cross.
 *
 * It only appears when there is something to hear, and that is decided by
 * `armSound`, not here: a button that would do nothing is worse than no button.
 *
 * **Its state is this thumbnail's and nothing else's**, which is a reversal. The
 * choice used to hold for the whole page once made, on the reasoning that having
 * to unmute each thumbnail in turn would be its own irritation. Used, it is the
 * other way round: one click, and every thumbnail the cursor crosses afterwards
 * starts talking, which is what a grid of previews must never do. So every
 * preview is born muted, here as at every page load, and the sound is a thing
 * asked for one video at a time. Leaving a thumbnail and coming back asks
 * again: the video is destroyed with the preview and the next one is new.
 *
 * It appears exactly like the cross, by the same CSS rule: two buttons in the
 * same column that behaved differently read as a defect. It exists only while a
 * preview is playing, so the two are only ever seen together anyway.
 */
function placeSoundButton(a, v) {
  const b = document.createElement('button');
  b.className = 'tracktube-sound';
  b.type = 'button';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svg.append(path);
  b.append(svg);

  const paint = () => {
    path.setAttribute('d', v.muted ? SOUND_OFF_PATH : SOUND_ON_PATH);
    b.setAttribute('aria-label', t(v.muted ? 'card.sound.on' : 'card.sound.off'));
    b.setAttribute('aria-pressed', String(!v.muted));
  };
  paint();

  b.addEventListener('click', (e) => {
    // The thumbnail is wrapped in the video's link: without this the click would
    // leave the page instead of turning the sound on.
    e.preventDefault();
    e.stopPropagation();
    v.muted = !v.muted;
    // Sound out loud is a gesture Chrome recognises as a user action, so the
    // playback it may have refused earlier becomes possible here.
    if (!v.muted && v.paused) v.play().catch(() => {});
    paint();
  });

  a.sound = b;
  // On the card, not on the thumbnail, and that is the whole alignment. The
  // cross hangs from the card, which is eight pixels wider than the thumbnail:
  // the same `right: 16px` on the two parents put the two buttons eight pixels
  // apart, measured. Same parent, same column.
  a.card.append(b);
}

/** The red line and its dot, placed where playback stands. */
function placePlayhead(a, v) {
  if (!(v.duration > 0)) return;
  const frac = `${Math.min(1, Math.max(0, v.currentTime / v.duration)) * 100}%`;
  a.mark.style.width = frac;
  a.point.style.left = frac;
}

/**
 * Wires the video to a stream we feed ourselves, rather than to the address.
 *
 * Three reasons, in this order:
 *
 * - handing the address to the tag does not work inside YouTube's page. It works
 *   everywhere else, including in a local page served by hand, with exactly the
 *   same stream. The page's directives, its service worker and the request's
 *   origin were measured and ruled out; the cause stays unknown, but this path
 *   does not meet it;
 * - a preview only lasts as long as a hover. A tag given an address downloads
 *   from the beginning; eight megabytes to show five seconds of it, on every
 *   thumbnail passed over, would be indecent;
 * - jumping to a precise instant becomes one round trip instead of a
 *   renegotiation, which is the whole point of clicking the rail.
 *
 * Picture and sound are two separate files and therefore two buffers laid into
 * the same `MediaSource`. The picture alone decides whether this path is taken:
 * a sound track we cannot read costs the preview nothing, a picture we cannot
 * read costs it everything.
 *
 * The fallback on the direct address stays for formats that do not advertise
 * their ranges, and for a codec the tag would play but `MediaSource` refuses.
 * That fallback is silent — the address is picture only.
 */
const usableTrack = (s) => Boolean(
  s?.mime && s.init && s.index && s.init.start === 0
  && typeof MediaSource === 'function' && MediaSource.isTypeSupported(s.mime),
);

function wireStream(a, v) {
  if (!usableTrack(a.stream)) {
    // Picture only, and irremediably so: the address is one half of an adaptive
    // pair. Nothing calls `armSound` on this path, and that is the point — the
    // preview stays mute and says so by having no button.
    v.src = a.stream.url;
    v.play().catch(() => {});
    return;
  }

  const specs = [a.stream];
  if (a.audio && usableTrack(a.audio)) specs.push(a.audio);

  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  // A video shorter than the window is reachable throughout, and must not be
  // shaded for a limit it never meets.
  a.source = { ms, objectUrl, tracks: [], ready: false, gen: 0, probing: false,
    reach: a.duration > PREVIEW_ASSUMED_REACH_S ? PREVIEW_ASSUMED_REACH_S : null,
    controller: new AbortController() };
  ms.addEventListener('sourceopen', () => openSource(a, v, ms, specs), { once: true });
  v.src = objectUrl;
}

/** Prepares the buffers, reads the segment maps, and starts playback. */
async function openSource(a, v, ms, specs) {
  const s = a.source;
  try {
    // Announced before anything is laid down: without a duration, `currentTime`
    // refuses to be moved, and a click that came early would do nothing at all.
    if (a.duration > 0) ms.duration = a.duration;

    // Probe before creating SourceBuffers: an empty audio buffer prevents the
    // video buffer from ever becoming playable.
    const probe = async (first, alternatives) => {
      const options = [first, ...alternatives.filter(x => x.url !== first.url)]
        .filter(usableTrack).slice(0, MAX_TRACK_PROBES);
      for (const spec of options) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (preview?.video !== v || s.controller.signal.aborted) return null;
          try {
            const head = await bytes(spec.url, 0, spec.index.end, s.controller.signal);
            const segments = readSidx(head, spec.index.start);
            if (segments?.length) return { spec, head, segments };
            break;
          } catch (err) {
            if (s.controller.signal.aborted) return null;
            if (err?.refused) break;
          }
        }
      }
      return null;
    };
    const resolved = await Promise.all(specs.map((spec, i) => probe(spec, i ? a.audios : a.streams)));
    if (preview?.video !== v || ms.readyState !== 'open') return;
    if (!resolved[0]) throw new Error('segment map unreadable');
    if (specs.length > 1 && !resolved[1]) {
      previewInfos.delete(a.videoId);
      if (!a.retries) { recoverPreview(a); return; }
    }
    // All buffers exist before the first append, as Chromium requires.
    for (const result of resolved.filter(Boolean)) {
      const sb = ms.addSourceBuffer(result.spec.mime);
      sb.mode = 'segments';
      s.tracks.push({ sb, spec: result.spec, segments: result.segments,
        busy: false, last: -1, failures: 0, reached: 0, head: result.head });
    }
    for (const track of s.tracks) {
      await append(track.sb, track.head);
      delete track.head;
      if (preview?.video !== v) return;
    }

    // The picture's map gives the stream's exact duration, and it has to be
    // announced. The feed does not always know it, and when it does it is
    // rounded to the second, sometimes past the last frame — aiming there
    // amounts to aiming at a fragment that does not exist.
    const map = s.tracks[0].segments;
    const lastSeg = map[map.length - 1];
    const total = lastSeg.time + lastSeg.duration;
    if (total > 0) ms.duration = total;

    s.ready = true;
    // Here and not at `wireStream`: the exact duration is only known once the
    // picture's map has been read, and the shading is a fraction of it.
    paintReach(a);
    v.play().catch(() => {});
    feedBuffer(a);

    // Here and nowhere else: a second buffer in the list is a sound track whose
    // header has been read and laid down, which is the only proof there will be
    // anything to hear.
    if (s.tracks.length > 1) armSound(a, v);
  } catch (err) {
    if (preview?.video !== v) return;
    log.debug('Preview stream initialization failed');
    recoverPreview(a);
  }
}

/**
 * Empties every buffer, and disowns the transfers under way.
 *
 * The generation number is what disowns them: a range asked for before the jump
 * would otherwise land after the clearing and put back exactly the island one
 * was trying to get rid of.
 */
function clearBuffers(a) {
  const s = a.source;
  if (!s) return;
  s.gen += 1;
  for (const tr of s.tracks) {
    try {
      if (tr.sb.updating) tr.sb.abort();
      if (tr.sb.buffered.length) tr.sb.remove(0, Number.POSITIVE_INFINITY);
    } catch (err) {
      log.debug('Preview buffer not clearable', err);
    }
    tr.busy = false;
  }
  // Emptying is asynchronous. Without this, the request that follows a jump
  // finds every buffer busy, gives up, and nothing calls it back — the picture
  // stays where it was until the watchdog fires a second later.
  refeedWhenIdle(a);
}

/** Claims again as soon as the buffers have finished what they were doing. */
function refeedWhenIdle(a) {
  const s = a.source;
  const v = a.video;
  if (!s || !v) return;
  for (const tr of s.tracks) {
    if (!tr.sb.updating) continue;
    tr.sb.addEventListener('updateend', () => {
      if (preview?.video === v) feedBuffer(a);
    }, { once: true });
  }
}

/**
 * Watches a jump that never lands.
 *
 * An mp4 fragment does not necessarily begin at the instant its map announces:
 * composition offsets can push the first decodable sample a few tens of
 * milliseconds further on. Aiming at the announced instant then waits for a
 * sample that will never come, with everything already downloaded — the picture
 * frozen as if it were still loading, which is exactly what a click in the
 * middle of the rail produced.
 *
 * `realign` covers the case as playback goes; this covers the case where
 * playback never restarts, and therefore where nothing calls `realign` any more.
 */
const PREVIEW_STALL_MS = 1200;

function armStallWatch(a, v) {
  clearTimeout(a.stall);
  a.stall = setTimeout(() => {
    if (preview?.video !== v || v.readyState >= 3) return;
    const b = v.buffered;
    for (let i = 0; i < b.length; i += 1) {
      if (b.end(i) - v.currentTime < 0.2) continue;
      if (Math.abs(b.start(i) - v.currentTime) > PREVIEW_BUFFER_S) continue;
      v.currentTime = Math.max(b.start(i) + 0.05, v.currentTime);
      v.play().catch(() => {});
      return;
    }
    feedBuffer(a);
  }, PREVIEW_STALL_MS);
}

/**
 * The segment map, read from the `sidx` box.
 *
 * It gives, for each fragment, its place in the file and its duration. Without
 * it one would have to guess where to cut, and an mp4 fragment cut in the wrong
 * place is not refused: it simply does not play.
 *
 * @param {ArrayBuffer} head the start of the file, up to the end of the map
 * @param {number} start position of the box in the file
 * @returns {Array<{start: number, end: number, time: number, duration: number}>|null}
 */
function readSidx(head, start) {
  const view = new DataView(head);
  if (start + 16 > view.byteLength) return null;

  const size = view.getUint32(start);
  const name = String.fromCharCode(
    view.getUint8(start + 4), view.getUint8(start + 5),
    view.getUint8(start + 6), view.getUint8(start + 7),
  );
  if (name !== 'sidx') return null;

  let p = start + 8;
  const version = view.getUint8(p);
  p += 4;                          // version and flags
  p += 4;                          // track identifier
  const scale = view.getUint32(p);
  p += 4;
  // The instant the first fragment starts at is not always zero, and it is the
  // origin of every time that follows. Read rather than skipped: taken as zero
  // on a track that starts later — the sound track, typically — every
  // instant is shifted, and a jump lands on the wrong fragment.
  let first;
  let gap;
  if (version === 0) {
    first = view.getUint32(p);
    p += 4;
    gap = view.getUint32(p);
    p += 4;
  } else {
    first = Number(view.getBigUint64(p));
    p += 8;
    gap = Number(view.getBigUint64(p));
    p += 8;
  }
  p += 2;                          // reserved
  const count = view.getUint16(p);
  p += 2;
  if (!(scale > 0) || !(count > 0)) return null;

  const segments = [];
  let position = start + size + gap;
  let time = first / scale;
  for (let i = 0; i < count; i += 1) {
    if (p + 12 > view.byteLength) break;
    const segBytes = view.getUint32(p) & 0x7fffffff;
    const duration = view.getUint32(p + 4) / scale;
    p += 12;                       // size, duration, and entry point
    segments.push({ start: position, end: position + segBytes - 1, time, duration });
    position += segBytes;
    time += duration;
  }
  return segments.length ? segments : null;
}

/**
 * Claims what is missing ahead of the playhead, on every track.
 *
 * One segment at a time and per track: the video is only a preview and the
 * cursor can leave at any moment. Better to ask often for little than to start a
 * long transfer whose end nobody will see.
 */
function feedBuffer(a) {
  const s = a.source;
  const v = a.video;
  if (!s?.ready || !v || s.ms.readyState !== 'open') return;

  // Nothing under the playhead although the buffer is not empty: what was laid
  // down starts a little further on. Fragment boundaries do not always fall where
  // the map announces them, and aiming between two leaves the picture frozen,
  // waiting for bytes that will never come. Better to bring playback there than
  // to ask endlessly for the same fragment.
  if (v.readyState < 2 && realign(v)) return;

  for (const tr of s.tracks) feedTrack(a, v, tr);
}

function feedTrack(a, v, tr) {
  const s = a.source;
  if (!tr.segments || tr.busy) return;
  if (tr.sb.updating) { refeedWhenIdle(a); return; }

  const t = v.currentTime;
  const buffered = tr.sb.buffered;

  // What has already gone by will not serve again, and the buffer has a
  // capacity: on a thumbnail kept long under the cursor, it would end up
  // overflowing. Only what surrounds the playhead is worth measuring — an island
  // left far behind by a jump is cleared elsewhere, not here.
  if (bufferedAround(buffered, t) && t - rangeStart(buffered, t) > PREVIEW_BUFFER_S) {
    tr.sb.addEventListener('updateend', () => { if (preview?.video === v) feedBuffer(a); }, { once: true });
    tr.sb.remove(0, t - PREVIEW_LEAD_S);
    return;
  }

  const edge = rangeEnd(buffered, t);
  if (edge - t >= PREVIEW_LEAD_S) return;

  const aim = edge > t ? edge : t;
  const i = tr.segments.findIndex((g) => g.time + g.duration > aim + 0.01);
  if (i < 0) return;

  // The same segment claimed twice in a row is a segment that brings nothing:
  // laid down, it did not make the buffer grow. A third request would change
  // nothing and the loop would spin without end, picture frozen. The tally starts
  // over as soon as another segment is aimed at, and therefore as soon as
  // playback moves on or a click takes it elsewhere.
  if (i === tr.last) {
    if (tr.failures >= 2) return;
    tr.failures += 1;
  } else {
    tr.last = i;
    tr.failures = 0;
  }

  const gen = s.gen;
  tr.busy = true;
  bytes(tr.spec.url, tr.segments[i].start, tr.segments[i].end, s.controller.signal)
    .then((buf) => {
      // A jump happened while this was in flight: laying it down would put back
      // the island the jump had just cleared.
      if (preview?.video !== v || s.gen !== gen || s.ms.readyState !== 'open') return null;
      if (i > tr.reached) tr.reached = i;
      return append(tr.sb, buf);
    })
    .catch((err) => {
      if (err?.refused && preview?.video === v) noteReach(a, tr, i);
      else log.debug('Preview segment missing', err);
    })
    .then(() => {
      if (s.gen !== gen) return;
      tr.busy = false;
      if (preview?.video === v) feedBuffer(a);
    });
}

/** Lays bytes into the buffer, and waits until it has swallowed them. */
function append(sb, buf) {
  return new Promise((resolve, reject) => {
    const done = () => { sb.removeEventListener('error', failed); resolve(); };
    const failed = () => { sb.removeEventListener('updateend', done); reject(new Error('buffer refused')); };
    sb.addEventListener('updateend', done, { once: true });
    sb.addEventListener('error', failed, { once: true });
    try {
      sb.appendBuffer(buf);
    } catch (err) {
      sb.removeEventListener('updateend', done);
      sb.removeEventListener('error', failed);
      reject(err);
    }
  });
}

/**
 * A byte range of the stream.
 *
 * The range goes through the address and not through the `Range` header: that
 * header is not one a cross-origin request may set outright, and each one would
 * then be preceded by a preflight. YouTube's servers accept both forms; this one
 * costs one round trip fewer.
 */
async function bytes(url, start, end, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 6000);
  try {
    try {
      return await rangeRequest(url, start, end, controller.signal, false);
    } catch (err) {
      // A refusal is an answer, and asking again differently only repeats it.
      // What is retried here is the absence of an answer.
      if (err?.refused || controller.signal.aborted) throw err;
      return await rangeRequest(url, start, end, controller.signal, true);
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * One attempt at one range, in one of the two forms the host accepts.
 *
 * A plain range request to `googlevideo` sometimes fails outright — a rejected
 * `fetch`, not an HTTP status — and the address it fails on changes from one
 * player response to the next. Measured on 7 October 2026 on `vDecQhtOtGw` and
 * `fUQru0SzyMY`: the audio header was refused that way six times out of eight,
 * while the very same request carrying `alr=yes` answered 200 with
 * `content-type: audio/mp4` and exactly the number of bytes asked for, eight
 * times out of eight. That is the whole explanation of "some previews have no
 * sound": the picture came from a host that answered and the sound from one that
 * did not, and nothing ever asked the second one differently. The two tracks are
 * two files on two hosts, which is why one can fail alone.
 *
 * `alr=yes` cannot be the only form. Past the readable window it answers **200
 * with a `text/plain` body** carrying an address instead of media — around 1 200
 * bytes where thousands were asked for, measured on `DiQhipeBR3k` at a quarter,
 * a half and nine tenths of the file. Appending that to a buffer would poison
 * it, so a text answer is read as the refusal it is and marks the boundary like
 * a 403.
 */
async function rangeRequest(url, start, end, signal, alternate) {
  const separator = url.includes('?') ? '&' : '?';
  const rep = await fetch(url + separator + 'range=' + start + '-' + end + (alternate ? '&alr=yes' : ''),
    { credentials: 'omit', signal });
  if (!rep.ok) {
    const err = new Error('range ' + rep.status);
    err.refused = rep.status === 403;
    throw err;
  }
  if ((rep.headers.get('content-type') ?? '').startsWith('text/')) {
    const err = new Error('range answered with an address');
    err.refused = true;
    throw err;
  }
  return await rep.arrayBuffer();
}

/**
 * The instant beyond which the server stops serving.
 *
 * Measured on 28 August 2026, on `Qtl8lJwbd4g`: a byte range inside the first
 * minute and a half comes back 200, one further in comes back **403**, and the
 * refusal is immediate and repeatable — a range at the start still works right
 * after, so nothing is being poisoned. Same answer whether the range travels in
 * the address or in a `Range` header. The boundary moves with the format, from
 * around 600 KB on the 144p stream to around 4 MB on the 360p one, that is to
 * say roughly the same hundred seconds of picture either way.
 *
 * This is the whole explanation of "clicking in the middle does nothing". It was
 * taken for a buffering defect and it is not one: the bytes are refused. The
 * YouTube player gets them because its address is signed by an attested session;
 * ours deliberately carries no cookie, and a preview is not worth a session.
 *
 * So rather than let the picture freeze on a click that can lead nowhere, the
 * boundary is learnt from the first refusal and the rail shades what lies beyond
 * it. Scrubbing keeps working over the whole video — the storyboards are
 * separate images and no limit touches them.
 */
async function noteReach(a, track, refused) {
  const s = a.source;
  if (!s || s.probing || (s.reach !== null && s.reach <= track.segments[refused].time)) return;
  s.probing = true;

  // A refusal at the middle of the rail says the middle is out of reach, not
  // where the reach ends. Shading only from the click would claim more than the
  // stream gives, and the point of the shading is to claim exactly what it
  // gives. So the boundary is looked for, between the last segment that came
  // back and the one that did not.
  //
  // One byte per probe and five probes at most: a boundary among two hundred and
  // fifty segments is found in eight halvings, and the ones that matter are the
  // first. It costs less than the segment whose refusal started it.
  let lo = track.reached;
  let hi = refused;
  for (let i = 0; i < 5 && hi - lo > 1; i += 1) {
    const mid = Math.floor((lo + hi) / 2);
    const at = track.segments[mid].start;
    // eslint-disable-next-line no-await-in-loop
    const ok = await bytes(track.spec.url, at, at).then(() => true, () => false);
    if (preview?.video !== a.video) { s.probing = false; return; }
    if (ok) lo = mid; else hi = mid;
  }

  s.probing = false;
  s.reach = track.segments[hi].time;
  log.debug(`Preview readable up to ${Math.round(s.reach)} s`);
  paintReach(a);

  // The click that ran into the boundary left the picture on a frame it can
  // never leave. It goes back where it was: the click did nothing, and the rail
  // now says why.
  const v = a.video;
  if (v && !withinReach(a, v.currentTime)) {
    v.currentTime = Math.min(a.before ?? 0, Math.max(0, s.reach - 1));
    v.play().catch(() => {});
  }
}

function paintReach(a) {
  const reach = a.source?.reach;
  const total = previewDuration(a);
  // Same coercion trap as in `withinReach`: `null >= 0` is true, and shading
  // `1 - null / total` would have covered the whole rail the moment this was
  // called before any boundary was known.
  if (!Number.isFinite(reach) || !(total > 0)) { a.reach.style.width = '0'; return; }
  a.reach.style.width = `${Math.max(0, 1 - reach / total) * 100}%`;
}

/**
 * Is this instant one playback can be taken to?
 *
 * `Number.isFinite` and not `reach >= 0`, because **`null >= 0` is `true`** in
 * JavaScript: `null` is coerced to zero. The guard was meant to read "no
 * boundary known, everything is allowed" and read the exact opposite — with no
 * boundary it fell through to `seconds < null`, that is `seconds < 0`, false for
 * every instant. A boundary is only learnt from a refusal, so a preview just
 * opened had none, and the click that was supposed to move playback was refused
 * before any byte was asked for. The rail gesture had never worked on a fresh
 * thumbnail; it looked like the server's sixty second limit and it was ours.
 */
function withinReach(a, seconds) {
  const reach = a.source?.reach;
  return !Number.isFinite(reach) || seconds < reach;
}

/**
 * Brings the playhead back into what has been laid down, if it landed just
 * beside it.
 *
 * Forwards only, and barely: going back would replay a passage already seen, and
 * a big leap forward would skip one. Beyond one fragment's gap, this is no longer
 * a boundary offset but a hole, and it is for the next request to fill it.
 *
 * @returns {boolean} true if playback was moved
 */
function realign(v) {
  const t = v.currentTime;
  const b = v.buffered;
  let target = -1;
  for (let i = 0; i < b.length; i += 1) {
    if (t >= b.start(i) - 0.1 && t <= b.end(i)) return false;
    if (b.start(i) > t && (target < 0 || b.start(i) < target)) target = b.start(i);
  }
  if (target < 0 || target - t > PREVIEW_LEAD_S + 4) return false;
  v.currentTime = target + 0.05;
  return true;
}

/** Is this instant inside one of these ranges? */
function bufferedAround(ranges, t) {
  for (let i = 0; i < ranges.length; i += 1) {
    if (t >= ranges.start(i) - 0.1 && t <= ranges.end(i)) return true;
  }
  return false;
}

/** How far the range containing this instant reaches. */
function rangeEnd(ranges, t) {
  for (let i = 0; i < ranges.length; i += 1) {
    if (t >= ranges.start(i) - 0.1 && t <= ranges.end(i)) return ranges.end(i);
  }
  return t;
}

/** Where the range containing this instant begins. */
function rangeStart(ranges, t) {
  for (let i = 0; i < ranges.length; i += 1) {
    if (t >= ranges.start(i) - 0.1 && t <= ranges.end(i)) return ranges.start(i);
  }
  return t;
}

/**
 * The cursor moves over the thumbnail: which frame of the video to show?
 *
 * The frame is laid down immediately, without going through
 * `requestAnimationFrame`. Chrome already aligns `pointermove` delivery on the
 * display frame — `pointerrawupdate` is what gives the sensor's raw failed — so
 * deferring the computation would save nothing and add one frame of lag.
 */
function onPointerMove(e) {
  const a = preview;
  if (!a?.storyboard) return;

  const rect = a.thumb.getBoundingClientRect();
  const inside = e.clientX >= rect.left && e.clientX <= rect.right
    && e.clientY >= rect.top && e.clientY <= rect.bottom;
  const onRail = inside && e.clientY >= rect.bottom - PREVIEW_RAIL_PX;

  // Aiming is not scrubbing. The frame follows the cursor over the whole
  // thumbnail, because that is what the storyboards are for and the video goes
  // on playing under the box; the band keeps the gesture that moves playback.
  if (onRail !== a.scrubbing) {
    a.scrubbing = onRail;
    a.thumb.classList.toggle('is-scrubbing', onRail);
    // The timestamp belongs to the band alone: a click above it must open the
    // video where it starts, not where the cursor happened to pass.
    if (!onRail && a.link) a.link.setAttribute('href', a.hrefBase);
  }
  if (inside !== a.aiming) {
    a.aiming = inside;
    a.thumb.classList.toggle('is-aiming', inside);
    if (!inside) leaveRail(a);
  }
  if (!inside) return;

  a.frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  placeSheet(a);
  if (onRail) aimInstant(a);
}

/**
 * The cursor leaves the rail: the link gets its address back, timestamp free.
 *
 * What was chosen with a click is not undone here: playback stays where it was
 * put, and only another click moves it.
 */
function leaveRail(a) {
  a.hover.style.width = '0';
  if (a.link) a.link.setAttribute('href', a.hrefBase);
}

/**
 * A click in the rail's band moves playback instead of opening the video.
 *
 * This is YouTube's player gesture: aim at an instant, click, playback resumes
 * there and carries on. Navigating would make no sense here, it would leave the
 * page one is in the middle of running through.
 *
 * Only a bare left click is captured, and only inside the band. Middle click and
 * modified clicks open the video as usual, at the instant aimed at, since the
 * link carries its timestamp.
 *
 * The click is kept even when the video is not there yet: the instant is set
 * aside, and playback will start on it. Opening the page instead would be a
 * surprise, when the rail has just invited a click.
 */
function onPreviewClick(e) {
  const a = preview;
  if (!a?.storyboard && !a?.stream) return;
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

  const rect = a.thumb.getBoundingClientRect();
  if (e.clientY < rect.bottom - PREVIEW_RAIL_PX || e.clientY > rect.bottom) return;
  if (e.clientX < rect.left || e.clientX > rect.right) return;

  e.preventDefault();
  e.stopPropagation();

  a.instant = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));

  // The hover box stays: the cursor is still on the rail, and YouTube's player
  // keeps it too while one is there. A first attempt removed it on click, which
  // uncovered the six second animation and gave the impression that the click
  // took you back to the start.
  const v = a.video;
  if (!v) return;
  // Never quite at the end: aiming at the last second gives no segment to play,
  // and the picture would stay frozen where it is.
  if (!(v.duration > 0)) return;
  const target = Math.min(a.instant, 0.995) * v.duration;
  // Past what the server serves, playback stays where it is rather than freeze
  // on a jump that cannot land. The rail already says so, shaded from that point
  // on, and the hover box goes on showing the frame aimed at while the video
  // keeps playing underneath — a full size still was tried here and refused:
  // it stopped the playback one wants to keep watching while scrubbing.
  if (!withinReach(a, target)) return;
  // Where to come back to if the jump turns out to be refused. The first click
  // of a preview cannot know: the boundary is only learnt from a refusal, and
  // that one click is what pays for the lesson.
  a.before = v.currentTime;
  v.currentTime = target;
  v.play().catch(() => {});
}

/**
 * The link's address carries the instant aimed at while the cursor stays on the
 * rail.
 *
 * Left click does not use it, being intercepted; but middle click and "open in a
 * new tab" carry it along, and land at the spot one was looking at.
 */
function aimInstant(a) {
  if (!a.link) return;
  const seconds = Math.floor(a.frac * previewDuration(a));
  a.link.setAttribute('href', seconds > 0 ? `${a.hrefBase}&t=${seconds}s` : a.hrefBase);
}

/**
 * The duration the scrubbing covers.
 *
 * The video's when it is known, otherwise the one the storyboards describe, give
 * or take one interval.
 */
function previewDuration(a) {
  if (a.video && a.video.duration > 0) return a.video.duration;
  if (a.duration > 0) return a.duration;
  return a.storyboard ? (a.storyboard.count * a.storyboard.intervalMs) / 1000 : 0;
}

function placeSheet(a) {
  const sb = a.storyboard;
  const index = Math.min(sb.count - 1, Math.floor(a.frac * sb.count));
  const perSheet = sb.columns * sb.rows;
  const sheet = Math.floor(index / perSheet);
  const url = sb.urls[sheet];
  if (!url) return;

  const cell = index % perSheet;
  const column = cell % sb.columns;
  const row = Math.floor(cell / sb.columns);
  // The last sheet is often incomplete, and the image is then shorter: cutting it
  // into as many rows as the others would shift everything.
  const rowsHere = Math.min(sb.rows, Math.ceil((sb.count - sheet * perSheet) / sb.columns));

  const style = a.image.style;
  if (a.sheet !== sheet) {
    style.backgroundImage = `url("${url}")`;
    a.sheet = sheet;
  }
  style.backgroundSize = `${sb.columns * 100}% ${rowsHere * 100}%`;
  style.backgroundPosition = `${percent(column, sb.columns)} ${percent(row, rowsHere)}`;

  // The box follows the cursor but does not spill out of the thumbnail: at the
  // edges it stops, and the rail's dot carries on alone.
  const boxWidth = a.thumb.clientWidth;
  const free = Math.max(4, boxWidth - PREVIEW_SHEET_PX - 4);
  a.scrub.style.left = `${Math.min(Math.max(a.frac * boxWidth - PREVIEW_SHEET_PX / 2, 4), free)}px`;

  // Everything to the left of the mouse lightens: that is the whole mark of the
  // aim on the rail, and it cannot be mistaken for playback.
  a.hover.style.width = `${a.frac * 100}%`;

  const duration = previewDuration(a);
  a.time.textContent = duration > 0 ? formatDuration(a.frac * duration) : '';
}

/** Position of one cell within a sheet, as a background percentage. */
function percent(index, total) {
  return total > 1 ? `${(index / (total - 1)) * 100}%` : '0%';
}

function armPreview(card, video) {
  if (!settings.showPreview || !finePointer.matches) return;
  // An announced broadcast has nothing to show, and a selection under way is no
  // time to make thumbnails move under the cursor.
  if (state.selecting || video.isUpcoming) return;

  // Coming back onto the thumbnail one had just left: the preview is still
  // there, running where it was. Reopening it would start it over from the
  // beginning, which is exactly what made a small slip of the mouse feel like a
  // punishment.
  //
  // Only for the card that owns it. Cancelling the grace from the neighbouring
  // card would leave the old preview playing for the six tenths that card takes
  // to open its own, under a cursor that is no longer on it.
  if (preview?.videoId === video.id && card.contains(preview.thumb)) {
    clearTimeout(previewGrace);
    previewGrace = null;
    return;
  }

  clearTimeout(previewTimer);
  previewArming = card;
  previewWanted = video.id;
  previewTimer = setTimeout(() => {
    previewTimer = null;
    previewArming = null;
    if (previewWanted === video.id) openPreview(card, video);
  }, PREVIEW_DELAY_MS);
}

/**
 * Leaving the card does not put the preview out straight away.
 *
 * The thumbnail's edges are where one aims at the rail, at the cross, at the
 * sound: the mouse goes past them constantly, by a few pixels, and closing on
 * the instant meant losing playback and starting over from zero. Half a second
 * of grace covers a slip; it does not cover a departure, and running the cursor
 * across the grid still leaves nothing behind, since the neighbouring card takes
 * six tenths to open its own.
 */
const PREVIEW_GRACE_MS = 500;

function disarmPreview(card) {
  // Only this card's own arming. The browser delivers the leave of one card and
  // the entry onto the next in either order depending on where the pointer
  // crosses, so cancelling blindly cancelled the arrival as often as the
  // departure.
  if (previewArming === card) {
    clearTimeout(previewTimer);
    previewTimer = null;
    previewArming = null;
    previewWanted = null;
  }

  // Only ours: a hover exit landing after the entry onto the neighbouring card
  // must not put out the preview that card has just opened.
  if (!preview || !card.contains(preview.thumb)) return;
  clearTimeout(previewGrace);
  previewGrace = setTimeout(() => {
    previewGrace = null;
    // The card may have been hovered again in between without a `pointerenter`
    // ever firing — a scroll under a still cursor does that.
    //
    // `removePreview` and not `closePreview`: this grace belongs to the card
    // being left, and closing everything would take the neighbour's pending
    // arming down with it. That is precisely the bug this replaced — running
    // from one card to the next opened nothing, because the grace of the first
    // fired at half a second and wiped the timer of the second, due at six
    // tenths.
    if (preview && card.contains(preview.thumb) && !card.matches(':hover')) removePreview();
  }, PREVIEW_GRACE_MS);
}

// A tab sent to the background would otherwise keep an animation running, with
// no `pointerleave` ever coming to stop it.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) closePreview();
  else screenVisibleShorts();
});

// ---------------------------------------------------------------------------
// Rendering a thumbnail
// ---------------------------------------------------------------------------

/**
 * Do we know how to paint this thumbnail's duration corner?
 *
 * A last guard, placed where we paint rather than where we query. The query has
 * its own, and that is the right place to hold a video back while it completes —
 * but it rests on the broadcast classification, which comes from YouTube and gets
 * it wrong: a premiere taken for an appointment, a replay with no duration. A
 * misclassified video then went through the filter and reached the grid with an
 * empty corner.
 *
 * The rule here is the only one that cannot be wrong: `buildBadge` returns
 * something, or the thumbnail is not painted.
 */
/**
 * Avatars actually loaded, one entry per channel.
 *
 * The database guard only ever knew whether an address was *recorded*, never
 * whether it still answers. YouTube's avatar addresses expire, and an expired
 * one silently became a coloured initial: half the grid, on a profile whose
 * subscriptions were imported weeks earlier. Reloading the page fixed it,
 * because the harvest then wrote a fresh address — which is exactly the manual
 * step that should not exist.
 *
 * The image is fetched here, before any card is built, and the promise is kept
 * per channel: one load for all of that channel's thumbnails, served from the
 * browser cache by the time the `img` in the card asks for it.
 *
 * @type {Map<string, Promise<string|null>>}
 */
const avatarLoads = new Map();

function loadAvatar(channelId, url) {
  const pending = avatarLoads.get(channelId);
  if (pending) return pending;
  const started = new Promise((resolve) => {
    const probe = new Image();
    probe.addEventListener('load', () => resolve(url), { once: true });
    probe.addEventListener('error', () => resolve(null), { once: true });
    probe.src = url;
  });
  avatarLoads.set(channelId, started);
  return started;
}

/**
 * Loads the avatars a batch of videos needs, and reports the channels whose
 * picture is really displayable.
 *
 * The addresses that fail are forgotten, in the tab and in the database alike:
 * that puts their channel back among those the catch-up refetches, and the
 * videos stay withheld until it has. A video is never shown with a stand-in
 * badge — that rule is the whole point of the guard.
 *
 * @param {object[]} items
 * @returns {Promise<Set<string>>} channel ids whose avatar is loaded
 */
async function loadAvatars(items) {
  const wanted = new Map();
  for (const video of items) {
    const id = video.channelId;
    if (!id || wanted.has(id)) continue;
    const url = channelsById.get(id)?.avatarUrl || video.channelAvatar;
    if (url) wanted.set(id, url);
  }
  if (!wanted.size) return new Set();

  const ready = new Set();
  const stale = [];
  await Promise.all([...wanted].map(async ([id, url]) => {
    if (await loadAvatar(id, url)) ready.add(id);
    else stale.push(id);
  }));

  if (stale.length) {
    for (const id of stale) {
      avatarLoads.delete(id);
      const channel = channelsById.get(id);
      if (channel) delete channel.avatarUrl;
    }
    send(MSG.DROP_AVATARS, { channelIds: stale }).catch(() => {});
    log.info(`${stale.length} avatar(s) no longer answer, their videos wait for a fresh one`);
  }
  return ready;
}

// Only confirmed exclusions and the current user view can withhold a card.
function paintable(video) {
  if (removedVideoIds.has(video.id)) return false;
  if (state.view === 'hidden' ? !video.hidden : video.hidden) return false;
  if (state.view === 'starred' && !video.starred) return false;
  return true;
}

function buildCard(video) {
  const channel = channelsById.get(video.channelId);

  const card = document.createElement('div');
  card.className = 'tracktube-card';
  card.dataset.videoId = video.id;
  // Needed to reinsert a new thumbnail at its chronological place rather than
  // blindly on top.
  card.dataset.publishedAt = String(video.publishedAt ?? 0);
  // Lets us find all of a channel's thumbnails again when its avatar arrives
  // afterwards.
  if (video.channelId) card.dataset.channelId = video.channelId;
  // A duration that arrives afterwards must be able to rebuild the right badge,
  // its "replay" marking included.
  if (video.wasLive) card.dataset.wasLive = '1';
  card.classList.toggle('is-hidden', Boolean(video.hidden));
  card.classList.toggle('is-starred', Boolean(video.starred));

  const href = `/watch?v=${encodeURIComponent(video.id)}`;

  const link = document.createElement('a');
  link.className = 'tracktube-link';
  link.href = href;

  // -- thumbnail
  const thumb = document.createElement('div');
  thumb.className = 'tracktube-thumb';

  const fallbackUrl = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  const thumbUrl = video.thumbUrl || fallbackUrl;

  const img = document.createElement('img');
  // Cards arrive in pages of 60. Start their images now: combining native lazy
  // loading with content-visibility can leave stills pending during scrolling.
  img.loading = 'eager';
  img.alt = '';
  // Loaded in CORS mode so the canvas can read it back without being "tainted" —
  // that is what makes the dominant colour computable. YouTube's stills answer
  // `Access-Control-Allow-Origin: *`, but a host that did not would make the load
  // fail outright: hence the fallback, which reloads the image without CORS
  // rather than show a hole. One then loses the tint, not the thumbnail.
  img.crossOrigin = 'anonymous';
  const recoverThumbnail = () => {
    if (img.hasAttribute('crossorigin')) {
      img.removeAttribute('crossorigin');
      img.src = thumbUrl;
    } else if (img.src !== fallbackUrl) {
      // Collected URLs can expire or name a resolution that no longer exists.
      // Keep the same video, using the stable still already used for RSS rows.
      img.src = fallbackUrl;
    } else {
      img.removeEventListener('error', recoverThumbnail);
    }
  };
  img.addEventListener('error', recoverThumbnail);
  img.src = thumbUrl;
  thumb.append(img);

  // The hover tint is computed on the first hover only: the grid shows sixty of
  // them, and lights only one at a time.
  card.addEventListener('pointerenter', () => tintCard(card, img), { once: true });

  // The preview, for its part, replays on every hover.
  card.addEventListener('pointerenter', () => armPreview(card, video));
  card.addEventListener('pointerleave', () => disarmPreview(card));

  const badge = buildBadge(video);
  if (badge) thumb.append(badge);

  if (video.watchProgress > 0) {
    const bar = document.createElement('span');
    bar.className = 'tracktube-progress';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(video.watchProgress * 100)}%`;
    bar.append(fill);
    thumb.append(bar);
  }

  const tick = document.createElement('span');
  tick.className = 'tracktube-tick';
  tick.textContent = '✓';
  thumb.append(tick);

  link.append(thumb);
  card.append(link);

  // -- metadata, outside the thumbnail's link
  const meta = document.createElement('div');
  meta.className = 'tracktube-meta';

  meta.append(buildAvatar(channel, video));

  const text = document.createElement('div');
  text.className = 'tracktube-text';

  const titleLink = document.createElement('a');
  titleLink.className = 'tracktube-title-link';
  titleLink.href = href;

  const title = document.createElement('h3');
  title.className = 'tracktube-title';
  title.textContent = video.title;
  titleLink.append(title);
  text.append(titleLink);

  // The channel name filters the feed instead of opening the video: that is the
  // natural gesture for "show me only what this channel published".
  //
  // It is nonetheless an `a` carrying the channel's address, and that is not
  // decoration. A span answers nothing to a middle click, to a control click or
  // to "open in a new tab" — the gestures one makes on a name without thinking
  // — and the silence reads as a broken element. The address is there for the
  // browser to honour those; the plain left click alone is taken back, and it
  // filters.
  const byline = document.createElement(video.channelId ? 'a' : 'span');
  byline.className = 'tracktube-byline';
  if (video.channelId) byline.href = `https://www.youtube.com/channel/${video.channelId}`;
  byline.textContent = channel?.title || video.channelTitle || '';
  byline.setAttribute('aria-label', t('card.channel.only'));
  byline.addEventListener('click', (e) => {
    if (state.selecting) return; // the selection keeps priority
    // A modified click belongs to the browser: it opens the channel in a new
    // tab, or in a new window, and we have nothing better to offer than that.
    // Middle click does not even come through here — it fires `auxclick` — which
    // is exactly why the address had to exist.
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    state.channelId = video.channelId;
    reload();
  });
  text.append(byline);

  const stats = document.createElement('div');
  stats.className = 'tracktube-stats';
  stats.textContent = [formatViews(video.views), relativeTime(video.publishedAt)]
    .filter(Boolean).join(' • ');
  text.append(stats);

  meta.append(text);

  // -- ⋮ menu: level with the text, bottom right, as on YouTube.
  // The text block to its left is bounded by the flex layout, so titles stop
  // before the button instead of running underneath it.
  const menuBtn = document.createElement('button');
  menuBtn.className = 'tracktube-menu-btn';
  menuBtn.type = 'button';
  menuBtn.textContent = '⋮';
  // No `title`: the browser's grey tooltip opened on hovering the button, right
  // in the middle of the next thumbnail, to restate what three dots already say.
  // YouTube does not set one either. The accessibility label does stay.
  menuBtn.setAttribute('aria-label', t('card.menu.aria', { title: video.title }));
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCardMenu(video, menuBtn);
  });
  meta.append(menuBtn);

  card.append(meta);

  // -- single item actions, deliberately outside the link so as not to navigate
  const hide = document.createElement('button');
  hide.className = 'tracktube-hide';
  hide.type = 'button';
  // On an already hidden video — visible only in "Hidden" mode — the same button
  // serves to put it back into the feed.
  hide.textContent = video.hidden ? '↺' : '✕';
  hide.setAttribute('aria-label', t(video.hidden ? 'card.restore' : 'card.hide', { title: video.title }));
  hide.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (card.classList.contains('is-hidden')) restoreVideo(video.id, card);
    else hideVideos([video.id]);
  });
  // Always added: a class on the root is what shows or hides it. Making its
  // creation conditional would force a rebuild of every card already rendered
  // whenever the setting changes.
  card.append(hide);

  // -- priority: the exact opposite of hiding
  const star = document.createElement('button');
  star.className = 'tracktube-star';
  star.type = 'button';
  star.textContent = '★';
  star.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleStar(video.id, card);
  });
  card.append(star);
  syncStarButton(star, Boolean(video.starred), video.title);

  return card;
}

// ---------------------------------------------------------------------------
// A thumbnail's context menu
// ---------------------------------------------------------------------------

/**
 * The "⋮" menu, deliberately limited to what we can do honestly.
 *
 * YouTube's entries that write to the account — add to queue, watch later, save
 * to a playlist — would mean forging authenticated requests to its internal API.
 * That is fragile and breaks on the first change at Google's end, so we do not
 * offer them rather than offer them half way.
 *
 * "Watch later" loses its meaning here in any case: this feed *is* the list of
 * what is left to watch, since everything unwanted is hidden.
 */
function openCardMenu(video, anchor) {
  closeCardMenu();
  anchor.setAttribute('aria-expanded', 'true');

  const menu = document.createElement('div');
  menu.className = 'tracktube-menu';
  menu.setAttribute('role', 'menu');

  const item = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeCardMenu();
      await onClick();
    });
    return b;
  };

  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
  const channelName = channelsById.get(video.channelId)?.title || video.channelTitle || t('menu.thischannel');

  // Three groups, from the most harmless to the most destructive: what one does
  // with the video, then what else one wants to see, then what one removes. The
  // previous order mixed all three, and "hide the whole channel" sat two pixels
  // from "copy the link".
  menu.append(
    item(t('menu.copy'), async () => {
      try {
        await navigator.clipboard.writeText(url);
        flash(t('menu.copied'));
      } catch {
        flash(t('menu.copy.failed'));
      }
    }),
    // "Open in a new tab" was removed: the thumbnail is a real link, middle click
    // and ctrl click already do the job, and the entry took up a line in a menu we
    // want short.
    separator(),
    // Stays in the feed instead of opening the channel: one wants to see what one
    // missed of it, not leave the sorting under way.
    item(t('menu.channel.videos', { name: channelName }), () => {
      state.channelId = video.channelId;
      return reload();
    }),
    separator(),
  );

  // The last group depends on the view: offering "hide" in the bin would make no
  // sense, and it is the reverse gesture one looks for there.
  //
  // The priority opens this group rather than the first: it is a sorting gesture,
  // like hiding, and the thumbnail's star makes it reachable in one click anyway
  // without coming through here.
  if (state.view === 'hidden') {
    menu.append(
      item(t('menu.restore.video'), () =>
        restoreVideo(video.id, cardFor(video.id))),
      item(t('menu.restore.channel', { name: channelName }), () =>
        applyToChannel(MSG.HIDE_CHANNEL, { channelId: video.channelId, hidden: false })),
    );
  } else if (state.view === 'starred') {
    menu.append(
      item(t('menu.unstar'), () => toggleStar(video.id, cardFor(video.id))),
      item(t('menu.unstar.channel', { name: channelName }), () =>
        applyToChannel(MSG.STAR_CHANNEL, { channelId: video.channelId, starred: false })),
    );
  } else {
    menu.append(
      video.starred
        ? item(t('menu.unstar'), () => toggleStar(video.id, cardFor(video.id)))
        : item(t('menu.star'), () => toggleStar(video.id, cardFor(video.id))),
      // Priority files away, hiding removes: two families, and the second ends
      // with an action that touches dozens of videos at once.
      separator(),
      item(t('menu.hide.video'), () => hideVideos([video.id])),
      item(t('menu.hide.channel', { name: channelName }), () =>
        applyToChannel(MSG.HIDE_CHANNEL, { channelId: video.channelId, hidden: true })),
      // Last, and after the separator, because it is the only entry here that
      // removes rows rather than setting them aside — and because it is the
      // answer to "why am I still seeing a channel I left", which no amount of
      // pruning logic can give on a browser whose session the extension cannot
      // read.
      item(t('menu.forget.channel', { name: channelName }),
        () => forgetChannel(video.channelId, channelName)),
    );
  }

  document.body.append(menu);
  placeMenu(menu, anchor);

  // Deferred by one turn of the loop, otherwise the click that just opened the
  // menu would close it again straight away.
  setTimeout(() => {
    document.addEventListener('click', closeCardMenu, { once: true });
    document.addEventListener('keydown', onMenuKey);
    window.addEventListener('scroll', closeCardMenu, { once: true, passive: true });
  }, 0);
}

/**
 * Places a floating menu under its button, keeping it inside the window.
 * It needs the menu's real size, so call it after insertion.
 */
function placeMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(rect.right - width, window.innerWidth - width - 8);
  const top = rect.bottom + height > window.innerHeight ? rect.top - height - 4 : rect.bottom + 4;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function closeCardMenu() {
  document.querySelector('.tracktube-menu')?.remove();
  for (const b of document.querySelectorAll('[aria-expanded="true"]')) {
    b.setAttribute('aria-expanded', 'false');
  }
  document.removeEventListener('keydown', onMenuKey);
}

function onMenuKey(event) {
  if (event.key === 'Escape') closeCardMenu();
}

function separator() {
  const hr = document.createElement('hr');
  hr.className = 'tracktube-menu-sep';
  return hr;
}

/**
 * Applies an action to all of a channel's videos and takes off screen those that
 * no longer belong in the current view.
 *
 * The same mechanism serves hiding, unhiding and priorities: in all three cases,
 * the thumbnails concerned leave the view under way.
 */
async function applyToChannel(message, payload) {
  const res = await send(message, payload);
  if (!res.ok) { log.error('Bulk action failed', res.error); return; }

  const ids = res.changedIds ?? [];
  if (!ids.length) { flash(t('feed.nothing.channel')); return; }

  for (const id of ids) cardFor(id)?.classList.add('is-leaving');
  setTimeout(() => { for (const id of ids) cardFor(id)?.classList.add('is-removed'); }, 160);

  state.rendered = Math.max(0, state.rendered - ids.length);
  updateToolbar();
  flash(t('toast.channel.changed', { n: ids.length }));
  refreshStats();
  loadMore();
}

/**
 * "I am not subscribed to this channel any more."
 *
 * Deliberately not routed through `applyToChannel`: that one reads
 * `changedIds` to fold the exact thumbnails away, and this removes every row
 * the channel has, including the ones no card is showing. The grid is reloaded
 * instead, which is also what makes the gesture visible — the cards go, and
 * nothing of that channel comes back on any later page.
 */
async function forgetChannel(channelId, channelName) {
  const res = await send(MSG.FORGET_CHANNEL, { channelId, key: activeAccountKey() });
  if (!res.ok || res.otherAccount) {
    log.error('Forgetting the channel failed', res.error ?? 'other account');
    flash(t('feed.error.forget'));
    return;
  }
  flash(t('toast.channel.forgotten', { name: channelName }));
  await reload();
  refreshStats();
}

/** Fleeting message, for actions with no visible effect on the grid. */
function flash(text) {
  document.querySelector('.tracktube-toast')?.remove();
  clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.className = 'tracktube-toast';
  toast.textContent = text;
  document.body.append(toast);
  toastTimer = setTimeout(() => toast.remove(), 2500);
}

/**
 * Channel avatar, falling back on the initial.
 *
 * Feed cards no longer wait for avatar downloads. The initial remains readable
 * while metadata is missing, and replaces an image whose recorded URL fails.
 */
function buildAvatar(channel, video) {
  const title = channel?.title || video.channelTitle || '?';
  const seed = video.channelId || title;
  // Two sources: the channel record, and failing that what the video carries — a
  // channel only just discovered has no avatar in the database yet, and showing a
  // grey badge in its place is needlessly confusing.
  const url = channel?.avatarUrl || video.channelAvatar;

  if (!url) return initialAvatar(title, seed);

  const img = document.createElement('img');
  img.className = 'tracktube-avatar';
  // No `loading="lazy"` here either: inside a subtree in
  // `content-visibility: auto`, deferred loading may never fire at all, and the
  // avatar stays empty indefinitely. These images weigh a few kilobytes and are
  // heavily shared between thumbnails of one channel, so loading them outright
  // costs nothing.
  img.alt = '';
  img.src = url;
  img.addEventListener('error', () => img.replaceWith(initialAvatar(title, seed)), { once: true });
  return img;
}

function initialAvatar(title, seed) {
  const el = document.createElement('span');
  el.className = 'tracktube-avatar tracktube-avatar-initial';
  el.textContent = (title.trim()[0] ?? '?').toUpperCase();
  // Deterministic colour: one channel always keeps the same badge.
  el.style.setProperty('--tracktube-avatar-hue', String(hueFor(seed)));
  return el;
}

function hueFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return hash;
}

/**
 * A card's hover tint, drawn from its still.
 *
 * The ground around a hovered thumbnail is not worth the same grey as drawn from
 * the image: grey, it points; tinted, it connects. On a grid of sixty thumbnails,
 * the second reading is immediate.
 *
 * The colour is computed on the fly rather than stored: it depends on the image,
 * which is already cached, and a round trip to the database would cost more than
 * the computation. The result is remembered by video id so that coming back to a
 * card recomputes nothing.
 */
const tints = new Map();

const TINT_CANVAS = 16;

function tintCard(card, img) {
  const id = card.dataset.videoId;
  const stored = tints.get(id);
  if (stored !== undefined) {
    if (stored) card.style.setProperty('--tracktube-card-tint', stored);
    return;
  }

  const apply = () => {
    const tint = dominantColour(img);
    tints.set(id, tint);
    if (tint) card.style.setProperty('--tracktube-card-tint', tint);
  };

  if (img.complete && img.naturalWidth) apply();
  else img.addEventListener('load', apply, { once: true });
}

/**
 * An image's dominant colour, brought back to a veil that sits on a light ground
 * as well as a dark one.
 *
 * The image is scaled down to sixteen pixels a side by the browser itself, which
 * does all the averaging work and makes the walk negligible. What cannot tint is
 * then set aside: near black and near white, which dominate most stills without
 * saying anything about them. The colour kept is the mean of the most represented
 * hue group, weighted by saturation — an overall mean always comes back to grey.
 *
 * Only the **hue** is kept; lightness and saturation are brought back into a
 * usable range. Measured on real stills, the raw mean gives a midnight blue at
 * `rgb(10, 37, 70)`, invisible on a dark theme, just as readily as a grey at
 * `rgb(193, 193, 193)`, invisible on a light one. Normalising guarantees the veil
 * always shows, while staying recognisable as the image's colour.
 *
 * An image with no dominant colour — black and white, or uniformly grey — gives
 * nothing back: the CSS neutral surface then takes over, which is exactly right
 * for an image that has no colour.
 *
 * @returns {string|null} a translucent CSS colour, or null
 */
function dominantColour(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = TINT_CANVAS;
    canvas.height = TINT_CANVAS;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, TINT_CANVAS, TINT_CANVAS);
    const { data } = ctx.getImageData(0, 0, TINT_CANVAS, TINT_CANVAS);

    // Twelve thirty degree sectors: fine enough to separate a red from an orange,
    // wide enough that a photograph's noise does not scatter the vote.
    const sectors = Array.from({ length: 12 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      const max = Math.max(r, g, b); const min = Math.min(r, g, b);
      const lightness = (max + min) / 2;

      if (lightness < 28 || lightness > 232) continue;   // black and white tint nothing
      const saturation = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
      if (saturation < 0.18) continue;             // grey: no hue to draw from it

      const sector = sectors[Math.floor(hueDegrees(r, g, b) / 30) % 12];
      sector.weight += saturation;
      sector.r += r * saturation;
      sector.g += g * saturation;
      sector.b += b * saturation;
    }

    const winner = sectors.reduce((a, c) => (c.weight > a.weight ? c : a), sectors[0]);
    if (!winner.weight) return null;

    const r = winner.r / winner.weight;
    const g = winner.g / winner.weight;
    const b = winner.b / winner.weight;

    // A veil, not a flat fill: the card must stay readable and YouTube's theme
    // show through underneath.
    return `hsla(${Math.round(hueDegrees(r, g, b))}, 55%, 55%, .2)`;
  } catch {
    // Tainted canvas: the image comes from an origin that does not allow reading
    // it back. The CSS neutral surface takes over.
    return null;
  }
}

/** Hue of an RGB colour, in degrees on the colour wheel. */
function hueDegrees(r, g, b) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * The time of an appointment, in as few characters as possible.
 *
 * The badge is narrow: it shares the thumbnail's width with the word SCHEDULED.
 * Today and tomorrow are therefore spelled out, the current week by its short
 * weekday, and the rest by a date. The full time lives in the tooltip.
 */
function shortTime(date, now = new Date()) {
  const time = date.toLocaleTimeString(bcp47(), { hour: '2-digit', minute: '2-digit' });
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const gap = Math.round((day(date) - day(now)) / 86_400_000);

  if (gap <= 0) return time;
  if (gap === 1) return t('time.tomorrow', { time });
  if (gap < 7) return `${date.toLocaleDateString(bcp47(), { weekday: 'short' })} ${time}`;
  return date.toLocaleDateString(bcp47(), { day: 'numeric', month: 'short' });
}

/**
 * Badge at the bottom right of the thumbnail: duration, live, or start time.
 *
 * It is built apart because it is recomputed afterwards — the duration does not
 * arrive with the Atom feed, but a few seconds later, and the already painted
 * thumbnail must be able to take it in without being rebuilt.
 *
 * @returns {HTMLElement|null} null when there is nothing honest to show
 */
function buildBadge(video) {
  const badge = document.createElement('span');

  // "Live" is only shown on an observed state, never a deduced one. The previous
  // version concluded "no known duration, therefore a live under way", and showed
  // in red replays several days old: their duration was simply missing because we
  // looked for it in the long videos playlist, where a broadcast never is.
  const broadcast = broadcastKind(video);

  if (broadcast === 'live') {
    badge.className = 'tracktube-duration tracktube-live';
    badge.textContent = t('card.badge.live');
    return badge;
  }

  // Broadcast announced but not started yet: the appointment's time is the only
  // useful thing to show. When it is not known, say so rather than invent a date —
  // and above all do not call it a replay, which it is not: it has not happened
  // yet, and shows zero views.
  if (broadcast === 'upcoming') {
    badge.className = 'tracktube-duration tracktube-scheduled';
    const start = video.publishedAt > Date.now() ? new Date(video.publishedAt) : null;
    badge.textContent = start ? t('card.badge.upcoming.at', { time: shortTime(start) }) : t('card.badge.upcoming');
    return badge;
  }

  // From here on the duration is known and positive: it is a video, or a replay,
  // which is a video like any other except that one wants to know. `-1` marks a
  // duration definitively unknown (deleted or private video): it must not show as
  // a real duration.
  if (video.durationSec > 0) {
    badge.classList.add('tracktube-duration');
    if (broadcast === 'replay') {
      // Without the word, nothing tells a replay from an ordinary upload.
      badge.classList.add('tracktube-replay');
      badge.textContent = t('card.badge.replay', { duration: formatDuration(video.durationSec) });
    } else {
      badge.textContent = formatDuration(video.durationSec);
    }
    return badge;
  }

  return null;
}

/**
 * Lays freshly recovered durations onto the thumbnails already on screen.
 *
 * Without this, a duration found after the first render only appeared on the
 * page's next load — which is exactly what gave the impression that durations
 * "arrive too late".
 *
 * @param {Array<[string, number]>} durations
 * @param {object} [opts]
 * @param {Set<string>} [opts.ended]  broadcasts we have just seen end
 */
export function applyDurations(durations, { ended = null } = {}) {
  if (!mounted || !durations?.length) return 0;

  let placed = 0;
  for (const [videoId, seconds] of durations) {
    if (!(seconds > 0)) continue;
    const card = mounted.root.querySelector(`.tracktube-card[data-video-id="${CSS.escape(videoId)}"]`);
    const thumb = card?.querySelector('.tracktube-thumb');
    if (!thumb) continue;

    const existing = thumb.querySelector('.tracktube-duration');
    // A live under way keeps its badge: its state is more accurate information
    // than the time elapsed since it began. An announced broadcast, on the other
    // hand, gives way — a known duration means precisely that the appointment has
    // taken place.
    //
    // Except when the reading has just found the broadcast over: the red badge
    // then becomes false, and waiting for the page to reload before removing it is
    // exactly what left a live finished hours ago still announcing itself as under
    // way.
    if (existing?.classList.contains('tracktube-live') && !ended?.has(videoId)) continue;

    const badge = buildBadge({ durationSec: seconds, wasLive: card.dataset.wasLive === '1' });
    if (!badge) continue;
    if (existing) existing.replaceWith(badge);
    else thumb.append(badge);
    placed++;
  }
  return placed;
}

/**
 * Applies freshly recovered avatars to both placeholders and stale images.
 *
 * @param {Array<[string, string]>} avatars
 */
export function applyAvatars(avatars) {
  if (!mounted || !avatars?.length) return 0;

  let placed = 0;
  for (const [channelId, url] of avatars) {
    const known = channelsById.get(channelId);
    if (known) known.avatarUrl = url;

    for (const card of mounted.root.querySelectorAll('.tracktube-card')) {
      if (card.dataset.channelId !== channelId) continue;
      const badgeEl = card.querySelector('.tracktube-avatar');
      if (!badgeEl || (badgeEl instanceof HTMLImageElement && badgeEl.src === url)) continue;
      const title = card.querySelector('.tracktube-byline')?.textContent ?? '';
      badgeEl.replaceWith(buildAvatar({ avatarUrl: url }, { channelId, channelTitle: title }));
      placed++;
    }
  }
  return placed;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---------------------------------------------------------------------------
// Hiding
// ---------------------------------------------------------------------------

function syncStarButton(button, starred, title) {
  button.setAttribute('aria-pressed', String(starred));
  button.setAttribute('aria-label', t(starred ? 'card.unstar' : 'card.star', { title }));
}

/**
 * Toggles a video's priority.
 *
 * Nothing disappears from the screen: unlike hiding, marking a video is a gesture
 * one wants to be able to correct immediately, while looking at it.
 */
async function toggleStar(id, card) {
  const next = !card.classList.contains('is-starred');
  card.classList.toggle('is-starred', next);
  syncStarButton(card.querySelector('.tracktube-star'), next, card.querySelector('.tracktube-title')?.textContent ?? '');

  const res = await send(MSG.SET_STARRED, { ids: [id], starred: next });
  if (!res.ok) {
    card.classList.toggle('is-starred', !next); // visual rollback
    log.error('Starring failed', res.error);
    return;
  }

  // Removing the priority while looking only at the priorities: the thumbnail no
  // longer belongs in the list.
  if (!next && state.view === 'starred') {
    card.classList.add('is-leaving');
    setTimeout(() => card.remove(), 160);
    state.rendered = Math.max(0, state.rendered - 1);
    updateToolbar();
    refreshStats();
  }
}

/** Puts a hidden video back into the feed, from the "Hidden" view. */
async function restoreVideo(id, card) {
  const res = await send(MSG.SET_HIDDEN, { ids: [id], hidden: false });
  // This one asks before it paints, so there is nothing to put back — only
  // something to say, which a console line is not.
  if (!res.ok) {
    log.error('Restore failed', res.error);
    flash(t('feed.error.restore'));
    return;
  }

  // In the "Hidden" view, a restored video has nothing left to do there.
  if (state.view === 'hidden') {
    card.classList.add('is-leaving');
    setTimeout(() => card.classList.add('is-removed'), 160);
    state.rendered = Math.max(0, state.rendered - 1);
    updateToolbar();
  } else {
    card.classList.remove('is-hidden');
    const button = card.querySelector('.tracktube-hide');
    button.textContent = '✕';
  }

  flash(t('toast.restored', { n: 1 }));
  refreshStats();
}

/**
 * Applies the selected batch, in the direction the current view imposes: hide
 * from the feed, recover from the bin.
 */
async function applySelection() {
  const ids = [...state.selected];
  if (!ids.length) return;

  if (state.view === 'hidden') await restoreVideos(ids);
  else await hideVideos(ids);

  state.selected.clear();
  state.anchorId = null;
  updateToolbar();
}

/**
 * Puts a batch of videos back into the feed.
 *
 * The same gesture as `restoreVideo`, in a single write: recovering thirty videos
 * hidden by mistake must not cost thirty round trips.
 */
async function restoreVideos(ids) {
  if (!ids.length) return;

  const cards = ids.map(cardFor).filter(Boolean);
  for (const card of cards) card.classList.add('is-leaving');
  setTimeout(() => { for (const card of cards) card.classList.add('is-removed'); }, 160);

  state.rendered = Math.max(0, state.rendered - cards.length);
  updateToolbar();

  const res = await send(MSG.SET_HIDDEN, { ids, hidden: false });
  if (!res.ok) {
    log.error('Restore failed', res.error);
    unhideCards(ids);
    flash(t('feed.error.restore'));
    return;
  }

  flash(t('toast.restored', { n: ids.length }));
  refreshStats();
  loadMore();
}

/**
 * Turns the selection into priorities.
 *
 * Unlike hiding, the thumbnails stay in place: marking a video as a priority does
 * not take it out of the feed, it points at it. So we merely update the stars and
 * leave selection mode.
 */
async function starSelection() {
  const ids = [...state.selected];
  if (!ids.length) return;

  // In the priorities view the button removes; elsewhere it adds.
  const starred = state.view !== 'starred';

  const res = await send(MSG.SET_STARRED, { ids, starred });
  if (!res.ok) { log.error('Priority change failed', res.error); return; }

  for (const id of ids) {
    const card = cardFor(id);
    if (!card) continue;
    // The stylesheet only knows `is-starred`: a `data-starred` attribute left
    // the ring and the orange star unpainted on a batch marking.
    card.classList.toggle('is-starred', starred);
    syncStarButton(card.querySelector('.tracktube-star'), starred,
      card.querySelector('.tracktube-title')?.textContent ?? '');
  }

  flash(starred
    ? t('toast.starred', { n: ids.length })
    : t('toast.unstarred', { n: ids.length }));
  setSelecting(false);

  // Taken out of the view one is in, they have nothing left to do there.
  if (starred) refreshStats();
  else reload();
}

/**
 * Removes the thumbnails immediately and writes to the database afterwards.
 * Hiding must feel instant; it is reversible in any case.
 *
 * The cost in the database is constant: `hidden` is an indexed flag, and the
 * video simply stops being visited by later queries.
 */
async function hideVideos(ids) {
  if (!ids.length) return;

  const cards = ids.map(cardFor).filter(Boolean);
  for (const card of cards) card.classList.add('is-leaving');
  // The thumbnails are folded away, not destroyed: an undo has to put them back
  // exactly where they were. Removing them from the DOM forced a reload of the
  // whole grid, which sent the user back to the top of the page — an ordinary
  // gesture with a disproportionate consequence.
  setTimeout(() => { for (const card of cards) card.classList.add('is-removed'); }, 160);

  state.rendered = Math.max(0, state.rendered - cards.length);
  for (const id of ids) state.selected.delete(id);
  updateToolbar();

  const res = await send(MSG.SET_HIDDEN, { ids, hidden: true });
  // A refused write used to leave the thumbnails folded away and say nothing
  // but a console line. The gesture reported itself as done, the videos came
  // back on the next paint, and the only honest reading of that is that hiding
  // is unreliable. Put them back and say so: an error message is the one
  // sentence this interface is allowed.
  if (!res.ok) {
    log.error('Hiding failed', res.error);
    unhideCards(ids);
    flash(t('feed.error.hide'));
    return;
  }

  showUndoToast(ids);
  refreshStats();

  // Removing thumbnails can bring the sentinel back into view without any new
  // scroll event happening at all.
  loadMore();
}

/** Puts folded away thumbnails back, without reloading or moving the page. */
function unhideCards(ids) {
  let restored = 0;
  for (const id of ids) {
    const card = cardFor(id);
    if (!card) continue;
    card.classList.remove('is-removed', 'is-leaving');
    restored++;
  }
  state.rendered += restored;
  updateToolbar();
  refreshStats();
}

let toastTimer = null;

function showUndoToast(ids) {
  document.querySelector('.tracktube-toast')?.remove();
  clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.className = 'tracktube-toast';

  // No count: the thumbnail has just faded away before one's eyes and the bar's
  // counters have gone down. What the toast brings, and it alone, is the way back
  // — and it only covers the last hiding, the rest being found again in the
  // "Hidden" view.
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = t('toast.undo');
  undo.addEventListener('click', async () => {
    toast.remove();
    clearTimeout(toastTimer);
    const res = await send(MSG.SET_HIDDEN, { ids, hidden: false });
    if (!res.ok) {
      log.error('Undo failed', res.error);
      flash(t('feed.error.restore'));
      return;
    }
    unhideCards(ids);
  });

  toast.append(undo);
  document.body.append(toast);
  toastTimer = setTimeout(() => toast.remove(), UNDO_MS);
}

async function reload() {
  if (!mounted) return;
  // Invalidates any load still in flight before emptying the grid.
  state.generation++;
  closePreview();
  grid().replaceChildren();
  const wasSelecting = state.selecting;
  resetPaging();
  state.selecting = wasSelecting;
  updateToolbar();
  await loadMore();
  await refreshStats();
}
