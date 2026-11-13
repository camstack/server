---
id: DNNN
title: A switch toggle is one default method, installed where every native provider is registered
status: proposed
date: 2026-11-13
supersedes:
applies-to:
  - packages/types/src/capabilities/switch.cap.ts
  - packages/system/src/kernel/moleculer/switch-toggle.ts
  - packages/system/src/kernel/moleculer/device-cap-proxy.ts
  - packages/types/src/composition/validate-forward.ts
---

## Context

`switch.on` and `switch.off` are vocabulary actions on `setState` with a fixed
`on`. A toggle cannot bake that arg: the value is the opposite of the current
slice, and a slice that has not reported (`on` not a boolean, or no slice) is
unknown, never off (D393).

An "invert this field" arg would have to be resolved wherever a vocabulary
action becomes a call. That is not one place. `vocabCall` is synchronous and
has no device state; the step runner, the generated automation block, the
scheduler and the remote command each call it and then invoke the cap on
their own.

## Decision

`switch.toggle` is a method of the `switch` capability, optional on the
provider type, with one action and no effect (a scheduler cannot hold an
outcome the action does not name). `registerNativeCap` — the one place a
native provider is stored, and already the place a missing `getStatus` is
filled in — installs one default for a switch provider that did not write
`toggle`: read the device's `switch` slice, and call that provider's
`setState` with the opposite boolean. A missing slice or a non-boolean `on`
refuses with `no-slice` or `stale` and logs `tags.deviceId`. A provider that
wrote its own `toggle` keeps it.

## Consequences

Every dispatcher (automation steps, the Buttons → devices template, remote
bindings, the device command dialog) picks the action from the vocabulary and
calls `switch.toggle`. No addon copies the invert. A driver that must toggle
without trusting the slice can still implement the method. A composition
does not forward `toggle`: the same default calls the composed `setState`,
which is already the forward.

## Enforcement

Specs: the action is listed for a switch; the default flips on to off and off
to on; an unknown slice refuses with the reason and does not call `setState`;
a command step and a Buttons → devices instance using `switch.toggle` expand
and validate. `scripts/check-cap-vocabulary.ts` accepts an action with no
effect. Nothing else may install a second default.
