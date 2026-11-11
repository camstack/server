---
id: D1043
title: Block steps nest two levels, and a third level is refused at save
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/trace.ts
  - packages/types/src/automation/step-runner.ts
  - packages/types/src/automation/codegen.ts
  - packages/addon-admin-ui/src/pages/build/automation/nest-model.ts
  - packages/addon-admin-ui/src/pages/build/flow/trace-view.ts
---

## Context

`choose`, `repeat`, `parallel` and `wait-until` (D1038 to D1041) each held
plain steps only. "For each light: if it is on, turn it off" or "if nobody
is home, wait until the door closes, then lock" needed a block step inside
another, and could only be written as a script block.

## Decision

- **Two levels of block steps, no more** (`STEP_NEST_MAX = 2`). The list of
  a `choose` branch, of its `else`, or of a `repeat` in the automation's own
  list may hold a `choose`, a `repeat`, a `parallel` or a `wait-until`. The
  lists of THOSE hold plain steps only.
- **A third level is refused when the recipe is saved**, in words: "steps
  nest two levels at most: a step inside a nested choose or repeat can be a
  plain step only". It is the same kind of author-time bound as
  `MAX_WHEN_DEPTH`.
- **A `parallel` stays a leaf**: its members are a command, an action or a
  wait at every depth (D1040's reasons do not change with depth).
- **The schema is two tiers built from one factory each**
  (`chooseSchemaOf(step)`, `repeatSchemaOf(step)`): the level-2 block takes
  the plain step, the level-1 block takes the body step. A deeper bound is
  one more application of the factories, not a new shape.
- **The generated block and the runner are recursive.** A step is emitted
  for a site (its trace path), so a nested block is emitted by the same
  function as a top-level one; nothing in them knows the bound.
- **The run trace gains one level**: a nested row may carry `branch`,
  `branchChecks`, `iterations` and its own `steps` (plain rows). Paths
  extend the parent's: `actions.0.steps.1.branches.0.steps.0`.
- **Inside a repeat over devices, `item` is the device of the nearest such
  loop.** A nested repeat over devices sets its own and gives the outer
  device back when it ends; a nested repeat on a count or a condition
  leaves the outer one in place, and a command two levels down can still be
  aimed at the device of the round (D1041). After a loop that has no loop
  around it, `item` keeps the last device, as D1041 says: before this
  change the generated block cleared it on the call that ends the loop.
- **The editor follows the same bound** (`bodyKindsAt(depth)`): a list one
  level down offers the block steps, a list two levels down does not. Code
  steps stay in the automation's own list.
- **Two schemas are declared by a named interface** (`AutomationRecipe`,
  `AutomationRunTrace`): with the second level inlined, the `core-blocks`
  capability type passed what the compiler can print (TS7056).

## Consequences

- An automation with a block at each level, each at its bounds, can hold a
  few hundred steps. Nothing limits the total beyond the per-list bounds.
- A repeat of 50 rounds holding a repeat of 50 rounds runs its steps 2500
  times; both bounds are still fixed at save.
- The run trace of a repeat keeps the last round only (D1041), at both
  levels: the rows of a nested repeat are the last round of the last round.
- The editor shows a nested block's steps one indentation further; on a
  phone a level-2 list is narrow.

## Rejected alternatives

- **A recursive schema with a depth check in a refinement.** The inferred
  type becomes self-referential and every reader must narrow at each level;
  two tiers keep "a level-2 list is plain" in the type.
- **Unbounded nesting.** The issue fixes the bound at two; the trace view
  and the editor are both laid out for it.

## Enforcement

- `packages/types/src/automation/__tests__/step-runner.spec.ts` — "two
  levels of block steps": the second level accepted, the third refused in
  words, a parallel leaf-only, the walkers' paths, the nested trace row.
- `packages/types/src/automation/__tests__/generated-block.spec.ts` — a
  choose inside a repeat, a repeat inside a branch, a nested wait-until
  woken by its device, a parallel inside a repeat, a device loop inside
  another and the value of `item` after each.
- `packages/addon-admin-ui/src/pages/build/automation/__tests__/ActionList.flow.spec.tsx`
  and `nest-model.spec.ts` — which kinds each depth offers, a nested block
  kept on edit, the loop's devices two levels down.
- `packages/addon-admin-ui/src/pages/build/flow/__tests__/trace-view.spec.ts`
  and `TraceResult.spec.tsx` — a nested block row with its own steps.
