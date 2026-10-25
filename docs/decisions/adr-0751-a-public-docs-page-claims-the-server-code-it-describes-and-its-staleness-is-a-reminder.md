---
id: D751
title: A public docs page claims the server code it describes, and its staleness is a reminder, never a gate
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - scripts/check-public-docs-staleness.ts
  - scripts/lib/public-docs-staleness.ts
---

## Context

The public site lives in its own repository (`camstack/docs`, Next.js +
fumadocs, pages under `content/docs/**.mdx`). The internal drift guard
(`scripts/check-docs-drift.ts`, D145) only reads this repository's markdown, so
nothing connected a public page to the code it explains.

On 2026-10-07 the server landed a day of model and inference work: CoreML
packages replaced in place (D742, D743), f32 IRs on an Intel GPU (D740),
model-bound per-model floors (D738, D739), root-supplied classifiers (D736),
Model Studio's Installed tab rebuilt (D746). The public pages for models,
inference engines, hardware acceleration, enrichments, Model Studio and the
benchmark were written the day before and described none of it. Nobody was
told, because no check knew those pages existed. The pages were found only
because the operator happened to read them.

Two shapes were considered and rejected:

- **A gate** in the commit hook or CI, like the internal ratchet. The public
  repo is a separate checkout that CI does not have, so a gate there would be
  either skipped (and read as passing) or red on every runner. And a gate makes
  a server commit wait on prose in another repository, which is the treadmill
  D19 exists to avoid.
- **One page-to-package table** kept in this repo. It would be a second index
  beside `docs/subsystems.yaml`, owned by nobody who edits the page, and it
  would rot the way every hand-kept list here has rotted.

## Decision

A public page declares in its own frontmatter the server code it describes,
with the same keys and meaning as an internal page (D145): `applies-to:` for
code the page was verified against (arms the reminder), `covers:` for code it
merely describes, plus `last-verified:` (`YYYY-MM-DD`, or an ISO datetime with
offset when a day is too coarse). Globs are relative to camstack-server; a
`camstack/…` glob names the viewer and is judged in the viewer's own history.
The fumadocs page schema (`source.config.ts` in the docs repo) validates the
three keys.

`npm run docs:public-stale` (`scripts/check-public-docs-staleness.ts`) lists
the pages whose `applies-to` code has non-release commits newer than
`last-verified` (or than the page's last commit, without one), with those
commits; the pages that claim nothing (coverage gap); and claimed globs that
match no tracked file (dead). It is a **reminder**: exit 0 always, `--strict`
for a caller that wants a failure. It finds the docs checkout through
`CAMSTACK_DOCS_DIR` or the sibling `../docs`, and says so and exits 0 when
there is none. It is read at the end of a piece of work, from the `sync-docs`
skill — never from the commit hook and never from a workflow.

A page's own commits never count as verifying it. Seeding `last-verified` with
the page's last commit date records when it was written, not a check against
the code; bump it only after reading the page against the code.

## Consequences

- A page with no claim is invisible to the reminder, and the report lists it
  as a gap so the hole is visible. Seeded on 2026-10-07 for the detection,
  tools, cluster and notifications index pages; the rest are open.
- A claim that is too broad makes a page permanently suspect and the list
  stops being read. Claim the files the page actually explains, not the
  package it lives in; use `covers:` for a class-level page.
- The reminder can only be as current as the local checkouts: a stale `../docs`
  or an unpopulated viewer submodule reports against what is on disk (a viewer
  glob with no viewer checkout is reported as unverifiable, not as fine).
- Release commits (`chore: publish packages`, `chore(release): publish`,
  `chore: bump version to`) are skipped, as in `lastCommitDate`.

## Enforcement

Nothing blocks, by design. `scripts/__tests__/check-public-docs-staleness.spec.ts`
proves stale detection, the `covers:` / `applies-to` split, the coverage gap,
dead globs, viewer globs and the missing-checkout skip against throwaway
repositories. The fumadocs schema refuses a malformed `last-verified` at build
time. Whether anyone reads the list is review only, via the `sync-docs`
checklist.
