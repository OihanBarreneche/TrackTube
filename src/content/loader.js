/**
 * Content script bootstrap.
 *
 * Content scripts declared in the manifest are classic scripts: MV3 has no way
 * to declare one as an ES module. So we load the real module dynamically —
 * `import()` does work, provided the target is listed under
 * `web_accessible_resources`.
 */

/**
 * Name of the page attribute through which two copies of this extension find
 * out about each other.
 *
 * **Two installed copies are invisible to one another in JavaScript.** Each
 * extension's content script runs in its own isolated world, so a marker on
 * `window` set by one is simply not there for the other. The DOM is the only
 * thing they share, hence an attribute on `<html>`.
 *
 * Why this guard exists at all: an unpacked copy loaded from a folder and the
 * same extension installed from the Store are two different origins, with two
 * different `chrome-extension://<id>/` roots and therefore **two different
 * IndexedDB databases**. Both inject here, both replace the subscriptions page,
 * and whichever paints last wins. Hiding a video then writes to the database of
 * whichever grid owned that card, and the next cold start may well be painted
 * by the other copy, which never heard about it. From inside either database
 * everything is consistent and durable — the storage layer is covered by a test
 * that reads a hidden row back through a fresh connection — and the reader sees
 * videos they hid come back every morning with nothing anywhere to explain it.
 *
 * A second copy therefore stands down rather than fighting, and says so.
 */
const OWNER_ATTR = 'data-tracktube-owner';

(async () => {
  try {
    const root = document.documentElement;
    const owner = root.getAttribute(OWNER_ATTR);
    const me = chrome.runtime.id;

    // Same id is re-entrant on purpose: an extension reload re-injects into a
    // document that may still carry our own marker, and that must not disable
    // the extension until the next full page load.
    if (owner && owner !== me) {
      console.error('[tracktube] Another copy of TrackTube already runs on this page '
        + `(${owner}), so this one (${me}) is standing down. Two copies keep two `
        + 'separate databases: what you hide in one does not exist in the other. '
        + 'Remove one of them from the extensions page.');
      return;
    }
    root.setAttribute(OWNER_ATTR, me);

    const mod = await import(chrome.runtime.getURL('src/content/main.js'));
    await mod.init();
  } catch (err) {
    console.error('[tracktube] Could not load the content script', err);
  }
})();
