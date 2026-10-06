---
paths:
  - "manifest.json"
  - "background.js"
  - "content.js"
  - "offscreen.js"
  - "service-worker.js"
  - "**/*.user.js"
---

# Browser Extension Rules (Chrome / Manifest V3)

For projects with no backend, where the extension itself is the whole product.

## Permissions & trust

**EXT-01 · MUST** — Request the narrowest permissions that work. Prefer `activeTab` over broad
`host_permissions`; prefer on-demand `chrome.scripting` injection over a blanket
`content_scripts` match on `<all_urls>`. Every extra permission shows up in the install prompt
and widens the blast radius.

**EXT-02 · MUST** — There is no server, so the trust boundary is the user's own browser. Treat
page content (DOM text, page scripts, injected data) as untrusted input; never `eval` it and
never let it drive privileged actions. This is core rule SEC-02 applied to extensions.

**EXT-03 · MUST** — API keys and tokens live in `chrome.storage` (`sync` to follow the user's
account, `local` for per-machine), never hard-coded, never in `manifest.json`, never logged.

## Manifest V3 lifecycle

**EXT-04 · MUST** — The service worker is killed when idle (~30 s) and loses all in-memory
state. Anything that must survive belongs in `chrome.storage.session` / `local`, not a module
variable. Assume it can restart between any two events.

**EXT-05 · MUST** — A service worker cannot hold a `MediaStream`, `AudioContext`, or long-lived
DOM work. Use an offscreen document for those, and handshake with it (wait for a ready ping)
instead of assuming it is listening the moment it is created.

**EXT-06 · MUST** — Content scripts declared in the manifest only auto-inject on page load, so
tabs already open when the extension is installed or reloaded have none. Inject on demand and
make the content script **re-entrant**: retire the previous instance, remove its listeners, and
wrap every `chrome.*` call — an orphaned script throws "Extension context invalidated".

**EXT-07 · SHOULD** — Release exclusive resources (tab capture, media streams) before
re-acquiring them. Chrome reports "already in use" based on its own state, not yours.

## Distribution

**EXT-08 · MUST** — If `manifest.json` pins the extension ID with a `key` field, do not change
or remove it: the ID is what `chrome.storage.sync` data is keyed to, so changing it silently
strands the user's synced settings. Keep the matching private key out of the repo.

**EXT-09 · SHOULD** — State the platform limits you actually hit in the README (DRM-protected
sites blocking capture, user-gesture requirements, per-API quotas), so the next person doesn't
rediscover them.

## Verification

**EXT-10 · SHOULD** — There is no build step to catch mistakes, so at minimum syntax-check
every script and validate the manifest before handing it over:

```bash
for f in *.js; do node --check "$f"; done
python3 -c "import json; json.load(open('manifest.json'))"
```

**EXT-11 · SHOULD** — Reload the extension **and** the target page after changing a content
script; a stale page keeps running the old copy.
