// Service worker entry point. Owns nothing itself — it wires each slice's
// handlers to the runtime and holds the shared badge cleanup.

import { MSG } from "../shared/messaging.js";
import { setBadge, registerBadgeCleanup } from "../shared/badge.js";
import { registerTriggers } from "../shared/triggers.js";
import { classifyChunk, verifySettings } from "../features/highlight/background.js";
import { registerSummarizePort } from "../features/summarize/background.js";

registerBadgeCleanup();
registerTriggers();
registerSummarizePort();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG.BADGE) {
    setBadge(sender.tab?.id, msg.text);
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === MSG.VERIFY) {
    verifySettings(msg.settings)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg?.type === MSG.CLASSIFY) {
    classifyChunk(msg)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the channel open for the async reply
  }

  // MSG.STATUS is for the popup, not this worker.
  return false;
});
