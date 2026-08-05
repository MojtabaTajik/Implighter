// Toolbar badge, owned by the worker because only it can resolve a sender tab.
// Marks whether a feature has been applied to a given tab — colored when it has,
// absent when it hasn't. Deliberately not a gray "off" badge: that would sit on
// every tab you ever open, to convey what its absence already conveys.

const BADGE_COLOR = "#2e7d32";

export function setBadge(tabId, text) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text: text || "" }).catch(() => {});
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
  }
}

// Backstop for navigations no content script can report — leaving a page for a
// chrome:// URL, say, where nothing runs to clear the badge itself.
export function registerBadgeCleanup() {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") setBadge(tabId, "");
  });
}
