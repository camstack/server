---
id: D1039
title: A wait for a condition always has a timeout, and a condition that cannot be read keeps waiting
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/automation/wait-until.ts
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/codegen.ts
  - packages/types/src/automation/step-runner.ts
  - packages/types/src/automation/trace.ts
  - packages/addon-admin-ui/src/pages/build/automation/WaitUntilFields.tsx
  - packages/addon-admin-ui/src/pages/build/automation/wait-until-model.ts
---

## Context

A run could pause for a fixed time only. "Open the gate, wait until it reports
open, then turn the light on" was written as a fixed wait long enough for the
slowest day, or as a script block.

## Decision

- **`wait-until` is a step of the automation list**: `{ when, timeoutS,
  onTimeout }`. `when` is the same tree a step condition takes, read by the
  same evaluator. The step is not offered inside a branch of a `choose`
  (D1038 keeps branches to plain steps until block steps nest; D1043 nests
  them, so a wait-until is now offered one level down).
- **The timeout is mandatory, from one second to six hours**
  (`WAIT_UNTIL_TIMEOUT_MAX_S`). A run never waits without an end.
- **`unknown` is never "met".** A condition that cannot be read keeps the run
  waiting (D49); at the deadline the timeout reports what the condition last
  read, which is then the reason on the record.
- **The run reads again only when it has a reason to**: a state report of one
  of the devices the tree reads (any report when the tree names a device by
  stable id), the 15 s reconcile tick, or a restart of the run. It reads no
  faster than its devices report. A `time-is` row inside the tree is seen at
  the next tick, so it can be up to 15 s late.
- **`onTimeout: 'continue'`** goes on with the next step; the step is traced
  with the new outcome `timed-out` and the reason, shown red in the editor
  while the run stays a success. **`onTimeout: 'stop'`** ends the run as a
  FAILURE with the same reason and the later steps are `not-run`: a run that
  was told to give up did not do what it was built for, and a green run would
  hide it.
- **A restart of the run (`restart` mode) ends the wait at once**, as it ends a
  fixed wait.

## Consequences

- The step outcome list gains `timed-out`. A reader that does not know it sees
  a step that is neither ok nor failed.
- A run paused on a `wait-until` occupies its run-mode slot for up to six
  hours: in `single` mode later triggers are skipped while it waits.
- Known limits: a hub restart during the wait leaves no trace of that run
  (D1037); a run that a restart aborted while it was paused traces the wait
  as `ok`, as a fixed wait does.

## Enforcement

- `packages/types/src/automation/__tests__/wait-until.spec.ts` — the loop
  (met, read again, deadline, unknown, abort) and the schema bounds.
- `packages/types/src/automation/__tests__/generated-block.spec.ts` — woken by
  the device's report and not by another device's, by the reconcile, timeout
  continue / stop, unreadable condition, restart.
- `packages/addon-admin-ui/src/pages/build/automation/__tests__/ActionList.flow.spec.tsx`
  and `wait-until-model.spec.ts` — offered only in an automation list; the
  timeout stays inside the bounds.
