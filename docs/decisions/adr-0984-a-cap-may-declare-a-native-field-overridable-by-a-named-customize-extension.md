---
id: D984
title: A cap may declare a native field overridable by a named Customize extension
status: accepted
date: 2026-10-31
supersedes:
applies-to:
  - packages/types/src/capabilities/lock-control.cap.ts
  - packages/types/src/capabilities/customize-spec.ts
  - packages/types/src/composition/validate-composition.ts
  - packages/types/src/composition/customize/scalar-compile.ts
  - packages/types/src/composition/customize/scalar-decode.ts
  - packages/system/src/builtins/core-blocks/lock-door-gate.ts
  - packages/system/src/builtins/core-blocks/core-blocks.addon.ts
  - scripts/lib/customize-apply.ts
  - scripts/check-customize-apply-add.ts
---

## Context

[D944](adr-0944-customize-attaches-a-fixed-set-of-extensions-and-everything-else-is-a-built-device.md)
made every Customize extension `apply: 'add'`: it attaches something the device
lacks and never rewrites a field its own cap already serves. A lock with a door
contact is the case that breaks it. The operator wants a lock that is `locked`
while its linked door contact reads open to REPORT `door-open`: in the slice the
hub mirrors, so history, automations and every exporter see it. A projection
beside the lock (a derived sensor, a UI badge) was rejected because each reader
would have to know to look there.

## Decision

A cap may declare, in its own `*.cap.ts`, `customize.overridable: [{ path, by }]`:
the native field `path` may be REPLACED by the extension target `by`. That is
the only way `apply: 'replace'` on a native field is legal. `featureTargetOf`
and `check-customize-apply-add.ts` read the allow-list; neither names a cap.

`lock-control` declares `state` overridable by `door-contact`. The target reads a
boolean source and carries `override: { whenSourceTrue: 'door-open',
unlessNative: ['jammed'] }`. Precedence: a native `jammed` wins; otherwise an
open contact reports `door-open` whatever the native state says; a closed or
unknown contact leaves the native state, and when the contact closes the native
state is re-emitted. The override rides the D663 claim machinery: the composer
writes the replaced field into the claimed slice and the hub serves the merged
slice, with self-reads served from the native view.

The command gate is the D963 device-call redirect extended to
`lock-control.lock`, composed with the media-player redirect into ONE slot. While
the contact reads open, `lock()` is refused with a typed error naming the sensor,
logged with the device tag. `unlock()` is never blocked. The gate state is
in-memory, fed from `device.state-changed` off the command path (D49); an unknown
door does not block and is logged once.

Rejected: (A) a projection or a new cap carrying the door state, which leaves the
real state `locked` for every consumer; (C) a built device wrapping the lock,
which loses the native cap and its bindings (D967).

## Consequences

`door-open` is a sixth `LockState`; every exhaustive map handles it. Exporters
map it: HomeKit unsecured, Alexa UNLOCKED, Home Assistant `open`, Google not
locked. The gate does not know the door state of a lock until the first
`lock-control` event after a hub restart.

## Enforcement

`check-customize-apply-add.ts` fails a `replace` the cap does not list in
`overridable`, and an `overridable` entry with no replace target. Specs:
`lock-door-contact.spec.ts` (plan, compile, decode), `lock-door-contact-runtime.spec.ts`
(precedence at the hub write), `lock-door-gate.spec.ts` (the gate).
