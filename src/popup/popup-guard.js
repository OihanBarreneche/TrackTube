/**
 * Diagnostic safety net for the popup.
 *
 * A classic script with deliberately no imports at all: if the `popup.js`
 * module fails to load (broken path, syntax error, missing import), none of its
 * code runs — not even an error handler. The buttons then simply look inert,
 * without so much as a message.
 *
 * This file loads first, cannot fail, and makes the failure visible. MV3's CSP
 * forbids inline scripts, so it has to be a separate file.
 *
 * The two sentences it can display are the only user facing strings in the
 * project that do not go through the translation catalogue: reaching the
 * catalogue would mean an import, and an import is exactly what may have
 * failed.
 */

(() => {
  'use strict';

  let moduleReady = false;
  let reported = false;

  /**
   * @param {string} text
   * @param {boolean} [precise]  an identified cause always wins over the generic
   *   timeout message, which arrives later and would otherwise overwrite it.
   */
  function showFatal(text, precise = true) {
    if (reported && !precise) return;
    reported = reported || precise;

    let box = document.getElementById('fatal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fatal';
      box.className = 'alarm';
      box.style.whiteSpace = 'pre-line';
      document.body.insertBefore(box, document.body.firstChild);
    }
    box.hidden = false;
    box.textContent = text;
  }

  window.addEventListener('error', (e) => {
    // A <script> tag that fails fires an error event carrying no message.
    const what = e.message || `Chargement impossible : ${e.target?.src ?? 'ressource inconnue'}`;
    showFatal(`Erreur : ${what}${e.filename ? `\n${e.filename}:${e.lineno}` : ''}`);
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    showFatal(`Promesse rejetée : ${e.reason?.message ?? e.reason}`);
  });

  // The module announces itself. No signal means it never started.
  window.addEventListener('ytfeed:popup-ready', () => { moduleReady = true; });

  setTimeout(() => {
    if (moduleReady) return;
    showFatal(
      "popup.js n'a pas fini de démarrer — les boutons sont inertes.\n" +
      'Clic droit sur la popup → Inspecter → onglet Console pour la cause.',
      false,
    );
  }, 1500);
})();
