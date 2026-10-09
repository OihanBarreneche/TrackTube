/**
 * The language switch and the version number of the privacy notice.
 *
 * This lives in a file of its own, and that is the whole point. An extension
 * page runs under Manifest V3's default `script-src 'self'`, which blocks an
 * inline `<script>` outright and silently. The first version of this code was
 * inline and was verified over `http://127.0.0.1`, where inline scripts do run;
 * inside the extension it did exactly what was reported — the page opened in
 * French, the English button did nothing at all, and the version stayed at
 * whatever the markup happened to say. Do not fold it back into the page.
 *
 * It is a classic script and not a module on purpose: this page is also served
 * on its own, from a URL a store listing points at, with nothing of the
 * extension loaded. It must therefore run with no import, no `chrome` and no
 * build step, which is also why both languages stay in the document instead of
 * being fetched.
 */
(function () {
  // Every element of the body that declares a language, which is the sections
  // and the two halves of the title. It used to be `section[lang]` alone, and
  // the English page was then headed by the French line. The language buttons
  // carry `data-lang` rather than `lang`, so they are not caught by this.
  var blocks = document.body.querySelectorAll('[lang]');
  var buttons = document.querySelectorAll('.lang button');

  // Whether the reader has decided on this page. The extension's own language
  // is read asynchronously, and that answer must never land on top of a click
  // already made: a button that undoes itself a moment later is a button that
  // looks broken.
  var chosen = false;

  function show(lang, remember) {
    document.documentElement.lang = lang;
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].hidden = blocks[i].lang !== lang;
    }
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].setAttribute('aria-pressed', String(buttons[j].dataset.lang === lang));
    }
    // Only an explicit choice is written down. Persisting the opening default
    // too would pin the page to the language of its first visit, and the
    // extension's own setting would never reach it again.
    if (remember) {
      try { localStorage.setItem('tracktube:privacyLang', lang); } catch (e) { /* private window */ }
    }
  }

  for (var k = 0; k < buttons.length; k++) {
    buttons[k].addEventListener('click', function () {
      chosen = true;
      show(this.dataset.lang, true);
    });
  }

  // The last choice made here, then the browser's language. The extension's
  // setting comes after, when there is an extension and nothing has been chosen.
  var stored = null;
  try { stored = localStorage.getItem('tracktube:privacyLang'); } catch (e) { /* ignored */ }
  var fromBrowser = (navigator.language || 'fr').slice(0, 2) === 'en' ? 'en' : 'fr';
  show(stored === 'en' || stored === 'fr' ? stored : fromBrowser, false);

  try {
    if (window.chrome && chrome.runtime && chrome.runtime.getManifest) {
      var version = chrome.runtime.getManifest().version;
      var marks = document.querySelectorAll('.version');
      for (var m = 0; m < marks.length; m++) marks[m].textContent = version;

      if (!stored && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('ytfeed:lang').then(function (got) {
          var lang = got && got['ytfeed:lang'];
          if (!chosen && (lang === 'fr' || lang === 'en')) show(lang, false);
        }, function () { /* not available */ });
      }
    }
  } catch (e) { /* served as a plain file */ }
}());
