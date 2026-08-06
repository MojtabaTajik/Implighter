// On-demand content script injection.
//
// The alternative — a content_scripts entry matching http://*/* — makes Chrome
// inject into every page the user ever visits, which earns the install warning
// "Read and change all your data on all websites". That is the single biggest
// drop-off point on a store listing, it slows review, and it is not even true of
// what this extension does: nothing happens until the toolbar icon, a shortcut,
// or a context menu is used.
//
// activeTab grants access to one tab, only after the user invokes something, and
// carries no install warning at all. The cost is that every entry point has to
// ensure injection before it messages a tab.

import { MSG } from "./messaging.js";

const CONTENT_SCRIPT = "src/entrypoints/content.js";
const CONTENT_STYLES = "src/features/highlight/highlight.css";

const READY_ATTEMPTS = 20;
const READY_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isReady(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

/**
 * Idempotent. Returns once the content script is loaded and answering, so a
 * caller can message it immediately afterwards.
 *
 * Readiness is polled rather than assumed from executeScript resolving:
 * the entry script pulls its feature modules in with dynamic import, so it
 * returns long before those modules have registered their listeners.
 */
// The popup fires two capability probes the moment it opens, and both need the
// script. Without this they race into a double executeScript.
const inflight = new Map();

export function ensureInjected(tabId) {
  if (tabId == null) return Promise.reject(new Error("No active tab."));

  let pending = inflight.get(tabId);
  if (!pending) {
    pending = inject(tabId).finally(() => inflight.delete(tabId));
    inflight.set(tabId, pending);
  }
  return pending;
}

async function inject(tabId) {
  if (await isReady(tabId)) return;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_STYLES] });
  } catch {
    // chrome://, the Web Store, PDF viewer, and other restricted origins.
    throw new Error("This page doesn't allow extensions to run.");
  }

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if (await isReady(tabId)) return;
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error("The extension failed to start on this page.");
}
