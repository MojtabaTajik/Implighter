# implighter — Important Highlighter

Chrome extension. You give it a goal ("I want to prepare for a system design interview"),
it reads the page you're on, highlights the parts that serve that goal, and dims the rest.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this directory
3. Click the extension icon → **Settings** → paste an Anthropic API key
4. Open a content-heavy page, click the icon, type a goal, hit **Highlight**

Tabs that were already open when you installed or reloaded the extension have no content
script yet — reload those tabs once.

## How it handles the context problem

Sending a whole page to the model degrades relevance judgement, so it never does that.

1. **Extract, don't scrape.** The content script walks the DOM for text-bearing blocks
   (`p`, `li`, `h1`–`h6`, `blockquote`, `pre`, table cells, …), skips `nav`/`footer`/`aside`
   and hidden nodes, and keeps only the outermost block at each position so nested elements
   aren't counted twice. Each block is truncated to 400 chars.
2. **Chunk in document order.** Batches of 30 blocks. Chunk boundaries follow document
   order so each chunk reads as continuous prose — the model sees a coherent passage, not
   30 disconnected fragments.
3. **Dispatch viewport-first.** Chunks are sorted by distance from the current viewport, so
   what you're looking at gets scored first and the rest fills in behind it.
4. **Order the request most-stable-first.** Caching is a prefix match, so anything volatile
   sitting early invalidates everything behind it. The request is layered:

   | # | Segment | Changes when | `cache_control` |
   |---|---------|--------------|-----------------|
   | 1 | rubric (`system`) | never — identical on every request this extension makes, across pages and goals | `ttl: 1h` |
   | 2 | page blocks | per chunk; identical when the same chunk is scored again | `ttl: 5m` (default) |
   | 3 | your goal | every edit | none — it's the volatile tail |

   The goal used to live in the system block, *above* the page content. That meant every goal
   edit invalidated the blocks behind it — which is precisely the loop you're in while tuning a
   goal on one page. Moving it to the tail makes a re-run on a new goal read the page content
   from cache at ~0.1x instead of paying full price. The rubric earns the 1h TTL outright: it's
   read on every chunk of every run, so the 2x write premium repays on the second chunk.

   The first chunk is sent alone to write the cache; the rest then run 3-at-a-time and read it.
   Firing everything at once would make each request pay its own cache write, since an entry
   isn't readable until the first response starts coming back.

   ⚠️ **The rubric is ~820 tokens, and the minimum cacheable prefix is model-dependent:** 512 on
   Opus 5, 1024 on Sonnet 5, 4096 on Haiku 4.5. On the two cheaper models the rubric silently
   never caches — no error, just `cache_creation_input_tokens: 0` — and every chunk pays full
   price for it, which can cost more than the pricier model. The popup reports **Cache % read**
   after each run, and the console logs the fresh/write/read split. Check it before concluding
   a cheaper model is cheaper.

Scores are `0` (noise → dimmed), `1` (supporting → left alone), `2` (core → highlighted),
returned via structured outputs so the response is schema-valid JSON, not parsed prose.

**Blocks carry a region hint.** The model sees text, not layout, so a commenter arguing about
sharding reads exactly like the article arguing about sharding — and scores just as high. Any
block inside a container whose id or class looks like a discussion region (`comment`, `disqus`,
`replies`, `thread`, `testimonial`, `review`) is tagged `(discussion)` in the payload, and the
rubric scores those `0` regardless of how insightful they are, unless the goal explicitly asks
what other people think. Detection is a regex over ancestor ids and classes — cheap, no tokens,
and it will miss sites that name their containers something unguessable.

**Media inherits.** Images, figures, diagrams, tables and embeds are never sent to the
model. After every chunk lands, each one takes the score of the nearest scored block above
it — a diagram almost always illustrates the prose immediately preceding it. Without this
they keep full brightness on a dimmed page and become the loudest thing on screen.

**Sections roll up.** Hiding scored blocks alone leaves scaffolding behind — a comment
thread loses its comment bodies but keeps every username, timestamp, vote count and "Reply"
link, because those are under the 25-char floor or outside `BLOCK_SELECTOR` entirely. So
after painting, each ancestor of a scored block is checked: if **every** scored descendant is
noise and there are at least 3 of them, the container is hidden as a unit and the whole
section goes, scaffolding included. Deterministic, no extra API call.

**Small sections need unanimity; large ones go by ratio — but never over a keeper.** Under ~12
blocks, one keeper spares the whole container. At or above 12, a section rolls up once ≥85% of
its scored blocks are noise **and none of them scored 2**. Unanimity alone doesn't survive a
long comment thread: a handful of replies always score above 0, so 190 noise blocks and all
their scaffolding survive to protect 10 mildly interesting ones. But ratio alone is worse — a
code listing where 6 of 40 lines are the answer is 85% noise by count, and rolling it up dims
the one thing the user came for. Ratio may swallow supporting material, never a keeper.

The failure mode is worth understanding because it looks like a CSS bug: `flattenNestedDim`
strips only `implighter-dim`, so keepers inside a rolled-up container keep their highlight and
you get glowing lines inside a greyed-out block. `unrollContainersHidingCore()` enforces the
invariant — nothing highlighted may sit inside something hidden — instead of trusting the rules
above to hold.

Nothing holding more than 80% of the page's scored blocks can roll up, and `MAIN`, `ARTICLE`,
`BODY`, `HTML` are hard stops.

**Roll-up is recomputed, not accumulated.** Each pass resets every element to its recorded
verdict, re-inherits media, then re-decides every section from scratch — a section's verdict
should reflect what's in it now, not what was in it when it had a third as many blocks. That
also removes any need to un-roll sections by hand: one that no longer qualifies simply isn't
re-rolled. Only the outermost dimmed element keeps the class, or opacity compounds to 0.06.

Because that flattening strips `implighter-dim` from nested elements, the verdict is recorded
in a `data-implighter` attribute rather than inferred from classes. Reading classes here would
make flattened blocks look unscored on the next pass and get them re-sent every time — a
billing loop.

**Late content gets scored.** After the first pass a `MutationObserver` stays attached, so
"Show all comments", infinite scroll, "read more" expanders and SPA navigation don't dump
unstyled content at full brightness onto a dimmed page. Insertions are debounced 500 ms into
one pass, then only genuinely new blocks are collected — already-scored elements still claim
their subtree but aren't re-sent. Media inheritance and roll-up re-run across the whole
session each pass, since a block that just arrived can complete a section that was previously
mixed.

Content loading **into** a rolled-up section is scored like any other. Skipping it as an
optimisation looks free and isn't: clicking "Show all comments" found zero new blocks and the
pass bailed silently — no overlay, no scoring, nothing. An explicit load is an intent signal,
and a stale roll-up must not veto it.

The observer watches `childList` + `subtree` only. Painting changes classes, not structure,
so it can't retrigger itself.

Cost is bounded twice: `MAX_INCREMENTAL_ROUNDS` (20) caps passes per session, and
`MAX_BLOCKS` (600) is a session-wide ceiling, not per-pass. Incremental passes reuse the same
cached system prompt, so they hit the prompt cache while the 5-minute TTL holds.

**Progress is visible.** The initial run puts a scrim and a progress panel over the page —
it's being restructured, and watching it half-paint is jarring. Incremental passes get a
small corner toast instead: dropping a scrim on someone mid-read because comments loaded
would be worse than saying nothing. The scrim is `pointer-events: none` either way, so a slow
API call never traps you.

The UI lives in a **shadow root hosted on `documentElement`**, not `body`. Two reasons: page
CSS can't reach into shadow DOM, and `body` is what the MutationObserver watches — injecting
there would trigger an incremental pass on our own UI.

**The badge is state, not progress.** A green badge showing the cut percentage means the
extension has been applied to that tab; no badge means it hasn't. It's per-tab and updates
after incremental passes, so it stays honest as content loads. Deliberately no gray "off"
badge — that would sit on every tab you ever open to convey what its absence already conveys.

Badge lifetime is tied to the content script rather than to a navigation event: a fresh content
script means a fresh page, so it clears the badge on load. That gives it exactly the same
lifecycle as the highlights it describes, with a `tabs.onUpdated` backstop for navigations no
content script can report (leaving for a `chrome://` URL, say).

The popup reads the same state on open — an applied page shows what was done to it, the button
reads "Re-run", and Clear is only enabled when there's something to clear.

**Collapse mode** (checkbox in the popup) swaps dimming for `display: none`, so a long page
actually gets short instead of just getting faint. Toggling it re-paints instantly without
re-scoring.

## Providers

Two dropdowns in Settings: provider and model. Anthropic, OpenAI and Groq, with keys kept
**per provider** so switching the dropdown doesn't discard the one you already pasted.

`src/providers.js` is the whole abstraction — each entry builds a request and reads scores and
token usage back out. There are two adapters, not three: Anthropic has its own request shape,
and OpenAI and Groq share the OpenAI-compatible one. Adding a provider touches that file and
the options dropdown, nothing else.

Default is `claude-opus-5` at `effort: "low"`. Per-call cost here is dominated by input tokens
rather than model tier, and "is this block core to *my* goal" is exactly the nuanced judgement
where a stronger model earns its keep — weaker ones reliably score well-written-but-irrelevant
intro material as relevant, which is the wall-of-yellow failure. Groq is the interesting middle
option: `gpt-oss-20b` at Groq's speed, though with no prompt caching so the rubric is paid for
on every chunk.

**Model ids change faster than a hardcoded list does.** Every provider's dropdown has an
`Other…` entry that reveals a free-text field, so a list that's gone stale is never a blocker.

`max_tokens` is deliberately omitted on the OpenAI-compatible path: OpenAI moved to
`max_completion_tokens` and rejects the old name on newer models, while Groq still wants the old
one. Output here is a few hundred tokens, so the provider default is fine and sidestepping the
divergence is worth more than the ceiling.

### Settings are verified before they're saved

**Save runs the real classify path** against a two-block fixture with an unambiguous answer —
one about database indexes, one newsletter pitch — then checks the shape of what came back. That
exercises auth, the model id, network reach and JSON-schema conformance in a single request. The
last one matters most: a model that doesn't honour strict schema output fails *silently at
scoring time*, on a real page, long after you'd connect it to the setting you changed.

Verification failure **does not save**. A key or model that doesn't work is worse than none,
because the failure surfaces later as a broken page rather than here. A "Save without verifying"
button appears on failure for when you're offline or a provider is having a bad afternoon — it's
explicit, never the default, and it says plainly that nothing was checked.

If the fixture is scored *backwards*, the settings still save with a warning. That means the
plumbing works and the judgement is poor, which is the user's call to make, not a reason to
block.

## API key handling

The key lives in `chrome.storage.local` and is read only by the service worker. The content
script never receives it and never calls `api.anthropic.com`. That keeps the key out of
reach of page JavaScript, but `chrome.storage.local` is **not encrypted** — anything with
read access to the browser profile directory can recover it. Use a dedicated key.

## Layout

```
manifest.json
src/
  providers.js    provider registry — request shapes, score parsing, usage normalising
  background.js   service worker — owns the keys, dispatches to a provider, verifies setup
  content.js      DOM extraction, chunking, viewport ordering, painting
  content.css     highlight / dim styles (light + dark)
  popup.html/.css/.js
  options.html/.js
```

## Not built yet

Deliberate MVP cuts: no per-site saved goals, no re-run on SPA navigation, no streaming
results, no keyboard shortcut, no highlight export. Blocks in chunks that error out are left
un-dimmed rather than guessed at.

## Tuning

In `src/content.js`:

- `CHUNK_SIZE` — smaller means sharper judgement per chunk, more requests
- `MAX_BLOCK_CHARS` — how much of each block the model sees
- `MAX_BLOCKS` — ceiling per page
- `PARALLEL_CHUNKS` — in-flight requests after the cache-priming first one
- `MIN_ROLLUP_BLOCKS` — raise it if roll-up is eating sections you wanted; lower it to 2 if
  small noise sections survive
- `MAX_ROLLUP_SHARE` — the ceiling on how much of a page one roll-up may swallow
- `LARGE_SECTION_BLOCKS` / `LARGE_SECTION_NOISE_RATIO` — where ratio-based roll-up kicks in and
  how much noise it tolerates. Lower the ratio to be more aggressive with comment threads;
  raise it if sections you wanted are disappearing
- `DISCUSSION_HINT` — the regex that recognises a comment region. Add a site's container name
  here if its comments aren't being caught
- `MUTATION_DEBOUNCE_MS` — raise it on pages that insert content in slow dribbles, so one
  batch doesn't become five paid passes
- `MAX_INCREMENTAL_ROUNDS` — the runaway guard for infinite-scroll pages

The rubric in `SYSTEM_PROMPT` (`src/background.js`) is the real tuning surface. Two failure
modes to watch:

- **Wall of yellow** — most blocks scored `2`, so nothing stands out. The rubric caps `2` at
  roughly a quarter of each chunk; tighten that fraction if it still over-highlights. Note
  the model only sees one chunk at a time, so the cap is per-chunk, not per-page.
- **Everything hedged to `1`** — nothing dims, page looks untouched. Push harder on the
  "prefer decisive scores" line.

The rubric also reads modifiers in your goal: "quick and practical" tightens the bar versus a
bare topic, so phrasing the goal precisely is the cheapest lever you have.
