import { MSG } from "../shared/messaging.js";

const goalInput = document.getElementById("goal");
const focusInput = document.getElementById("focus");
const runButton = document.getElementById("run");
const clearButton = document.getElementById("clear");
const collapseInput = document.getElementById("collapse");
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
  }
};

function showTab(name) {
  for (const [key, entry] of Object.entries(tabs)) {
    const active = key === name;
    entry.tab.classList.toggle("active", active);
    entry.tab.setAttribute("aria-selected", String(active));
    entry.panel.hidden = !active;
  }
  chrome.storage.local.set({ lastTab: name });
  tabs[name].focus();
}

tabs.highlight.tab.addEventListener("click", () => showTab("highlight"));
tabs.summarize.tab.addEventListener("click", () => showTab("summarize"));

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
  .get(["lastGoal", "lastFocus", "lastTab", "collapse", "provider", "keys", "apiKey"])
  .then(({ lastGoal, lastFocus, lastTab, collapse, provider, keys, apiKey }) => {
    const configured = Boolean((keys || {})[provider || "anthropic"] || apiKey);
    setupEl.hidden = configured;
    mainEl.hidden = !configured;
    if (!configured) return;

    if (lastGoal) goalInput.value = lastGoal;
    if (lastFocus) focusInput.value = lastFocus;
    collapseInput.checked = !!collapse;
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
    } else {
      clearButton.disabled = true;
    }
  } catch {
    // No content script on this tab (needs a reload, or it's a restricted page).
    clearButton.disabled = true;
  }
})();

// Toggling applies live — no need to re-score a page that's already painted.
collapseInput.addEventListener("change", async () => {
  await chrome.storage.local.set({ collapse: collapseInput.checked });
  try {
    await sendToTab({ type: MSG.COLLAPSE, collapse: collapseInput.checked });
  } catch {
    // Nothing painted on this tab yet; the setting applies on the next run.
  }
});

async function sendToTab(message) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active tab.");
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // The content script is injected at document_idle, so tabs opened before
    // the extension was installed or updated have no listener yet.
    throw new Error("Reload this page, then try again.");
  }
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
  runButton.disabled = true;
  setStatus("Reading the page…");

  try {
    const result = await sendToTab({
      type: MSG.RUN,
      goal,
      collapse: collapseInput.checked
    });
    if (result?.ok) {
      const failed = result.failed
        ? ` ${result.failed} chunk(s) failed and were left alone.`
        : "";
      const rolled = result.rolled ? ` ${result.rolled} section(s) rolled up.` : "";
      const cache = ` Cache ${result.hitRate ?? 0}% read.`;
      setStatus(
        `Kept ${result.kept} of ${result.blocks} blocks — cut ${result.cut}%.${rolled}${cache}${failed}`
      );
      runButton.textContent = "Re-run";
      clearButton.disabled = false;
    } else {
      setStatus(result?.error || "Something went wrong.", true);
    }
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    runButton.disabled = false;
  }
});

clearButton.addEventListener("click", async () => {
  try {
    await sendToTab({ type: MSG.CLEAR });
    setStatus("Cleared.");
    runButton.textContent = "Highlight";
    clearButton.disabled = true;
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

document.getElementById("options").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});
