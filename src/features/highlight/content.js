// Page side of the highlight slice: extract, score viewport-first in chunks,
// paint, roll up dead sections, and keep scoring content that loads later.

import {
  collectBlocks,
  hasClaimedAncestor,
  normalize,
  SKIP_ANCESTOR_SELECTOR
} from "../../shared/extraction.js";
import { MSG } from "../../shared/messaging.js";
import { overlayShow, overlayProgress, overlayFinish, overlayHide } from "./overlay.js";

const CHUNK_SIZE = 30;          // blocks per API call
const MAX_BLOCK_CHARS = 400;    // enough to judge relevance; see extraction.js
const MAX_BLOCKS = 600;         // session-wide ceiling, not per pass
const PARALLEL_CHUNKS = 3;      // in-flight requests after the first

// Late-arriving content. The debounce lets a burst of DOM insertions settle into
// one pass; the round cap stops an infinite-scroll page billing forever.
const MUTATION_DEBOUNCE_MS = 500;
const MAX_INCREMENTAL_ROUNDS = 20;

const MEDIA_SELECTOR = "img, picture, svg, canvas, video, iframe, figure, table";

const MIN_ROLLUP_BLOCKS = 3;
const MAX_ROLLUP_SHARE = 0.8;
const LARGE_SECTION_BLOCKS = 12;
const LARGE_SECTION_NOISE_RATIO = 0.85;
const ROLLUP_STOP_TAGS = new Set(["BODY", "HTML", "MAIN", "ARTICLE"]);

const CLASS = {
  core: "implighter-core",
  support: "implighter-support",
  dim: "implighter-dim",
  pending: "implighter-pending"
};

// "Already handled" must survive flattenNestedDim(), which strips the dim class
// off nested elements. If this read classList instead, those blocks would look
// unscored on the next pass and get re-collected and re-billed forever.
const HANDLED_ATTR = "data-implighter";

const VERDICT_CLASS = {
  "0": CLASS.dim,
  "1": CLASS.support,
  "2": CLASS.core,
  m0: CLASS.dim,
  m1: CLASS.support
};

let blockIndex = new Map();
let session = null;
let observer = null;
let mutationTimer = null;
let running = false;

const markHandled = (el, value) => el.setAttribute(HANDLED_ATTR, value);
const isTagged = (el) => el.hasAttribute(HANDLED_ATTR);
const isScored = (el) =>
  el.classList.contains(CLASS.core) ||
  el.classList.contains(CLASS.support) ||
  el.classList.contains(CLASS.dim);

function hasDimAncestor(el) {
  let parent = el.parentElement;
  while (parent) {
    if (parent.classList.contains(CLASS.dim)) return true;
    parent = parent.parentElement;
  }
  return false;
}

// Chunk boundaries follow document order so each chunk reads as continuous prose,
// then chunks are dispatched nearest-to-viewport first.
function buildChunks(blocks) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
    chunks.push(blocks.slice(i, i + CHUNK_SIZE));
  }

  const viewportHeight = window.innerHeight;
  return chunks
    .map((chunk) => {
      let best = Infinity;
      for (const block of chunk) {
        const rect = block.el.getBoundingClientRect();
        const gap =
          rect.bottom < 0 ? -rect.bottom
          : rect.top > viewportHeight ? rect.top - viewportHeight
          : 0;
        if (gap < best) best = gap;
      }
      return { chunk, distance: best };
    })
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.chunk);
}

// Media is never sent to the model; it inherits the verdict of the nearest scored
// block above it, since a diagram almost always illustrates the prose preceding
// it. Without this it keeps full brightness on a dimmed page and becomes the
// loudest thing on screen.
function paintMedia(blocks) {
  const scored = blocks.filter((b) => isScored(b.el));
  if (!scored.length) return;
  const scoredSet = new Set(scored.map((b) => b.el));

  for (const el of document.body.querySelectorAll(MEDIA_SELECTOR)) {
    // closest() matches self, and <svg> is in the skip list — test ancestors only.
    if (el.parentElement?.closest(SKIP_ANCESTOR_SELECTOR)) continue;
    if (scoredSet.has(el) || isTagged(el)) continue;
    if (hasClaimedAncestor(el, scoredSet)) continue;
    if (el.getClientRects().length === 0) continue;

    let inherited = null;
    for (const block of scored) {
      if (block.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        inherited = block.el;
      } else break;
    }
    if (!inherited) continue;

    if (inherited.classList.contains(CLASS.core)) {
      el.classList.add(CLASS.support);
      markHandled(el, "m1");
    } else if (inherited.classList.contains(CLASS.dim)) {
      el.classList.add(CLASS.dim);
      markHandled(el, "m0");
    }
  }
}

// Roll-up is recomputed from scratch each pass rather than accumulated: a
// section's verdict should reflect what is in it now, not what was in it when it
// had a third as many blocks. That also removes any need to un-roll by hand — a
// section that no longer qualifies simply isn't re-rolled.
function resetPainting() {
  for (const el of document.querySelectorAll(`[${HANDLED_ATTR}]`)) {
    const verdict = el.getAttribute(HANDLED_ATTR);
    if (verdict === "rolled") {
      el.classList.remove(CLASS.dim);
      el.removeAttribute(HANDLED_ATTR);
      continue;
    }
    const cls = VERDICT_CLASS[verdict];
    if (!cls) continue; // "pending", still in flight
    el.classList.remove(CLASS.dim, CLASS.support, CLASS.core);
    el.classList.add(cls);
  }
}

function rollUpDeadSections() {
  const scored = Array.from(document.querySelectorAll(`[${HANDLED_ATTR}]`)).filter(
    (el) => VERDICT_CLASS[el.getAttribute(HANDLED_ATTR)]
  );
  if (scored.length < MIN_ROLLUP_BLOCKS) return 0;

  const stats = new Map();
  for (const el of scored) {
    const isDim = el.classList.contains(CLASS.dim);
    const isCore = el.classList.contains(CLASS.core);
    let node = el.parentElement;
    while (node && !ROLLUP_STOP_TAGS.has(node.tagName)) {
      let entry = stats.get(node);
      if (!entry) {
        entry = { total: 0, dim: 0, core: 0 };
        stats.set(node, entry);
      }
      entry.total += 1;
      if (isDim) entry.dim += 1;
      if (isCore) entry.core += 1;
      node = node.parentElement;
    }
  }

  const candidates = [];
  for (const [el, { total, dim, core }] of stats) {
    if (total < MIN_ROLLUP_BLOCKS) continue;
    if (total / scored.length > MAX_ROLLUP_SHARE) continue;

    // Small sections need unanimity: with a handful of blocks, one keeper really
    // might be the point of the section. Large ones go by ratio — in a
    // 200-comment thread, unanimity means 190 noise blocks and all their
    // scaffolding survive to protect 10 mildly interesting replies.
    //
    // But ratio may only swallow supporting material, never a keeper. A code
    // listing where 6 of 40 lines are the answer is 85% noise by count, and
    // hiding it dims the one thing the user came for.
    const unanimous = dim === total;
    const overwhelming =
      core === 0 && total >= LARGE_SECTION_BLOCKS && dim / total >= LARGE_SECTION_NOISE_RATIO;
    if (!unanimous && !overwhelming) continue;

    candidates.push(el);
  }

  const candidateSet = new Set(candidates);
  let rolled = 0;
  for (const el of candidates) {
    if (hasClaimedAncestor(el, candidateSet)) continue;
    el.classList.add(CLASS.dim);
    markHandled(el, "rolled");
    rolled += 1;
  }

  rolled -= unrollContainersHidingCore();
  flattenNestedDim();
  return rolled;
}

// Invariant: nothing highlighted may sit inside something hidden. The rules above
// should already guarantee it, but enforce it anyway — when it breaks nothing
// errors, you just get glowing lines inside a greyed-out block, which reads as a
// CSS bug rather than a scoring one.
function unrollContainersHidingCore() {
  let undone = 0;
  for (const el of document.querySelectorAll(`.${CLASS.dim}`)) {
    if (!el.querySelector(`.${CLASS.core}`)) continue;
    el.classList.remove(CLASS.dim);
    if (el.getAttribute(HANDLED_ATTR) === "rolled") el.removeAttribute(HANDLED_ATTR);
    undone += 1;
  }
  return undone;
}

// Only the outermost dimmed element keeps the class, so opacity does not compound
// (0.25 * 0.25 = 0.06) and display:none is applied once.
function flattenNestedDim() {
  for (const el of document.querySelectorAll(`.${CLASS.dim}`)) {
    if (hasDimAncestor(el)) el.classList.remove(CLASS.dim);
  }
}

function finalizePass(blocks) {
  resetPainting();
  paintMedia(blocks);
  return rollUpDeadSections();
}

function clearHighlights() {
  stopObserver();
  overlayHide();
  reportBadge("");
  session = null;
  document.documentElement.classList.remove("implighter-active", "implighter-collapse");
  for (const el of document.querySelectorAll(
    `.${CLASS.core}, .${CLASS.support}, .${CLASS.dim}, .${CLASS.pending}, [${HANDLED_ATTR}]`
  )) {
    el.classList.remove(CLASS.core, CLASS.support, CLASS.dim, CLASS.pending);
    el.removeAttribute(HANDLED_ATTR);
  }
  blockIndex = new Map();
}

function markPending(blocks) {
  document.documentElement.classList.add("implighter-active");
  for (const block of blocks) {
    block.el.classList.add(CLASS.pending);
    markHandled(block.el, "pending");
  }
}

function paint(scores) {
  for (const { id, score } of scores) {
    const el = blockIndex.get(id);
    if (!el) continue;
    el.classList.remove(CLASS.pending, CLASS.core, CLASS.support, CLASS.dim);
    if (score === 2) el.classList.add(CLASS.core);
    else if (score === 1) el.classList.add(CLASS.support);
    else el.classList.add(CLASS.dim);
    markHandled(el, String(score));
  }
}

const report = (status, detail) =>
  chrome.runtime.sendMessage({ type: MSG.STATUS, status, detail }).catch(() => {});

const reportBadge = (text) =>
  chrome.runtime.sendMessage({ type: MSG.BADGE, text }).catch(() => {});

// One source of truth for "what did we do to this page", read from recorded
// verdicts rather than classes, so badge, popup and overlay cannot disagree.
function sessionStats() {
  if (!session) return null;
  const total = session.blocks.length;
  const kept = session.blocks.filter((b) => b.el.getAttribute(HANDLED_ATTR) !== "0").length;
  return { total, kept, cut: total ? Math.round((1 - kept / total) * 100) : 0 };
}

async function scoreBlocks(goal, blocks) {
  for (const block of blocks) blockIndex.set(block.id, block.el);
  markPending(blocks);

  const chunks = buildChunks(blocks);
  const errors = [];
  // Cache behaviour is invisible unless measured: a silent prefix invalidator
  // shows up as cacheRead staying flat at zero, with no error anywhere.
  const usage = { fresh: 0, cacheWrite: 0, cacheRead: 0 };
  let done = 0;

  const handle = async (chunk) => {
    const result = await chrome.runtime.sendMessage({
      type: MSG.CLASSIFY,
      goal,
      blocks: chunk.map(({ id, tag, region, text }) => ({ id, tag, region, text }))
    });

    if (result?.ok) {
      paint(result.scores);
      usage.fresh += result.usage?.input || 0;
      usage.cacheWrite += result.usage?.cacheWrite || 0;
      usage.cacheRead += result.usage?.cacheRead || 0;
    } else {
      errors.push(result?.error || "unknown error");
      // Leave unscored blocks untouched rather than dimming them blind, and drop
      // the handled marker so a later pass can pick them up again.
      for (const block of chunk) {
        block.el.classList.remove(CLASS.pending);
        block.el.removeAttribute(HANDLED_ATTR);
      }
    }
    done += 1;
    overlayProgress(done, chunks.length);
    report("progress", { done, total: chunks.length });
  };

  // First chunk alone: it writes the prompt cache the rest read from. Firing
  // everything at once would make each request pay its own cache write, since an
  // entry is not readable until the first response comes back.
  await handle(chunks[0]);

  const queue = chunks.slice(1);
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_CHUNKS, queue.length) }, async () => {
      while (queue.length) await handle(queue.shift());
    })
  );

  const total = usage.fresh + usage.cacheWrite + usage.cacheRead;
  const hitRate = total ? Math.round((usage.cacheRead / total) * 100) : 0;
  console.info(
    `[implighter] ${chunks.length} chunk(s) — input tokens: ${usage.fresh} fresh, ` +
      `${usage.cacheWrite} cache write, ${usage.cacheRead} cache read (${hitRate}% read). ` +
      `A flat 0 for cache read across repeated runs means the prefix is being invalidated.`
  );

  return { chunks: chunks.length, errors, hitRate, inputTokens: total };
}

// Exports what survived scoring as markdown. This is only possible because the
// verdicts are already recorded per block — no second model call, no re-reading
// the page. Headings keep their level so the export retains the page's shape.
function exportKept() {
  if (!session) return null;

  const kept = session.blocks.filter((b) => {
    const verdict = b.el.getAttribute(HANDLED_ATTR);
    return verdict === "1" || verdict === "2";
  });
  if (!kept.length) return null;

  const lines = kept.map((b) => {
    const text = normalize(b.el.innerText || b.text);
    if (b.level) return `${"#".repeat(b.level)} ${text}`;
    // Core blocks are the ones the user actually came for; marking them keeps
    // that distinction in the exported file rather than flattening it away.
    return b.el.getAttribute(HANDLED_ATTR) === "2" ? `**${text}**` : text;
  });

  return [
    `# ${document.title}`,
    "",
    `> Goal: ${session.goal}`,
    `> Source: ${location.href}`,
    `> Kept ${kept.length} of ${session.blocks.length} blocks`,
    "",
    lines.join("\n\n")
  ].join("\n");
}

async function run(goal, collapse) {
  if (running) return { ok: false, error: "Already running on this page." };
  running = true;

  try {
    clearHighlights();
    // Must come after clearHighlights() — that call resets both state classes.
    setCollapse(collapse);
    overlayShow({ mode: "full", goal, detail: "Reading the page…" });

    const blocks = collectBlocks({ budget: MAX_BLOCKS, maxChars: MAX_BLOCK_CHARS, skip: isTagged });
    if (!blocks.length) {
      overlayHide();
      return { ok: false, error: "Found no readable text blocks on this page." };
    }

    // Established before scoring so sessionStats() works throughout. The observer
    // is what actually starts incremental work, and it starts at the end.
    session = { goal, blocks: [...blocks], nextId: blocks.length, rounds: 0 };

    const { chunks, errors, hitRate, inputTokens } = await scoreBlocks(goal, blocks);
    if (errors.length === chunks) {
      clearHighlights();
      overlayHide();
      return { ok: false, error: errors[0] };
    }

    const rolled = finalizePass(session.blocks);
    const stats = sessionStats();
    startObserver();

    overlayFinish(`Kept ${stats.kept} of ${stats.total} blocks — cut ${stats.cut}%`);
    reportBadge(`${stats.cut}%`);

    return {
      ok: true,
      blocks: stats.total,
      kept: stats.kept,
      cut: stats.cut,
      rolled,
      chunks,
      hitRate,
      inputTokens,
      failed: errors.length
    };
  } finally {
    running = false;
  }
}

// --- Late-arriving content ---------------------------------------------------

function startObserver() {
  if (observer) return;
  // childList + subtree only. Painting mutates classes and attributes, not
  // structure, so our own writes cannot retrigger this.
  observer = new MutationObserver(scheduleIncrementalPass);
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
  if (mutationTimer) {
    clearTimeout(mutationTimer);
    mutationTimer = null;
  }
}

function scheduleIncrementalPass() {
  if (mutationTimer) clearTimeout(mutationTimer);
  mutationTimer = setTimeout(incrementalPass, MUTATION_DEBOUNCE_MS);
}

async function incrementalPass() {
  mutationTimer = null;
  if (!session) return;

  // A pass in flight means more mutations are probably still coming. Re-arm
  // rather than dropping the batch on the floor.
  if (running) {
    scheduleIncrementalPass();
    return;
  }

  if (session.rounds >= MAX_INCREMENTAL_ROUNDS) return;
  const budget = MAX_BLOCKS - session.blocks.length;
  if (budget <= 0) return;

  // Deliberately not skipping blocks inside a rolled-up section: loading content
  // into one ("Show all comments") is an explicit intent signal, and a stale
  // roll-up must not veto it — that made the pass find zero new blocks and bail
  // silently, with no overlay and no scoring.
  const fresh = collectBlocks({
    startId: session.nextId,
    budget,
    maxChars: MAX_BLOCK_CHARS,
    skip: isTagged
  });
  if (!fresh.length) return;

  running = true;
  session.rounds += 1;
  session.nextId += fresh.length;
  session.blocks.push(...fresh);

  overlayShow({ mode: "toast", detail: `Scoring ${fresh.length} newly loaded block(s)…` });

  try {
    await scoreBlocks(session.goal, fresh);
    // Whole session, not just the new blocks: an arrival can tip a section that
    // was previously mixed, or make one that was rolled up no longer qualify.
    finalizePass(session.blocks);
    const stats = sessionStats();
    overlayFinish(`Scored ${fresh.length} new block(s)`);
    reportBadge(`${stats.cut}%`);
    report("incremental", { added: fresh.length, total: stats.total });
  } catch {
    for (const block of fresh) {
      block.el.classList.remove(CLASS.pending);
      block.el.removeAttribute(HANDLED_ATTR);
    }
    overlayHide();
  } finally {
    running = false;
  }
}

function setCollapse(on) {
  document.documentElement.classList.toggle("implighter-collapse", !!on);
}

export function initHighlight() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === MSG.RUN) {
      run(msg.goal, msg.collapse).then(sendResponse);
      return true;
    }
    if (msg?.type === MSG.COLLAPSE) {
      setCollapse(msg.collapse);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === MSG.CLEAR) {
      clearHighlights();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === MSG.EXPORT_KEPT) {
      const markdown = exportKept();
      sendResponse(
        markdown
          ? { ok: true, markdown }
          : { ok: false, error: "Nothing kept on this page yet — run Highlight first." }
      );
      return false;
    }
    if (msg?.type === MSG.STATE) {
      sendResponse({ ok: true, active: !!session, goal: session?.goal, ...sessionStats() });
      return false;
    }
    return false;
  });

  // A fresh content script means a fresh page, so any badge left over from what
  // was in this tab before is stale. Clearing here ties badge lifetime to exactly
  // the same lifecycle as the highlights themselves.
  reportBadge("");
}
