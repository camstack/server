---
id: D1072
title: A provider never restarts its own power source; recovery is an operator automation on the error cap
status: accepted
date: 2026-11-21
supersedes: D997
applies-to:
  - packages/addon-provider-velux/src/velux-integration-manager.ts
  - packages/addon-provider-velux/src/migrations/drop-power-restart-keys.ts
---

## Context

D997 let the Velux provider call `power-source.forceRestart` on its own gateway
after it had been unreachable for a while, bounded by a 30 minute cooldown the
provider persisted itself. It worked, but it was a hidden policy: the operator
could not see it in the automation list, change the wait, add a notification,
turn the restart off, or reuse it for another device. Every provider that
wanted the same would have added itself to D997 and carried its own copy of the
threshold, cooldown, in-flight guard and reconnect logic.

The gateway now reports its own state on the `error` cap (`unreachable` after
the same two minutes, `auth-failed`, `connection-lost`), so the trigger the
provider computed internally is a state any automation can read.

## Decision

A provider reports a fault; it never acts on it by restarting a power source.
Recovery is an operator automation: trigger on the device's `error` becoming
active with the fault code, then a notification, then `power-source.forceRestart`
on the device, with the cooldown on the automation. For Velux that automation
exists on the hub: gateway `error.active` with code `unreachable`, a Zentik
notification, a 30 minute cooldown, then `powerSource.forceRestart` on the
gateway. The provider keeps the gateway session's own reconnect backoff and
nothing else.

## Consequences

- `VeluxPowerRecovery`, its deadline timer, the `powerSource` and
  `powerCycleStore` wiring and the manager's `lastRecovery` are gone.
- A migration removes the `powerRestartAt:<integration>` keys the provider kept
  in its store.
- The restart now waits for the automation engine rather than a provider timer,
  and the reconnect after a restart is the manager's ordinary backoff, not a
  fixed 90 second boot wait. A gateway with no automation is never restarted:
  the fault is shown and nothing else happens.
- Nothing may call `forceRestart` on its own initiative from a provider: a new
  recovery is an automation, not an addition to a record.

## Enforcement

Review only for other providers. The Velux manager's specs cover the session
retry and the fault reading it keeps; the migration has its own spec.
