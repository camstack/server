---
name: camstack-docs
description: Keep CamStack documentation true after a change — what is generated and must never be hand-edited, what prose to write, ADRs, and the docs check.
---

# Keeping the docs true

Anything derivable from the repository is **generated**. Your job is prose.

## Never edit (regenerated)

| File | Derived from |
| --- | --- |
| `docs/reference/packages.md` | workspace manifests |
| `docs/reference/addons.md` | `camstack.addons[]` |
| `docs/reference/capabilities.md` | `*.cap.ts` |
| `docs/reference/guards.md` | `scripts/check-*` + CI |
| `docs/reference/subsystems.md` | `docs/subsystems.yaml` × workspace × frontmatter |
| `docs/reference/api.md` | caps + Zod shapes |
| `docs/decisions/index.md` | ADR frontmatter |

Pre-commit regenerates them; CI fails on drift. Do not restate table facts in
prose. Regenerate by hand with `npm run docs:generate`. A generated file that
conflicts in a rebase is never hand-merged: take either side, regenerate,
stage.

## Hand-written index

`docs/subsystems.yaml` — chapter list. Touch when adding a subsystem, not when
adding one more file to one.

## Frontmatter: `covers` vs `applies-to`

- **`applies-to:`** — verified against these files on `last-verified` (arms
  staleness).
- **`covers:`** — describes these files (no staleness arm). For class-level
  pages with many implementers.

## What to write (stop at first yes)

1. Learned something expensive? → append `../planning/sessions/<YYYY-MM>.md` (sibling clone of github.com/camstack/planning; include wrong turns).
2. Chose between real alternatives? → new `docs/decisions/` record from
   `template.md`. State a violable rule; put the failure in Context.
3. Changed how a whole subsystem behaves? → matching `docs/architecture/*.md`.
4. Package-local traps? → that package's `AGENTS.md` (`CLAUDE.md` beside it
   is a one-line `@AGENTS.md` import), or its notes page under `docs/addons/`.
5. Repo-wide rule? → root `AGENTS.md`, one line, + prefer a guard in `scripts/`.

A decision record takes the next free number (`docs/decisions/conventions.md`),
is copied from `docs/decisions/template.md`, and is never edited once accepted
— supersede it instead.

## Verify

```bash
npm run docs:check
```

Dead paths fail. Staleness warnings are reported, not failed.

## Do not

- Restate a generated table.
- Leave orphaned comments describing deleted behaviour.
- Add an architecture page for one addon.
- Manufacture a decision with no rejected alternative.
