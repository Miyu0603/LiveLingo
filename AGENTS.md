# AGENTS.md

## Product Builder Engineering Rules — Core

Version: 1.2

> Single source of truth for always-on engineering rules.
> Read by VS Code (GitHub Copilot) directly, and by Claude Code via `@AGENTS.md` in CLAUDE.md.
> Stack-specific rules live in path-scoped files (see end of this document).
>
> **This core file must stay stack-agnostic** — it applies to a Next.js app, a Chrome
> extension, a CLI, or a Python service alike. Anything that names a specific language,
> framework, or vendor belongs in a path-scoped file, not here.

---

## Mission

Build products that solve real user problems.

Priorities:

1. Correctness
2. User Experience
3. Maintainability
4. Security
5. Performance
6. Development Speed

Never optimize for clever code. Optimize for shipping valuable products.

---

## How to read these rules

Every rule has an ID and a severity:

```
MUST   Non-negotiable. Violating it is a defect. Block or fix.
SHOULD Strongly recommended. To break it, state why in the PR or a comment.
MAY    Use when it fits.
```

When rules conflict, resolve by the Mission priority order:

```
Correctness > UX > Maintainability > Security > Performance > Speed
```

Reference rules by ID in reviews and commits, e.g. "violates DEV-02".

---

## PRODUCT FIRST

**PB-01 · MUST** — Before implementing, state `User / Problem / Value`. If value can't be explained clearly, stop and ask.

**PB-02 · SHOULD** — Avoid feature bloat. Ask "can users reach their goal without this?" If yes, backlog it.

**PB-03 · SHOULD** — Prefer MVP (simple, understandable, deployable) before scalable/extensible/enterprise-grade, unless explicitly required.

---

## REQUIREMENT ANALYSIS

**REQ-01 · MUST** — Before coding, provide **Understanding** (what), **Plan** (how), **Risks** (unknowns/assumptions).

**REQ-02 · MUST** — Never invent requirements. When unclear, ask. Do not guess.

**REQ-03 · MUST** — Define acceptance criteria before building.

**REQ-04 · MUST** — Capture non-functional requirements early: scale, performance, security/privacy, availability, compatibility. These decide the architecture.

---

## SYSTEM DESIGN

**ARCH-01 · SHOULD** — Feature-first folders (`app/ components/ features/ lib/ services/ hooks/ types/`). Avoid giant folders.

**ARCH-02 · MUST** — Business logic never lives in UI. Flow: `UI → Service → Repository → Database`.

**ARCH-03 · SHOULD** — Keep files focused: components < 300, hooks < 200, services < 300 lines. Split large files.

**ARCH-04 · MUST** — Data shapes are contracts. Define them explicitly at every boundary (user input, API response, storage) and validate against them instead of assuming. Language-specific guidance lives in the stack rules (e.g. `typescript.md`).

**ARCH-05 · SHOULD** — For hard-to-reverse decisions (DB, core framework, auth model), write a short ADR: `Context → Options → Decision → Why`.

---

## SECURITY

**SEC-01 · MUST** — Secrets in env vars only. Never commit them, expose them to the client bundle, or log them. Separate config per env (dev/staging/prod).

**SEC-02 · MUST** — Authenticate AND authorize on the trusted side (server, or whatever you control) for every protected route, endpoint, and privileged operation. Checks that run in code the user can modify are UX, not security. *If the project has no backend, record where the real trust boundary is instead.*

**SEC-03 · MUST** — Least privilege everywhere. Admin or elevated credentials never reach client-side code.

**SEC-04 · MUST** — Do not invent your own crypto or auth. Use vetted platform auth and standard libraries.

**SEC-05 · MUST** — Prevent injection and unsafe output: parameterized queries/ORM (never string concat), escape output (XSS), validate redirects.

**SEC-06 · SHOULD** — Rate-limit public, expensive, abusable endpoints (auth, uploads, AI generation).

**SEC-07 · SHOULD** — Keep dependencies healthy: pin versions, audit, patch known CVEs.

**SEC-08 · SHOULD** — Where the project has server-side sessions or form posts, protect them: HttpOnly+Secure cookies, CSRF protection, sensible security headers.

---

## AI OUTPUT SAFETY

**AI-01 · MUST** — AI output is always untrusted. Validate format, structure, and content before use.

**AI-02 · MUST** — AI failures must be recoverable. Never allow blank screens, unhandled responses, or silent failures.

**AI-03 · SHOULD** — Show progress feedback (Thinking… / Generating… / Analyzing…) for slow operations.

---

## CODING

**DEV-01 · MUST** — Names are documentation. Avoid `data/tmp/item/value`; prefer `invoiceRows`, `patientRecords`, `billingSummary`.

**DEV-02 · SHOULD** — Prefer early return; reduce nesting.

**DEV-03 · SHOULD** — Delete dead code. Git stores history.

**DEV-04 · SHOULD** — Comments explain WHY, not WHAT.

**DEV-05 · SHOULD** — Don't over-abstract. Rule of Three: 1st duplicate → 2nd observe → 3rd extract.

---

## ERROR HANDLING

**ERR-01 · MUST** — Never swallow errors. Handle, wrap-and-rethrow, or log — never an empty catch.

**ERR-02 · MUST** — Validate all external input: forms, CSV, APIs, query params, env vars.

**ERR-03 · MUST** — User-facing errors are understandable and actionable. Never leak stack traces or sensitive detail.

---

## OBSERVABILITY & LOGGING

**OBS-01 · MUST** — Log key flows with structure and context (request id, user id where safe). Never log secrets or PII.

**OBS-02 · SHOULD** — Send errors to monitoring with enough context to diagnose without a repro.

**OBS-03 · SHOULD** — Metrics and alerts on critical paths. Learn about outages before users report them.

**OBS-04 · MAY** — Trace slow/costly operations (AI calls, heavy DB queries).

---

## TESTING

**TEST-01 · MUST** — Test behavior, not implementation details.

**TEST-02 · MUST** — For every feature verify: Success, Failure, Empty, Edge Case.

**TEST-03 · MUST** — Bug fix workflow: Reproduce → Write test → Fix → Verify.

**TEST-04 · SHOULD** — Follow the test pyramid: many unit, some integration, few e2e.

**TEST-05 · SHOULD** — CI must pass before merge (tests + linter + type check + format). A red build does not merge.

---

## GIT

**GIT-01 · MUST** — One commit = one logical change.

**GIT-02 · SHOULD** — Separate feature / refactor / fix when possible.

**GIT-03 · MUST** — Commit messages explain why.

---

**GIT-04 · MUST** — Before the first commit, create a `.gitignore` that covers: `.env*`, `node_modules/`, build output (`.next/` etc.), and any credential files (`*.pem`). Never commit secrets even accidentally.

---

## DEPLOYMENT

**SHIP-01 · MUST** — Code review before merging to main. Review design, readability, security, tests — not just "does it run".

**SHIP-02 · MUST** — `main` is always deployable. Develop on branches, merge via PR.

**SHIP-03 · SHOULD** — Ship through staging before prod. Have a tested rollback path.

**SHIP-04 · SHOULD** — Keep environments separated and reproducible (dev/staging/prod).

**SHIP-05 · MAY** — Track tech debt explicitly as backlog items.

---

## SELF REVIEW

Before finishing, ask:

```
Does it work?            (Correctness)
Is it understandable?    (Maintainability)
Is it secure?            (authN/authZ, secrets, input)
Is it accessible?        (keyboard, semantics, contrast)
Are all states handled?  (Loading / Empty / Error / Success)
Is it necessary?         (Product value)
```

If any answer is no, improve it.

---

## REQUIRED RESPONSE FORMAT

For all implementation tasks:

```
Understanding · Plan · Implementation · Risks · Validation · Next Steps
```

---

## FINAL RULE

Do not write code immediately.

```
Understand first. Plan second. Build third. Review fourth. Ship last.
```

---

## Stack-specific rules (path-scoped)

Each file declares the globs it applies to and loads only when you touch a matching file.
**Copy only the ones a project actually needs** — an unused file is harmless (its globs never
match) but it is clutter.

| Rule file | Applies to | Copy it when |
|---|---|---|
| `ui-ux.md` | `tsx jsx vue svelte html css` | the project has any UI — **almost always** |
| `accessibility.md` | `tsx jsx vue svelte html css` | the project has any UI — **almost always** |
| `typescript.md` | `ts tsx` | the project uses TypeScript |
| `tailwind.md` | `tsx jsx vue svelte html` + config | the project uses Tailwind |
| `nextjs.md` | `app/ src/` `ts tsx` | the project is Next.js |
| `supabase.md` | `ts`, `supabase/`, `migrations/` | the project uses Supabase / a SQL DB |
| `browser-extension.md` | `manifest.json`, `background.js`, `content.js`, … | the project is a browser extension |

Two copies of each exist because the two tools read different locations:

- **Claude Code** → `.claude/rules/<name>.md`
- **VS Code / GitHub Copilot** → `.github/instructions/<name>.instructions.md`

Keep the pair in sync when editing a rule.

> Note on globs: `ui-ux.md` and `accessibility.md` used to be scoped to `**/*.tsx` only, which
> meant they silently never loaded on plain HTML/JS projects even though they fully apply
> there. If you add a new rule file, check its globs against a non-React project before
> assuming it works.
