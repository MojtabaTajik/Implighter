// Keyboard shortcuts and context menus. Both are just alternative ways to send
// the same tab messages the popup sends, so nothing feature-specific lives here
// beyond the message names.

import { MSG } from "./messaging.js";
import { ensureInjected } from "./injector.js";

const MENU = {
  HIGHLIGHT: "implighter-highlight",
  SUMMARIZE: "implighter-summarize",
  SUMMARIZE_SELECTION: "implighter-summarize-selection"
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(tabId, message) {
  if (tabId == null) return;
  try {
    await ensureInjected(tabId);
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // A restricted origin, most likely. There is no UI surface to report this
    // from in a shortcut or context-menu flow, so it stays silent here.
  }
}

// Highlighting needs a goal, and a shortcut has nowhere to type one. Reuse the
// last goal; with none stored, open the popup so the user can supply it rather
// than silently doing nothing.
async function triggerHighlight(tabId) {
  const { lastGoal, collapse } = await chrome.storage.local.get(["lastGoal", "collapse"]);
  if (!lastGoal) {
    try {
      await chrome.action.openPopup();
    } catch {
      // openPopup is not available in every Chrome build or window state.
    }
    return;
  }
  await send(tabId, { type: MSG.RUN, goal: lastGoal, collapse: !!collapse });
}

async function triggerSummarize(tabId, { selectionOnly = false } = {}) {
  const { lastFocus } = await chrome.storage.local.get(["lastFocus"]);
  await send(tabId, { type: MSG.SUMMARIZE_RUN, focus: lastFocus || "", selectionOnly });
}

export function registerTriggers() {
  chrome.commands?.onCommand.addListener(async (command) => {
    const tab = await activeTab();
    if (command === "run-highlight") await triggerHighlight(tab?.id);
    if (command === "run-summarize") await triggerSummarize(tab?.id);
  });

  // Menus are recreated on install and update; removeAll first so a reload does
  // not throw on duplicate ids.
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU.HIGHLIGHT,
        title: "Highlight this page for my goal",
        contexts: ["page"]
      });
      chrome.contextMenus.create({
        id: MENU.SUMMARIZE,
        title: "Summarize this page",
        contexts: ["page"]
      });
      chrome.contextMenus.create({
        id: MENU.SUMMARIZE_SELECTION,
        title: "Summarize selection",
        contexts: ["selection"]
      });
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === MENU.HIGHLIGHT) await triggerHighlight(tab?.id);
    if (info.menuItemId === MENU.SUMMARIZE) await triggerSummarize(tab?.id);
    if (info.menuItemId === MENU.SUMMARIZE_SELECTION) {
      await triggerSummarize(tab?.id, { selectionOnly: true });
    }
  });
}
