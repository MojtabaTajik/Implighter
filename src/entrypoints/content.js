// Content script entry point.
//
// MV3 content_scripts cannot be ES modules, and listing several files in the
// manifest's js array puts them all in one global scope — which defeats slice
// isolation. Dynamic import of extension-packaged modules works from a content
// script provided they are web_accessible_resources, so this stays a classic
// script whose only job is to pull in the real modules.
//
// Each slice registers its own listeners; nothing here knows what they do.

(async () => {
  const load = (path) => import(chrome.runtime.getURL(path));

  // Guard against double injection: entry points call ensureInjected on every
  // invocation, and a second run would register every listener twice.
  if (window.__implighterLoaded) return;
  window.__implighterLoaded = true;

  try {
    const [highlight, summarize] = await Promise.all([
      load("src/features/highlight/content.js"),
      load("src/features/summarize/content.js")
    ]);

    highlight.initHighlight();
    summarize.initSummarize();

    // Registered last, so a ready probe only succeeds once the features behind
    // it can actually answer.
    const { MSG } = await load("src/shared/messaging.js");
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== MSG.PING) return false;
      sendResponse({ ok: true });
      return false;
    });
  } catch (err) {
    // A failure here means no feature works on this page, and it is otherwise
    // silent — the popup would just report "reload this page".
    console.error("[implighter] failed to initialise:", err);
  }
})();
