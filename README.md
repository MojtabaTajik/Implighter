# implighter

A Chrome extension that reads the page you're on and highlights the parts that serve **your**
goal — dimming or hiding everything else.

Tell it *why* you're reading ("prepare for a system design interview, quick and practical") and
the same article gives different results than it would for a different goal. It isn't a generic
"important sentences" highlighter; relevance depends on what you came for.

It also summarizes pages and YouTube videos, with timestamps you can click to jump to the moment.

---

## Install

Not yet on the Chrome Web Store. To run it now:

1. Download the latest `implighter-x.y.z.zip` from
   [Releases](https://github.com/MojtabaTajik/Implighter/releases) and unzip it
2. Go to `chrome://extensions` and turn on **Developer mode**
3. Click **Load unpacked** and select the unzipped folder
4. Click the implighter icon → **Open settings** → choose a provider and paste an API key

## You need an API key

There's no server and no subscription. implighter talks directly to an AI provider using your
own key, so you pay them for what you use and nothing else — but it does nothing until you add
one.

| Provider | Notes |
|---|---|
| **Groq** | Free tier, no card required. The quickest way to try it. |
| **Anthropic** | Sharpest results. The default. |
| **OpenAI** | Supported. |

Settings sends one small test request before saving, so a wrong key or a model that can't do
strict JSON output fails there rather than silently on a real page.

## Using it

**Highlight** — click the icon, type what you're trying to do, hit Highlight. Text that doesn't
serve that goal is dimmed or hidden; what matters is highlighted. `Ctrl/Cmd+Shift+Y` re-runs
with your last goal.

**Choose how aggressive it is** in Settings → Highlight:

- **Dim** — noise fades but keeps its place
- **Hide** — noise is removed and the page gets shorter
- **Only highlights** — supporting text goes too

Headings always survive, so you never lose your place.

**Copy what was kept** — exports the surviving text as Markdown, a goal-filtered version of the
page for your notes.

**Summarize** — an overview, key points and anything worth acting on, streamed into a panel you
can copy or download. `Ctrl/Cmd+Shift+U`. Right-click a selection to summarize just that.

**Summarize a video** — on a YouTube video, a **Video** tab appears in the popup. It reads the
transcript through your own YouTube session and cites timestamps you can click to jump straight
to that moment.

**Make it yours** — both summary prompts are editable in Settings, and the scoring rubric lives
in [`src/features/highlight/prompt.js`](src/features/highlight/prompt.js) if you want to tune
what counts as relevant.

## Privacy

Nothing runs until you invoke it. There is no content script sitting on every page you visit —
the extension injects itself only when you click it, and only into that tab.

No analytics, no telemetry, no account. Page text goes to the provider you chose and nowhere
else. Your key stays in your browser.

Full detail: [PRIVACY.md](PRIVACY.md).

## Contributing

No build step — plain ES modules, loaded directly by Chrome. Clone it, load it unpacked, edit,
reload the extension.

```sh
node scripts/check.mjs        # syntax, manifest references, imports, assets
node scripts/make-icons.mjs   # regenerate the icon set from geometry
```

- **[How it works](docs/architecture.md)** — the design notes: why extraction beats scraping,
  how chunking and caching are ordered, and what each scoring rule exists to prevent
- **[Security policy](SECURITY.md)** — where scrutiny is most worth spending
- **[Store submission notes](docs/store-listing.md)**

## Licence

[MIT](LICENSE) — Moji Tajik
