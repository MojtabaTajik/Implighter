// Worker side of the highlight slice: scoring one chunk, and verifying that a
// provider configuration actually works.

import { loadSettings } from "../../shared/settings.js";
import { providerOf, VERIFY_FIXTURE } from "../../shared/providers.js";
import { HIGHLIGHT_SYSTEM_PROMPT } from "./prompt.js";

function buildBlocksText(blocks) {
  return blocks
    .map((b) => {
      const region = b.region ? ` (${b.region})` : "";
      return `[${b.id}] <${b.tag}>${region} ${b.text}`;
    })
    .join("\n\n");
}

async function runClassify({ provider, model, apiKey, goal, blocksText }) {
  if (provider.needsKey && !apiKey) {
    throw new Error(`No ${provider.label} API key set. Open the extension options and add one.`);
  }

  try {
    return await provider.classify({
      apiKey,
      model,
      system: HIGHLIGHT_SYSTEM_PROMPT,
      blocksText,
      goalText: `The user's goal:\n${goal}`
    });
  } catch (err) {
    // Providers report the same failures with different status codes and bodies,
    // so name the provider — a bare 401 from a stale key in a dropdown you forgot
    // you switched is genuinely hard to place.
    throw new Error(`${provider.label} (${model}): ${err.message || err}`);
  }
}

export async function classifyChunk({ goal, blocks }) {
  const { provider, model, apiKey } = await loadSettings();
  return runClassify({ provider, model, apiKey, goal, blocksText: buildBlocksText(blocks) });
}

// Runs the real classify path against a fixture whose answer is unambiguous, then
// checks the shape of what came back. Passing means auth, model id, network and
// JSON-schema conformance all work — the last being the one that would otherwise
// fail silently on the first real page instead of here.
export async function verifySettings({ providerId, model, apiKey }) {
  const provider = providerOf(providerId);
  const { scores } = await runClassify({
    provider,
    model,
    apiKey,
    goal: VERIFY_FIXTURE.goal,
    blocksText: VERIFY_FIXTURE.blocksText
  });

  if (!Array.isArray(scores) || scores.length !== 2) {
    throw new Error(
      `${provider.label} returned ${scores?.length ?? 0} scores for 2 blocks. ` +
        `This model may not support strict JSON schema output — try another.`
    );
  }
  const ids = scores.map((s) => s.id).sort();
  if (ids[0] !== 0 || ids[1] !== 1) {
    throw new Error(`${provider.label} returned unexpected block ids: ${ids.join(", ")}.`);
  }

  // Not a hard failure — a model that scores this fixture backwards will produce
  // poor highlights, but it is working, and that judgement is the user's.
  const byId = Object.fromEntries(scores.map((s) => [s.id, s.score]));

  return { provider: provider.label, model, sensible: byId[0] > byId[1] };
}
