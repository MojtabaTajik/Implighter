// A deliberately small markdown renderer for model output.
//
// SECURITY: model output is untrusted. Page text flows into the prompt, so a
// hostile page can attempt prompt injection to get markup such as
// `<img onerror=...>` into the response. This renders into a shadow root that
// lives inside the page's document, where injected script would run in page
// context — so everything is HTML-escaped FIRST, and only then are a fixed set
// of tags introduced. Never reverse that order, and never pass raw model text
// to innerHTML anywhere else.
//
// Links are rendered as plain text rather than anchors. A summary rarely needs
// them, and it removes any need to validate javascript:/data: URLs.

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Applied only to already-escaped text, so these patterns can never match markup
// the model emitted — by this point it is all entities.
function inline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

export function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  const out = [];
  let listType = null;
  let inFence = false;
  let fence = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const openList = (type) => {
    if (listType !== type) {
      closeList();
      out.push(`<${type}>`);
      listType = type;
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        out.push(`<pre><code>${fence.join("\n")}</code></pre>`);
        fence = [];
      } else {
        closeList();
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length + 1); // demote: the modal owns h1
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      openList("ul");
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      openList("ol");
      out.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }

  // An unterminated fence still has content worth showing.
  if (inFence && fence.length) out.push(`<pre><code>${fence.join("\n")}</code></pre>`);
  closeList();

  return out.join("");
}
