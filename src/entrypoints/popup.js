import { MSG } from "../shared/messaging.js";

const goalInput = document.getElementById("goal");
const runButton = document.getElementById("run");
const clearButton = document.getElementById("clear");
const collapseInput = document.getElementById("collapse");
const statusEl = document.getElementById("status");

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

// Restore the last goal so re-running on another page is one click.
chrome.storage.local.get(["lastGoal", "collapse"]).then(({ lastGoal, collapse }) => {
  if (lastGoal) goalInput.value = lastGoal;
  collapseInput.checked = !!collapse;
  goalInput.focus();
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
// regardless of what has or hasn't been scored, and needs no goal.
document.getElementById("summarize").addEventListener("click", async () => {
  try {
    await sendToTab({ type: MSG.SUMMARIZE_RUN });
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
