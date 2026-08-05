// Content script: extracts candidate blocks, asks the background worker to score
// them viewport-first in small chunks, and paints the result. After the first
// pass a MutationObserver keeps watching, so content the page loads later gets
// scored too instead of arriving at full brightness on a dimmed page.

const CHUNK_SIZE = 30;          // blocks per API call
const MAX_BLOCK_CHARS = 400;    // per-block truncation sent to the model
const MAX_BLOCKS = 600;         // hard ceiling on one page, across all passes
const PARALLEL_CHUNKS = 3;      // in-flight requests after the first

// Late-arriving content. The debounce lets a burst of DOM insertions settle into
// one pass; the round cap stops an infinite-scroll page from billing forever.
const MUTATION_DEBOUNCE_MS = 500;
const MAX_INCREMENTAL_ROUNDS = 20;

const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, figcaption, dd, dt, td, th, summary";

const SKIP_ANCESTOR_SELECTOR =
  "nav, footer, aside, script, style, noscript, svg, form, select, textarea, [aria-hidden='true'], [role='navigation'], [role='banner'], [role='contentinfo']";

// Visual elements the model never sees. They inherit the score of the nearest
// preceding scored block, since a diagram almost always illustrates the prose
// immediately above it. Without this they stay full-brightness on a dimmed page
// and become the loudest thing on screen.
const MEDIA_SELECTOR = "img, picture, svg, canvas, video, iframe, figure, table";

// Section roll-up. A container whose every scored descendant is noise is itself
// noise, so it gets hidden whole — sweeping up the unscored scaffolding inside
// it (usernames, Reply links, timestamps, vote counts, forms) that is too short
// or too structural to have been collected as a block on its own.
const MIN_ROLLUP_BLOCKS = 3;    // below this, one bad score could hide a section
const MAX_ROLLUP_SHARE = 0.8;   // never roll up a container holding most of the page
const LARGE_SECTION_BLOCKS = 12;      // at this size, judge by ratio not unanimity
const LARGE_SECTION_NOISE_RATIO = 0.85;
const ROLLUP_STOP_TAGS = new Set(["BODY", "HTML", "MAIN", "ARTICLE"]);

const CLASS = {
  core: "implighter-core",
  support: "implighter-support",
  dim: "implighter-dim",
  pending: "implighter-pending"
};

// The recorded verdict on an element, and the class it maps back to. "m0"/"m1"
// are media that inherited a neighbour's verdict; "rolled" and "pending" have no
// class to restore.
const VERDICT_CLASS = {
  "0": CLASS.dim,
  "1": CLASS.support,
  "2": CLASS.core,
  m0: CLASS.dim,
  m1: CLASS.support
};

let blockIndex = new Map(); // id -> element, spans every pass in a session
let session = null;         // { goal, blocks, nextId, rounds }
let observer = null;
let mutationTimer = null;
let running = false;

// --- Progress UI ----------------------------------------------------------
// Lives in a shadow root so page CSS cannot reach it, hosted on documentElement
// rather than body — body is what the MutationObserver watches, and inserting
// our own UI there would trigger an incremental pass on ourselves.

let ui = null;
let uiHideTimer = null;

const UI_STYLES = `
  :host { all: initial; }
  .scrim {
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(12, 14, 18, 0.42);
    backdrop-filter: blur(1.5px);
    pointer-events: none;
    opacity: 0; transition: opacity .18s ease;
  }
  .panel {
    position: fixed; z-index: 2147483647;
    pointer-events: none;
    box-sizing: border-box;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #f2f4f7;
    background: #1b1e24;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 10px;
    box-shadow: 0 10px 34px rgba(0, 0, 0, .45);
    opacity: 0; transition: opacity .18s ease, transform .18s ease;
  }
  .panel.center {
    top: 50%; left: 50%; transform: translate(-50%, -46%);
    width: 320px; padding: 16px 18px;
  }
  .panel.corner {
    right: 16px; bottom: 16px; transform: translateY(6px);
    max-width: 300px; padding: 10px 13px;
  }
  :host(.visible) .scrim { opacity: 1; }
  :host(.visible) .panel.center { opacity: 1; transform: translate(-50%, -50%); }
  :host(.visible) .panel.corner { opacity: 1; transform: translateY(0); }

  .title { display: flex; align-items: center; gap: 7px; font-weight: 600; letter-spacing: .01em; }
  .dot {
    width: 7px; height: 7px; border-radius: 50%; background: #e2b23c;
    animation: pulse 1.1s ease-in-out infinite;
  }
  .goal {
    margin-top: 7px; color: #a7aeba; font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .track { margin-top: 11px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.13); overflow: hidden; }
  .fill { height: 100%; width: 0%; background: #e2b23c; border-radius: 2px; transition: width .2s ease; }
  .detail { margin-top: 8px; color: #a7aeba; font-size: 12px; }
  .panel.corner .goal, .panel.corner .track { display: none; }
  .panel.corner .detail { margin-top: 3px; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) {
    .dot { animation: none; }
    .scrim, .panel, .fill { transition: none; }
  }
`;

function ensureUI() {
  if (ui?.host?.isConnected) return ui;

  const host = document.createElement("div");
  host.setAttribute("data-implighter-ui", "");
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${UI_STYLES}</style>
    <div class="scrim" part="scrim"></div>
    <div class="panel center">
      <div class="title"><span class="dot"></span><span>implighter</span></div>
      <div class="goal"></div>
      <div class="track"><div class="fill"></div></div>
      <div class="detail"></div>
    </div>
  `;

  ui = {
    host,
    scrim: root.querySelector(".scrim"),
    panel: root.querySelector(".panel"),
    goal: root.querySelector(".goal"),
    fill: root.querySelector(".fill"),
    detail: root.querySelector(".detail"),
    dot: root.querySelector(".dot")
  };
  return ui;
}

function uiShow({ mode, goal, detail }) {
  const el = ensureUI();
  if (uiHideTimer) {
    clearTimeout(uiHideTimer);
    uiHideTimer = null;
  }

  const isFull = mode === "full";
  el.panel.classList.toggle("center", isFull);
  el.panel.classList.toggle("corner", !isFull);
  el.scrim.style.display = isFull ? "" : "none";
  el.goal.textContent = goal || "";
  el.detail.textContent = detail || "";
  el.fill.style.width = "0%";
  el.dot.style.animationPlayState = "running";

  // Force a frame so the opacity transition actually runs on first show.
  requestAnimationFrame(() => el.host.classList.add("visible"));
}

function uiProgress(done, total) {
  if (!ui?.host?.isConnected) return;
  const percent = total ? Math.round((done / total) * 100) : 0;
  ui.fill.style.width = `${percent}%`;
  ui.detail.textContent = `Scoring ${done} of ${total} chunks`;
}

function uiFinish(text) {
  if (!ui?.host?.isConnected) return;
  ui.fill.style.width = "100%";
  ui.detail.textContent = text;
  ui.dot.style.animationPlayState = "paused";
  uiHideTimer = setTimeout(uiHide, 1600);
}

function uiHide() {
  if (uiHideTimer) {
    clearTimeout(uiHideTimer);
    uiHideTimer = null;
  }
  if (!ui?.host?.isConnected) return;
  const host = ui.host;
  host.classList.remove("visible");
  // A uiShow() during the fade-out re-adds .visible — don't rip out the panel
  // we just brought back. run() hides then immediately shows on every re-run.
  setTimeout(() => {
    if (!host.classList.contains("visible")) host.remove();
  }, 250);
}

// The model sees text, not layout, so a commenter arguing about sharding reads
// exactly like the article arguing about sharding. This tags blocks that live in
// a discussion region so the rubric can treat them as what they are.
const DISCUSSION_HINT =
  /(^|[-_ ])(comment|comments|disqus|discussion|replies|reply|thread|testimonial|review)s?([-_ ]|$)/i;

function regionOf(el) {
  let node = el;
  while (node && node !== document.body) {
    const id = node.id || "";
    const cls = typeof node.className === "string" ? node.className : "";
    if (DISCUSSION_HINT.test(id) || DISCUSSION_HINT.test(cls)) return "discussion";
    node = node.parentElement;
  }
  return null;
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isVisible(el) {
  if (el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.opacity !== "0";
}

function hasClaimedAncestor(el, claimed) {
  let parent = el.parentElement;
  while (parent) {
    if (claimed.has(parent)) return true;
    parent = parent.parentElement;
  }
  return false;
}

// "Already handled" must survive flattenNestedDim(), which strips the dim class
// off nested elements. If this read classList instead, those blocks would look
// unscored on the next pass and get re-collected and re-billed forever.
const HANDLED_ATTR = "data-implighter";

function markHandled(el, value) {
  el.setAttribute(HANDLED_ATTR, value);
}

function isTagged(el) {
  return el.hasAttribute(HANDLED_ATTR);
}

function isScored(el) {
  return (
    el.classList.contains(CLASS.core) ||
    el.classList.contains(CLASS.support) ||
    el.classList.contains(CLASS.dim)
  );
}

// True if the element sits inside something already judged noise — a rolled-up
// section, typically.
function hasDimAncestor(el) {
  let parent = el.parentElement;
  while (parent) {
    if (parent.classList.contains(CLASS.dim)) return true;
    parent = parent.parentElement;
  }
  return false;
}

// Walks the page in document order and keeps the outermost text-bearing block at
// each position, so a <li> containing a <p> is counted once, not twice. Blocks
// already handled in an earlier pass still claim their subtree but are not
// re-emitted, which is what makes incremental passes cheap.
function collectBlocks(startId, budget) {
  const candidates = Array.from(document.body.querySelectorAll(BLOCK_SELECTOR));
  const claimed = new Set();
  const blocks = [];
  let nextId = startId;

  for (const el of candidates) {
    if (blocks.length >= budget) break;
    if (el.closest(SKIP_ANCESTOR_SELECTOR)) continue;
    if (hasClaimedAncestor(el, claimed)) continue;

    const isHeading = /^H[1-6]$/.test(el.tagName);
    const text = normalize(el.innerText || "");
    if (text.length < (isHeading ? 3 : 25)) continue;
    if (!isVisible(el)) continue;

    claimed.add(el);
    // Scored in an earlier pass. Still claims its subtree above, so descendants
    // stay skipped, but it is not re-sent.
    if (isTagged(el)) continue;

    // Deliberately NOT skipping blocks inside a rolled-up section. Loading
    // content into one ("Show all comments") is an explicit intent signal, and a
    // stale roll-up decision must not veto it — that made the pass find zero new
    // blocks and bail silently, with no overlay and no scoring.
    blocks.push({
      id: nextId++,
      el,
      tag: el.tagName.toLowerCase(),
      region: regionOf(el),
      text: text.slice(0, MAX_BLOCK_CHARS)
    });
  }

  return blocks;
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
      // Distance from the viewport to the nearest block in the chunk.
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

// Give every unscored media element the class of the nearest scored block above
// it. Run after all chunks in a pass have landed, so inheritance sees final scores.
function paintMedia(blocks) {
  const scored = blocks.filter((b) => isScored(b.el));
  if (scored.length === 0) return;

  const scoredSet = new Set(scored.map((b) => b.el));

  for (const el of document.body.querySelectorAll(MEDIA_SELECTOR)) {
    // closest() matches self, and <svg> is in the skip list — test ancestors only.
    if (el.parentElement?.closest(SKIP_ANCESTOR_SELECTOR)) continue;
    if (scoredSet.has(el)) continue;
    if (isTagged(el)) continue;
    if (hasClaimedAncestor(el, scoredSet)) continue; // already dimmed by its container
    if (el.getClientRects().length === 0) continue;

    // Nearest scored block that precedes this element in document order.
    let inherited = null;
    for (const block of scored) {
      const position = block.el.compareDocumentPosition(el);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) inherited = block.el;
      else break;
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

// Every element that carries a verdict, restored to the class that verdict
// implies. Roll-up is recomputed from scratch on each pass rather than
// accumulated: a section's verdict should reflect what is in it now, not what
// was in it when it had a third as many blocks. This also removes the need to
// un-roll sections by hand — a section that no longer qualifies simply isn't
// re-rolled.
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

  // For every ancestor of a scored element: how many scored elements it holds,
  // and how many of those are noise.
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

    // Small sections need unanimity: with only a handful of blocks, one keeper
    // really might be the point of the section. Large ones go by ratio — in a
    // 200-comment thread, insisting on unanimity means 190 noise blocks and all
    // their scaffolding survive to protect 10 mildly interesting replies, which
    // is how a comment section ends up fully expanded on a stripped page.
    //
    // But ratio roll-up may only swallow supporting material, never a keeper.
    // A code listing where 6 of 40 lines are the answer is 85% noise by count,
    // and hiding it dims the one thing the user came for. flattenNestedDim only
    // strips the dim class, so the keepers keep their highlight and you get
    // glowing lines inside a greyed-out block.
    const unanimous = dim === total;
    const overwhelming =
      core === 0 &&
      total >= LARGE_SECTION_BLOCKS &&
      dim / total >= LARGE_SECTION_NOISE_RATIO;
    if (!unanimous && !overwhelming) continue;

    candidates.push(el);
  }

  // Keep only the outermost qualifying container in each nest.
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
// should already guarantee that, but enforce it anyway — when it breaks, nothing
// errors, you just get glowing lines inside a greyed-out block and it reads as a
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

// Only the outermost dimmed element keeps the class, so opacity does not
// compound (0.25 * 0.25 = 0.06) and display:none is applied once.
function flattenNestedDim() {
  for (const el of document.querySelectorAll(`.${CLASS.dim}`)) {
    if (hasDimAncestor(el)) el.classList.remove(CLASS.dim);
  }
}

// Reset to recorded verdicts, re-inherit media, then re-decide every section.
// Both the initial and incremental paths go through here so they cannot drift.
function finalizePass(blocks) {
  resetPainting();
  paintMedia(blocks);
  return rollUpDeadSections();
}

function clearHighlights() {
  stopObserver();
  uiHide();
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

function sendChunk(goal, chunk) {
  return chrome.runtime.sendMessage({
    type: "implighter:classify",
    goal,
    blocks: chunk.map(({ id, tag, region, text }) => ({ id, tag, region, text }))
  });
}

function report(status, detail) {
  chrome.runtime.sendMessage({ type: "implighter:status", status, detail }).catch(() => {});
}

// One source of truth for "what did we do to this page", read from the recorded
// verdicts rather than from classes, so the badge, the popup and the overlay can
// never disagree.
function sessionStats() {
  if (!session) return null;
  const total = session.blocks.length;
  const kept = session.blocks.filter(
    (b) => b.el.getAttribute(HANDLED_ATTR) !== "0"
  ).length;
  return { total, kept, cut: total ? Math.round((1 - kept / total) * 100) : 0 };
}

// Empty text clears the badge. Per-tab, so the worker resolves the tab from the
// message sender rather than guessing at the active one.
function reportBadge(text) {
  chrome.runtime.sendMessage({ type: "implighter:badge", text }).catch(() => {});
}

// Scores one batch of blocks. Shared by the initial pass and every incremental
// one, so late content goes through the same viewport-ordering and caching path.
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
    const result = await sendChunk(goal, chunk);
    if (result?.ok) {
      paint(result.scores);
      if (result.usage) {
        usage.fresh += result.usage.input_tokens || 0;
        usage.cacheWrite += result.usage.cache_creation_input_tokens || 0;
        usage.cacheRead += result.usage.cache_read_input_tokens || 0;
      }
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
    uiProgress(done, chunks.length);
    report("progress", { done, total: chunks.length });
  };

  // First chunk alone: it writes the prompt cache that the rest read from.
  // Firing everything at once would make every request pay a cache write.
  await handle(chunks[0]);

  const queue = chunks.slice(1);
  const workers = Array.from({ length: Math.min(PARALLEL_CHUNKS, queue.length) }, async () => {
    while (queue.length) {
      await handle(queue.shift());
    }
  });
  await Promise.all(workers);

  const total = usage.fresh + usage.cacheWrite + usage.cacheRead;
  const hitRate = total ? Math.round((usage.cacheRead / total) * 100) : 0;
  console.info(
    `[implighter] ${chunks.length} chunk(s) — input tokens: ${usage.fresh} fresh, ` +
      `${usage.cacheWrite} cache write, ${usage.cacheRead} cache read (${hitRate}% read). ` +
      `A flat 0 for cache read across repeated runs means the prefix is being invalidated.`
  );

  return { chunks: chunks.length, errors, usage, hitRate };
}

async function run(goal, collapse) {
  if (running) return { ok: false, error: "Already running on this page." };
  running = true;

  try {
    clearHighlights();
    // Must come after clearHighlights() — that call resets both state classes.
    setCollapse(collapse);
    uiShow({ mode: "full", goal, detail: "Reading the page…" });

    const blocks = collectBlocks(0, MAX_BLOCKS);
    if (blocks.length === 0) {
      uiHide();
      return { ok: false, error: "Found no readable text blocks on this page." };
    }

    // Established before scoring so sessionStats() works throughout. The observer
    // is what actually starts incremental work, and that is started at the end.
    session = { goal, blocks: [...blocks], nextId: blocks.length, rounds: 0 };

    const { chunks, errors, hitRate } = await scoreBlocks(goal, blocks);
    if (errors.length === chunks) {
      clearHighlights();
      uiHide();
      return { ok: false, error: errors[0] };
    }

    const rolled = finalizePass(session.blocks);
    const stats = sessionStats();
    startObserver();

    uiFinish(`Kept ${stats.kept} of ${stats.total} blocks — cut ${stats.cut}%`);
    reportBadge(`${stats.cut}%`);

    return {
      ok: true,
      blocks: stats.total,
      kept: stats.kept,
      cut: stats.cut,
      rolled,
      chunks,
      hitRate,
      failed: errors.length
    };
  } finally {
    running = false;
  }
}

// --- Late-arriving content ------------------------------------------------

function startObserver() {
  if (observer) return;
  // childList + subtree only. Painting mutates classes, not structure, so our
  // own writes cannot retrigger this — no feedback loop to guard against.
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

  const fresh = collectBlocks(session.nextId, budget);
  if (fresh.length === 0) return;

  running = true;
  session.rounds += 1;
  session.nextId += fresh.length;
  session.blocks.push(...fresh);

  // Corner toast, never a scrim: the user is mid-read and something just loaded.
  // Blacking out the page for that would be worse than saying nothing.
  uiShow({
    mode: "toast",
    detail: `Scoring ${fresh.length} newly loaded block(s)…`
  });

  try {
    await scoreBlocks(session.goal, fresh);
    // Whole session, not just the new blocks: an arrival can tip a section that
    // was previously mixed, or make one that was rolled up no longer qualify.
    finalizePass(session.blocks);
    const stats = sessionStats();
    uiFinish(`Scored ${fresh.length} new block(s)`);
    reportBadge(`${stats.cut}%`);
    report("incremental", { added: fresh.length, total: stats.total });
  } catch {
    for (const block of fresh) {
      block.el.classList.remove(CLASS.pending);
      block.el.removeAttribute(HANDLED_ATTR);
    }
    uiHide();
  } finally {
    running = false;
  }
}

function setCollapse(on) {
  document.documentElement.classList.toggle("implighter-collapse", !!on);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "implighter:run") {
    run(msg.goal, msg.collapse).then(sendResponse);
    return true;
  }
  if (msg?.type === "implighter:collapse") {
    setCollapse(msg.collapse);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "implighter:clear") {
    clearHighlights();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "implighter:state") {
    sendResponse({ ok: true, active: !!session, goal: session?.goal, ...sessionStats() });
    return false;
  }
  return false;
});

// A fresh content script means a fresh page, so any badge left over from whatever
// was in this tab before is stale. Clearing here rather than on a navigation event
// ties badge lifetime to exactly the same lifecycle as the highlights themselves.
reportBadge("");
