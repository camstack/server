---
name: camstack-workflow
description: Load FIRST for ANY change to CamStack — implement, fix, add, change, refactor or build a feature, bug fix, UI, server, addon or capability; invocable as /camstack-workflow. The single entry point and definition of done — the phases (understand, design, plan, build with TDD, verify, document, ship, report), the gate each one must pass and the evidence it must show, which domain skill supplies the details, and how it composes with the superpowers process skills (brainstorming, writing-plans, test-driven-development, verification-before-completion). Load again at plan, verify and done.
---

# CamStack workflow — from request to done

This skill sets **what** a change in this repository must show before it is
done: the gates, the commands, the evidence. The domain skills hold the
details; the superpowers process skills, when installed, set **how** to
brainstorm, plan, test and verify. Nothing here replaces either: it is the
checklist they are run against.

## 0. When to load it

| Moment | Why |
| --- | --- |
| Before anything else — before `superpowers:brainstorming` | to load the gates the design and plan must answer |
| When the plan is written | the plan must carry the repo checklist (§3) |
| Before claiming verified | the evidence list (§5) |
| Before "done" | the definition of done (end of this file) |

## Who does the work — model routing

Tokens are a budget. The coordinating session keeps the phases that need
judgment — understand, design, plan, review, report — and hands everything
else to a smaller / cheaper model through a project agent, which preloads
the right skills so it does not rediscover the rules.

**Pick the model for the JOB and the HARNESS — never pin one vendor for
everything.** Claude Code agent frontmatter uses Claude family names;
Cursor's `Task` tool uses the slugs in that turn's `available_subagent_models`
catalog (often `composer-2.5-fast` + `inherit`). Do not invent a slug; if
the catalog has no cheap model, use `inherit`.

| Work | Agent (`.claude/agents/`) | Claude Code | Cursor `Task` `model` |
| --- | --- | --- | --- |
| Building an approved plan: server, system, addon, capability | `camstack-implementer` | sonnet | cheapest non-`inherit` in catalog (today: `composer-2.5-fast`) |
| Any UI implementation | `camstack-ui-engineer` | sonnet | same cheap slug; coordinator (`inherit`) looks at `ui:shots` PNGs |
| Red CI, failing or flaky test, TS7 typecheck over the pins | `camstack-test-fixer` | sonnet | cheapest non-`inherit` |
| Regenerated docs, `docs:check`, a sessions entry from given facts | `camstack-docs-writer` | haiku | cheapest non-`inherit` |
| A live symptom whose logs and API dumps would flood the coordinator | `camstack-diagnostician` | opus | `inherit` (chat model) |
| Code review after a task | `code-reviewer` / Bugbot | (harness default) | `inherit` |

- **Never `general-purpose` for camstack work** — it starts without the
  repo rules. If no agent fits, name the skills it must load first and pass
  an explicit model from the table above (Claude: `sonnet`; Cursor: the
  cheap catalog slug or `inherit`).
- Pure implementation is never done by the coordinator's own model.
  Exception: an edit of a few lines that costs less than writing its brief.
- A brief carries exact paths, the acceptance check, "do not push", and a
  report cap (≤ 25 lines). Results are conclusions, not file dumps.
- One or two agents at a time, each in its own worktree when it commits.
  Do not repeat a search you delegated, and never re-read what an agent
  already summarised.
- Reading costs too: the Token budget below. Excerpts over whole files;
  filtered command output over full logs.

### Token budget

Repo knowledge comes from the `camstack-dev` MCP: `search_knowledge`, then
`read_section` on the returned id. Also `decisions_for_path`, `get_decision`,
`traps_for`, `guards_for`, `find_example`, `who_provides`, `get_capability`,
`subsystem_of`. The next ADR number is `next_adr_number`. Do not open a whole
architecture page.

- Never open the planning session index. Append to the current month file
  (private diary, sibling of the main checkout): `cat >> ../planning/sessions/<YYYY-MM>.md`.
- Never read `docs/reference/*.md`, `docs/decisions/index.md`,
  or an i18n JSON whole. Add a key with
  `npm run i18n:set -- <dotted.key> "<en>" "<it>"` (`i18n:get`, `i18n:keys`).
- A file over ~60 KB: grep the symbol and read ±80 lines.
- Filter command output (`tail`, `grep`, `head`) before it enters context.

**Scoped gate.** A worker runs `npx tsx scripts/typecheck-tsgo.ts <pkg>…` on
packages it touched, `vitest related --run <files>`, `npm run ui:check` on
touched UI, the guards the change names, and `npm run codegen` when a
`*.cap.ts` changed. The coordinator runs `npm run verify:push` once per batch.
A worker does not.

Cursor also has `.cursor/rules/camstack-model-routing.mdc` (always on).

## Phases at a glance

| # | Phase | Gate (what you must be able to show) | Details |
| --- | --- | --- | --- |
| 1 | Understand | the real behaviour, observed — not a theory | `camstack-diagnose` |
| 2 | Design | an approved design; viewer layout co-designed | `superpowers:brainstorming` or §2 |
| 3 | Plan | a plan carrying the repo checklist | `superpowers:writing-plans` + §3 |
| 4 | Build | a discriminating test that failed first, then the real build | `superpowers:test-driven-development`, `camstack-server-change`, `camstack-addon`, `camstack-capability`, `camstack-secrets`, `camstack-ui` |
| 5 | Verify | test + build output, live proof by toggling, UI shots | `superpowers:verification-before-completion`, `camstack-diagnose`, `camstack-ui` |
| 6 | Document | docs true, `docs:check` green, ADR only for a real choice | `camstack-docs` |
| 7 | Ship | committed to main with explicit paths; published/deployed and named | `camstack-publish-ci`, `camstack-hub-image-deploy`, `camstack-addon` |
| 8 | Report | what changed, the evidence, what is still open | §8 |

Skills live in `.claude/skills/<name>/SKILL.md`; any harness can open the file.

## 1. Understand

- A live symptom → `camstack-diagnose` first: what is running, which log tier
  still holds the window, where the work actually ran.
- **Instrument before guessing.** When two causes fit, add the log line or the
  probe that tells them apart; one hypothesis at a time. With superpowers, a
  bug runs through `superpowers:systematic-debugging` — this phase is its
  evidence-gathering step.
- Read the real code path end to end before proposing anything (root
  `AGENTS.md`, "Working style").

## 2. Design

**With superpowers:** run `superpowers:brainstorming` (spike / bounded /
architectural). Its architectural path ends in `superpowers:writing-plans` and
nothing else — that is fine: you loaded this skill before brainstorming, so
the gates already shape the design, and you come back here at plan time.

**Without it (Cursor, Codex, or by choice), the short version:**

1. Read enough code and docs to ask only what they cannot answer.
2. Ask the decisions that matter (rules below).
3. Present 2–3 options with trade-offs and a recommendation.
4. Get the operator's approval before building anything user-visible.

**Viewer layout changes are always co-designed with the operator** — describe
before/after and wait (`camstack-ui-viewer`).

### Ask with the harness's question tool, not chat text

Every question to the operator is a native, selectable prompt:

| Harness | Use |
| --- | --- |
| Claude Code | `AskUserQuestion` — 1–4 questions per call, 2–4 options each, the recommended option first with "(Recommended)" in its label; previews for visual choices ([docs](https://code.claude.com/docs/en/tools-reference#askuserquestion-tool-behavior)) |
| Cursor | the `AskQuestion` tool ("Ask questions" in [Agent tools](https://cursor.com/docs/agent/tools)) — reliably offered in **Plan mode** (Shift+Tab in the chat input, or the mode picker; [Plan mode](https://cursor.com/docs/agent/plan-mode)). In Agent mode it depends on the model and surface: some models, and Auto routing to them, get no picker |
| Codex | `request_user_input` — in the **Plan** collaboration mode ([template](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md)); in the default mode only with `default_mode_request_user_input = true` (Codex 0.106+, [#10384](https://github.com/openai/codex/issues/10384)) — the operator's setting, never change it yourself |
| None of these available | a numbered list of options with the recommendation marked, then **STOP and wait** for the answer |

- One decision per question; 2–4 mutually exclusive options; the
  recommendation first.
- Batch at most 4 related questions in one prompt.
- Never ask what the code, the docs or a read-only probe can answer.
- When `superpowers:brainstorming` runs, this overrides its plain-text
  questions: its "one question at a time" becomes "one question per native
  prompt".

## 3. Plan — the repo checklist every plan carries

When `superpowers:writing-plans` runs, tell it to include these under the
plan's **Global Constraints** and to give each task its own lines; without
superpowers, write them at the top of your plan:

- **Tests that prove it** — which spec, in which package, fails on the old
  code (§4).
- **Live verification that proves it** — which node, which call or log line,
  and the toggle that shows cause and effect (§5).
- **Screens** — every UI route touched, with before/after `ui:shots` (§5).
- **Docs and ADR** — which pages change; ADR only if a real alternative was
  rejected (`camstack-docs` §3).
- **Ship** — what must be published (which packages) and deployed (addon
  `camstack deploy`, server closure `applyServerUpdate`), or "nothing ships".

## 4. Build with TDD

With superpowers: `superpowers:test-driven-development`. The repo rules on
top of it:

- **The test must discriminate**: it fails on the old code for the reason
  the change exists. For a migration, mark a field in the fixture and assert
  it survived — a copy test that passes on an empty target proves nothing.
- **Fix the implementation, not the test**, unless the test is wrong — and
  then say why.
- When you fix a gate, remove the fix and watch the test fail (a fake once
  supplied the value production forgot to fetch).
- Specs live next to their package's sources (`__tests__/*.spec.ts`), never
  in a shared bucket. Run them:
  - one spec: `npx vitest run <path/to/spec.ts>`;
  - a package: `npm run test -w <package-path>`;
  - repo scripts and guards: `npm run test:scripts`.
  - **real-cluster specs** (several Moleculer brokers over real TCP/TLS) are
    named `*.cluster.spec.ts`, are excluded from `npm run test` and the
    per-push CI, and run in the `test:cluster` lane (`npm run test:cluster`;
    the on-demand Checks `e2e` job). Name a new one that way — a fake-transporter
    or single-broker spec stays a normal unit spec, whatever its name says.
- **A typecheck is not verification.** Use the real build for what you
  touched — the order and the `.d.ts` sweep are in `camstack-server-change` §2.
- Domain details: addon → `camstack-addon`, capability → `camstack-capability`,
  credentials → `camstack-secrets`, UI → `camstack-ui` (+ `-admin` / `-viewer`).

## 5. Verify — evidence before claims

With superpowers: `superpowers:verification-before-completion`. What counts
here:

- **Test output** of the suites you touched, run fresh, with the counts.
- **Build output** of the real build (`camstack-server-change` §2).
- **Live proof** on the running system when behaviour changed
  (`camstack-diagnose`): say WHERE it ran (node, process) and prove it by
  TOGGLING — turn the feature off and on, or trigger the event, and watch the
  effect follow. State that was already there before your change proves
  nothing.
- **UI**:
  - `npm run ui:check -- <every touched UI file>` with 0 new findings;
  - `npm run ui:shots` before and after (below), with the measurement table
    pasted and the shots looked at.

### `npm run ui:shots`

Renders admin-ui routes from workspace source against fixture data (no hub),
shoots light and dark at 1440×900 and 390×844, and measures document and
`<main>` horizontal overflow, elements past the viewport edge, and whether
sticky headers / save bars stay pinned.

```bash
npx playwright install chromium        # once per machine
# BEFORE your first edit (or in a clean worktree of origin/main):
npm run ui:shots -- --route "/system/identity?tab=access" --fixtures access --label before
# … your change …
npm run ui:shots -- --route "/system/identity?tab=access" --fixtures access --label after \
  --compare scratchpad/ui-shots/before
```

- Output: `scratchpad/ui-shots/<label>/` — PNGs, `report.md` (the table to
  paste, with side-by-side paths and regression flags under `--compare`),
  `report.json`. Gitignored: never commit the shots.
- Options: `--theme`, `--viewport 320x640` (repeatable), `--out`, `--port`;
  the full list is in `scripts/ui/shots/lib/args.ts`.
- **Fixtures**: one file per admin area in `scripts/ui/shots/fixtures/`
  (contract in `_define.ts`; `access.ts` is the example). The run lists every
  tRPC path the page asked for that no fixture answers — add those to your
  area's file. Invented data only: documentation IP ranges, `example.com`.
- The viewer is a separate Expo app; the same Playwright measurement could
  run against its web build (`npm run web` in `camstack/`) — not wired yet
  (`camstack-ui-viewer`).

## 6. Document

`camstack-docs`, end to end: regenerate what your change feeds, decide the
prose with its ladder, ADR only for a choice between real alternatives,
the private backlog when it moved, `npm run docs:check` green. A new lesson goes in
`../planning/sessions/<YYYY-MM>.md` (private diary, sibling of the main checkout).
The index is `../planning/sessions/sessions.md`; do not append to it.

## 7. Ship

- **Commit**: explicit paths (`git add <path> …`, never `-A` or `.`),
  conventional commits (`feat:`, `fix:`, `docs:` …), rebase on `origin/main`
  right before pushing, push to `main` (no PRs). Parallel agents each get
  their own worktree — one committer per clone.
- **Main is green before you start.** `gh run list --workflow ci.yml
  --branch main --limit 3`: if the newest finished run is red, fixing it comes
  first (`camstack-test-fixer`), or you tell the operator — never stack a
  push on a red main, the next diff then inherits every failure.
- **Before every push — `npm run verify:push`, GREEN**, run by the coordinator
  once per batch (a worker runs the scoped gate under Token budget, not this).
  It runs exactly the
  CI gates for what you are about to push (merge-base with `origin/main`,
  working tree included): the TypeScript 7 typecheck graded against the pins
  (`scripts/typecheck-tsgo.ts`), the affected tests in CI's lanes and
  workers (`scripts/ci/test-affected.sh`), and `test:scripts` when
  `scripts/` moved. A local `tsc`, `nx affected -t typecheck` or one green
  spec is NOT the CI gate — that gap turned 9 of 13 red runs of 2026-10-12/13
  into "pinned-or-new error(s)" nobody had seen. RED means you do not push.
- **Viewer (`camstack/` submodule) — same rule, before every commit and
  push:** `npm run verify:push` in the viewer checkout (GREEN). It grades the
  changed set against TypeScript Check (`ts-check` + `test:v2` + embed build
  when `embed/` moved + `ui:check` on touched UI files). Details:
  `camstack-ui-viewer`. Do not commit a viewer change on a red
  `verify:push`.
- **After the push — watch your run.** `gh run list --workflow ci.yml
  --branch main --limit 1`, then `gh run watch <id> --exit-status` in the
  background. Red on your sha is yours to fix before any other work. A test
  that fails without its files changing is flaky: hand it to
  `camstack-test-fixer`, never rerun until green.
- **Publish and deploy** through the skills, and say exactly what shipped:
  npm packages through CI → `camstack-publish-ci`; a server closure to nodes
  → `camstack-hub-image-deploy`; an addon → `camstack deploy`
  (`camstack-addon`). `publish ≠ deployed ≠ live`.
- **Never dispatch the Checks workflow** — only the operator does. Run the
  guards you touched locally (`npx tsx scripts/check-<name>.ts`).

## 8. Report

Three parts, short: **what changed** (commits, files that matter), **the
evidence** (test/build output, the live toggle, the `ui:shots` table), **what
is still open** (not shipped, not verified, follow-ups, with the planning-board issue).

## Lessons (one line each)

- Verify empirically, not by theory: run it and read the output.
- Instrument before guessing: add the probe that separates two causes.
- Silence ≠ "never called": a missing log line can be a log tier that forgot.
- A returned `nodeId` is not proof of where the work ran — the work's own log
  on that node is.
- Registry lag after a publish is not a failure: npm can serve the old
  version for minutes (`camstack-publish-ci`).

## Definition of done — paste it, filled in

```
CHANGE DONE — <what>
understand:  <observed behaviour + where (node/process), or "new feature: n/a">
design:      <approved option + date | "bounded, approved in chat">; viewer layout: <no change | agreed on <date>>
tests:       <spec(s) that failed on the old code → now pass; command + counts>
build:       <real build command + result>
live:        <node + what was toggled + effect seen | "no live behaviour changed">
ui:          <ui:check output (0 new) + ui:shots after-vs-before table | "no UI">
docs:        <camstack-docs done-gate | "none needed: reason">; docs:check green
shipped:     <commits on main> · <published packages@versions | deployed to <nodes> | "nothing ships">
pre-push:    <verify:push summary line (GREEN)> · CI run <id> on <sha>: <green | red → fixed by <sha>>
             (viewer change: also `camstack/` `npm run verify:push` GREEN before the viewer commit)
open:        <what is not done or not verified | "nothing">
```

A coordinator checks this block, not the summary. A line you cannot fill is
work that is not done.
