---
id: D1056
title: A workload is one device type and one cap, and its role is the kind
status: accepted
date: 2026-11-16
supersedes:
applies-to:
  - packages/types/src/capabilities/workload.cap.ts
  - packages/types/src/device/device-type.ts
  - packages/system/src/builtins/device-manager/workload-transition.ts
---

## Context

Unraid runs Docker containers and VMs and is itself a machine; Proxmox adds LXCs;
UniFi consoles and a Homematic CCU are appliances with their own OS. Each needs a
state (running, stopped, crashed), start / stop / restart, and resources (CPU,
memory, network) with history (#585).

The first shape on the table was one device type and one cap per kind
(`docker-container`, `vm`, `host` …), or one cap with a `kind` field. Both were
rejected by the operator. Per-kind types multiply every exhaustive table, card
and export by five for the same controls, and a new hypervisor would add a type
again. A `kind` field duplicates what a role already says (D1033) and collides
with `kind`, which is behavioural cap metadata (D4) and already a field in ~50
cap schemas.

## Decision

Everything that runs on a machine, and the machine itself, is a device of type
`workload` with one of the roles `vm`, `app-container`, `lxc`, `app`, `host`.
ONE cap, `workload`, serves every role: no field in its schemas says the kind.
The role picks wording and icons (`vocabulary.overrides.byRole`) and
`deviceRoles` keeps the cap on a workload that carries one of the five roles.
What a device can do is declared per device by `getOptions` (`supportsX`,
`hasX`), and the UI is derived from it (`deriveWorkloadControls`). Its on / off
is the `power` hint over `state` (stopped and crashed are off), never a second
state. Its events (started, stopped, crashed, recovered) are raised by the hub
mirror from the state transitions, so a provider only writes its state.

## Consequences

- A provider (Unraid, UniFi, CCU, Proxmox) implements one cap and registers
  `switch` through `registerPowerSwitch` (`check-power-hint`).
- A host's load and temperature live in `resources` beside a VM's; its uptime is
  `since` while it runs. A field one role never fills stays `null` (D393).
- A rule on CPU above a threshold needs a numeric state trigger on a nested
  field, which the vocabulary cannot express yet (top-level fields only); the
  history is recorded meanwhile.
- The first state the mirror sees for a device is a seed, so a hub restart never
  announces every container as started; a transition during a restart is lost
  (events are telemetry, D8).

## Enforcement

`packages/types/src/capabilities/__tests__/workload.cap.spec.ts` pins the
absence of `kind`, the role gate, the options-derived controls and the power
derivation; `workload-transition.spec.ts` and `workload-events.spec.ts` pin the
events. `check-power-hint` refuses a second on/off field or setter.
