# Privacy Policy — implighter

**Last updated:** 6 August 2026

implighter is a Chrome extension that highlights the parts of a web page relevant to a goal you
state, and summarizes pages and YouTube videos on request.

There is no implighter server. The extension runs entirely in your browser and talks directly to
the AI provider you choose. Nothing is routed through infrastructure operated by the developer.

## What is collected

**Nothing is collected by the developer.** There is no analytics, no telemetry, no crash
reporting, no advertising identifier, and no account.

## What is sent, when, and to whom

The extension sends data only when you explicitly invoke it — by clicking the toolbar icon,
using a keyboard shortcut, or choosing a context menu item. It sends nothing while you merely
browse.

| When you… | What is sent | Where it goes |
|---|---|---|
| Highlight a page | The visible text of the page, and the goal you typed | The AI provider you selected |
| Summarize a page | The visible text of the page, and your optional focus text | The AI provider you selected |
| Summarize a selection | Only the text you selected | The AI provider you selected |
| Summarize a video | The video's transcript text, and your optional focus text | The AI provider you selected |
| Save settings | A two-sentence fixed test message, to verify your key works | The AI provider you selected |

The AI provider is whichever you configure — **Anthropic**, **OpenAI**, or **Groq**. Your data is
handled under that provider's privacy policy once it reaches them:

- Anthropic — https://www.anthropic.com/legal/privacy
- OpenAI — https://openai.com/policies/privacy-policy
- Groq — https://groq.com/privacy-policy/

Page text is extracted, not scraped wholesale: the extension collects the rendered text of
content elements and skips navigation, footers, sidebars, forms, and hidden elements. No HTML,
CSS, scripts, attributes, cookies, or URLs are transmitted.

## What is stored, and where

Stored locally in your browser profile via `chrome.storage.local`, and never transmitted
anywhere:

- Your API key or keys, one per provider
- Your chosen provider and model
- Your summary and video-summary instruction prompts
- Your recent goals, last focus text, and interface preferences

**Your API key is stored unencrypted**, which is a limitation of `chrome.storage.local` rather
than a choice. Any software able to read your Chrome profile directory can read it. Use a key
issued for this purpose, and rotate it if the machine is shared. Uninstalling the extension
deletes everything it stored.

## What is never done

- No data is sold, shared, or transferred to anyone other than the AI provider you chose
- No data is used for advertising, profiling, or creditworthiness assessment
- No remote code is loaded or executed — the extension ships all of its own code
- No page content is read on pages where you have not invoked the extension

## Permissions, and why each exists

- **activeTab** — read the text of the page you are currently on, at the moment you invoke the
  extension. This is deliberately used instead of broad host access so the extension has no
  ability to read pages you have not asked it to act on.
- **scripting** — insert the extension's code into that page when you invoke it.
- **storage** — keep your settings and API key in your browser.
- **contextMenus** — add the right-click entries.
- **Access to `api.anthropic.com`, `api.openai.com`, `api.groq.com`** — send your request to the
  provider you chose. These are the only three hosts the extension can contact.

## Children

implighter is not directed at children and collects nothing from anyone.

## Changes

Material changes will be published in this file, with the date above updated. The file is
version-controlled, so its full history is public at
https://github.com/MojtabaTajik/Implighter/commits/main/PRIVACY.md

## Contact

Questions or concerns: https://github.com/MojtabaTajik/Implighter/issues
