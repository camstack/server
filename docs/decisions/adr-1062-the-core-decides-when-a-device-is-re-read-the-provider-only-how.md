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
- a batching integration has ONE schedule: one due time and one read of every
  device of the instance per interval. Command and burst reads are per device
  and never move it; a device registered later joins the next tick;
- reads of one device are serialized: each starts after the previous one on
  that device ended. A tick whose last read still runs is skipped at debug; a
  command waits for the read in flight at most 5 s, then reads its own device
  (debug line).
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
- An account none of whose devices registered the cap has no schedule. Its
  account list (the adoption candidates and their `online` flag) is served and
  revalidated (D224): `listCandidates` answers from the cached list at once and,
  when that list is older than the account's interval, starts ONE background
  re-read (never joining or waiting on one in flight); the adoption `refresh`
  re-lists the account, joining a read already running, before it answers.
  Once a device is adopted, the scheduled group read re-lists the account and
  so refreshes the candidates too.
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

## Amended

A first read is answered only by a reading, for every provider. A slice still
at its cap's construction placeholder (an explicit `lastChangedAt` or
`lastUpdated` of 0) never settles it. This is a general change: the full-push
providers (Dreo, ESPHome, Home Assistant, MQTT Home Assistant, Tuya) used to
settle on their first non-framework slice even when it was a cold seed; they
now wait for a real report or for the first-report bound.

A policy may also name the cap that answers, with the optional `answersWith`:
a sibling slice (a lock's folded battery) then does not settle the device. A
policy without `answersWith` keeps the earlier rule, any non-cold,
non-framework slice answers. A device that is still unanswered when the bound
passes is concluded offline if its reads failed (an unreachable lock), and
otherwise released without a verdict.
