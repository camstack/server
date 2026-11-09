---
id: D1026
title: An action step may carry one `if` and one else list, read on the condition mirror when the step is reached
status: accepted
date: 2026-11-09
supersedes:
applies-to:
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/step-runner.ts
  - packages/types/src/automation/step-condition.ts
  - packages/system/src/builtins/core-blocks/step-condition-door.ts
  - packages/addon-admin-ui/src/pages/build/automation/StepGuard.tsx
---

## Context

An automation can gate a whole run on a `when` tree (D980), but a sequence of
steps could not branch: "turn the light on only if it is off, otherwise dim it"
meant two automations. Every consumer of a step list (actions, the scheduler,
fan presets, generated automation blocks) shares one step shape, so the choice
was whether each grew its own branching or the shape did.

## Decision

1. **The shape carries it.** A `wait` or `cap` step has an optional `if` (the ONE
   `when` tree) and an optional `else` list of steps without an `if` of their own.
   An `else` without an `if` is refused at save. The `action` and `code` kinds are
   not guarded: an Action carries its own steps, and code can branch in code.
2. **One level.** The else list is bounded (`STEP_ELSE_MAX`) and nests no deeper,
   so a trace stays a flat list with at most one level of children.
3. **Unknown runs neither side (D49).** `runSteps` reads the guard when the step is
   reached, on a `ConditionMirror` filled for exactly the leaves the tree names.
   A state that cannot be read is `unknown`: the step is traced `skipped` with the
   reason and its else does not run. A guard that throws is an unknown too.
4. **Each consumer supplies the evaluator, none keeps a copy.** `stepConditionEvaluator`
   (core-blocks) reads through `ctx.api`; a generated block reads through its own
   mirror reads. A consumer with no evaluator reads every guard as unknown.
5. **A non-admin reads only what the scope gate proved.** For a caller restricted to
   a device set, a tree that names a device outside it, or any stable id, reads
   unknown: a branch outcome is itself an answer and would leak the state.

## Consequences

- The trace of a guarded step records `condition` (`true | false | unknown`) and
  `conditionReason`; the else steps are its `else` children.
- The notification center keeps its own twin step schema and is NOT covered here.
- A cap-shape change ships through `@camstack/types`; a node needs the framework
  closure that carries it.
