import { MSG } from "../shared/messaging.js";
import { ensureInjected } from "../shared/injector.js";

const goalInput = document.getElementById("goal");
const focusInput = document.getElementById("focus");
const recentGoalsSelect = document.getElementById("recentGoals");
const copyKeptButton = document.getElementById("copyKept");
const videoFocusInput = document.getElementById("videoFocus");
const runButton = document.getElementById("run");
const clearButton = document.getElementById("clear");
const statusEl = document.getElementById("status");

const setupEl = document.getElementById("setup");
const mainEl = document.getElementById("main");
const tabs = {
  highlight: {
    tab: document.getElementById("tabHighlight"),
    panel: document.getElementById("panelHighlight"),
    focus: () => goalInput.focus()
  },
  summarize: {
    tab: document.getElementById("tabSummarize"),
    panel: document.getElementById("panelSummarize"),
    focus: () => focusInput.focus()
  },
  transcript: {
    tab: document.getElementById("tabTranscript"),
    panel: document.getElementById("panelTranscript"),
    focus: () => videoFocusInput.focus()
  }
};

// Set as soon as the user touches a tab, so the capability probe — which resolves
// a moment later — never yanks them off a panel they just chose.
let userChoseTab = false;

function showTab(name, { persist = true } = {}) {
  if (tabs[name]?.tab.hidden) name = "highlight";
  for (const [key, entry] of Object.entries(tabs)) {
    const active = key === name;
    entry.tab.classList.toggle("active", active);
    entry.tab.setAttribute("aria-selected", String(active));
    entry.panel.hidden = !active;
  }
  // Auto-selecting Video on a watch page is context, not preference — persisting
  // it would make every later page open on a tab the user never picked.
  if (persist) chrome.storage.local.set({ lastTab: name });
  tabs[name].focus();
}

for (const [name, entry] of Object.entries(tabs)) {
  entry.tab.addEventListener("click", () => {
    userChoseTab = true;
    showTab(name);
  });
}

document.getElementById("setupOpen").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Progress pings from the content script arrive here while the popup is open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== MSG.STATUS) return;
  if (msg.status === "progress") {
    const { done, total } = msg.detail;
    setStatus(`Scoring… ${done}/${total} chunks`);
  } else if (msg.status === "incremental") {
    const { added, total } = msg.detail;
    setStatus(`Scored ${added} newly loaded block(s). ${total} total.`);
  }
});

// Gate the whole UI on having a key. Otherwise a new user's first action is a
// button that fails with an error naming a provider they have not met yet.
chrome.storage.local
  .get(["lastGoal", "lastFocus", "lastTab", "provider", "keys", "apiKey", "recentGoals", "lastVideoFocus"])
  .then(({ lastGoal, lastFocus, lastTab, provider, keys, apiKey, recentGoals, lastVideoFocus }) => {
    const configured = Boolean((keys || {})[provider || "anthropic"] || apiKey);
    setupEl.hidden = configured;
    mainEl.hidden = !configured;
    if (!configured) return;

    if (lastGoal) goalInput.value = lastGoal;
    if (lastFocus) focusInput.value = lastFocus;
    if (lastVideoFocus) videoFocusInput.value = lastVideoFocus;
    renderRecentGoals(recentGoals);
    showTab(lastTab === "summarize" ? "summarize" : "highlight");
  });

// Reflect whether this tab has already been processed, so reopening the popup on
// an applied page doesn't look identical to opening it on an untouched one.
(async () => {
  try {
    const state = await sendToTab({ type: MSG.STATE });
    if (state?.active) {
      // Prefer the goal actually in force on the page over the last one typed.
      if (state.goal) goalInput.value = state.goal;
      setStatus(`Applied to this page — kept ${state.kept} of ${state.total}, cut ${state.cut}%.`);
      runButton.textContent = "Re-run";
      copyKeptButton.disabled = false;
    } else {
      clearButton.disabled = true;
    }
  } catch {
    // No content script on this tab (needs a reload, or it's a restricted page).
    clearButton.disabled = true;
  }
})();

// The Video tab only exists where it can work. Asked on every popup open rather
// than cached, so YouTube's client-side navigation needs no special handling.
(async () => {
  try {
    const caps = await sendToTab({ type: MSG.CAPABILITIES });
    if (!caps?.transcript) return;

    tabs.transcript.tab.hidden = false;
    // On a watch page the video is what you are looking at, so open on it —
    // unless the user already picked something else while this was resolving.
    if (!userChoseTab) showTab("transcript", { persist: false });
  } catch {
    // No content script here; the tab simply stays hidden.
  }
})();

document.getElementById("summarizeVideo").addEventListener("click", async () => {
  const focus = videoFocusInput.value.trim();
  await chrome.storage.local.set({ lastVideoFocus: focus });
  try {
    await sendToTab({ type: MSG.SUMMARIZE_RUN, focus, kind: "transcript" });
    window.close();
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
});

const MAX_RECENT_GOALS = 8;

function renderRecentGoals(goals = []) {
  recentGoalsSelect.hidden = goals.length === 0;
  for (const option of [...recentGoalsSelect.options].slice(1)) option.remove();
  for (const goal of goals) {
    const option = document.createElement("option");
    option.value = goal;
    // Truncated for the dropdown; the full text still lands in the textarea.
    option.textContent = goal.length > 48 ? `${goal.slice(0, 47)}…` : goal;
    recentGoalsSelect.append(option);
  }
}

async function rememberGoal(goal) {
  const { recentGoals = [] } = await chrome.storage.local.get("recentGoals");
  const next = [goal, ...recentGoals.filter((g) => g !== goal)].slice(0, MAX_RECENT_GOALS);
  await chrome.storage.local.set({ recentGoals: next });
}

recentGoalsSelect.addEventListener("change", () => {
  if (!recentGoalsSelect.value) return;
  goalInput.value = recentGoalsSelect.value;
  recentGoalsSelect.selectedIndex = 0;
  goalInput.focus();
});

async function sendToTab(message) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active tab.");
  // Injection happens on demand, so there is no longer any such thing as a tab
  // that was open "before the extension was installed" — the old reload-first
  // papercut disappeared with the blanket content script.
  await ensureInjected(tab.id);
  return chrome.tabs.sendMessage(tab.id, message);
}

runButton.addEventListener("click", async () => {
  const goal = goalInput.value.trim();
  if (!goal) {
    setStatus("Describe your goal first.", true);
    return;
  }

  // No key pre-check here — the worker owns provider config and already returns a
  // provider-named error. Duplicating the check would mean two places to keep in
  // step with the provider registry.
  await chrome.storage.local.set({ lastGoal: goal });
  await rememberGoal(goal);
  runButton.disabled = true;
  setStatus("Reading the page…");

  try {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("No active tab.");

    // Injection is awaited because it fails fast and its errors — a restricted
    // page, say — are worth showing here. The run itself is not: it takes many
    // seconds, and holding the popup open for it left it sitting there until the
    // user clicked away. The in-page overlay reports progress, the result, and
    // now failures too, so there is nothing left for the popup to stay open for.
    await ensureInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: MSG.RUN, goal }).catch(() => {});
    window.close();
  } catch (err) {
    setStatus(String(err.message || err), true);
    runButton.disabled = false;
  }
});

clearButton.addEventListener("click", async () => {
  try {
    await sendToTab({ type: MSG.CLEAR });
    setStatus("Cleared.");
    runButton.textContent = "Highlight";
    clearButton.disabled = true;
    copyKeptButton.disabled = true;
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
});

// Summarize is independent of the highlight session — it reads the whole page
// regardless of what has or hasn't been scored, and takes its own optional focus
// rather than reusing the highlight goal.
document.getElementById("summarize").addEventListener("click", async () => {
  const focus = focusInput.value.trim();
  await chrome.storage.local.set({ lastFocus: focus });
  try {
    await sendToTab({ type: MSG.SUMMARIZE_RUN, focus });
    // The modal lives on the page and streams into itself; the popup's job ends
    // here, and it closes so it isn't covering the thing it just opened.
    window.close();
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
});

// The one export nobody else can offer: the verdicts are already recorded per
// block, so this is a read of existing state rather than a second model call.
copyKeptButton.addEventListener("click", async () => {
  try {
    const result = await sendToTab({ type: MSG.EXPORT_KEPT });
    if (!result?.ok) {
      setStatus(result?.error || "Nothing to copy.", true);
      return;
    }
    await navigator.clipboard.writeText(result.markdown);
    setStatus("Kept content copied as markdown.");
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
});

document.getElementById("displayModeLink").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("options").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});
