// Progress UI for the highlight slice.
//
// A scrim only for the initial run — the page is being restructured and watching
// it half-paint is jarring. Incremental passes get a corner toast instead:
// dropping a scrim on someone mid-read because comments loaded would be worse
// than saying nothing. The scrim is pointer-events:none either way, so a slow
// API call never traps the user.

import { createShadowHost } from "../../shared/ui/shadow-host.js";

const STYLES = `
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
    color: #f2f4f7; background: #1b1e24;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 10px;
    box-shadow: 0 10px 34px rgba(0,0,0,.45);
    opacity: 0; transition: opacity .18s ease, transform .18s ease;
  }
  .panel.center { top: 50%; left: 50%; transform: translate(-50%,-46%); width: 320px; padding: 16px 18px; }
  .panel.corner { right: 16px; bottom: 16px; transform: translateY(6px); max-width: 300px; padding: 10px 13px; }
  :host(.visible) .scrim { opacity: 1; }
  :host(.visible) .panel.center { opacity: 1; transform: translate(-50%,-50%); }
  :host(.visible) .panel.corner { opacity: 1; transform: translateY(0); }
  .title { display: flex; align-items: center; gap: 7px; font-weight: 600; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #e2b23c; animation: pulse 1.1s ease-in-out infinite; }
  .goal { margin-top: 7px; color: #a7aeba; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { margin-top: 11px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.13); overflow: hidden; }
  .fill { height: 100%; width: 0%; background: #e2b23c; border-radius: 2px; transition: width .2s ease; }
  .detail { margin-top: 8px; color: #a7aeba; font-size: 12px; }
  .panel.corner .goal, .panel.corner .track { display: none; }
  .panel.corner .detail { margin-top: 3px; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) {
    .dot { animation: none; }
    .scrim, .panel, .fill { transition: none; }
  }
`;

const MARKUP = `
  <div class="scrim"></div>
  <div class="panel center">
    <div class="title"><span class="dot"></span><span>implighter</span></div>
    <div class="goal"></div>
    <div class="track"><div class="fill"></div></div>
    <div class="detail"></div>
  </div>
`;

let ui = null;
let hideTimer = null;

function ensure() {
  if (ui?.host?.isConnected) return ui;
  const { host, root } = createShadowHost("progress", STYLES, MARKUP);
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

export function overlayShow({ mode, goal, detail }) {
  const el = ensure();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  const isFull = mode === "full";
  el.panel.classList.toggle("center", isFull);
  el.panel.classList.toggle("corner", !isFull);
  el.scrim.style.display = isFull ? "" : "none";
  el.goal.textContent = goal || "";
  el.detail.textContent = detail || "";
  el.fill.style.width = "0%";
  el.dot.style.animationPlayState = "running";

  // Force a frame so the opacity transition runs on first show.
  requestAnimationFrame(() => el.host.classList.add("visible"));
}

export function overlayProgress(done, total) {
  if (!ui?.host?.isConnected) return;
  ui.fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  ui.detail.textContent = `Scoring ${done} of ${total} chunks`;
}

export function overlayFinish(text) {
  if (!ui?.host?.isConnected) return;
  ui.fill.style.width = "100%";
  ui.detail.textContent = text;
  ui.dot.style.animationPlayState = "paused";
  hideTimer = setTimeout(overlayHide, 1600);
}

export function overlayHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!ui?.host?.isConnected) return;
  const host = ui.host;
  host.classList.remove("visible");
  // A show() during the fade-out re-adds .visible — don't rip out the panel we
  // just brought back. run() hides then immediately shows on every re-run.
  setTimeout(() => {
    if (!host.classList.contains("visible")) host.remove();
  }, 250);
}
