// Page side of the summarize slice: build the page text, stream a summary into a
// modal, let the user copy it.

import { collectBlocks } from "../../shared/extraction.js";
import { MSG, STREAM } from "../../shared/messaging.js";
import { createShadowHost } from "../../shared/ui/shadow-host.js";
import { renderMarkdown } from "../../shared/ui/markdown.js";

// Summarising needs far more of each paragraph than scoring does. 400 chars is
// ample to judge relevance but would truncate every long paragraph mid-sentence
// here, producing a confident summary of partial text with nothing to signal it.
const SUMMARY_BLOCK_CHARS = 2000;
const SUMMARY_BLOCK_BUDGET = 1500;

// Roughly 30k tokens. Past this the request gets slow and expensive, and the
// user is told rather than silently given a summary of the first half.
const MAX_PAGE_CHARS = 120_000;

const STYLES = `
  :host { all: initial; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(10, 12, 16, .55);
    opacity: 0; transition: opacity .16s ease;
  }
  .modal {
    position: fixed; z-index: 2147483647;
    top: 50%; left: 50%; transform: translate(-50%, -48%);
    width: min(760px, 92vw); max-height: 82vh;
    display: flex; flex-direction: column;
    box-sizing: border-box;
    background: #1b1e24; color: #e9ecf1;
    border: 1px solid rgba(255,255,255,.13); border-radius: 12px;
    box-shadow: 0 18px 60px rgba(0,0,0,.5);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    opacity: 0; transition: opacity .16s ease, transform .16s ease;
  }
  :host(.visible) .backdrop { opacity: 1; }
  :host(.visible) .modal { opacity: 1; transform: translate(-50%, -50%); }

  header {
    display: flex; align-items: center; gap: 10px;
    padding: 13px 16px; border-bottom: 1px solid rgba(255,255,255,.1);
  }
  header h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #e2b23c; animation: pulse 1.1s ease-in-out infinite; }
  .dot.idle { animation: none; background: #4a5261; }
  .icon {
    border: 0; background: transparent; color: #a7aeba;
    font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 5px;
  }
  .icon:hover { background: rgba(255,255,255,.08); color: #e9ecf1; }

  .body { padding: 4px 18px 16px; overflow-y: auto; overflow-wrap: anywhere; }
  .body h2, .body h3, .body h4 { margin: 18px 0 6px; font-size: 14px; }
  .body p { margin: 9px 0; }
  .body ul, .body ol { margin: 9px 0; padding-left: 20px; }
  .body li { margin: 4px 0; }
  .body code { background: rgba(255,255,255,.09); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  .body pre { background: rgba(0,0,0,.32); padding: 10px 12px; border-radius: 7px; overflow-x: auto; }
  .body pre code { background: none; padding: 0; }
  .placeholder { color: #8d94a1; }

  footer {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 16px; border-top: 1px solid rgba(255,255,255,.1);
  }
  .note { flex: 1; color: #8d94a1; font-size: 12px; }
  .note.error { color: #ff8a8a; }
  button.copy {
    padding: 6px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid #e2b23c; background: #e2b23c; color: #1a1608;
    font: 600 13px/1 inherit;
  }
  button.copy:disabled { opacity: .5; cursor: default; }

  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) {
    .dot { animation: none; }
    .backdrop, .modal { transition: none; }
  }
`;

const MARKUP = `
  <div class="backdrop"></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Page summary">
    <header>
      <span class="dot"></span>
      <h2>Summary</h2>
      <button class="icon close" title="Close (Esc)" aria-label="Close">&times;</button>
    </header>
    <div class="body"><p class="placeholder">Reading the page…</p></div>
    <footer>
      <span class="note"></span>
      <button class="copy" disabled>Copy</button>
    </footer>
  </div>
`;

let ui = null;
let port = null;
let raw = "";
let escHandler = null;
let renderQueued = false;

// Headings carry structure that plain paragraphs lose, and a model summarises far
// better when it can see the page's shape rather than an undifferentiated wall.
function buildPageText() {
  const blocks = collectBlocks({
    budget: SUMMARY_BLOCK_BUDGET,
    maxChars: SUMMARY_BLOCK_CHARS
  });

  const text = blocks
    .map((b) => (b.level ? `${"#".repeat(b.level)} ${b.text}` : b.text))
    .join("\n\n");

  return {
    text: text.slice(0, MAX_PAGE_CHARS),
    truncated: text.length > MAX_PAGE_CHARS,
    blocks: blocks.length
  };
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  // Re-rendering the whole document on every delta would thrash layout on a long
  // summary. One render per frame keeps it smooth and still looks live.
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!ui) return;
    const atBottom =
      ui.body.scrollHeight - ui.body.scrollTop - ui.body.clientHeight < 40;
    ui.body.innerHTML = renderMarkdown(raw);
    if (atBottom) ui.body.scrollTop = ui.body.scrollHeight;
  });
}

function closeModal() {
  port?.disconnect();
  port = null;
  if (escHandler) {
    document.removeEventListener("keydown", escHandler, true);
    escHandler = null;
  }
  if (!ui) return;
  const host = ui.host;
  ui.host.classList.remove("visible");
  ui = null;
  setTimeout(() => host.remove(), 200);
}

function openModal() {
  closeModal();
  raw = "";

  const { host, root } = createShadowHost("summary", STYLES, MARKUP);
  ui = {
    host,
    body: root.querySelector(".body"),
    note: root.querySelector(".note"),
    copy: root.querySelector(".copy"),
    dot: root.querySelector(".dot")
  };

  root.querySelector(".close").addEventListener("click", closeModal);
  root.querySelector(".backdrop").addEventListener("click", closeModal);

  // Capture phase: some pages bind their own Escape handlers and stop propagation.
  escHandler = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeModal();
    }
  };
  document.addEventListener("keydown", escHandler, true);

  ui.copy.addEventListener("click", async () => {
    // Copies the raw markdown rather than the rendered text — that is what you
    // would paste into notes.
    try {
      await navigator.clipboard.writeText(raw);
      ui.note.textContent = "Copied as markdown.";
    } catch {
      ui.note.textContent = "Clipboard blocked by this page — select and copy manually.";
    }
  });

  requestAnimationFrame(() => host.classList.add("visible"));
  return ui;
}

function finish(noteText, isError) {
  if (!ui) return;
  ui.dot.classList.add("idle");
  ui.note.textContent = noteText;
  ui.note.classList.toggle("error", !!isError);
  ui.copy.disabled = !raw.trim();
}

async function summarize(focus) {
  const modal = openModal();
  const page = buildPageText();

  if (!page.text.trim()) {
    finish("Found no readable text on this page.", true);
    modal.body.innerHTML = "";
    return;
  }

  modal.note.textContent = page.truncated
    ? `Page is long — summarising the first ${Math.round(MAX_PAGE_CHARS / 1000)}k characters of ${page.blocks} blocks.`
    : `${page.blocks} blocks sent.`;
  modal.body.innerHTML = '<p class="placeholder">Summarising…</p>';

  // The port name must match what the worker listens for — distinct from the
  // popup trigger above, which is an ordinary tab message.
  port = chrome.runtime.connect({ name: MSG.SUMMARIZE_PORT });

  port.onMessage.addListener((msg) => {
    if (msg.type === STREAM.DELTA) {
      raw += msg.text;
      scheduleRender();
    } else if (msg.type === STREAM.DONE) {
      scheduleRender();
      finish(page.truncated ? "Done (page was truncated)." : "Done.");
    } else if (msg.type === STREAM.ERROR) {
      finish(msg.error, true);
      if (!raw) modal.body.innerHTML = "";
    }
  });

  port.onDisconnect.addListener(() => {
    // The worker can be evicted mid-stream. If nothing arrived, say so rather
    // than leaving a modal that looks like it is still thinking.
    if (ui && !raw) finish("Connection to the extension dropped. Try again.", true);
  });

  port.postMessage({ type: MSG.SUMMARIZE_START, pageText: page.text, focus });
}

export function initSummarize() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== MSG.SUMMARIZE_RUN) return false;
    summarize(msg.focus);
    sendResponse({ ok: true });
    return false;
  });
}
