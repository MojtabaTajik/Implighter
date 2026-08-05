// A shadow root hosted on documentElement, not body. Two reasons:
//
//   1. Page CSS cannot reach into shadow DOM, and ours cannot leak out — which
//      matters when the page has just been restyled by the highlight feature.
//   2. body is what the highlight MutationObserver watches, so injecting UI
//      there would trigger an incremental scoring pass on our own chrome.

export function createShadowHost(name, styles, html) {
  const host = document.createElement("div");
  host.setAttribute(`data-implighter-${name}`, "");
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${styles}</style>${html}`;

  return { host, root };
}

export function removeShadowHost(host) {
  host?.remove();
}
