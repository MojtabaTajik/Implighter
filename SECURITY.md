# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/MojtabaTajik/Implighter/security/advisories/new)
rather than as a public issue.

Expect an acknowledgement within a few days. This is a solo project, so response times are
best effort rather than contractual.

## Scope

This extension handles API keys and page content, so the areas most worth scrutiny are:

- **API key handling.** Keys live in `chrome.storage.local` and are read only by the service
  worker. Content scripts never receive one, and no key is sent anywhere except the provider
  that issued it. `chrome.storage.local` is not encrypted — that is a documented limitation, not
  a vulnerability report.
- **Rendering model output.** `src/shared/ui/markdown.js` escapes HTML before applying any
  markup, because page text reaches the model and a hostile page can attempt prompt injection to
  get markup into the response. The summary modal renders inside the page's document, so a
  bypass there would execute in page context. This is the highest-value area to look at.
- **Injected content scripts.** The extension declares no `content_scripts` and injects on
  demand under `activeTab`, so it should have no ability to read pages the user has not acted on.
  A path to reading arbitrary pages would be a genuine finding.
- **Web accessible resources.** Feature modules are listed in `web_accessible_resources` so the
  content entry can import them. They contain no secrets, but confused-deputy issues are in scope.

## Out of scope

- The unencrypted-at-rest nature of `chrome.storage.local`, which Chrome does not offer an
  alternative to
- Content sent to a third-party AI provider that the user explicitly configured
- Vulnerabilities in the AI providers themselves
