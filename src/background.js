// Service worker: owns the API keys and every network call. Content scripts
// never see a key and never talk to a provider directly.

import { PROVIDERS, providerOf, VERIFY_FIXTURE } from "./providers.js";

const DEFAULT_PROVIDER = "anthropic";

const SYSTEM_PROMPT = `You are a relevance grader for a browser extension. The user is reading a web page with a specific goal in mind. You receive numbered text blocks extracted from that page, in document order, and score each one for how much it serves the user's goal.

Scores:
2 = core. Directly advances the goal. Substantive content the user came for: the actual explanation, the trade-off, the number, the step, the definition of a term they need, the worked example, the heading that labels such a section.
1 = supporting. Useful only because it frames or connects the core material: section headings above core content, a sentence that sets up a concept the user needs, a caveat on a core claim, navigation within the substantive content.
0 = noise. Everything else. Marketing copy, author bios, newsletter and signup prompts, cookie notices, social proof, testimonials, pricing pitches, related-article teasers, comment threads, "why this matters" preambles that state the obvious, generic motivation the user has already accepted by having the goal, boilerplate legal text, and content about a different topic than the goal.

Rules:
- Score against the stated goal, not against general quality. Well-written text about the wrong subject is 0.
- Read the whole goal, including its modifiers. "Quick" or "practical" means the user is rejecting depth and background they did not ask for, so material that would be a 2 for a thorough read is a 0 for a quick one. Tighten the bar to match the modifiers.
- If the user's goal implies they already know the basics, introductory "what is X" material is 0 even when it is accurate and well written. Someone preparing for an interview on a topic does not need the topic defined.
- 2 is scarce. It is not "useful", it is "the user loses something if this is hidden". Score 2 for at most roughly a quarter of the blocks in the chunk. If a whole section looks like a 2, score the heading and the one or two blocks carrying the actual substance as 2 and the elaboration around them as 1. A page where most blocks are 2 tells the user nothing.
- Prefer decisive scores. Do not hedge everything to 1. Expect a typical content page to be mostly 0, with a thin band of 2s and 1s.
- A block marked (discussion) is a comment, reply, review or testimonial — readers talking, not the page's own content. Score it 0 even when it is on-topic and insightful. A commenter arguing about the subject reads exactly like the article arguing about the subject, which is why the marker is there. Only score discussion above 0 if the goal explicitly asks for community opinion, reviews, or what other people think.
- Blocks are truncated and stripped of formatting. Judge the substance, not the prose polish.
- You see one chunk of a longer page. Do not assume missing context makes a block irrelevant; score the block on its own merits.
- Return exactly one score per block id you were given. Do not invent ids, omit ids, or reorder.

The user turn gives you the page blocks first, then the user's goal on the last line. Read the goal before you score anything — it is the only thing that decides what counts.`;

// Keys are stored per provider so switching the dropdown does not discard the
// key you already pasted for the other one.
async function getSettings() {
  const stored = await chrome.storage.local.get(["provider", "model", "keys", "apiKey"]);
  const providerId = stored.provider || DEFAULT_PROVIDER;
  const keys = stored.keys || {};

  // Migration: the single-provider build stored one bare `apiKey`, always Anthropic.
  const apiKey = keys[providerId] ?? (providerId === DEFAULT_PROVIDER ? stored.apiKey : undefined);

  return {
    providerId,
    provider: providerOf(providerId),
    model: stored.model || providerOf(providerId).defaultModel,
    apiKey
  };
}

function buildBlocksText(blocks) {
  return blocks
    .map((b) => {
      const region = b.region ? ` (${b.region})` : "";
      return `[${b.id}] <${b.tag}>${region} ${b.text}`;
    })
    .join("\n\n");
}

async function classify({ providerId, provider, model, apiKey, goal, blocksText }) {
  if (provider.needsKey && !apiKey) {
    throw new Error(`No ${provider.label} API key set. Open the extension options and add one.`);
  }

  try {
    return await provider.call({
      apiKey,
      model,
      system: SYSTEM_PROMPT,
      blocksText,
      goalText: `The user's goal:\n${goal}`
    });
  } catch (err) {
    // Providers report the same failures with different status codes and bodies,
    // so name the provider — otherwise "401" from a stale key in a dropdown you
    // forgot you switched is genuinely hard to place.
    throw new Error(`${provider.label} (${model}): ${err.message || err}`);
  }
}

async function classifyChunk({ goal, blocks }) {
  const settings = await getSettings();
  return classify({ ...settings, goal, blocksText: buildBlocksText(blocks) });
}

// Runs the real classify path against a fixture whose answer is unambiguous, then
// checks the shape of what came back. Passing means auth, model id, network and
// JSON-schema conformance all work — the last being the one that would otherwise
// fail silently on the first real page instead of here.
async function verifySettings({ providerId, model, apiKey }) {
  const provider = providerOf(providerId);
  const { scores, usage } = await classify({
    providerId,
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
  // poor highlights, but it is working, and the judgement call is the user's.
  const byId = Object.fromEntries(scores.map((s) => [s.id, s.score]));
  const sensible = byId[0] > byId[1];

  return { provider: provider.label, model, sensible, usage };
}

// Badge marks whether the extension has been applied to a given tab — colored
// with the cut percentage when it has, absent when it hasn't. Deliberately not a
// gray "off" badge: that would sit on every tab you ever open, to convey what its
// absence already conveys.
const BADGE_COLOR = "#2e7d32";

function setBadge(tabId, text) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text: text || "" }).catch(() => {});
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
  }
}

// Backstop for navigations the content script cannot report — leaving a page for
// a chrome:// URL, say, where no content script runs to clear the badge itself.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") setBadge(tabId, "");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "implighter:badge") {
    setBadge(sender.tab?.id, msg.text);
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === "implighter:verify") {
    verifySettings(msg.settings)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  // implighter:status is for the popup, not this worker.
  if (msg?.type !== "implighter:classify") return false;

  classifyChunk(msg)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));

  return true; // keep the channel open for the async reply
});
