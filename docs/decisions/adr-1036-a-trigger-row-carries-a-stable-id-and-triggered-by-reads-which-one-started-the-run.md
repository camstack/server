---
id: D1036
title: A trigger row carries a stable id, and "triggered by" reads which one started the run — unknown where the run is not told
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/automation/when.ts
  - packages/types/src/automation/condition-eval.ts
  - packages/types/src/automation/step-condition.ts
  - packages/types/src/automation/codegen.ts
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/scheduler.ts
  - packages/addon-admin-ui/src/pages/build/automation/triggered-by-model.ts
---

## Context

An automation with two trigger rows ("the button is pressed", "motion starts")
could not run a different step for each: a step guard saw device state only, so
the operator wrote two automations that shared everything but one step. The run
already knows which row fired — `trigger.leaf` is the row's PATH in the `when`
tree (`when.0.1`) — but a path is a position: moving, wrapping or deleting a
row would silently repoint every guard that named it.

## Decision

- **Every event leaf may carry an `id`** (`EVENT_LEAF_ID_RE`, at most 40
  characters), unique in its tree; `validateWhenTree` refuses a duplicate. The
  id is optional: a tree nobody branches on stores none.
- **`{ kind: 'triggered-by', leafIds: string[] }` is a condition, not a
  trigger.** It passes when the row that started the run carries one of the
  listed ids. It may sit in the rules next to the triggers or in a step guard.
- **The evaluator is told the trigger, or says unknown.** In the rules the
  fired row is the `firedPath` already passed to `evaluateWhenTree`; a step
  guard gets it from the run (`evaluateStepCondition(..., trigger)`), which the
  generated block derives from `vars.leaf` with `eventLeafIdAt`. Where no run
  trigger exists — a hold being observed, the hub-side step-condition door —
  the leaf is `unknown` with its reason, so neither branch is taken on a guess
  and a `not` over it is not trusted.
- **Outside an automation the leaf is refused at save**: a standalone action
  list, a scheduler point or tree, a preset have no trigger rows, so
  `ActionStepSchema` and `SchedulerStateTreeSchema` refuse it with one message.
- **A dangling id is refused by the recipe, not by the tree.**
  `validateRecipeBounds` checks every `triggered-by` (rules and step guards)
  against the ids of the recipe's own trigger rows. `validateWhenTree` cannot:
  it is also called on a step guard alone, where the trigger rows are not in
  sight, and refusing there marked every valid guard as broken.
- **The editor assigns the ids.** `ensureTriggerIds` gives every trigger row an
  id (`t1`, `t2`, …, never reusing one in use) the first time a `triggered-by`
  appears, and changing a row's kind keeps its id. The operator picks rows by
  position and description and never types an id.

## Consequences

A run started by a row with no id (a recipe written by hand) matches no
`triggered-by`: the answer is a definite "no", with the reason on the trace.

Not covered: the row picker still offers the kind in the standalone action and
scheduler editors, where the save then refuses it with the reason.

## Enforcement

`triggered-by-leaf.spec.ts` (schema refusals, duplicate and dangling ids,
evaluator, unknown without a trigger, a guard alone is not refused),
`generated-block.spec.ts` ("one automation, a different step per trigger"),
`triggered-by-model.spec.ts` and `TriggeredByFields.spec.tsx` (id assignment,
the picker), `when-ops.spec.ts` (an id survives a kind change).
