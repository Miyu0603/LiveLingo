---
applyTo: "**/*.tsx,**/*.jsx,**/*.vue,**/*.svelte,**/*.html,**/*.css"
---

# UI / UX Rules

Applies to any user interface — React, plain HTML/CSS, a browser-extension popup, anything
a person looks at. Tailwind-specific guidance lives in `tailwind.md`.

**UX-01 · SHOULD** — Interfaces are understandable without explanation. If users need instructions, the UI likely needs work.

**UX-02 · MUST** — Every feature supports four states: Loading (skeletons/indicators), Empty (no data), Error (actionable recovery), Success (confirmation).

**UX-03 · MUST** — Forms validate, explain errors, and prevent accidental submission.

**UX-04 · SHOULD** — Mobile first. Design for 375px before desktop. Where the interface has a fixed target instead (kiosk, projector, extension popup), design for that target's real size and viewing distance.

**UX-05 · SHOULD** — Consistency beats creativity. Reuse patterns, spacing, components.

**UX-06 · SHOULD** — Controls must not move under the user. Don't let content length resize or reposition a control someone needs to click.

**UX-07 · SHOULD** — Persist what the user adjusted (position, size, chosen options) so they don't have to redo it next session.
