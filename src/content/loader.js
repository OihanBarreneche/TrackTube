/**
 * Content script bootstrap.
 *
 * Content scripts declared in the manifest are classic scripts: MV3 has no way
 * to declare one as an ES module. So we load the real module dynamically —
 * `import()` does work, provided the target is listed under
 * `web_accessible_resources`.
 */

(async () => {
  try {
    const mod = await import(chrome.runtime.getURL('src/content/main.js'));
    await mod.init();
  } catch (err) {
    console.error('[tracktube] Could not load the content script', err);
  }
})();
