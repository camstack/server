# CamStack server docs

Everything here describes **this repository as it is now**. Two kinds of page, and
the difference matters:

**Generated** — derived from the workspace on every commit. Never edit these; the
pre-commit hook overwrites them and CI fails on drift.

| Page | What it answers |
| --- | --- |
| [reference/packages.md](reference/packages.md) | every package, its role, and how its code reaches a node |
| [reference/addons.md](reference/addons.md) | every addon manifest, its category and process group |
| [reference/capabilities.md](reference/capabilities.md) | every `*.cap.ts` and who declares it |
| [reference/guards.md](reference/guards.md) | what the repo refuses to let you commit |
| [reference/storage.md](reference/storage.md) | every SQLite table and the file that owns it |
| [reference/subsystems.md](reference/subsystems.md) | what this system consists of, chapter by chapter, and which parts no document describes |
| [reference/coverage.md](reference/coverage.md) | the same, per unit of code: who claims it and when they last checked |
| [reference/api.md](reference/api.md) | every capability method — tRPC path, kind, auth, resolved input/output |
| [reference/api-schemas.md](reference/api-schemas.md) | every named Zod schema the API references, defined once |
| [decisions/index.md](decisions/index.md) | the decision log |

The subsystem index is the map to start from when you do not yet know **where**
something lives. Its one hand-written input is
[`subsystems.yaml`](subsystems.yaml) — the chapter list, which nothing can
derive; everything else on that page is a join over the workspace.

**Hand-written** — reasoning, which cannot be derived. Guarded mechanically: every
repo path mentioned must resolve.

| Page | Start here if… |
| --- | --- |
| [architecture/overview.md](architecture/overview.md) | you are new, or returning after a while |
| [architecture/transport.md](architecture/transport.md) | a capability call is not reaching its provider |
| [architecture/capabilities.md](architecture/capabilities.md) | you are adding or changing a capability |
| [architecture/addon-lifecycle.md](architecture/addon-lifecycle.md) | an addon will not start, or keeps restarting |
| [architecture/data-planes.md](architecture/data-planes.md) | you are touching frames, decode or streaming |
| [architecture/testing.md](architecture/testing.md) | a spec times out under load, or you add a timing-bound spec |
| [architecture/device-model.md](architecture/device-model.md) | you are writing a device provider |
| [architecture/records.md](architecture/records.md) | you are persisting an addon's own facts, a list of entries, or a credential in a row (`ctx.records`) |
| [architecture/notifications.md](architecture/notifications.md) | you are touching rules, the outbox, attachments or notifiers |
| [architecture/logging.md](architecture/logging.md) | you are touching log destinations, the log buffer, `logs.query` or the log viewer |
| [architecture/object-detection.md](architecture/object-detection.md) | you are tuning a threshold, or a detection feature looks "not implemented" |
| [architecture/detection-execution.md](architecture/detection-execution.md) | you are touching engines, pools, step dispatch, or the frame→result path |
| [architecture/inference-devices.md](architecture/inference-devices.md) | you are asking which accelerator ran a camera, or why one did not |
| [architecture/post-analysis.md](architecture/post-analysis.md) | you are touching tracking, the confirmation gate, media capture, or their knobs |
| [architecture/osd-manager.md](architecture/osd-manager.md) | you are changing camera overlay sources, recognition refresh or configuration copying |
| [architecture/benchmark.md](architecture/benchmark.md) | you are changing the Benchmark Admin tool, capacity ramp, or bench actions on pipeline-runner |
| [architecture/terminal.md](architecture/terminal.md) | you are changing terminal profiles, PTY routing or Terminal cameras |
| [architecture/update-and-release.md](architecture/update-and-release.md) | your change does not seem to be running |
| [architecture/deploying.md](architecture/deploying.md) | you are running this on a machine — Compose or Unraid |
| [architecture/unraid.md](architecture/unraid.md) | you are installing, updating or packaging for Unraid |
| [architecture/ui.md](architecture/ui.md) | you need the Admin UI's architecture: mounting, data flow, where a settings schema lands |
| [addons/](addons/) | you are changing one of the addons whose package notes outgrew its `AGENTS.md` (the `AGENTS.md` links here) |
| [ui/](ui/README.md) | you are BUILDING UI in either client: components, tokens, page patterns, anti-patterns (the `camstack-ui` skill applies them) |
| [decisions/](decisions/conventions.md) | you want to know *why*, or you want to change a rule |
| the private planning repo | what was already tried, the backlog, or an idea not yet scheduled |

## How this stays true

`scripts/docs-generate.ts` writes the generated pages and
`scripts/gen-api-reference.ts` the two API ones.
`scripts/check-docs-drift.ts` checks the hand-written ones for dead repo paths and
for `applies-to` / `covers` globs that match nothing.
`scripts/check-subsystem-map.ts` checks that no chapter describes deleted code and
that no source file is in no chapter. All run in `.husky/pre-commit` and in CI via
`npm run docs:check`.

Two frontmatter keys, and they mean different things ([D145](decisions/adr-0145.md)):
`applies-to` says *"I verified this page against these files"* and arms the
staleness ratchet; `covers` says *"this page describes these files"* and arms
nothing. Use `covers` for a page describing a class many units implement.

Doc **staleness** — a page whose `last-verified` predates the last commit to the
code it declares in `applies-to` — is *reported*, never failed. Requiring a doc edit
to land an unrelated commit is what killed the previous documentation. The rationale
is [D19](decisions/adr-0019.md).

```bash
npm run docs:generate   # rewrite the generated pages
npm run docs:drift      # check prose (dead paths, applies-to globs, staleness)
npm run docs:check      # both, as CI runs them
```

## History, not documentation

These are accurate **to their date**. Do not treat them as current:

- `design/` — point-in-time design documents. Two are exceptions and are still
  required reading, linked from the architecture pages:
  [transport-and-cross-node-routing.md](design/transport-and-cross-node-routing.md)
  and [decode-path.md](design/decode-path.md). Because of those two, this
  directory **is** drift-checked; the purely historical documents in it carry
  `<!-- drift-ok -->` markers.

Working specs, plans and handovers are not in this repository. They live in the
sibling planning repo under `superpowers/`, `.superpowers/` and `archive/`.

## Planning is private

The session diary, the backlog, unscheduled ideas, and working notes
(superpowers specs and plans, archive handovers, agent run ledgers) are not in
this repository. Clone <https://github.com/camstack/planning> as a sibling of this
checkout (`../planning` from the repository root). A git worktree's parent is
still inside this repo, so that sibling sits next to the main checkout, not
next to the worktree. Append a lesson with
`cat >> ../planning/sessions/<YYYY-MM>.md`. The backlog is the board
<https://github.com/orgs/camstack/projects/1>, which replaced the roadmap file.

## The public docs are elsewhere

User-facing documentation lives in **<https://github.com/camstack/docs>** (local
clone: `../docs/`), a Next.js + fumadocs site that also bundles the
`@camstack/ui-library` Storybook under `/storybook/`. This directory is for
people working **on** the server.

Each public page can name the server code it describes in its frontmatter
(`applies-to:` / `covers:` / `last-verified:`, the same keys as here, globs
relative to this repo). `npm run docs:public-stale` lists the pages whose code
changed after they were verified — a reminder, never a gate (D751).
