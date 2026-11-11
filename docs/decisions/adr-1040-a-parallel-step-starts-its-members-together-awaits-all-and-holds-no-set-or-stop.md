---
id: D1040
title: A parallel step starts its members together, awaits all of them, and holds no set or stop
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/step-runner.ts
  - packages/types/src/automation/codegen.ts
  - packages/addon-admin-ui/src/pages/build/automation/ActionList.tsx
  - packages/addon-admin-ui/src/pages/build/automation/choose-model.ts
---

## Context

The steps of an automation ran one after the other only. "Close every
shutter and turn the alarm on" waited for the slowest shutter before the
alarm was armed, or was written as a script block.

## Decision

- **`parallel` is a step of the automation list**: `{ steps }`, from two to
  five members (`PARALLEL_STEPS_MIN`, `PARALLEL_STEPS_MAX`). All members are
  started together and the run goes on when every one of them has finished.
- **A member is a device command, an action or a wait.** A `set` or a `stop`
  is refused at save: beside other steps neither has an order, so a variable
  written there could be read before or after, and a stop could not say what
  it stopped. A block step (`choose`, `wait-until`, `parallel`) is not a
  member either.
- **Failure is the failure of a sequence, read once everyone finished.** A
  member that fails does not cut the others short; when all are done the
  parallel is traced `error` and the run fails. A member marked "continue if
  this fails" is traced `failed-continued` and does not fail the run (D1037).
- **Each member has its own row in the run trace**, nested under the
  parallel, at the path `…<n>.steps.<m>`: the same shape a branch of a
  `choose` uses (D1038), so a later level of nesting adds depth, not a new
  shape.
- **A restart of the run cuts every wait in flight.** The run token holds a
  set of wake callbacks, one per sleeping member; a single slot would wake
  only the member that slept last.
- **The editor offers `parallel` in an automation list only**, never inside
  a branch or another parallel, and disables "add step" at five. (D1043: a
  parallel is now also offered one level down, in a branch or a repeat; its
  own members stay a command, an action or a wait.)

## Consequences

- A parallel has no condition of its own; a `choose` around it is the next
  nesting level of #500.
- The members share the variables the run had when the parallel started;
  none of them can change them.
- Two members commanding the same device race, as two automations would.

## Rejected alternatives

- **Cancel the others on the first failure.** A device command already sent
  cannot be recalled, so "cancelled" would only hide what ran.
- **Allow `set` with a last-writer-wins rule.** The winner would depend on
  which device answered first.

## Enforcement

- `packages/types/src/automation/__tests__/step-runner.spec.ts` — members
  start together, a failure waits for the others, continue-on-error, the
  member kinds and the bounds refused at save.
- `packages/types/src/automation/__tests__/generated-block.spec.ts` — the
  generated block awaits all members; a restart cuts every wait.
- `packages/addon-admin-ui/src/pages/build/automation/__tests__/ActionList.flow.spec.tsx`
  and `choose-model.spec.ts` — offered only in an automation list, member
  kinds, no sixth step.
