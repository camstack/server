---
id: D723
title: A node announces its own restart, and a stale "updating" is dropped once the update landed
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/restart-supersede.ts
  - server/backend/src/agent/agent-update-service.ts
---

## Context

The notification centre could tell an operator that a node had updated
(`server-updated`, from `system.restart-completed` after the boot) but never
that a node was ABOUT to restart. The operator asked for both: a plain restart
and an update-driven one, chosen in the existing system-events rule.

The hub already emitted `system.restarting` (payload: the restart marker) 10 s
before it exits, and only the alerts addon listened. The agent emitted nothing
before exiting; only `system.restart-completed` after its boot. And since D718
both event planes drop every category no subscriber declared, so an agent's
announcement would not have reached the centre's runner even if emitted.

Two hazards shaped the design:

- **One marker, two readings.** A plain node restart travels under the same
  `server-update:` reason prefix as an update (`server-update: manual
  restart`). The landing side already refuses to call that an update without a
  version. An announcement that judged it differently would announce an update
  the landing then never reports.
- **The hub announces its own death.** When the hub restarts, the centre runs on
  the hub and has the 10 s grace to send the push. The outbox is durable, so a
  send that did not finish is retried after the reboot, next to the
  `server-updated` the new process announces: "about to update" about an update
  that is already over.

## Decision

`system.restarting` becomes two system-event kinds in the `system` family:
`node-restarting` (no target version; group `nodes`) and `node-updating` (an
update: node, package, from → to; group `updates`, beside `server-updated`).
The intake splits them with the SAME predicate `server-updated` uses
(`restartIsUpdate`, one function for both halves). The agent emits
`system.restarting` (with its `nodeId`) through its event bus before the
self-SIGTERM; the hub's emit now names its node the way the post-boot landing
does. The centre's runner declares `system.restarting` in its subscription.

The centre records every `server-updated` it hears, whether or not a rule
matched it, keyed by node and target version. At send time a `node-updating`
row whose node and version have already landed is dropped benignly (the row
ends `sent`, like a snooze) with an info line naming the node and version. A
`node-restarting` is never superseded: it has no version to compare.

## Consequences

- The record is RAM, bounded (`NC_UPDATE_LANDINGS_MAX`). It covers the case it
  exists for: the retry after the hub's reboot and the landing, heard by the
  same process. A landing heard AFTER the stale row drained cannot recall it;
  the two then arrive in the right order, which is the harmless half.
- The hub's `system.restart-completed` is emitted by post-boot, and reaches the
  centre only if its runner is already subscribed. When it is not, there is no
  landing to supersede with, and a stale "updating" goes out. That is the same
  reach `server-updated` itself has on the hub; this record does not widen it.
- Installed phones parse the served template catalog with their own kind enum,
  so both kinds are held back from the SERVED catalog
  (`NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS`), as the tank kinds were. A phone
  that has not installed the viewer OTA mirroring them still drops a rule that
  selects one; that is unavoidable for any new kind.
- The viewer's kind mirror cannot run ahead of the PUBLISHED types it is
  checked against, so it follows the `@camstack/types` bump; until then the
  mirror guard carries an `aheadOfViewer` allowance for both kinds, which fails
  the day the viewer gains them. The viewer's en/it words ship first.
- An agent restart before its event bus is bound (mesh not up) is not
  announced, and says so in a WARN line.

## Enforcement

Tests: `node-restart-intake.spec.ts` (the split), `node-updating-superseded.spec.ts`
(the drop, with a control for a different version and for a plain restart),
`agent-update-service.spec.ts` (the agent emits before exiting),
`wire-subscriptions.spec.ts` (the category is declared), the types group
membership specs, and the viewer mirror guard (`check-nc-mirrors-in-sync.ts`,
with its self-expiring `aheadOfViewer` allowance).
