// YouTube transcript reader.
//
// Deliberately scrapes the on-page transcript panel rather than parsing
// ytInitialPlayerResponse for captionTracks[].baseUrl and fetching it. The
// fetch approach is the popular one and the fragile one: YouTube has added
// token requirements to those caption endpoints, which is what keeps breaking
// third-party transcript tools. Reading the panel means YouTube already
// fetched it — no extra request, no token, and it works for age-restricted or
// members-only videos because it rides the user's own session.
//
// The cost is selector churn, so every lookup has fallbacks and an empty result
// is reported rather than silently treated as "no transcript".

// Ordered by specificity; YouTube renames custom elements from time to time.
const SEGMENT_SELECTORS = [
  "ytd-transcript-segment-renderer",
  "ytd-transcript-body-renderer .segment",
  "[class*='transcript-segment']"
];

const TRANSCRIPT_BUTTON_SELECTORS = [
  "ytd-video-description-transcript-section-renderer button",
  "button[aria-label*='transcript' i]",
  "button[aria-label*='Show transcript' i]",
  "yt-button-shape button[aria-label*='transcript' i]"
];

const MERGE_TARGET_CHARS = 220; // merge caption fragments into readable spans

export function isWatchPage() {
  return (
    /(^|\.)youtube\.com$/.test(location.hostname) &&
    location.pathname === "/watch" &&
    new URLSearchParams(location.search).has("v")
  );
}

function findAll(selectors) {
  for (const selector of selectors) {
    const found = document.querySelectorAll(selector);
    if (found.length) return Array.from(found);
  }
  return [];
}

function findOne(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSegments(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const segments = findAll(SEGMENT_SELECTORS);
    if (segments.length) return segments;
    await wait(150);
  }
  return [];
}

// "12:34" -> 754, "1:02:03" -> 3723. Used for seeking, so a bad parse must
// yield null rather than a plausible-looking wrong number.
export function timestampToSeconds(label) {
  const parts = String(label).trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function readSegments(segments) {
  const out = [];
  for (const segment of segments) {
    const stamp =
      segment.querySelector(".segment-timestamp")?.textContent?.trim() ||
      segment.querySelector("[class*='timestamp']")?.textContent?.trim() ||
      "";
    const text =
      segment.querySelector(".segment-text")?.textContent?.trim() ||
      segment.querySelector("[class*='segment-text']")?.textContent?.trim() ||
      "";
    if (text) out.push({ stamp, text });
  }
  return out;
}

// Caption fragments are a few words each — thousands of them for a long video.
// Merging into ~200-char spans keeps the first timestamp of each span, which is
// what a citation needs, and removes a large amount of token noise.
function merge(segments) {
  const merged = [];
  let current = null;

  for (const segment of segments) {
    if (!current) {
      current = { stamp: segment.stamp, text: segment.text };
    } else if (current.text.length + segment.text.length + 1 <= MERGE_TARGET_CHARS) {
      current.text += ` ${segment.text}`;
    } else {
      merged.push(current);
      current = { stamp: segment.stamp, text: segment.text };
    }
  }
  if (current) merged.push(current);
  return merged;
}

async function openPanel() {
  if (findAll(SEGMENT_SELECTORS).length) return true; // already open

  // The transcript control usually lives inside the collapsed description.
  document.querySelector("#expand, tp-yt-paper-button#expand")?.click();
  await wait(200);

  const button = findOne(TRANSCRIPT_BUTTON_SELECTORS);
  if (!button) return false;
  button.click();
  return true;
}

export function videoTitle() {
  return (
    document.querySelector("h1.ytd-watch-metadata")?.textContent?.trim() ||
    document.title.replace(/\s*-\s*YouTube\s*$/, "").trim()
  );
}

/**
 * Returns { text, count, title } or throws with a message worth showing.
 * Timestamps are kept in the payload so the summary can cite them — that is the
 * whole point of summarising a video rather than an article.
 */
export async function getTranscript() {
  const opened = await openPanel();
  const segments = opened ? await waitForSegments() : [];

  if (!segments.length) {
    throw new Error(
      "No transcript available for this video. YouTube only offers one when the video has captions."
    );
  }

  const merged = merge(readSegments(segments));
  if (!merged.length) {
    throw new Error("Found the transcript panel but could not read it — YouTube's markup may have changed.");
  }

  const text = merged.map((s) => (s.stamp ? `[${s.stamp}] ${s.text}` : s.text)).join("\n");
  return { text, count: merged.length, title: videoTitle() };
}
