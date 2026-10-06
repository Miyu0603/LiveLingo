---
applyTo: "**/*.tsx,**/*.jsx,**/*.vue,**/*.svelte,**/*.html,**/*.css"
---

# Accessibility Rules

Applies to any markup or styling, not just React.

**A11Y-01 · MUST** — Use semantic HTML. Buttons are `<button>` (not clickable `<div>`), inputs have associated `<label>`, headings are ordered and meaningful.

**A11Y-02 · MUST** — Everything works with the keyboard. All interactive elements reachable by Tab, focus is visible, no keyboard traps.

**A11Y-03 · SHOULD** — Meet WCAG AA color contrast for text and essential UI.

**A11Y-04 · SHOULD** — Provide text alternatives: alt text for images, aria-label for icon-only buttons, empty alt for decorative images.

**A11Y-05 · SHOULD** — Never rely on color alone. Pair color with text, icon, or pattern (errors, status, charts).
