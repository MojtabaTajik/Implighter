// Worker side of the summarize slice.
//
// Uses a long-lived port rather than one-shot messaging: a summary takes ten to
// twenty seconds, and streaming deltas into the modal as they arrive is the
// difference between a blank box and visible progress. One-shot sendMessage has
// no way to deliver partial results.

import { loadSettings } from "../../shared/settings.js";
import { MSG, STREAM } from "../../shared/messaging.js";
import { DEFAULT_SUMMARY_PROMPT } from "./prompt.js";

export function registerSummarizePort() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== MSG.SUMMARIZE_PORT) return;

    let cancelled = false;
    port.onDisconnect.addListener(() => {
      // The modal was closed or the tab navigated. Nothing can consume further
      // deltas, so stop posting them; the fetch itself is left to settle.
      cancelled = true;
    });

    port.onMessage.addListener(async (msg) => {
      if (msg?.type !== MSG.SUMMARIZE_START) return;

      try {
        const { provider, model, apiKey, summaryPrompt } = await loadSettings();

        if (provider.needsKey && !apiKey) {
          throw new Error(
            `No ${provider.label} API key set. Open the extension options and add one.`
          );
        }

        await provider.completeStream({
          apiKey,
          model,
          system: summaryPrompt || DEFAULT_SUMMARY_PROMPT,
          user: msg.pageText,
          onDelta: (text) => {
            if (cancelled) return;
            port.postMessage({ type: STREAM.DELTA, text });
          }
        });

        if (!cancelled) port.postMessage({ type: STREAM.DONE });
      } catch (err) {
        if (cancelled) return;
        const { provider, model } = await loadSettings().catch(() => ({}));
        const prefix = provider ? `${provider.label} (${model}): ` : "";
        port.postMessage({ type: STREAM.ERROR, error: `${prefix}${err.message || err}` });
      }
    });
  });
}
