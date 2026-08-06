# Chrome Web Store submission — copy to paste

Everything the dashboard asks for, written out. The **Privacy practices** tab is the part that
gets submissions rejected or delayed, so those answers are given verbatim.

---

## Listing

**Name**

```
implighter
```

**Short description** (132 char limit — this is 98)

```
Highlight what matters for your goal, dim the rest, and summarize pages or YouTube videos with AI.
```

**Category:** Productivity — **Language:** English

**Homepage URL:** `https://github.com/MojtabaTajik/Implighter`
**Support URL:** `https://github.com/MojtabaTajik/Implighter/issues`
**Privacy policy URL:** `https://github.com/MojtabaTajik/Implighter/blob/main/PRIVACY.md`

**Detailed description**

```
Most pages bury what you need. implighter finds it.

Tell it why you're on the page — "prepare for a system design interview, quick and
practical" — and it reads the page, highlights the parts that serve that goal, and dims or
hides everything else. The same article gives different results for different goals, because
relevance depends on what you came for.

WHAT IT DOES

• Highlights for your goal, not generic "importance". Marketing copy, author bios, newsletter
  pitches and comment threads fade out.
• Hides dead sections whole. A comment thread loses its usernames, timestamps and Reply links
  too, not just the comments.
• Keeps working as the page grows. Content loaded by "Show all comments" or infinite scroll is
  scored as it arrives.
• Summarizes any page into key points you can copy or download as Markdown.
• Summarizes YouTube videos from the transcript, with timestamps you click to jump straight to
  the moment.
• Exports what survived as Markdown — a goal-filtered version of the page.

BRING YOUR OWN API KEY

implighter has no server and no subscription. It talks directly to Anthropic, OpenAI or Groq
using your own API key, so you pay the provider for what you use and nothing else. Groq has a
free tier if you want to try it without a card.

PRIVACY

Nothing runs until you invoke it. There is no analytics, no telemetry, and no account. Page
text goes to the provider you chose and nowhere else. Your key stays in your browser.

OPEN SOURCE

Every line is readable at github.com/MojtabaTajik/Implighter
```

**Screenshots** — 1280×800 or 640×400, 1–5. Suggested, in order:

1. A cluttered article before and after, side by side — the clearest single image
2. The popup with a goal typed in
3. A summary modal mid-stream
4. A YouTube video summary showing clickable timestamps
5. The settings Provider tab

---

## Privacy practices tab

**Single purpose description**

```
implighter helps a user read a web page more efficiently: it highlights the parts of the page
relevant to a goal the user states, and produces summaries of pages and videos on request.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| `activeTab` | Reads the text of the page the user is currently on, only at the moment they invoke the extension, so it can be sent for relevance scoring or summarizing. Used deliberately instead of broad host permissions so the extension cannot read pages the user has not acted on. |
| `scripting` | Injects the extension's content script into the current tab when the user invokes the extension. Required because the extension deliberately declares no content_scripts entry and therefore does not run automatically on any site. |
| `storage` | Stores the user's API key, chosen provider and model, editable prompts, and interface preferences locally in the browser. None of it is transmitted anywhere except the user's chosen AI provider. |
| `contextMenus` | Adds right-click entries for highlighting a page, summarizing a page, summarizing a selection, and summarizing a YouTube video. |
| Host access to `api.anthropic.com`, `api.openai.com`, `api.groq.com` | Sends the extracted page text and the user's goal to whichever of these three AI providers the user configured. These are the only hosts the extension contacts. |

**Remote code:** No. All code is contained in the package. No `eval`, no external scripts, no
CDN, no remotely hosted modules.

**Data usage disclosures** — tick these and only these:

- ☑ **Website content** — page text is sent to the user's chosen AI provider to produce
  highlights and summaries.
- ☑ **Authentication information** — the user's API key is stored locally so requests can be
  made on their behalf. It is transmitted only to the provider that issued it.

Leave unticked: personally identifiable information, health information, financial and payment
information, personal communications, location, web history, user activity.

**Certifications** — all three apply and can be affirmed:

- Data is not sold or transferred to third parties outside approved use cases
- Data is not used or transferred for purposes unrelated to the single purpose
- Data is not used or transferred to determine creditworthiness or for lending

---

## Anticipated review questions

**"Why does this need to read website content?"**
Its function is to judge which parts of the page the user cares about. It cannot do that without
the page text. Only rendered text of content elements is read — no HTML, scripts, cookies,
form fields, or URLs — and only on pages where the user explicitly invoked the extension.

**"Why bring-your-own API key rather than a backend?"**
So no user data passes through developer-operated infrastructure. The extension is a direct
client of the provider the user already has an account with.

---

## Before you submit

- [ ] Bump `version` in `manifest.json`
- [ ] `node scripts/check.mjs --strict` passes
- [ ] `git tag vX.Y.Z && git push origin vX.Y.Z` — CI builds and attaches the zip
- [ ] Download that zip from the GitHub release and upload it, rather than zipping by hand
- [ ] Decide visibility: **Unlisted** works via direct link with no search presence, which is
      the sane first release

## After it is live

- [ ] Add the store URL to the repo README and the GitHub project description
