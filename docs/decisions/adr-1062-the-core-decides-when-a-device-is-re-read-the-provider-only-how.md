---
id: D1062
title: The core decides WHEN a device's state is re-read; the provider only knows HOW
status: accepted
date: 2026-11-18
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/state-refresh-scheduler.ts
  - packages/system/src/builtins/device-manager/state-refresh-wiring.ts
  - packages/system/src/kernel/state-refresh-policies.ts
  - packages/system/src/kernel/command-follow-up.ts
  - packages/types/src/device/state-refresh.ts
  - packages/types/src/capabilities/device-state-refresh.cap.ts
  - packages/addon-provider-vesync/src/vesync-integration-manager.ts
  - packages/addon-provider-vesync/src/devices/vesync-state-refresh.ts
  - scripts/check-no-provider-poll-loops.ts
---

## Context

Every polled integration kept its own clock. VeSync polled the account on a
`setInterval` (30 s by default) and, after a command, re-read the commanded
device inside `runCommand`. Each provider re-solved the same questions
differently, or not at all: how soon after a command to read, whether to read
again while the device catches up, what to do when two reads overlap, and how
to notice that a push channel went quiet. The D1061 hold showed a commanded
value at once, but whether the REAL state arrived in time depended on a
per-provider timer the hub could not see. The first attempt, a faster poll
interval, only multiplied the reads against a rate-limited cloud and still
left the command waiting for a tick.

D224 put the freshness of a device fact in the provider that owns the device.
That still holds for WHAT a read returns. It does not hold for WHEN a read
happens, because "when" depends on things only the hub sees: the commands, the
holds that are still unconfirmed, the reports that arrive.

## Decision

A provider moved to the core state refresh registers `device-state-refresh` on
each device it reads. It declares a policy with the registration
(`registerNativeCap(cap, provider, { stateRefresh })`, carried like the D1061
hold options): `minIntervalMs`, an optional slower `intervalMs` (the
integration's own setting, which can only slow the cadence), `batch`,
`push: none | partial | full`, and optionally `heartbeatMs` and a
`connectionEpoch`. The hub's device-manager runs ONE scheduler, keyed per
(integration instance, device), and it alone decides when to call
`refresh(deviceIds, reason)` / `resubscribe()`:

- cadence: `effectiveRefreshIntervalMs`, with no idle back-off. `push: 'full'`
  is never scheduled.
- command: the D1022 seams (the hub mount, the UDS parent, the in-process
  `ctx.api` link) AWAIT a follow-up after the provider's call settles. A polled
  device is read at once, so the command returns after the real state was
  pushed. It is read again at about 3 s and 10 s while a D1061 hold on it is
  unconfirmed. A push device waits about 2.5 s for the confirming push and is
  read once if none came. A refresh failure is a warn line tagged
  `{ deviceId }` and never fails the command.
- refreshes of one device never overlap: a tick that finds one in flight is
  skipped at debug, and a command waits for it.
- push health: silence past `heartbeatMs` triggers a read of the integration,
  then `resubscribe()`, then another read, with a warn line per device. A new
  `connectionEpoch` (a reconnect) triggers a read of every device.

This amends D224: freshness of a VALUE stays with the provider, timing moves to
the core. D847's battery window is a scheduler policy of the same kind. It is
not migrated here.

## Consequences

- A migrated provider owns no timer. VeSync (the first adopter) keeps
  `commandMs` on the command and `refreshMs`/`totalMs` on the read the core
  asks for.
- The follow-up is awaited, so a command now takes as long as one read. That
  is the point: the caller hears the answer after the state is real.
- An account none of whose devices registered the cap is not read at all.
- Providers hosted on an agent are not covered yet: the policy road is the
  hub's in-process and UDS registration, the same scope as D1061.
- A push integration that cannot be read at all has no way to say so yet.

## Enforcement

`scripts/check-no-provider-poll-loops.ts` (Checks workflow) refuses
`setInterval`, `setTimeout`, `pollTimer` or `pollLoop` in the runtime source of
every migrated provider (`MIGRATED`: VeSync). The scheduler spec
(`state-refresh-scheduler.spec.ts`) and the seam specs
(`command-follow-up-seams.spec.ts`, `transport/command-follow-up.spec.ts`)
pin each rule above.
