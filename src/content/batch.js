/**
 * Applying a list of channels to the account, in batches.
 *
 * Triage handles subscriptions one by one, with context and an undo window.
 * Here everything comes from a file: there is nothing to look at, the decision
 * was taken elsewhere, and the only question is "are you sure of what this file
 * contains". So the screen is built around that question and not around the
 * channels.
 *
 * Three safety rails, in this order:
 *
 * 1. The complete plan is displayed before a single request goes out, line by
 *    line and by name. A malformed file shows up immediately.
 * 2. Every line can be unchecked. Nothing forces you to apply everything.
 * 3. If there are departures, a backup less than a week old is required — not
 *    merely advised. A badly started triage costs one channel at a time; a
 *    badly chosen file would cost nine hundred at once, and that cannot be
 *    undone.
 *
 * Nothing goes out before "Apply" is pressed. Opening this screen, changing
 * mode, checking and unchecking never touches the account.
 */

import { MSG, send } from '../lib/messages.js';
import { MODES, planApplication } from '../lib/subscriptions-csv.js';
import { log } from '../lib/log.js';
import { activeAccountKey } from './active-account.js';
import { t, initLocale } from '../lib/i18n.js';

const ROOT_ID = 'tracktube-batch';

/** A backup older than this no longer protects much. */
const BACKUP_MAX_AGE_MS = 7 * 24 * 3600e3;

/** Between two calls: YouTube dislikes bursts, and nothing is urgent. */
const PAUSE_MS = 350;

/** Opening request left by the popup, with the file already parsed. */
export const BULK_FLAG = 'ytfeed:pendingLot';
const BULK_FILE = 'ytfeed:lotFichier';

let mounted = null;

const state = {
  /** `{nom, channels: [{id, title}], skipped}` as the popup deposited it. */
  file: null,
  subscriptions: [],
  lastExportAt: 0,
  mode: MODES.SUBSCRIBE,
  /** Ids unchecked by the user. @type {Set<string>} */
  excluded: new Set(),
  /** Application in progress: `null` as long as nothing has been started. */
  run: null,
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Keys: the label is only written when the screen is drawn. */
const MODE_LABELS = {
  [MODES.SUBSCRIBE]: 'lot.mode.join',
  [MODES.UNSUBSCRIBE]: 'lot.mode.leave',
  [MODES.ALIGN]: 'lot.mode.align',
};

const MODE_EXPLANATIONS = {
  [MODES.SUBSCRIBE]: 'lot.mode.join.p',
  [MODES.UNSUBSCRIBE]: 'lot.mode.leave.p',
  [MODES.ALIGN]: 'lot.mode.align.p',
};

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export async function mountBulk() {
  if (mounted) return;

  // The first screen is already translated text: the language comes first.
  await Promise.all([injectStyle(), waitForBody(), initLocale()]);

  const root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.append(root);
  document.documentElement.classList.add('tracktube-batch-open');

  const abort = new AbortController();
  mounted = { root, abort };
  root.replaceChildren(el('div', 'tracktube-batch-panel', t('lot.reading')));

  const stored = await chrome.storage.local.get(BULK_FILE);
  const file = stored?.[BULK_FILE];
  const res = await send(MSG.BULK_CONTEXT, { key: activeAccountKey() });
  if (!mounted) return;

  if (!file?.channels?.length) {
    root.replaceChildren(failure(t('lot.nofile')));
    return;
  }
  if (!res.ok) {
    root.replaceChildren(failure(t('lot.loadfailed', { error: t(res.error) })));
    return;
  }

  state.file = file;
  state.subscriptions = res.subscriptions ?? [];
  state.lastExportAt = res.lastExportAt ?? 0;
  state.mode = MODES.SUBSCRIBE;
  state.excluded = new Set();
  state.run = null;

  document.addEventListener('keydown', onKey, { signal: abort.signal });
  draw();
}

export function unmountBulk() {
  if (!mounted) return;
  // An application in progress is not interrupted by closing the screen: the
  // queue runs to the end, as with triage. Closing it mid flight would leave
  // the account half applied without saying so.
  mounted.abort.abort();
  mounted.root.remove();
  document.documentElement.classList.remove('tracktube-batch-open');
  mounted = null;
}

function onKey(e) {
  if (e.key === 'Escape' && !state.run?.running) unmountBulk();
}

function failure(message) {
  const panel = el('div', 'tracktube-batch-panel');
  panel.append(el('h2', null, t('lot.h')), el('p', 'tracktube-batch-lead', message));
  const close = el('button', 'tracktube-batch-ghost', t('pop.close'));
  close.type = 'button';
  close.addEventListener('click', unmountBulk);
  panel.append(close);
  return panel;
}

/**
 * Injects the stylesheet and resolves once it is applied — see the twin
 * function in `feed-view.js`: appending the panel before the rules arrive
 * showed a second of unstyled HTML.
 */
function injectStyle() {
  const href = chrome.runtime.getURL('src/content/batch.css');
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

function waitForBody() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      if (!document.body) return;
      obs.disconnect();
      resolve();
    });
    obs.observe(document.documentElement, { childList: true });
  });
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * The plan for the current mode.
 *
 * `raw` is what the file implies, `toJoin` and `toLeave` what is left after
 * unchecking. Both are needed: the lists display everything so lines can be
 * checked again, the counters and the execution only cover what is kept.
 */
function currentPlan() {
  const raw = planApplication(state.file.channels, state.subscriptions, state.mode);
  const keep = (c) => !state.excluded.has(c.id);
  return {
    raw,
    unchanged: raw.unchanged,
    toJoin: raw.toJoin.filter(keep),
    toLeave: raw.toLeave.filter(keep),
  };
}

function backupMissing(plan) {
  return plan.toLeave.length > 0
    && Date.now() - (state.lastExportAt || 0) > BACKUP_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function draw() {
  if (!mounted) return;
  const plan = currentPlan();

  const panel = el('div', 'tracktube-batch-panel');
  panel.append(header());
  panel.append(modeChoice());
  panel.append(el('p', 'tracktube-batch-explainer', t(MODE_EXPLANATIONS[state.mode])));
  panel.append(summary(plan));

  const alert = warning(plan);
  if (alert) panel.append(alert);

  panel.append(lists(plan));
  panel.append(actions(plan));

  if (state.run) panel.append(progress());

  mounted.root.replaceChildren(panel);
}

function header() {
  const top = el('div', 'tracktube-batch-head');
  const left = el('div');
  left.append(el('h2', null, t('lot.title')));

  const f = state.file;
  left.append(el('p', 'tracktube-batch-lead',
    t('lot.file', { name: f.nom, n: f.channels.length })
    + (f.skipped ? t('lot.file.skipped', { n: f.skipped }) : '')));

  const close = el('button', 'tracktube-batch-ghost', t('pop.close'));
  close.type = 'button';
  close.disabled = Boolean(state.run?.running);
  close.addEventListener('click', unmountBulk);

  top.append(left, close);
  return top;
}

function modeChoice() {
  const box = el('div', 'tracktube-batch-modes');
  for (const mode of Object.values(MODES)) {
    const b = el('button', 'tracktube-batch-chip', t(MODE_LABELS[mode]));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.mode === mode));
    b.disabled = Boolean(state.run);
    b.addEventListener('click', () => {
      state.mode = mode;
      // The exclusions applied to the previous plan: keeping them would make
      // lines of the new one disappear with nothing to explain it.
      state.excluded = new Set();
      draw();
    });
    box.append(b);
  }
  return box;
}

function summary(plan) {
  const box = el('div', 'tracktube-batch-summary');
  const figure = (n, word, cls) => {
    const c = el('div', `tracktube-batch-figure ${cls ?? ''}`.trim());
    c.append(el('b', null, String(n)), el('span', null, word));
    return c;
  };
  box.append(figure(plan.toJoin.length, t('lot.count.join'), 'join'));
  box.append(figure(plan.toLeave.length, t('lot.count.leave'), 'leave'));
  box.append(figure(plan.unchanged, t('lot.count.same')));
  return box;
}

function warning(plan) {
  if (backupMissing(plan)) {
    return el('p', 'tracktube-batch-blocking',
      t(state.lastExportAt ? 'lot.backup.old' : 'lot.backup.none'));
  }
  if (plan.toLeave.length) {
    return el('p', 'tracktube-batch-warning',
      t('lot.warning', { n: plan.toLeave.length }));
  }
  return null;
}

function lists(plan) {
  const box = el('div', 'tracktube-batch-lists');
  if (plan.raw.toJoin.length) {
    box.append(column(t('lot.col.join'), plan.raw.toJoin, plan.toJoin.length, 'join'));
  }
  if (plan.raw.toLeave.length) {
    box.append(column(t('lot.col.leave'), plan.raw.toLeave, plan.toLeave.length, 'leave'));
  }
  if (!plan.raw.toJoin.length && !plan.raw.toLeave.length) {
    box.append(el('p', 'tracktube-batch-lead', t('lot.nothing')));
  }
  return box;
}

/**
 * One column of the plan, line by line and by name.
 *
 * Everything is listed, with no folding and no pagination: a truncated plan
 * would no longer be a plan, and large files are exactly where you need to be
 * able to check. The column scrolls.
 */
function column(title, source, kept, cls) {
  const block = el('div', 'tracktube-batch-column');
  const top = el('div', 'tracktube-batch-column-head');
  top.append(el('h3', cls, `${title} · ${kept}`
    + (kept === source.length ? '' : t('lot.col.of', { n: source.length }))));

  const all = el('button', 'tracktube-batch-mini', t(kept ? 'lot.uncheck' : 'lot.check'));
  all.type = 'button';
  all.disabled = Boolean(state.run);
  all.addEventListener('click', () => {
    if (kept) for (const c of source) state.excluded.add(c.id);
    else for (const c of source) state.excluded.delete(c.id);
    draw();
  });
  top.append(all);
  block.append(top);

  const list = el('div', 'tracktube-batch-list');

  for (const c of source) {
    const row = el('label', 'tracktube-batch-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !state.excluded.has(c.id);
    box.disabled = Boolean(state.run);
    box.addEventListener('change', () => {
      if (box.checked) state.excluded.delete(c.id);
      else state.excluded.add(c.id);
      draw();
    });

    const name = el('span', 'tracktube-batch-name', c.title || c.id);
    row.append(box, name);
    list.append(row);
  }

  block.append(list);
  return block;
}

function actions(plan) {
  const box = el('div', 'tracktube-batch-actions');
  const total = plan.toJoin.length + plan.toLeave.length;

  const apply = el('button', 'tracktube-batch-primary',
    total ? t('lot.apply', { n: total }) : t('lot.apply.none'));
  apply.type = 'button';
  apply.disabled = !total || backupMissing(plan) || Boolean(state.run);
  apply.addEventListener('click', () => run(plan));
  box.append(apply);

  // The reminder stays under the button, even when nothing is blocking: it is
  // the last thing read before pressing.
  box.append(el('p', 'tracktube-batch-notice', t('lot.notice')));
  return box;
}

function progress() {
  const r = state.run;
  const box = el('div', 'tracktube-batch-progress');

  const gauge = el('div', 'tracktube-batch-gauge');
  const bar = el('i');
  bar.style.width = `${r.total ? Math.round((r.done / r.total) * 100) : 0}%`;
  gauge.append(bar);
  box.append(gauge);

  if (r.failure) {
    box.append(el('p', 'tracktube-batch-blocking',
      t('lot.run.refused', { name: r.failure, joined: r.joined, left: r.left })));
  } else if (r.running) {
    box.append(el('p', 'tracktube-batch-notice', t('lot.run.going', {
      done: r.done, total: r.total, joined: r.joined, left: r.left,
    })));
  } else {
    box.append(el('p', 'tracktube-batch-done',
      t('lot.run.done', { joined: r.joined, left: r.left })));
  }
  return box;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Executes the plan, one operation at a time.
 *
 * Serialised and spaced out: nothing is urgent, and a burst of several hundred
 * calls is the best way to get the rest refused. On the first refusal we stop
 * dead rather than insist — carrying on would mask the problem and suggest
 * everything went through.
 *
 * The departures are done last. If YouTube cuts us off along the way, we will
 * have lost additions, which can be redone, rather than subscriptions, which
 * cannot.
 */
async function run(plan) {
  if (state.run) return;

  const operations = [
    ...plan.toJoin.map((c) => ({ ...c, action: 'join' })),
    ...plan.toLeave.map((c) => ({ ...c, action: 'leave' })),
  ];

  state.run = { running: true, total: operations.length, done: 0, joined: 0, left: 0, failure: null };
  draw();

  try {
    const { subscribeChannel, unsubscribeChannel } =
      await import(chrome.runtime.getURL('src/content/innertube.js'));

    for (const op of operations) {
      const ok = op.action === 'join'
        ? await subscribeChannel(op.id)
        : await unsubscribeChannel(op.id);

      if (!ok) {
        state.run.failure = op.title || op.id;
        log.error(`Bulk apply: YouTube refused ${op.action} on ${op.id}`);
        break;
      }

      state.run.done++;
      if (op.action === 'join') state.run.joined++;
      else state.run.left++;

      // A single write path to the database, the same as triage and as the
      // automatic detection during navigation.
      await send(MSG.SUBSCRIPTION_SEEN, {
        channelId: op.id, subscribed: op.action === 'join', source: 'lot',
      });

      draw();
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  } catch (err) {
    log.error('Bulk apply failed', err);
    state.run.failure = t('lot.internal');
  } finally {
    state.run.running = false;
    // The file has served its purpose: leaving it in place would reopen the
    // same plan on the next visit to the page, on an account that has changed
    // in the meantime.
    await chrome.storage.local.remove(BULK_FILE);
    draw();
  }
}
