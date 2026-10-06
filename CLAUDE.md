# CLAUDE.md

@AGENTS.md

## Claude Code notes

- The shared engineering rules live in `@AGENTS.md` above (imported in full at session start).
- Keep this file thin: shared rules belong in `AGENTS.md`, project-specific context belongs here.

---

## What this project is

**LiveLingo** — a Chrome extension (Manifest V3) that captures audio, transcribes it with
**Deepgram** (streaming WebSocket), translates it with **DeepL** (REST), and displays live
bilingual subtitles.

Built for a specific real event: a **visiting foreign scholar's talk in September 2026**,
where the Q&A needs both English→Chinese and Chinese→English simultaneously.

### Three separate capture pipelines

| Entry point | Audio source | Display | Used for |
|---|---|---|---|
| `live.html` / `live.js` | mic / mixer input | full-screen black projection page | **the September talk** (primary deliverable) |
| `mic.html` / `mic.js` | mic input | normal dark window, scrolling transcript | meetings, ad-hoc use |
| popup → `background.js` → `offscreen.js` | **tab audio** (`chrome.tabCapture`) | draggable floating overlay on the page (`content.js`) | YouTube / Twitch streams |

All three share `pcm-worklet.js` (downsamples to 16 kHz mono PCM16 for Deepgram).

### File map

```
manifest.json     MV3 config. NOTE the "key" field — see constraints below.
background.js     Service worker: tabCapture stream id, offscreen lifecycle, message relay
offscreen.js      Tab-audio capture + Deepgram + DeepL (MV3 can't do MediaStream in a SW)
pcm-worklet.js    AudioWorklet: any sample rate -> 16 kHz mono PCM16
content.js/css    Injected floating subtitle overlay (draggable, re-entrant)
popup.html/js     Extension popup: launches the other pages, controls tab capture
options.html/js   API key entry (writes to chrome.storage.sync)
live.html/js      Projection page: single centred column, or split view in bidirectional mode
mic.html/js       Standalone mic transcription page
logo.png          Used by the pages; icons/ holds the 16/48/128 extension icons
```

---

## Hard-won constraints — do not re-learn these the hard way

**Deepgram**

- `is_final` does **NOT** mean "the sentence ended" — it means "this chunk of text is
  settled". Committing a line on `is_final` produces fragments like `"The humans"` /
  `"have input."` / `"that"`, each translated in isolation, which also destroys translation
  quality. Buffer chunks and only flush on **`speech_final`** or an **`UtteranceEnd`**
  message. All three pipelines implement this (`appendPending` / `flushPending`).
- Live streaming does **not** support automatic language detection. `detect_language` only
  works on pre-recorded audio; passing it to a stream yields empty transcripts. Always send
  an explicit `language`.
- Live streaming does **not** support Chinese code-switching. `language=multi` covers only
  en/es/fr/de/hi/ru/pt/ja/it/nl — **Chinese is excluded**. This is why bidirectional mode
  runs two separate sockets instead of one multilingual one.
- Valid Chinese codes: `zh-TW` / `zh-Hant` (traditional), `zh-CN` / `zh` (simplified).
- Deepgram closes an audio-less socket after ~10 s. To pause a direction without losing the
  connection, stop sending audio but send `{"type":"KeepAlive"}` every ~5 s (this is how the
  per-column pause button stays instant and free).

**Chrome / MV3**

- Service workers are killed after ~30 s idle and lose in-memory variables, but the
  offscreen document (and its live tab capture) keeps running. Session state must live in
  `chrome.storage.session` — otherwise the popup thinks nothing is capturing while a stale
  capture still holds the tab, producing *"Cannot capture a tab with an active stream"*.
- Always force-release any existing capture before requesting a new stream id.
- Content scripts are only auto-injected on page load. Tabs opened before the extension was
  installed/reloaded have no script, so `content.js` is injected on demand via
  `chrome.scripting` and is written to be **re-entrant** (`window.__lctCleanup` retires the
  previous instance). All its `chrome.*` calls are wrapped, because an orphaned instance
  throws *"Extension context invalidated"*.
- `manifest.json` contains a fixed **`key`** (public key) that pins the extension ID. **Do
  not change or remove it** — the ID is what `chrome.storage.sync` data is keyed to, so
  changing it breaks API-key sync across the user's machines. The matching private key was
  deliberately deleted; a `.crx` build would need a new key and would get a new ID.
- DRM sites (Netflix, Disney+) block `tabCapture`. YouTube/Twitch are fine.

**Secrets**

- API keys are stored in `chrome.storage.sync` (so they follow the user's Google account
  across machines) and **never** written to any file in the repo. Do not add them to
  `manifest.json`, options defaults, or docs.

---

## Running and testing

There is **no build step** — plain JS/HTML/CSS loaded directly.

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder
2. Open the extension's **Options** page and enter Deepgram + DeepL API keys
3. Reload the extension after any code change; **reload the target web page too** if you
   changed `content.js`

Verification is manual (see "Testing" caveat below). Useful quick checks:

```bash
for f in *.js; do node --check "$f"; done
python3 -c "import json; json.load(open('manifest.json'))"
```

---

## Which AGENTS.md rules do not apply here

`AGENTS.md` is the shared, stack-agnostic standard (also read by GitHub Copilot) and is
written for Next.js + Supabase + TypeScript web apps. It should **not** be edited to suit
this project. These rules are inapplicable as written:

- **ARCH-04** (TypeScript types / zod) — this project is plain JavaScript, no TS toolchain.
- **SEC-02 / SEC-03** (server-side authN/authZ, service-role keys) — there is no backend;
  the extension talks straight to Deepgram/DeepL with the user's own keys.
- **SEC-06** (rate-limit endpoints) — no endpoints of our own are exposed.
- **SEC-08** (cookies / CSRF / security headers) — no sessions or forms posted to a server.
- **TEST-01 … TEST-05** — there is currently **no test suite and no CI**. Verification is
  manual: real audio through a real mic/mixer, since the whole system is live-audio and
  third-party-API bound. Treat this as known, accepted tech debt (SHIP-05).
- **GIT-01 … GIT-04, SHIP-01 … SHIP-04** — this folder is **not a git repository**, so
  there are no commits, branches, PR reviews, staging, or rollback path. A `.gitignore` is
  already prepared for whenever it is initialised.
- `nextjs.md`, `supabase.md`, `typescript.md` and `tailwind.md` are deliberately **not
  installed** here — no Next.js, no Supabase, no TypeScript, no Tailwind.

### Rule files installed for this project

`.claude/rules/` (with `.github/instructions/` twins for Copilot):

- `ui-ux.md` — applies to all the HTML/CSS in this extension
- `accessibility.md` — same
- `browser-extension.md` — MV3 lifecycle, permissions, and distribution rules; this is where
  most of the "hard-won constraints" above are encoded as checkable rules

Rules that apply and are actively followed: PB-01…03, REQ-01…04, ARCH-01…03, ARCH-04 (data
shapes validated at every boundary — Deepgram frames, DeepL responses, stored settings),
SEC-01, SEC-02/SEC-03 as reinterpreted by EXT-02/EXT-03 (no backend, so the trust boundary is
the browser and keys live in `chrome.storage`), AI-01…03, DEV-01…05, ERR-01…03, plus the
SELF REVIEW checklist.

`engineering-rules-split/` is a copy of the rules **template** that `AGENTS.md` came from. It
is not part of the extension and should be moved out to a single shared location — keeping a
copy inside a project invites the two drifting apart.

**Response format:** `AGENTS.md` asks for
`Understanding · Plan · Implementation · Risks · Validation · Next Steps` on every
implementation task. In practice this project has been built through fast conversational
iteration (many small UI tweaks), where that format is more overhead than help. Use
judgement: apply it for substantial changes, and stay brief for small tweaks — but always
state assumptions and flag risks.
