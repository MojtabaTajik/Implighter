// Worker side of the summarize slice.
//
// Uses a long-lived port rather than one-shot messaging: a summary takes ten to
// twenty seconds, and streaming deltas into the modal as they arrive is the
// difference between a blank box and visible progress. One-shot sendMessage has
// no way to deliver partial results.

import { loadSettings } from "../../shared/settings.js";
import { MSG, STREAM } from "../../shared/messaging.js";
import { DEFAULT_SUMMARY_PROMPT, DEFAULT_TRANSCRIPT_PROMPT } from "./prompt.js";

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
        const settings = await loadSettings();
        const { provider, model, apiKey } = settings;

        // A transcript is a different medium, so it gets its own instruction —
        // spoken, unstructured, and carrying timestamps an article never has.
        const system =
          msg.kind === "transcript"
            ? settings.transcriptPrompt || DEFAULT_TRANSCRIPT_PROMPT
            : settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT;

        if (provider.needsKey && !apiKey) {
          throw new Error(
            `No ${provider.label} API key set. Open the extension options and add one.`
          );
        }

        await provider.completeStream({
          apiKey,
          model,
          system,
          // The focus line goes after the page text, as the last thing read. It
          // is a user-level steer, not a replacement for the instructions — the
          // popup asks for "anything to focus on", not for a system prompt.
          user: msg.focus
            ? `${msg.pageText}\n\nFocus especially on: ${msg.focus}`
            : msg.pageText,
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
