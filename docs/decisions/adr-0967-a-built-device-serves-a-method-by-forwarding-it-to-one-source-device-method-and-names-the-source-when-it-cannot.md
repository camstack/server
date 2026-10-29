---
id: D967
title: A built device serves a method by forwarding it to one source device's method, and names the source when it cannot
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - packages/types/src/composition/composition.ts
  - packages/types/src/composition/validate-forward.ts
  - packages/types/src/composition/validate-composition.ts
  - packages/system/src/builtins/composer/forward-commands.ts
  - packages/system/src/builtins/composer/actuator-groups.ts
  - packages/system/src/builtins/composer/composed-device.ts
---

## Context

D659 reserved `commands` in the composition wire shape and refused them by
name ("slice 3"): a composed capability was a native provider with no methods.
That kept a device built from a room's sensors honest, and left every built
device read-only. A fountain that Home Assistant exports as a container of
loose entities (a pump switch, two number boxes, a "filter changed" button) had
all its state composable and none of its controls, so the operator got a card
that showed the pump and could not start it. A consumable item could never be
`resettable` either: D663 pinned `resettable: false` until commands arrived.

The first design considered was a second dispatch path for the built device's
commands. The actuator helper group already owns the right one: a composed
device calls one process-wide dispatcher, the composer resolves its sources
and calls the member through `ctx.api`, a failure on one member is recorded
and logged under the group's id. A second path would have needed its own
liveness, source resolution and logging, and would have drifted from the first.

## Decision

A built device (`target.kind: 'new'`) serves a method of its cap by a
`forward` command: the method is dispatched under its own name and lands on ONE
mutation of ONE source device's cap. The dispatch path is the actuator
group's (`ComposedDevice.dispatch` to `ActuatorGroups.command`); a device that
has forwards takes `ForwardCommands` there instead of the fan-out.

- **Every served method needs a command.** The validator accepts a built cap
  only when each non-system method without a composer answer has a `forward`
  (`has-commands`), refuses a command for a method the cap does not serve
  (`command-method-unknown`), and checks the source cap and method exist and
  that the method is a mutation (`command-source-unknown`). A forward is
  refused on an existing target (`reserved-variant`); a `code` command and a
  `passthrough` feature stay reserved.
- **The input mapping is additive.** Without `args` the caller's input passes
  through minus `deviceId`, and the source's own `deviceId` is injected; a
  field the source does not take is refused by name (`command-input-unknown`),
  and so is a required source field nothing provides
  (`command-input-missing`). With `args` the template is the whole input: a
  constant is sent as it is, `{ $input: '<field>' }` is replaced by that field
  of the caller's input at any depth (a `control.setValue` takes a nested
  record). `deviceId` is never an argument.
- **An item's reset is the item's own.** `items[key].reset` is a forward; it
  makes the item `resettable: true` and answers `consumables.reset { key }`.
  The graft path keeps refusing `reset` by name (the cap's `composedMethods`).
- **A forward fails with a reason that names the source.** The source is
  resolved against the device index on every command, never from a remembered
  id; a gone source is `source-gone`, an unanswered index read `source-unknown`,
  a call the source rejected (offline included) `source-call-failed`, a
  method with no command `no-command`. Each is a `ForwardRefusedError` whose
  message carries the source key, and is logged with `tags: { deviceId }` of the
  composed device and the source in `meta`.
- **The sources are tracked like any other:** a forward's source is listed in
  `compositionSourceRefs`, so a save reads it, and `forwardSourceProblems`
  refuses one that is missing or lacks the called cap.

## Consequences

- A built device is no longer read-only; a hero card that sends a command
  reaches the vendor addon through the same `ctx.api` call an automation makes.
- A device of a type the composer builds can carry methods, so the
  `composed-device.spec.ts` invariant (status keys are runtime-state keys)
  still guards the read side, and `forward-device.e2e.spec.ts` guards the
  write side through the real registry.
- A forward onto an existing target is not available: a customization adds a
  cap to a device another addon owns, and a command there needs the owning
  runner's consent. That stays reserved.
- The forked composer runner dispatches a native method over UDS; this record
  is proven through the hub-style registry path only. The first deploy verifies
  `getBindings` on the composed device and one command end to end.

## Enforcement

`validate-forward.ts` (static, in `planComposition`) and
`forwardSourceProblems` (with the sources read) refuse a wrong composition at
save time, covered by `forward-commands.spec.ts` in `@camstack/types`. The
runtime is covered by `forward-commands.spec.ts`,
`actuator-groups.spec.ts` and `forward-device.e2e.spec.ts` in
`@camstack/system`.
