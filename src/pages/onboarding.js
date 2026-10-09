/**
 * Getting started, on first launch.
 *
 * Only two things are really decided here: the subscription list is fetched,
 * and the record of what you watch is accepted or refused. Everything else is
 * context setting, and can be skipped.
 *
 * The import is triggered from this page but carried out by the content script
 * of a YouTube tab: that is what has the session, the extension has none. The
 * tab is opened in the background so this screen stays in front of the user,
 * and progress is read here from the number of channels in the database.
 */

import { MSG } from '../lib/messages.js';
import { t, initLocale, getLocale, LANG_KEY, setLocale } from '../lib/i18n.js';
import { translateDom } from '../lib/i18n-dom.js';

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'ytfeed:settings';
const IMPORT_FLAG = 'ytfeed:pendingImport';

/** Marks onboarding as seen: the service worker will not reopen it. */
const SEEN_KEY = 'ytfeed:onboarded';

const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

// ---------------------------------------------------------------------------
// Moving between steps
// ---------------------------------------------------------------------------

const steps = [...document.querySelectorAll('.step')];
let current = 0;

function show(n) {
  current = Math.max(0, Math.min(steps.length - 1, n));
  for (const [i, el] of steps.entries()) el.hidden = i !== current;

  for (const [i, dot] of [...$('steps-bar').children].entries()) {
    dot.classList.toggle('active', i === current);
    dot.classList.toggle('passed', i < current);
    dot.setAttribute('aria-current', i === current ? 'step' : 'false');
  }

  // On the last step, "Skip" and "Open my feed" would do the same thing in two
  // places of the screen.
  $('btn-skip').hidden = current === steps.length - 1;

  // Going back from the bottom of a long step left the next one displayed
  // halfway down, with nothing readable on screen.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function buildDots() {
  $('steps-bar').textContent = '';
  for (const [i] of steps.entries()) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', t('onb.step.aria', { n: i + 1 }));
    dot.addEventListener('click', () => show(i));
    $('steps-bar').append(dot);
  }
}

document.addEventListener('click', (e) => {
  const jump = e.target.closest('[data-go]');
  if (jump) show(current + Number(jump.dataset.go));
});

// ---------------------------------------------------------------------------
// Importing the subscriptions
// ---------------------------------------------------------------------------

/**
 * How many channels the extension already knows.
 *
 * Serves as a progress measure: the importing tab does not report to this page,
 * but it writes to the database, and the database can be queried.
 */
async function channelCount() {
  const res = await send(MSG.GET_STATS);
  return res?.ok ? (res.stats?.activeChannels ?? 0) : 0;
}

function setStatus(text, cls = '') {
  const el = $('import-status');
  el.hidden = false;
  el.className = `status ${cls}`;
  el.textContent = '';
  if (!cls) el.append(Object.assign(document.createElement('span'), { className: 'spinner' }));
  el.append(text);
}

/** Kept so the status can be redisplayed in the new language. */
let importedChannels = 0;

function importDone(n) {
  importedChannels = n;
  setStatus(t('onb.s3.done', { n }), 'done');
  $('btn-import').textContent = t('onb.s3.again');
  $('import-note').hidden = true;
  $('btn-later').hidden = true;
  $('btn-import-next').hidden = false;
}

/**
 * Opens or reuses a YouTube tab and asks it for the list.
 *
 * An already open tab answers at once. Otherwise one has to be created, and its
 * content script has to start: hence the flag in storage, which the script
 * picks up by itself on load.
 */
async function startImport() {
  $('btn-import').disabled = true;
  setStatus(t('onb.s3.wait'));

  const before = await channelCount();
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });

  let launched = false;
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.RUN_IMPORT });
      launched = true;
      break;
    } catch { /* tab with no active script: try the next one */ }
  }

  if (!launched) {
    await chrome.storage.local.set({ [IMPORT_FLAG]: true });
    // In the background: this screen stays what the user has in front of them.
    await chrome.tabs.create({ url: 'https://www.youtube.com/feed/subscriptions', active: false });
  }

  await awaitImport(before);
}

/** The import does not announce its end to this page: we watch the database move. */
async function awaitImport(before) {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const n = await channelCount();
    if (n > before) { importDone(n); $('btn-import').disabled = false; return; }
  }

  setStatus(t('onb.s3.fail'), 'failed');
  $('btn-import').disabled = false;
}

$('btn-import').addEventListener('click', startImport);

// ---------------------------------------------------------------------------
// Recording what gets watched
// ---------------------------------------------------------------------------

/**
 * The choice is written as soon as it is made, not at the end.
 *
 * Nobody reaches the last screen of an onboarding flow: if saving waited for
 * the final button, a refusal expressed midway would be lost — which is exactly
 * the case where getting it wrong is not acceptable.
 */
async function saveTracking(enabled) {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] ?? {};
  stored.liveHistory = enabled;
  await chrome.storage.local.set({ [SETTINGS_KEY]: stored });
}

for (const radio of document.querySelectorAll('input[name="releve"]')) {
  radio.addEventListener('change', () => saveTracking(radio.value === 'oui'));
}

// ---------------------------------------------------------------------------
// Ways out
// ---------------------------------------------------------------------------

$('btn-history-page').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html#import') });
});

/** Leaving the flow, either through the end or through the Skip button. */
async function leave() {
  await chrome.storage.local.set({ [SEEN_KEY]: true });
  // An ordinary navigation rather than `chrome.tabs.update`: the extension does
  // not have the `tabs` permission, and the welcome tab has served its purpose.
  location.href = 'https://www.youtube.com/feed/subscriptions';
}

$('btn-finish').addEventListener('click', leave);
$('btn-skip').addEventListener('click', leave);

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

/**
 * Retranslates the whole page.
 *
 * The texts written by the script carry no markup: they are redone by hand.
 * There are only three of them, all in the import step.
 */
function retranslate() {
  document.documentElement.lang = getLocale();
  translateDom();
  buildDots();
  show(current);
  if (importedChannels > 0) importDone(importedChannels);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

(async function start() {
  await initLocale();
  translateDom();
  buildDots();
  show(0);

  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  // The selector shows the language in force, chosen or inherited from the
  // browser, and writes the same key the popup does: the two stay in step
  // through the storage listener below.
  $('onb-lang').value = getLocale();
  $('onb-lang').addEventListener('change', async () => {
    setLocale($('onb-lang').value);
    await chrome.storage.local.set({ [LANG_KEY]: getLocale() });
    retranslate();
  });

  // Reopening onboarding from the help must not offer an import already done.
  const already = await channelCount();
  if (already > 0) importDone(already);

  const stored = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] ?? {};
  const tracking = stored.liveHistory === true;
  document.querySelector(`input[name="releve"][value="${tracking ? 'oui' : 'non'}"]`).checked = true;

  // The language can change from the popup while this screen is open.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes[LANG_KEY]) return;
    await initLocale();
    $('onb-lang').value = getLocale();
    retranslate();
  });

  // An onboarding abandoned along the way is still an onboarding seen:
  // reopening it every time the browser starts would be more annoying than
  // useful, and the "Getting started" button exists in the help.
  await chrome.storage.local.set({ [SEEN_KEY]: true });
})();

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
