---
id: D1038
title: A choose runs the first true branch, and a branch that cannot be read runs nothing
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/automation/step-runner.ts
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/codegen.ts
  - packages/types/src/automation/trace.ts
  - packages/types/src/automation/when-site.ts
  - packages/addon-admin-ui/src/pages/build/automation/ChooseFields.tsx
  - packages/addon-admin-ui/src/pages/build/automation/choose-model.ts
---

## Context

A step could carry one condition and one else list (D1037 and the step guard
before it). "If it is night do this, if somebody is home do that, otherwise do
a third thing" needed either three guarded steps whose conditions had to be
written as each other's negation, or a script block.

## Decision

- **`choose` is one step of the automation list** with up to six branches
  (`CHOOSE_BRANCHES_MAX`), each a condition tree and a list of steps, and an
  optional else list. The branch conditions are the same `when` trees a step
  guard takes, read by the same evaluator.
- **Branches are read in order and the first true one runs, alone.** A later
  branch that is also true does not run. When none is true the else list runs;
  with no else list the step is `skipped` with `not run: no branch is true`.
- **A branch whose condition cannot be read ends the choice.** Nothing runs:
  not that branch, not a later one, not the else list (D49: a fallible read
  never decides to do work). The step is `skipped`, its message names the
  branch and the reason, and the run goes on with the next step, exactly as an
  unreadable step guard does.
- **A branch holds plain steps only**: wait, capability call, run an action,
  set, stop. No condition of their own, no code, no `choose` inside a `choose`.
  The issue allows two levels of block steps; the second level is deferred to
  the change that adds the next block step, where the depth check is written
  once for all of them. (Done in D1043: a branch may now hold one more level
  of block steps.)
- **A stop or a failure inside a branch is the run's.** A `stop` ends the run
  from inside a branch; a step that fails ends the run unless it is marked
  "continue if this fails", in which case the branch goes on (D1037).
- **The trace keeps one row per list step.** The `choose` row carries which
  list ran (`branch`: `branches.<n>` or `else`), what each condition read
  before the choice was made (`branchChecks`) and the outcome of the steps of
  the list that ran (`steps`). The editor shows the branch and those steps
  under the step.
- **The stored if / else of a step is left as stored.** It behaves as a
  one-branch choose, and nothing converts it: no migration, and the editor
  keeps showing it as a condition on the step.

## Consequences

- An automation that grew three guarded steps can be one step whose branches
  cannot both run.
- An unreadable sensor in branch 1 disables the whole choice for that run. This
  is deliberate: falling through to branch 2 or to the else list would run
  work on the strength of a read that failed.
- Known gaps, shared with the else list that existed before: the save-time unit
  stamping and the command-line tool's template vetting do not walk the steps
  inside a branch, and the command-line questionnaire does not offer `choose`
  (a recipe that contains one is still checked against the site when saved).

## Enforcement

- `packages/types/src/automation/__tests__/step-runner.spec.ts` — order, first
  match, unknown runs nothing, else, the branch bound and the plain-step rule.
- `packages/types/src/automation/__tests__/generated-block.spec.ts` — the
  generated block runs one branch end to end.
- `packages/addon-admin-ui/src/pages/build/automation/__tests__/choose-model.spec.ts`
  and `ActionList.flow.spec.tsx` — the editor offers the step only in an
  automation list, stops at six branches and keeps the last one.
