---
id: D1045
title: An automation row fires on a device event, and recovers the latest one from the slice
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/automation/fired-trigger.ts
  - packages/types/src/automation/when.ts
  - packages/types/src/automation/codegen.ts
  - packages/types/src/automation/trigger-variables.ts
  - packages/addon-admin-ui/src/pages/build/automation/fired-model.ts
  - packages/addon-admin-ui/src/pages/build/automation/FiredFields.tsx
---

## Context

An `event-emitter` device declares what it fires in a typed vocabulary
(D1044). An automation could react to it only through the generic
`device-event` row: a whole category, optionally one device. "Button 3,
long press" could not be said, the run did not know which button it was,
and — a press being an event with no state — two identical presses could
not be told from one by reading the device.

Events are telemetry and may be dropped (D8). A dropped press is a rule
that silently did not run.

## Decision

- **A `device-fired` event row**: `{ deviceId, eventIds?, sourceIds?,
  kinds?, match? }`. Each list is an OR, the lists together an AND, an
  absent list does not narrow. `eventIds` are the device's own tokens,
  `sourceIds` the parts of the device (a button), `kinds` the shared kinds
  of its vocabulary. `match` is a list of `{ path, equals }` on the fire's
  payload, compared strictly.
- **Two doors, one fire.** The bus event (`EventCategory.EventEmitted`)
  is the normal door. Every 15 s the row also reads the device's
  `event-emitter` slice: a `lastEvent` newer than the newest fire the row
  has handled is a fire whose event was dropped, and it starts the run
  with the reason "… — recovered by reconcile". A fire passes exactly one
  door: `DeviceFiredWatch` remembers the newest fire handled by either.
- **Newer = timestamp, then `seq`.** `seq` restarts at 1 with the
  provider, so alone it would call every fire after a provider restart
  old. It orders two fires of one provider run and nothing else.
- **The first good read only seeds.** What fired before the row started
  is not a trigger, and a read that failed changes nothing (D49): the next
  good one still seeds, it never turns a stale `lastEvent` into a press.
- **A fire that is not this row's is ignored without a trace** (another
  button, another event, another kind) and logged at debug with the
  device. A `match` miss on the right button IS traced, with the value
  found.
- **The kind of a fire comes from the device's vocabulary** as the row
  last read it (the entry of that token and source, else of that token).
  Before any read answered, it comes from the token by the shared
  convention (`conventionalEventVocabulary`).
- **Run variables**: `deviceId`, `eventType`, `sourceId`, `eventKind`
  (both empty strings when the fire names none), and the payload's scalars
  as `data.<path>` — `{{vars.data.channel}}`. The bag stays flat: the dots
  are part of the key, and the `{{vars.…}}` slot accepts a dotted name.
- **The editor** picks the device (only devices with the capability are
  offered), then the part and the event from the vocabulary read from the
  slice. Until that read answers it says so and offers nothing (D315). A
  pick the device no longer declares stays visible with a warning. It
  writes one `sourceIds` and one `eventIds` entry; `kinds` and `match`
  written elsewhere are shown and kept.

## Consequences

- "Button 3 long press" runs only for that button and press, twice for
  two presses, and the steps read `{{vars.sourceId}}`.
- **Only the latest dropped fire is recoverable.** Two presses dropped
  inside one 15 s window recover as one, and a recovered run starts up to
  15 s late. A press whose event AND slice write were both lost is lost.
- The variable is `eventKind`, not `kind`: `kind` in a run's bag already
  names the trigger row, and the trace reads it.
- No new `EventCategory` value: every integration fires through the one
  existing category.
- The draft assistant (the LLM draft schema) and the command-line
  questionnaire do not offer the row yet; a recipe that carries it is
  validated (the device must exist).

## Rejected alternatives

- **Reconcile on `seq` alone**: a provider restart resets it, and every
  later press would be older than the last one seen.
- **Reading the slice instead of the event** (as `device-becomes` does):
  the slice holds one `lastEvent`; two presses between reads are one
  value.
- **A trace for every fire of another button**: a six-button remote
  would fill the run history of each of its six rules with five skips
  per press.
- **A nested `data` object in the bag**: the trace and the substitution
  both work on a flat bag of scalars.

## Enforcement

- `packages/types/src/automation/__tests__/fired-trigger.spec.ts`: two
  identical presses fire twice, the same fire delivered twice fires once,
  another button does not fire, the first read seeds, a dropped fire is
  recovered once, a provider restart is newer.
- `packages/types/src/automation/__tests__/generated-block.spec.ts`
  ("device-fired trigger"): the same, through the generated block, with
  the variables reaching a step.
- `packages/addon-admin-ui/src/pages/build/automation/__tests__/fired-model.spec.ts`:
  what the editor offers and what a pick writes.
