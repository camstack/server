---
id: D1037
title: Flow-control steps belong to the automation list, and a failure the run was told to pass over stays visible
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/automation/step-runner.ts
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/codegen.ts
  - packages/types/src/automation/trace.ts
  - packages/addon-admin-ui/src/pages/build/automation/ActionList.tsx
  - packages/addon-admin-ui/src/pages/build/automation/set-vars-model.ts
---

## Context

An automation's action list was a straight line: every step ran, and the first
failure ended the run. An operator who wanted "stop here when nobody is home",
"go on even if the speaker is offline" or "compute this once and use it in the
next three steps" wrote a script block instead, and lost the editor, the save
checks and the per-step run trace. The longest pause was five minutes.

## Decision

- **`stop`** ends the run on purpose: `{ reason, outcome: 'ok' | 'failed' }`.
  The steps after it are traced `not-run` with `stopped at <path>: <reason>`. A
  `failed` stop is a failed run, with the reason as its message; an `ok` stop is
  a run that ran. A stop inside an else list stops the whole run.
- **`set`** writes run variables: `{ vars: Record<name, text | number | boolean> }`.
  Substitution only, never evaluation: a text value may carry `{{vars.x}}`
  slots. The bag is the run's own, so a value never outlives the run or reaches
  another one. The names the run itself owns (`kind`, `leaf`, `at`) are refused,
  as is a name that is not an identifier.
- **`continueOnError: true`** on a `cap` or `action` step lets the run go on
  when that step fails. The step is traced **`failed-continued`** with the
  error, shown red in the editor, and logged as a warning; the run still ends
  as "ran". The flag is stored as the literal `true` or not at all.
- **`wait` lasts up to one hour** (`WAIT_MAX_SECONDS`). A wait is cut when the
  run is restarted (run mode `restart`) or the block stops, and the run is then
  traced `aborted`.
- **Both new steps may carry an `if`**, with no else: a condition that is false
  or cannot be read means the step does nothing.
- **`stop`, `set` and `continueOnError` exist only in an automation's own
  list** (`AutomationActionSchema`). The shared `ActionStepSchema` (standalone
  actions, scheduler points, fan presets) keeps `wait` and `cap`: those lists
  are called from several places and return one result to their caller, and a
  step that ends or half-fails the caller's run is a contract none of them has.
  The editor offers the new steps only where the list is an automation's
  (`flowControl`).

## Consequences

- A hub that crashes during a wait leaves no trace of that run: the trace is
  written when a run ends. A clean stop traces it `aborted`.
- A one-hour wait in run mode `queue` holds the queue for that hour.
- The command-line tool's guided automation flow keeps its own, stricter step
  schema (wait up to 300 s, no stop or set).
- The next steps of planning#500 (`choose`, `wait-until`, `repeat`, `parallel`)
  build on the same runner contract: a step asks the scope to stop, and every
  step leaves a trace row with an outcome and a reason.

## Enforcement

`step-runner.spec.ts` ("flow control", "flow-control schema": stop, continued
failure, the refusals and their sentences, the standalone list unchanged),
`generated-block.spec.ts` ("flow control (#500)": the generated block),
`ActionList.flow.spec.tsx` and `set-vars-model.spec.ts` (the editor, and its
absence outside an automation), `trace-view.spec.ts` (a continued failure is red).
