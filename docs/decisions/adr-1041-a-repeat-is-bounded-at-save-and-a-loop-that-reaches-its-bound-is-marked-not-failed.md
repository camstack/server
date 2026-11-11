---
id: D1041
title: A repeat is bounded at save, and a loop that reaches its bound is marked, not failed
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/step-runner.ts
  - packages/types/src/automation/codegen.ts
  - packages/types/src/automation/trace.ts
  - packages/addon-admin-ui/src/pages/build/automation/RepeatFields.tsx
  - packages/addon-admin-ui/src/pages/build/automation/repeat-model.ts
---

## Context

"Ring three times", "keep reminding while the door is open" and "do this
for each of these devices" were written as copies of the same step, or as a
script block with a loop nothing bounded.

## Decision

- **`repeat` is a step of the automation list**: `{ loop, steps }`. `loop`
  is one of four forms, told apart by `by`:
  - `count` — `{ count }`, 1 to 20 (`REPEAT_COUNT_MAX`);
  - `while` / `until` — `{ when, maxIterations, waitS? }`. `maxIterations`
    is mandatory, 1 to 50 (`REPEAT_ITERATIONS_MAX`): a loop on a condition
    without a maximum cannot be saved. `waitS` is a pause between two
    rounds, never after the last;
  - `forEach` — `{ target: { kind: 'devices', ids } }`, 1 to 50 devices.
    Before each round the run variable `item` (`REPEAT_ITEM_VAR`) is set to
    that device's id.
- **Its steps are plain steps**, 1 to 10: the same set a branch of a
  `choose` takes (D1038). No block step inside until block steps nest
  (D1043 nests them: the steps of a top-level repeat may be block steps).
- **`while` is read before each round, `until` after each round.** A `while`
  that is false at the start runs nothing; an `until` runs its steps at
  least once.
- **A condition that cannot be read ENDS the loop** and the run goes on
  (D49): a loop never runs another round on a value it could not read. The
  row says so and the block logs it. This is the opposite of `wait-until`
  (D1039), which keeps waiting: waiting on an unknown costs nothing, acting
  on it does.
- **A loop that reaches `maxIterations` while its condition still asks
  stops there**, is traced `timed-out` with "stopped at N iterations", and
  the run goes on. It is red in the editor while the run stays a success,
  as a `wait-until` that continues after its timeout.
- **A failure or a `stop` inside ends the loop and the run**, as in a
  sequence; a step marked "continue if this fails" does not.
- **One row in the run trace**: how many rounds ran (`iterations`), why the
  loop ended, and the steps of the LAST round only. Fifty rounds of ten
  steps would otherwise be 500 rows per run.
- **A restart of the run cuts the pause between rounds** and ends the loop.

## Consequences

- `forEach` takes a list of devices, not a room or a device type: a domain
  target is resolved through a vocabulary action, and the loop has none.
- Inside a `forEach` the editor's device command step can be aimed at "the
  device of this round": it is stored on the `item` variable and offers
  only the commands EVERY device of the loop's list has
  (`commonVocabActions`). A command whose argument is answered per device
  (a `dynamic` offer, such as one device's presets) is left out, because no
  single value fits the whole list. A stored step whose command is no
  longer common to the list is shown through the generic row and kept as
  it is. `item` is also offered as a value for a step parameter and for
  the variables of a "run an action" step.
- `item` keeps the last device's id after the loop.
- A `time-is` or device condition of a `while` is read when the round
  starts, not while its steps run.

## Rejected alternatives

- **Fail the run at `maxIterations`.** The bound is a safety net the
  operator was made to set, not an error they caused; a run that did all
  its rounds and then fails would send people looking for a fault.
- **Keep every round in the trace.** See above; the count and the reason
  answer "did it loop, and why did it stop".
- **`unknown` keeps looping.** That is a siren ringing 50 times because a
  sensor went offline.

## Enforcement

- `packages/types/src/automation/__tests__/step-runner.spec.ts` — the loop
  (count, while, until, bound, unreadable, failure, stop, pause) and the
  schema bounds in words.
- `packages/types/src/automation/__tests__/generated-block.spec.ts` — each
  form in a generated block, `vars.item`, a step aimed at `item`, restart.
- `packages/addon-admin-ui/src/pages/build/flow/__tests__/CommandStep.round.spec.tsx`
  and `command-vocab.spec.ts` — the device of the round: offered only in a
  loop over devices, only the common commands, written on the variable.
- `packages/addon-admin-ui/src/pages/build/automation/__tests__/ActionList.flow.spec.tsx`
  and `repeat-model.spec.ts` — offered only in an automation list, a loop
  on a condition always carries its maximum, the bounds.
