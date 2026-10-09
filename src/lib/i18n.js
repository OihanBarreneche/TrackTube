/**
 * Interface translation, in French and English.
 *
 * The `chrome.i18n` API is not used, and that is not an oversight: it follows
 * the browser language and the extension cannot change it. What we want here is
 * precisely for the language to be a setting — someone whose Chrome is in
 * English may want their feed in French, and the other way round.
 *
 * The catalogues are therefore ordinary JavaScript modules, imported
 * statically: they behave identically in the service worker, the popup, the
 * pages and the content scripts, with no `fetch` and no permission.
 *
 * Usage:
 *
 *     import { t, initLocale } from '../lib/i18n.js';
 *     await initLocale();            // once, at start up
 *     t('feed.search.placeholder')   // "Search the feed"
 *     t('feed.videos.count', { n: 3 })
 *
 * A missing key renders itself rather than emptying the interface: extra text
 * is visible, an empty string goes unnoticed until the day somebody reports a
 * button with no label.
 */

import { fr } from './locales/fr.js';
import { en } from './locales/en.js';

export const LOCALES = ['fr', 'en'];

const CATALOGUES = { fr, en };
export const LANG_KEY = 'ytfeed:lang';

/**
 * The browser language narrowed down to the ones we know.
 *
 * Used as the default until the user has chosen: landing in French on an
 * English Chrome would be just as arbitrary as the reverse.
 */
function defaultLocale() {
  const nav = (globalThis.navigator?.language ?? 'fr').slice(0, 2).toLowerCase();
  return LOCALES.includes(nav) ? nav : 'en';
}

let current = defaultLocale();

export function getLocale() {
  return current;
}

export function setLocale(code) {
  current = LOCALES.includes(code) ? code : defaultLocale();
  return current;
}

/**
 * Reads the chosen language and installs it. Call once when each context starts
 * up — storage is asynchronous, `t()` is not.
 */
export async function initLocale() {
  try {
    const stored = await chrome.storage.local.get(LANG_KEY);
    setLocale(stored?.[LANG_KEY] ?? defaultLocale());
  } catch {
    setLocale(defaultLocale());
  }
  return current;
}

/** Saves the chosen language. Open contexts see it through `onChanged`. */
export async function saveLocale(code) {
  setLocale(code);
  await chrome.storage.local.set({ [LANG_KEY]: current });
  return current;
}

/**
 * Translates a key.
 *
 * Parameters are substituted on `{name}`. A numeric parameter named `n` also
 * drives plurals: a key may hold a string, or an object `{ one, other }` —
 * English and French do not split at the same place for zero, hence the choice
 * of letting each catalogue decide instead of wiring in a single rule.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(key, params = {}) {
  const raw = CATALOGUES[current]?.[key] ?? CATALOGUES.fr[key] ?? key;

  const form = typeof raw === 'object'
    ? (pickPlural(raw, Number(params.n)) ?? key)
    : raw;

  return String(form).replace(/\{(\w+)\}/g, (whole, name) => (
    params[name] === undefined ? whole : String(params[name])
  ));
}

function pickPlural(forms, n) {
  if (Number.isNaN(n)) return forms.other ?? forms.one;
  // French files 0 with the singular, English with the plural. Each catalogue
  // may supply `zero` if it wants to decide otherwise.
  if (n === 0 && forms.zero !== undefined) return forms.zero;
  const singular = current === 'fr' ? n < 2 : n === 1;
  return singular ? (forms.one ?? forms.other) : (forms.other ?? forms.one);
}

/** Language tag for `toLocaleString` and friends. */
export function bcp47() {
  return current === 'fr' ? 'fr-FR' : 'en-US';
}
