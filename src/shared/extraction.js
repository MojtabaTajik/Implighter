// DOM text extraction, shared by every feature that needs to send page content
// to a model. No HTML, CSS, attributes or URLs ever leave the page — only the
// rendered text of an allowlist of elements.

export const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, figcaption, dd, dt, td, th, summary";

export const SKIP_ANCESTOR_SELECTOR =
  "nav, footer, aside, script, style, noscript, svg, form, select, textarea, [aria-hidden='true'], [role='navigation'], [role='banner'], [role='contentinfo']";

// The model sees text, not layout, so a commenter arguing about sharding reads
// exactly like the article arguing about sharding. This tags blocks that live in
// a discussion region so a prompt can treat them as what they are.
const DISCUSSION_HINT =
  /(^|[-_ ])(comment|comments|disqus|discussion|replies|reply|thread|testimonial|review)s?([-_ ]|$)/i;

export function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function isVisible(el) {
  if (el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.opacity !== "0";
}

export function hasClaimedAncestor(el, claimed) {
  let parent = el.parentElement;
  while (parent) {
    if (claimed.has(parent)) return true;
    parent = parent.parentElement;
  }
  return false;
}

export function regionOf(el) {
  let node = el;
  while (node && node !== document.body) {
    const id = node.id || "";
    const cls = typeof node.className === "string" ? node.className : "";
    if (DISCUSSION_HINT.test(id) || DISCUSSION_HINT.test(cls)) return "discussion";
    node = node.parentElement;
  }
  return null;
}

/**
 * Walks the page in document order and keeps the outermost text-bearing block at
 * each position, so a <li> containing a <p> is counted once, not twice.
 *
 * `maxChars` is per-feature on purpose. 400 is ample to judge whether a paragraph
 * is relevant, but truncating at 400 to summarise would silently drop the second
 * half of every long paragraph and produce a confident summary of partial text.
 *
 * `skip` lets a feature exclude elements it has already dealt with while still
 * letting them claim their subtree, which is what makes incremental passes cheap.
 */
export function collectBlocks({
  startId = 0,
  budget = 600,
  maxChars = 400,
  skip = () => false
} = {}) {
  const candidates = Array.from(document.body.querySelectorAll(BLOCK_SELECTOR));
  const claimed = new Set();
  const blocks = [];
  let nextId = startId;

  for (const el of candidates) {
    if (blocks.length >= budget) break;
    if (el.closest(SKIP_ANCESTOR_SELECTOR)) continue;
    if (hasClaimedAncestor(el, claimed)) continue;

    const headingLevel = /^H([1-6])$/.exec(el.tagName);
    const text = normalize(el.innerText || "");
    if (text.length < (headingLevel ? 3 : 25)) continue;
    if (!isVisible(el)) continue;

    claimed.add(el);
    if (skip(el)) continue;

    blocks.push({
      id: nextId++,
      el,
      tag: el.tagName.toLowerCase(),
      level: headingLevel ? Number(headingLevel[1]) : 0,
      region: regionOf(el),
      text: text.slice(0, maxChars)
    });
  }

  return blocks;
}
