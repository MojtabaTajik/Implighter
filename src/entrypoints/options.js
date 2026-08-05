import { MSG } from "../shared/messaging.js";

import { providerOf } from "../shared/providers.js";
import { saveSummaryPrompt } from "../shared/settings.js";
import { DEFAULT_SUMMARY_PROMPT } from "../features/summarize/prompt.js";

const providerSelect = document.getElementById("provider");
const modelSelect = document.getElementById("model");
const customModel = document.getElementById("customModel");
const apiKeyInput = document.getElementById("apiKey");
const keyField = document.getElementById("keyField");
const keyLink = document.getElementById("keyLink");
const providerHint = document.getElementById("providerHint");
const saveButton = document.getElementById("save");
const saveAnywayButton = document.getElementById("saveAnyway");
const summaryPromptInput = document.getElementById("summaryPrompt");
const resetPromptButton = document.getElementById("resetPrompt");
const statusEl = document.getElementById("status");

const CACHE_NOTE = {
  explicit:
    "Caches the rubric explicitly. The rubric is ~820 tokens and the minimum cacheable " +
    "prefix is 512 on Opus 5, 1024 on Sonnet 5, 4096 on Haiku 4.5 — so on the cheaper two " +
    "it silently never caches and every chunk pays full price for it.",
  automatic: "Caches long prefixes automatically; no configuration needed.",
  none: "No prompt caching, so the rubric is paid for on every chunk."
};

// Keys live per provider so switching the dropdown doesn't discard the other one.
let keys = {};

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", kind === "error");
  statusEl.classList.toggle("ok", kind === "ok");
}

function selectedModel() {
  return modelSelect.value === "__custom__" ? customModel.value.trim() : modelSelect.value;
}

function renderProvider(providerId, model) {
  const provider = providerOf(providerId);

  modelSelect.innerHTML = "";
  for (const id of provider.models) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    modelSelect.append(option);
  }
  const other = document.createElement("option");
  other.value = "__custom__";
  other.textContent = "Other…";
  modelSelect.append(other);

  const known = provider.models.includes(model);
  modelSelect.value = known ? model : model ? "__custom__" : provider.defaultModel;
  customModel.value = known ? "" : model || "";
  customModel.style.display = modelSelect.value === "__custom__" ? "" : "none";

  keyField.style.display = provider.needsKey ? "" : "none";
  apiKeyInput.placeholder = provider.keyPlaceholder || "";
  apiKeyInput.value = keys[providerId] || "";
  keyLink.href = provider.keyUrl || "#";
  providerHint.textContent = CACHE_NOTE[provider.promptCache] || "";
}

function currentSettings() {
  const providerId = providerSelect.value;
  return {
    providerId,
    model: selectedModel(),
    apiKey: apiKeyInput.value.trim()
  };
}

async function persist({ providerId, model, apiKey }) {
  keys[providerId] = apiKey;
  await chrome.storage.local.set({ provider: providerId, model, keys });
}

async function load() {
  const stored = await chrome.storage.local.get([
    "provider",
    "model",
    "keys",
    "apiKey",
    "summaryPrompt"
  ]);
  keys = stored.keys || {};
  // Migration from the single-provider build, which stored one bare Anthropic key.
  if (!keys.anthropic && stored.apiKey) keys.anthropic = stored.apiKey;

  const providerId = stored.provider || "anthropic";
  providerSelect.value = providerId;
  renderProvider(providerId, stored.model);

  summaryPromptInput.value = stored.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
}

// Saved on edit rather than behind the verify button: the prompt has nothing to
// verify, and making a prose tweak wait on a network round trip would be absurd.
let promptSaveTimer = null;
summaryPromptInput.addEventListener("input", () => {
  clearTimeout(promptSaveTimer);
  promptSaveTimer = setTimeout(async () => {
    await saveSummaryPrompt(summaryPromptInput.value);
    setStatus("Summary instructions saved.", "ok");
  }, 600);
});

resetPromptButton.addEventListener("click", async (event) => {
  event.preventDefault();
  summaryPromptInput.value = DEFAULT_SUMMARY_PROMPT;
  await saveSummaryPrompt(DEFAULT_SUMMARY_PROMPT);
  setStatus("Summary instructions reset to default.", "ok");
});

providerSelect.addEventListener("change", () => {
  // Hold on to whatever is typed before swapping the field out from under it.
  keys[currentSettings().providerId] = apiKeyInput.value.trim();
  renderProvider(providerSelect.value, null);
  setStatus("");
});

modelSelect.addEventListener("change", () => {
  customModel.style.display = modelSelect.value === "__custom__" ? "" : "none";
  if (modelSelect.value === "__custom__") customModel.focus();
});

saveButton.addEventListener("click", async () => {
  const settings = currentSettings();
  const provider = providerOf(settings.providerId);

  if (!settings.model) {
    setStatus("Pick a model, or type one under Other…", "error");
    return;
  }
  if (provider.needsKey && !settings.apiKey) {
    setStatus(`${provider.label} needs an API key.`, "error");
    return;
  }

  saveButton.disabled = true;
  saveAnywayButton.style.display = "none";
  setStatus("Verifying — sending one two-block test request…");

  const result = await chrome.runtime.sendMessage({
    type: MSG.VERIFY,
    settings
  });

  saveButton.disabled = false;

  if (!result?.ok) {
    // Deliberately do not save. A key or model that doesn't work is worse than
    // none, because the failure surfaces later as a broken page rather than here.
    setStatus(`Not saved — ${result?.error || "verification failed"}`, "error");
    saveAnywayButton.style.display = "";
    return;
  }

  await persist(settings);

  // Verification proves the plumbing works; scoring the fixture backwards means
  // it works but judges badly. Worth saying, not worth blocking on.
  setStatus(
    result.sensible
      ? `Verified and saved. ${result.provider} · ${result.model} responded correctly.`
      : `Saved. ${result.provider} · ${result.model} responded, but scored the test case ` +
        `oddly — it may produce weak highlights. Try a stronger model if results disappoint.`,
    result.sensible ? "ok" : null
  );
});

// Escape hatch for being offline, or a provider having a bad afternoon. Explicit,
// never the default, and it says plainly that it wasn't checked.
saveAnywayButton.addEventListener("click", async () => {
  await persist(currentSettings());
  saveAnywayButton.style.display = "none";
  setStatus("Saved without verifying. If pages fail to score, come back and verify.");
});

load();
