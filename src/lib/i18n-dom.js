/**
 * Translation of the static HTML pages.
 *
 * Content scripts build their interface in JavaScript and call `t()` as they
 * create each node. The pages shipped as HTML (popup, analysis, onboarding)
 * have their text written into the document instead: turning it all into `t()`
 * calls would mean rebuilding every page in JavaScript, which would cost far
 * more than it would return.
 *
 * Hence the markup: the French text stays in the HTML, where it acts as a
 * fallback and keeps the document readable as it is, and an attribute carries
 * the key.
 *
 *     <h1 data-i18n="onb.s1.h">Ton feed d’abonnements, en entier</h1>
 *     <input data-i18n-placeholder="feed.search.placeholder">
 *     <button data-i18n-label="feed.refresh.title">
 *
 * `translateDom()` replaces everything in one pass, after `initLocale()`.
 * Content is never injected as HTML: each key fills a `textContent` or an
 * attribute, so a catalogue cannot introduce markup.
 */

import { t } from './i18n.js';

/**
 * Translatable attributes, from the `data-i18n-…` suffix to the real attribute.
 *
 * `title` is no longer among them: the browser's grey tooltip takes a second to
 * appear, ignores the page styling and clashes with everything else. What was
 * only a name moved to `aria-label`.
 *
 * `info` is gone with it. The analysis page draws its own hover box, but what it
 * shows there is a chart reading built by the script, never a sentence written
 * in the markup: a block whose meaning has to be hovered for is a block that has
 * not been named properly, and the paragraphs that used to hang off these
 * figures are now written under them.
 */
const ATTRIBUTES = {
  placeholder: 'placeholder',
  label: 'aria-label',
  alt: 'alt',
  value: 'value',
};

/**
 * Translates a fragment of an already built document.
 *
 * Idempotent: the key lives in the attribute, not in the replaced text, so a
 * second pass after a language change re-translates from the source and not
 * from the previous translation. That is what allows the whole page to be wired
 * to `chrome.storage.onChanged` without reloading it.
 *
 * @param {ParentNode} [root]
 */
export function translateDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n, readParams(el));
  }

  for (const [suffix, attribute] of Object.entries(ATTRIBUTES)) {
    for (const el of root.querySelectorAll(`[data-i18n-${suffix}]`)) {
      el.setAttribute(attribute, t(el.dataset[`i18n${capitalize(suffix)}`], readParams(el)));
    }
  }
}

/**
 * Substitution parameters, carried by `data-i18n-arg-…`.
 *
 * Used by the rare fixed texts that contain a value known at writing time, a
 * number of years or a file format. Values computed at run time go through
 * `t()` directly, not through the markup.
 */
function readParams(el) {
  const params = {};
  for (const [key, value] of Object.entries(el.dataset)) {
    if (key.startsWith('i18nArg')) params[uncapitalize(key.slice(7))] = value;
  }
  return params;
}

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);
const uncapitalize = (s) => s[0].toLowerCase() + s.slice(1);
