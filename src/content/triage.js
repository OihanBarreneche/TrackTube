/**
 * Subscription triage: frame, cards, navigation and application.
 *
 * Decisions are applied as the triage goes, five cards behind. That lag *is*
 * the safety net: the last five stay undoable, beyond that it is done. There is
 * therefore no final confirmation screen — the choice has already been made,
 * card by card, knowingly. The safeguard that remains is at the entrance:
 * without a recent backup, triage does not start.
 *
 * Application goes through YouTube's internal API, at roughly 150 ms per
 * channel, which makes it invisible. The previous version drove the real
 * interface in a background tab: some fifteen seconds per channel, and only
 * when YouTube agreed to build its menus there.
 */

import { MSG, send } from '../lib/messages.js';
import {
  ORDERS, ORDER_LABELS, sortChannels, describeCadence, describeHiding, describeWatching,
  hasWatchData, findDormant,
} from '../lib/triage-order.js';
import { relativeTime } from '../lib/util.js';
import { t, initLocale, bcp47 } from '../lib/i18n.js';
import { log } from '../lib/log.js';
import { activeAccountKey } from './active-account.js';

const ROOT_ID = 'tracktube-triage';

/** Three rows of four: enough context to recognise a channel without the card
 *  turning into a wall of images. */
const THUMBS_PER_LOAD = 12;

/** Number of undoable decisions — see the design of step 4. */
const UNDO_DEPTH = 5;

let mounted = null;

const state = {
  /** Every subscription, in the order they were loaded. */
  /** @type {import('../lib/triage-order.js').TriageChannel[]} */
  channels: [],
  /** Those left to see, sorted according to the chosen order. */
  /** @type {import('../lib/triage-order.js').TriageChannel[]} */
  queue: [],
  index: 0,
  order: ORDERS.SUSPECT,
  /**
   * Decisions already made, by channel id.
   *
   * This map is what gets persisted, not a numeric position: between two
   * sessions the subscription list moves and the triage order is recomputed, so
   * an index would no longer designate the same channel. Starting again from
   * "these ones are handled" stays right in every case.
   *
   * @type {Map<string, boolean>}
   */
  decided: new Map(),
  /** @type {Array<{channelId: string, keep: boolean}>} */
  decisions: [],
  /**
   * Decisions already considered committed.
   *
   * A decision leaves for YouTube five cards later: beyond that, it is no
   * longer undoable.
   */
  committed: 0,
  /** Decisions already handed to execution, so they are not sent twice. */
  /** @type {Set<string>} */
  sent: new Set(),
  /** Channels left to leave, in order. @type {string[]} */
  pending: [],
  /** Only one pump at a time. */
  pumpRunning: false,
  /** Number of channels actually left during this session. */
  leftCount: 0,
  /** The channel YouTube refused on, if any. */
  failure: null,
};

/** Number of decisions still undoable. */
const undoableCount = () => state.decisions.length - state.committed;

/**
 * "1 070 000" → "1.1 M subscribers".
 *
 * We show an order of magnitude because that is what it is: YouTube itself only
 * ever says "1.07 M". Showing "1 070 000 subscribers" would suggest a precision
 * that does not exist.
 */
function formatSubscribers(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1e6) {
    // The decimal separator follows the language, not the code: `toFixed` would
    // write a dot even in French.
    return t('tri.subs.m', {
      n: (n / 1e6).toLocaleString(bcp47(), { maximumFractionDigits: n >= 1e7 ? 0 : 1 }),
    });
  }
  if (n >= 1e3) return t('tri.subs.k', { n: Math.round(n / 1e3) });
  return t('tri.subs', { n });
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export async function mountTriage() {
  if (mounted) return;

  // The first text shown is already a catalogue text: the language must be
  // known before the veil comes down.
  await Promise.all([injectStylesheet(), waitForBody(), initLocale()]);

  // The veil goes up before the data is even loaded: we are called at the very
  // beginning of the page load, and letting the subscription list show for a
  // second before covering it gave the impression the extension was slow to
  // start.
  const root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.append(root);

  const abort = new AbortController();
  mounted = { root, abort };
  document.documentElement.classList.add('tracktube-triage-open');
  root.replaceChildren(el('div', 'tracktube-triage-panel', t('tri.loading')));

  const res = await send(MSG.TRIAGE_CHANNELS);
  if (!mounted) return;

  if (!res.ok || !res.channels?.length) {
    root.replaceChildren(buildFailure(res.ok
      ? t('tri.empty')
      : t('tri.loadfailed', { error: t(res.error) })));
    return;
  }

  document.addEventListener('keydown', onKeyDown, { signal: abort.signal });

  state.channels = res.channels;
  state.lastExportAt = res.lastExportAt ?? 0;
  state.index = 0;
  state.decisions = [];
  state.committed = 0;

  await restoreProgress();
  state.sent = new Set();
  state.pending = [];
  state.leftCount = 0;
  state.failure = null;

  // A session closed midway may have left decisions inside the undo window,
  // never applied. We pick them up again — limited to the channels the database
  // still believes are followed, otherwise every opening would replay all the
  // unsubscriptions already done.
  const stillFollowed = new Set(state.channels.map((c) => c.id));
  const forgotten = [...state.decided]
    .filter(([id, keep]) => !keep && stillFollowed.has(id))
    .map(([id]) => id);

  if (forgotten.length) {
    for (const id of forgotten) state.sent.add(id);
    state.pending.push(...forgotten);
    pumpUnsubscriptions();
  }

  renderIntro();
}

/** Reloads the decisions already made in a previous session. */
async function restoreProgress() {
  state.decided = new Map();

  const res = await send(MSG.TRIAGE_PROGRESS, {});
  const saved = res.ok ? res.progress : null;
  if (!saved?.decided) return;

  // We only keep the channels still present: those unsubscribed from in the
  // meantime have no business taking up room in the progress.
  const known = new Set(state.channels.map((c) => c.id));
  for (const [id, keep] of Object.entries(saved.decided)) {
    if (known.has(id)) state.decided.set(id, keep);
  }
  if (saved.order && Object.values(ORDERS).includes(saved.order)) state.order = saved.order;
}

function saveProgress() {
  send(MSG.TRIAGE_PROGRESS, {
    save: { order: state.order, decided: Object.fromEntries(state.decided), at: Date.now() },
  });
}

/** Builds the queue of what is left to see, in the chosen order. */
function buildQueue() {
  state.queue = sortChannels(
    state.channels.filter((c) => !state.decided.has(c.id)),
    state.order,
  );
  state.index = 0;
}

/** The content script starts before `<body>` exists. */
function waitForBody() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.documentElement, { childList: true });
  });
}

function buildFailure(message) {
  const panel = el('div', 'tracktube-triage-panel');
  panel.append(el('h2', null, t('tri.h')), el('p', 'tracktube-triage-lead', message));

  const close = el('button', 'tracktube-triage-ghost', t('pop.close'));
  close.type = 'button';
  close.addEventListener('click', unmountTriage);
  panel.append(actionRow(close));
  return panel;
}

export function unmountTriage() {
  if (!mounted) return;
  mounted.abort.abort();
  mounted.root.remove();
  document.documentElement.classList.remove('tracktube-triage-open');
  mounted = null;
}

/**
 * Injects the stylesheet and resolves once it is applied — see the twin
 * function in `feed-view.js`: appending the panel before the rules arrive
 * showed a second of unstyled HTML.
 */
function injectStylesheet() {
  const href = chrome.runtime.getURL('src/content/triage.css');
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

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

/**
 * Before sorting: choose the order, and offer the batch of silent channels.
 *
 * The only warning left is the one about what can still be undone. The three
 * others described the mechanism — the background tab, what resubscribing does
 * not restore, where to find the export — without changing anything about how
 * one sorts. This one does: whoever believes they can undo everything at the
 * end does not sort the same way.
 */
function renderIntro() {
  const remaining = state.channels.length - state.decided.size;
  const dormant = findDormant(state.channels).filter((c) => !state.decided.has(c.id));

  const panel = el('div', 'tracktube-triage-panel');
  panel.append(el('h2', null, t('tri.title')));

  panel.append(el('p', 'tracktube-triage-lead', state.decided.size
    ? t('tri.lead.resume', { done: state.decided.size, left: remaining })
    : t('tri.lead', { n: state.channels.length })));

  panel.append(el('p', 'tracktube-triage-warning', t('tri.warning', { n: UNDO_DEPTH })));

  const noRecentBackup = Date.now() - (state.lastExportAt || 0) > BACKUP_MAX_AGE_MS;

  // -- order of passage
  const orderBox = el('div', 'tracktube-triage-orders');
  orderBox.append(el('span', 'tracktube-triage-label', t('tri.order')));
  for (const value of Object.values(ORDERS)) {
    const button = el('button', 'tracktube-triage-chip', t(ORDER_LABELS[value]));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.order === value));
    button.addEventListener('click', () => {
      state.order = value;
      renderIntro();
    });
    orderBox.append(button);
  }
  panel.append(orderBox);

  if (dormant.length) {
    const box = el('div', 'tracktube-triage-dormant');
    box.append(el('strong', null, t('tri.dormant', { n: dormant.length })));
    box.append(el('span', null, ` ${t('tri.dormant.hint', { n: dormant.length })}`));

    const see = el('button', 'tracktube-triage-chip', t('tri.dormant.see'));
    see.type = 'button';
    see.style.marginTop = '10px';
    see.addEventListener('click', () => renderDormant(dormant));
    box.append(document.createElement('br'), see);

    panel.append(box);
  }

  const begin = () => { buildQueue(); renderCard(); };

  const start = el('button', 'tracktube-triage-primary',
    t(state.decided.size ? 'tri.resume' : 'tri.start'));
  start.type = 'button';
  start.disabled = remaining === 0;
  // Without a recent backup the button no longer disables itself: it asked the
  // question without ever putting it into words, and left a dead command in
  // front of the user. It opens a confirmation whose two answers both say what
  // they do.
  start.addEventListener('click', () => {
    if (noRecentBackup) renderBackupConfirm(begin);
    else begin();
  });

  const buttons = [start];

  // Resuming is the everyday gesture; starting over from scratch must stay
  // possible without being confused with it.
  if (state.decided.size) {
    const reset = el('button', 'tracktube-triage-ghost', t('tri.restart'));
    reset.type = 'button';
    reset.addEventListener('click', () => {
      state.decided.clear();
      state.decisions = [];
      state.committed = 0;
      saveProgress();
      renderIntro();
    });
    buttons.push(reset);
  }

  const close = el('button', 'tracktube-triage-ghost', t('pop.close'));
  close.type = 'button';
  close.addEventListener('click', unmountTriage);
  buttons.push(close);

  panel.append(actionRow(...buttons));
  mounted.root.replaceChildren(panel);
}

/**
 * Entry confirmation, when no recent backup has been exported.
 *
 * Both answers name their effect. An "OK" facing "are you sure?" leaves one to
 * guess what is being consented to, and gets clicked without being read.
 *
 * @param {() => void} begin  what to do once the question is settled
 */
function renderBackupConfirm(begin) {
  const panel = el('div', 'tracktube-triage-panel');
  panel.append(el('h2', null, t('tri.confirm.h')));
  panel.append(el('p', 'tracktube-triage-lead', t('tri.confirm.p')));

  const status = el('p', 'tracktube-triage-notice');

  const exportBtn = el('button', 'tracktube-triage-primary', t('tri.confirm.export'));
  exportBtn.type = 'button';
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    const ok = await downloadBackup(status);
    exportBtn.disabled = false;
    if (ok) begin();
  });

  const anyway = el('button', 'tracktube-triage-ghost', t('tri.confirm.go'));
  anyway.type = 'button';
  anyway.addEventListener('click', begin);

  const back = el('button', 'tracktube-triage-ghost', t('tri.back'));
  back.type = 'button';
  back.addEventListener('click', renderIntro);

  panel.append(actionRow(exportBtn, anyway, back), status);
  mounted.root.replaceChildren(panel);
}

/**
 * Exports the backup without going through the popup.
 *
 * The worker supplies the data; the download is triggered here, by a `download`
 * link on a blob URL. `chrome.downloads` does not exist in a content script, and
 * sending the user off to open the popup themselves would amount to offering
 * nothing.
 *
 * @param {HTMLElement} status  where to write the result
 * @returns {Promise<boolean>}
 */
async function downloadBackup(status) {
  const res = await send(MSG.EXPORT_DATA);
  if (!res.ok) {
    status.textContent = t('tri.export.failed', { error: t(res.error) });
    return false;
  }

  const blob = new Blob([JSON.stringify(res.data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tracktube-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // The URL must outlive the start of the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  // The worker has just timestamped the backup; without echoing it here, going
  // back to the home screen would reopen the same question.
  state.lastExportAt = Date.now();

  status.textContent = t('tri.export.done');
  return true;
}

/**
 * Bulk handling of the silent channels.
 *
 * Everything is ticked by default: one came here to clear out the obvious. But
 * every line stays untickable, and the list is shown in full — no "unsubscribe
 * from 31 channels" without saying which ones.
 */
function renderDormant(dormant) {
  const panel = el('div', 'tracktube-triage-panel');
  panel.append(
    el('h2', null, t('tri.dormant.title')),
    el('p', 'tracktube-triage-lead', t('tri.dormant.lead')),
  );

  const list = el('div', 'tracktube-triage-checklist');
  for (const channel of dormant) {
    const row = el('label', 'tracktube-triage-checkrow');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.value = channel.id;

    const name = el('span', 'tracktube-triage-checkname', channel.title || channel.id);
    const when = el('span', 'tracktube-triage-checkdate', channel.lastUploadAt
      ? relativeTime(channel.lastUploadAt)
      : t('tri.novideo.low'));

    row.append(box, name, when);
    list.append(row);
  }
  panel.append(list);

  const counter = el('p', 'tracktube-triage-lead');
  const updateCounter = () => {
    const n = list.querySelectorAll('input:checked').length;
    counter.textContent = t('tri.selected', { n, total: dormant.length });
  };
  list.addEventListener('change', updateCounter);
  updateCounter();
  panel.append(counter);

  const apply = el('button', 'tracktube-triage-primary', t('tri.dormant.mark'));
  apply.type = 'button';
  apply.addEventListener('click', () => {
    for (const box of list.querySelectorAll('input:checked')) {
      state.decided.set(box.value, false);
      state.decisions.push({ channelId: box.value, keep: false });
    }
    state.committed = Math.max(0, state.decisions.length - UNDO_DEPTH);
    saveProgress();
    renderIntro();
  });

  const back = el('button', 'tracktube-triage-ghost', t('tri.back'));
  back.type = 'button';
  back.addEventListener('click', renderIntro);

  panel.append(actionRow(apply, back));
  mounted.root.replaceChildren(panel);
}

/** `Element.append()` returns nothing: the row is built separately. */
function actionRow(...buttons) {
  const row = el('div', 'tracktube-triage-actions');
  row.append(...buttons);
  return row;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

async function renderCard() {
  if (!mounted) return;

  if (state.index >= state.queue.length) { renderSummary(); return; }
  const channel = state.queue[state.index];

  // Progress is counted over all subscriptions, not over the remaining queue:
  // after resuming, starting again from "1 / 40" would give the impression
  // everything had been lost.
  const done = state.decided.size;
  const total = state.channels.length;

  const wrap = el('div', 'tracktube-triage-stage');

  // -- header and progress
  const header = el('div', 'tracktube-triage-header');
  // The counter says what the bar measures — the decisions made — and not the
  // rank of the displayed card. Side by side the two contradicted each other:
  // "4 / 4" above a bar three quarters full.
  header.append(el('span', 'tracktube-triage-count', t('tri.count', { n: done, total })));

  const close = el('button', 'tracktube-triage-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', t('tri.quit'));
  close.addEventListener('click', unmountTriage);
  header.append(close);

  const bar = el('div', 'tracktube-triage-progress');
  const fill = el('i');
  fill.style.width = `${(done / total) * 100}%`;
  bar.append(fill);

  // What the application really did while the triage went on. Without this
  // feedback, the sliding queue would work with nothing to show for it.
  const run = el('p', 'tracktube-triage-run');
  run.id = 'tracktube-triage-run';
  run.hidden = true;

  // -- card
  const card = el('div', 'tracktube-triage-card');
  card.dataset.channelId = channel.id;

  // Two possible failures, not one: the URL may be missing, and it may exist
  // while returning 404. Without the second case, the card showed the browser's
  // "broken image" square where the feed already knows to place a badge.
  const badge = () => {
    const span = el('span', 'tracktube-triage-initial', (channel.title.trim()[0] ?? '?').toUpperCase());
    span.classList.add('tracktube-triage-avatar');
    return span;
  };

  let avatar;
  if (channel.avatarUrl) {
    avatar = Object.assign(document.createElement('img'), { src: channel.avatarUrl, alt: '' });
    avatar.classList.add('tracktube-triage-avatar');
    avatar.addEventListener('error', () => avatar.replaceWith(badge()), { once: true });
  } else {
    avatar = badge();
  }

  card.append(avatar, el('h3', null, channel.title || channel.id));

  // The size of the channel helps decide: leaving a confidential channel and
  // leaving one followed by millions do not call for the same judgement. The
  // information arrives with the subscription list, with no extra request.
  const subtitle = [formatSubscribers(channel.subscriberCount), channel.handle]
    .filter(Boolean).join(' · ');
  if (subtitle) card.append(el('p', 'tracktube-triage-sub', subtitle));

  const facts = el('div', 'tracktube-triage-facts');
  facts.append(el('p', null, channel.lastUploadAt
    ? t('tri.lastvideo', { when: relativeTime(channel.lastUploadAt) })
    : t('tri.novideo')));

  const cadence = describeCadence(channel);
  if (cadence) facts.append(el('p', null, cadence));

  // Computed over all subscriptions, not over the displayed card: see
  // `describeWatching`.
  const watched = describeWatching(channel, { hasWatchData: hasWatchData(state.channels) });
  if (watched) facts.append(el('p', null, watched));

  const hiding = describeHiding(channel);
  if (hiding) facts.append(el('p', 'tracktube-triage-flag', hiding));

  card.append(facts);

  // Twelve is enough: the feeds only give fifteen videos per channel, so a "see
  // more" button would have three entries to reveal.
  const strip = el('div', 'tracktube-triage-thumbs');
  card.append(strip);

  // -- decisions
  const actions = el('div', 'tracktube-triage-decide');

  const drop = el('button', 'tracktube-triage-drop', t('tri.drop'));
  drop.type = 'button';
  drop.addEventListener('click', () => flingCard(false));

  const back = el('button', 'tracktube-triage-ghost', t('tri.undo'));
  back.type = 'button';
  back.disabled = undoableCount() <= 0;
  back.setAttribute('aria-label', back.disabled
    ? t('tri.undo.none')
    : t('tri.undo.title', { n: undoableCount() }));
  back.addEventListener('click', goBack);

  const keep = el('button', 'tracktube-triage-keep', t('tri.keep'));
  keep.type = 'button';
  keep.addEventListener('click', () => flingCard(true));

  actions.append(drop, back, keep);

  // Colour veil during the drag: green to the right, red to the left. The
  // colour alone is enough — an overlaid label added nothing the gesture and
  // the hue did not already say.
  card.append(el('div', 'tracktube-triage-veil'));

  enableDrag(card);

  wrap.append(header, bar, card, actions, run);
  mounted.root.replaceChildren(wrap);
  updateRunStatus();

  loadThumbs(channel.id, strip, 0);
}

// ---------------------------------------------------------------------------
// Dragging
// ---------------------------------------------------------------------------

/** Distance beyond which releasing counts as a decision. */
const DRAG_THRESHOLD_RATIO = 0.22;
const DRAG_THRESHOLD_MAX = 160;

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Makes the card draggable with the mouse or a finger.
 *
 * We follow the pointer, tilt slightly, and the veil takes on colour as the
 * threshold approaches. Released before it, the card springs back; beyond it,
 * it flies off and the decision is made.
 *
 * `setPointerCapture` guarantees a fast movement leaving the card stays tracked
 * until release — without which the gesture would get lost on the way.
 */
function enableDrag(card) {
  let startX = 0;
  let dx = 0;
  let dragging = false;

  const threshold = () =>
    Math.min(DRAG_THRESHOLD_MAX, card.getBoundingClientRect().width * DRAG_THRESHOLD_RATIO);

  const paint = () => {
    const ratio = Math.max(-1, Math.min(1, dx / threshold()));
    card.style.transform = `translateX(${dx}px) rotate(${ratio * 4}deg)`;
    card.style.setProperty('--tracktube-drag', String(ratio));
    card.style.setProperty('--tracktube-drag-abs', String(Math.abs(ratio)));
  };

  const reset = (animated = true) => {
    card.classList.toggle('is-springing', animated && !reducedMotion());
    card.style.transform = '';
    card.style.setProperty('--tracktube-drag', '0');
    card.style.setProperty('--tracktube-drag-abs', '0');
  };

  card.addEventListener('pointerdown', (event) => {
    // Thumbnails and buttons keep their own behaviour.
    if (event.target.closest('a, button')) return;
    if (event.button !== 0) return;

    dragging = true;
    startX = event.clientX;
    dx = 0;
    card.classList.remove('is-springing');
    card.setPointerCapture(event.pointerId);
  });

  card.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    dx = event.clientX - startX;
    paint();
  });

  const finish = (event) => {
    if (!dragging) return;
    dragging = false;
    card.releasePointerCapture?.(event.pointerId);

    if (Math.abs(dx) < threshold()) { reset(); return; }
    flingCard(dx > 0);
  };

  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', (event) => { dragging = false; reset(); card.releasePointerCapture?.(event.pointerId); });
}

/**
 * Flings the card out, then records the decision.
 *
 * Used by all three modes — drag, buttons, arrow keys — so that they produce
 * exactly the same movement. Deciding with the keyboard without an animation
 * gave an abrupt sequence where one doubted having acted at all, and above all
 * in which direction.
 *
 * The decision never depends on the animation: `transitionend` may never arrive
 * — background tab, interrupted transition, removed element — and the triage
 * would stay stuck on a card already off screen. A fallback timeout fires it in
 * every case, and a latch keeps it from firing twice.
 *
 * @param {boolean} keep
 */
function flingCard(keep) {
  const card = mounted?.root.querySelector('.tracktube-triage-card');
  if (!card) return;
  // A card already gone is not decided again: without this, two rapid presses
  // would consume two channels for a single visible gesture.
  if (card.classList.contains('is-leaving')) return;

  if (reducedMotion()) { decide(keep); return; }

  card.classList.remove('is-springing');
  card.classList.add('is-leaving');
  // The veil leaves tinted on the right side, as after a drag.
  card.style.setProperty('--tracktube-drag', keep ? '1' : '-1');
  card.style.setProperty('--tracktube-drag-abs', '1');
  card.style.transform = `translateX(${keep ? 140 : -140}%) rotate(${keep ? 12 : -12}deg)`;

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    card.removeEventListener('transitionend', onEnd);
    decide(keep);
  };

  // `transitionend` bubbles up from the children and fires once per animated
  // property. Without this filter, an inner element's transition cut the exit
  // short and the next card appeared immediately.
  function onEnd(event) {
    if (event.target === card && event.propertyName === 'transform') commit();
  }

  card.addEventListener('transitionend', onEnd);
  // Well beyond the transition's 300 ms: this delay must catch an animation
  // that never arrives, not race against it.
  setTimeout(commit, 600);
}

/**
 * Loads a batch of thumbnails.
 *
 * The slots are created **before** the request, at their final size. Without
 * that, the card was born short then grew as the images arrived: since it is
 * vertically centred, the whole block jumped up at once and the header and the
 * progress bar were seen hopping at every change of channel.
 */
async function loadThumbs(channelId, strip, offset) {
  const slots = Array.from({ length: THUMBS_PER_LOAD }, () => {
    const slot = el('span', 'tracktube-triage-thumb is-loading');
    strip.append(slot);
    return slot;
  });

  const res = await send(MSG.TRIAGE_VIDEOS, { channelId, limit: THUMBS_PER_LOAD, offset });

  // The card may have changed during the request.
  if (!mounted || mounted.root.querySelector('.tracktube-triage-card')?.dataset.channelId !== channelId) {
    return;
  }

  const videos = res.ok ? res.videos : [];

  slots.forEach((slot, i) => {
    const video = videos[i];
    if (!video) { slot.remove(); return; }

    const link = document.createElement('a');
    link.className = 'tracktube-triage-thumb';
    link.href = `/watch?v=${encodeURIComponent(video.id)}`;
    // New tab: we do not want to lose our place in the triage.
    link.target = '_blank';
    link.rel = 'noopener';
    link.setAttribute('aria-label', video.title);

    const img = document.createElement('img');
    img.src = video.thumbUrl || `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;
    img.alt = '';
    link.append(img);
    slot.replaceWith(link);
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function decide(keep) {
  const channel = state.queue[state.index];
  if (!channel) return;

  state.decisions.push({ channelId: channel.id, keep });
  state.decided.set(channel.id, keep);
  state.index++;
  // Everything past the undo depth becomes final.
  state.committed = Math.max(0, state.decisions.length - UNDO_DEPTH);

  saveProgress();
  flushCommitted();
  renderCard();
}

/**
 * Hands over to execution the decisions that have left the undo window.
 *
 * This is the sliding queue: only the last five cards are held back, the rest
 * leaves while the triage goes on. Waiting until the end would impose several
 * minutes of progress to watch, for work that does perfectly well in the
 * background.
 */
function flushCommitted() {
  const toSend = state.decisions
    .slice(0, state.committed)
    .filter((d) => !d.keep && !state.sent.has(d.channelId))
    .map((d) => d.channelId);
  if (!toSend.length) return;

  for (const id of toSend) state.sent.add(id);
  state.pending.push(...toSend);
  pumpUnsubscriptions();
}

/**
 * Applies the queue, one channel at a time.
 *
 * Serialised, but each call costs around 150 ms: the queue drains at the pace
 * of the triage without ever slowing it down. That is what the previous
 * version, which drove YouTube's interface in a background tab, could not
 * offer — it needed some fifteen seconds per channel, when it managed at all.
 */
async function pumpUnsubscriptions() {
  if (state.pumpRunning) return;
  state.pumpRunning = true;

  try {
    const { unsubscribeChannel } = await import(chrome.runtime.getURL('src/content/innertube.js'));

    while (state.pending.length) {
      const channelId = state.pending[0];
      const gone = await unsubscribeChannel(channelId);

      if (!gone) {
        // We stop rather than carry on: if YouTube refuses, insisting would fix
        // nothing and would hide the problem.
        state.failure = channelId;
        log.error(`Unsubscription refused by YouTube: ${channelId}`);
        break;
      }

      state.pending.shift();
      state.leftCount++;
      // The service worker deactivates the channel and deletes its videos. Same
      // message as the automatic detection: a single write path.
      await send(MSG.SUBSCRIPTION_SEEN, {
        channelId, subscribed: false, source: 'triage', key: activeAccountKey(),
      });
      updateRunStatus();
    }
  } catch (err) {
    log.error('Could not apply the unsubscriptions', err);
    state.failure = state.pending[0] ?? null;
  } finally {
    state.pumpRunning = false;
    updateRunStatus();
  }
}

/** Reflects the progress of the application under the card. */
function updateRunStatus() {
  const zone = mounted?.root.querySelector('#tracktube-triage-run');
  if (!zone) return;

  if (state.failure) {
    zone.hidden = false;
    zone.textContent = t('tri.run.refused');
    return;
  }

  zone.hidden = !state.leftCount && !state.pending.length;
  zone.textContent = state.pending.length
    ? t('tri.run.going', { n: state.leftCount, left: state.pending.length })
    : t('tri.run.done', { n: state.leftCount });
}

/**
 * Goes back on the previous decision and shows the card again, so another
 * choice can be made.
 *
 * The depth is bounded to five: beyond that, the decision has been applied.
 */
function goBack() {
  if (undoableCount() <= 0) return;
  const last = state.decisions.pop();
  state.decided.delete(last.channelId);
  state.index = Math.max(0, state.index - 1);
  saveProgress();
  renderCard();
}

function onKeyDown(event) {
  if (!mounted) return;
  if (event.key === 'Escape') { unmountTriage(); return; }
  if (!mounted.root.querySelector('.tracktube-triage-card')) return;

  if (event.key === 'ArrowRight') { event.preventDefault(); flingCard(true); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); flingCard(false); }
  else if (event.key === 'Backspace') { event.preventDefault(); goBack(); }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** A backup over a week old no longer protects much. */
const BACKUP_MAX_AGE_MS = 7 * 24 * 3600e3;

/**
 * Closing screen.
 *
 * It asks for nothing. With the sliding queue, everything past the undo window
 * has already left during the triage, and what remains leaves on arriving here
 * — the user has already decided, card by card, and did so knowing only the
 * last five stayed undoable. Asking for a confirmation at the end would add a
 * step to a choice already made.
 */
function renderSummary() {
  // The last decisions, still inside the window: the triage is over, so they
  // leave it now.
  if (state.committed < state.decisions.length) {
    state.committed = state.decisions.length;
    saveProgress();
    flushCommitted();
  }

  const left = [...state.decided].filter(([, keep]) => !keep).length;
  const kept = state.decided.size - left;

  const panel = el('div', 'tracktube-triage-panel');
  panel.append(
    el('h2', null, t('tri.end')),
    el('p', 'tracktube-triage-lead', t('tri.end.count', { kept, left })),
    el('p', 'tracktube-triage-notice', t('tri.end.notice')),
  );

  const runStatus = el('p', 'tracktube-triage-run');
  runStatus.id = 'tracktube-triage-run';
  runStatus.hidden = true;
  panel.append(runStatus);
  updateRunStatus();

  panel.append(actionRow(restartButton(), closeButton()));
  mounted.root.replaceChildren(panel);
}

function restartButton() {
  const again = el('button', 'tracktube-triage-ghost', t('tri.restart'));
  again.type = 'button';
  again.addEventListener('click', () => {
    state.decided.clear();
    state.decisions = [];
    state.committed = 0;
    saveProgress();
    renderIntro();
  });
  return again;
}

function closeButton() {
  const close = el('button', 'tracktube-triage-ghost', t('pop.close'));
  close.type = 'button';
  close.addEventListener('click', unmountTriage);
  return close;
}
