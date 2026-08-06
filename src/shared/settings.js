// All persisted configuration. Features read through here rather than touching
// chrome.storage directly, so the storage shape and its migrations live in one
// file instead of being rediscovered in each slice.

// Shared deliberately does not import from features — the dependency runs one
// way only. So the summary prompt is returned raw here, and the summarize slice
// applies its own default.
import { providerOf } from "./providers.js";

export const DEFAULT_PROVIDER = "anthropic";

export async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "provider",
    "model",
    "keys",
    "apiKey",
    "summaryPrompt",
    "transcriptPrompt"
  ]);

  const providerId = stored.provider || DEFAULT_PROVIDER;
  const keys = { ...(stored.keys || {}) };

  // Migration: the single-provider build stored one bare `apiKey`, always Anthropic.
  if (!keys.anthropic && stored.apiKey) keys.anthropic = stored.apiKey;

  const provider = providerOf(providerId);

  return {
    providerId,
    provider,
    model: stored.model || provider.defaultModel,
    apiKey: keys[providerId],
    keys,
    // Both may be undefined; the slice that owns them applies its own default,
    // since shared never imports from a feature.
    summaryPrompt: stored.summaryPrompt,
    transcriptPrompt: stored.transcriptPrompt
  };
}

export async function saveProviderSettings({ providerId, model, keys }) {
  await chrome.storage.local.set({ provider: providerId, model, keys });
}

export async function saveSummaryPrompt(summaryPrompt) {
  await chrome.storage.local.set({ summaryPrompt });
}

export async function saveTranscriptPrompt(transcriptPrompt) {
  await chrome.storage.local.set({ transcriptPrompt });
}
