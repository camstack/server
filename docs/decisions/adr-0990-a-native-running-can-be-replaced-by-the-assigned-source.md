---
id: D990
title: A native running can be replaced by the assigned source, through the D984 door
status: accepted
date: 2026-11-01
supersedes:
applies-to:
  - packages/types/src/capabilities/running-state.cap.ts
  - packages/types/src/composition/validate-composition.ts
  - packages/types/src/composition/customize/scalar-compile.ts
  - scripts/lib/customize-apply.ts
  - packages/addon-admin-ui/src/components/device/customize/assignment-availability.ts
---

## Context

D944 point 1 said Customize never overrides a native value, and D984 opened one
narrow door for the lock's `state`. D933 had already said an operator
assignment "replaces" the native running, but D944 made the extension absent on
any device that serves `running-state` itself — so a dishwasher whose native
running is wrong (a Home Connect program that reports idle while the machine
works) could not take its Zigbee plug's power as the truth. The operator wants
exactly that: threshold and dwell on the plug, replacing the native boolean.

## Decision

`running-state` lists `running` in `customize.overridable` by its own `running`
target — the D984 mechanism, no second door. Three precisions on it:

1. The target stays `apply: 'add'`. The same target ADDS `running` where the
   device has none and REPLACES it where the device serves it; the Customize
   offer (`assignmentAvailability`) reads the cap's `overridable` list to tell
   which. An `overridable` row may therefore name an `add` or a `replace` target.
2. A replace writes the target's field plus its replace-time companions
   (`source: 'assigned'`, `lastFetchedAt`, `since`). The validator's allowed set
   is the row's path and those companions; anything else stays refused (D944).
3. `phase` is a native fact the assignment cannot know, so it is an `add`-only
   companion: on a replace it is not written and the claimed slice, which merges
   over the native one, keeps the NATIVE phase. `since` is stamped on the
   assigned value itself (`latchedAt(<assigned expression>)`), never on a read of
   `running`, which on a replaced field reads back the native value.

`onStarted` / `onFinished` need nothing new: the flip detector watches the
merged public slice, so the events follow the assigned boolean. Removing the
customization releases the claim and the native slice is served again.

Rejected: a second target `running-replace` (two cards per cap, one stored
shape); `phase: null` on replace (discards a true native fact for nothing).

## Consequences

D944 point 1 is now "never overrides a native value except one the cap declares
overridable" (D984 for the lock, this record for running). The native phase can
disagree with the assigned running (a program name while the plug reads idle);
the card says the source is assigned, and the operator chose it.

## Enforcement

`check-customize-apply-add.ts` (an `overridable` row must name a target on its
path). Specs: `running-replace.spec.ts` (plan, compile, decode),
`running-replace-runtime.spec.ts` (`since` follows the assigned value),
`running-replace-events.spec.ts` (flip events, native phase, release),
`assignment-availability.spec.ts`.
