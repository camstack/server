---
id: D633
title: A DELETED device (or target) leaves the notification rules — confirmed by a second read, never widening a rule, disabling it once when it was the last
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/device-prune.ts
  - packages/addon-post-analysis/src/notification-center/device-prune-runner.ts
  - packages/addon-post-analysis/src/notification-center/device-prune-ledger.ts
  - packages/addon-post-analysis/src/notification-center/device-directory.ts
---

## Context

Deleting a camera left its id in every notification store that named it:
`conditions.devices`, `systemEvent.deviceIds`, `deviceState` / `scene` gates,
action-sequence `cap` steps, timelapse and digest `deviceIds`, the alarm's
non-blocking lists and exclusions, the per-camera mutes. The operator reported
it (2026-09-25): a rule referencing a deleted device rendered it nowhere and it
could not be deselected. Task 13b made the pickers show a kept id as
"Device #id — removed"; the stores themselves still held it forever.
`nc.deleteMyTarget` did the same to target ids — and a rule holding a deleted
target could no longer save a target edit (`validateTargetRefs`).

Three things made the obvious fix ("on `DeviceUnregistered`, drop the id")
wrong:

1. **The event is telemetry and may be dropped (D8, D11)** — a prune that only
   listened would miss deletions made while the evaluating node was down.
2. **A device that is only gone for a moment looks the same as a deleted one**
   to most reads: a respawn, a rebuild, a migration swap (`swapIds` parks an id
   on a temp id), a hub restart window where `listAll` answers little or
   nothing. The prune is DESTRUCTIVE, so D49 applies: the reading that
   destroys work needs a second read to agree.
3. **Dropping the LAST id of a list widens the rule.** `conditions.devices: []`
   means every camera and an absent `systemEvent.deviceIds` means every device;
   a scoped rule that silently became all-cameras is the 2026-08-12 incident.

## Decision

The notification centre forgets a deleted device through two doors with one
bar, and never widens a rule doing it.

- **Doors.** `EventCategory.DeviceUnregistered` (emitted only by
  `removeDevice`, after the row is gone; `decommission` — respawn / rebuild /
  shutdown — never emits it, pinned by a system spec), forwarded by
  `pipeline-analytics` through a type guard; and a reconcile on the EXISTING
  rule-reload tick (no new timer, D3), where a candidate is an id missing from
  the last TWO answered (successful, non-empty) directory refreshes.
- **The bar.** Only the evaluating node writes; the rules must be loaded; the
  prune ledger must have loaded (its guard is a destructive-direction read);
  and `deviceManager.getDevice` must answer `null` — the persisted row is
  gone. A read that throws or answers a device changes nothing.
- **Written from the durable row.** The plan only names the affected rows;
  each is re-read from the store (`durable-reread.ts`) immediately before its
  write and its edit re-planned from that copy. CRUD is served on any node and
  the evaluating node's mirror can be a reload tick stale — a whole-row write
  from it would revert an edit the operator saved elsewhere a moment ago. A
  row deleted meanwhile is not written back. The alarm panel's lists are
  re-read (in-process, the authority) at their write.
- **The bound.** A reconcile pass that would act on more than 16 subjects
  prunes nothing and warns (the declared-device sweep's shape).
- **Never widen, never write an empty list.** A non-last id is removed. A last
  id (`conditions.devices`, `systemEvent.deviceIds`, timelapse / digest
  `deviceIds`) and a `deviceState` / `scene` gate on a deleted device are KEPT
  and the rule is switched off. A `cap` step on a deleted device is removed; a
  sequence left with no device step goes, with every button naming it (never
  `enabled:false` on a sequence — a button would still run it). Alarm lists and
  mutes just shrink. Zones, liveness, alerts and history are untouched.
- **Disable ONCE.** The new `notification-center:device-prunes` ledger records
  every prune per (rule, field, subject); a last-id case already recorded is
  never acted on again, so an operator who re-enables the rule is never
  overridden. The same ledger is served by the admin-only `nc.listPrunes`, and
  both UIs show "Disabled on <date>: its last device (#id) was deleted" while
  the rule is still off.
- **Targets** use the same reconcile, against the catalog the DELIVERY path
  already cached (`NcDispatcher.catalogSnapshot`, fresh within its TTL) —
  never a catalog read of its own; an answer is a cache GENERATION, so the same
  cached catalog read on many ticks is one answer. One more condition: the catalog is a concat fan-out across providers and can
  be PARTIAL, so a target is a candidate only when its own provider (remembered
  from an earlier catalog) answered in both absent catalogs. A last target with
  no `targetUsers` (rule) or of a min(1) list (timelapse / digest) is kept and
  the rule switched off.

## Consequences

- A deleted device's kept id stays on a disabled rule until the operator
  removes it — that removal is the operator's explicit choice to widen.
- A deletion made while the evaluating node was down is caught within two
  reload ticks of it coming back, not instantly.
- A target this process never saw in a catalog (deleted before it started) has
  no known provider and is NOT pruned; neither is a provider's LAST target
  (the provider vanishes from the catalog with it). Both are logged nowhere and
  stay dangling — the safe side of D49, stated rather than hidden (one INFO
  line per such target per process: `referenced target is missing but cannot
  be pruned`). A target prune also waits for the delivery path to refresh its
  cache twice; on a hub that delivers nothing, it waits.
- `getDevice === null` has two known answers for a device that is NOT deleted:
  a row that fails `decodeDeviceRow`, and a source id left vacant by a crash in
  the middle of `swapIds`. Both would be pruned (last-id cases kept + disabled,
  so recoverable by the operator); accepted residuals.
- The fresh re-read narrows the lost-update window but does not close it: the
  settings store has no compare-and-set, so an operator save that lands
  between the prune's durable `get` and its `set` of the same row is lost —
  a window of about one settings round trip, on a write that happens only when
  a referenced device or target was actually deleted. Accepted residual.
- A row whose stored copy no longer validates is not written; it is WARNed
  once (per subject, `tags: { deviceId }`) and left out of planning until its
  `updatedAt` changes, so a bad row never costs a second read per tick.
- The ledger grows with rules × deleted subjects; a row whose rule was deleted
  is inert.
- No `@camstack/types` or cap change: the reason lives in an addon-local side
  table because `NcRuleSchema` drops unknown keys on read.

## Enforcement

Specs, each proven by removing its gate and watching it fail:
`device-prune-plan.spec.ts` (never widen), `device-prune-transient.spec.ts`
(second read, one answer is not two, failed/empty refresh, unloaded ledger),
`device-prune-bound.spec.ts` (the 16 bound), `device-prune-idempotent.spec.ts`
(re-enable not overridden, durable guard), `target-prune.spec.ts` (partial
catalog), `device-prune-center.spec.ts` (evaluating node only; reconcile wired
to the tick), and in `packages/system` the `decommission` / `removeDevice`
event-ordering specs. Nothing checks that a FUTURE store holding device ids is
added to the planner — review only.
