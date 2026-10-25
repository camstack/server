---
id: D293
title: "A location is deleted only after it is verified EMPTY — and 'could not check' refuses too, overridably"
status: accepted
date: 2026-08-29
supersedes:
applies-to:
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts
---

## Context

`deleteLocation` checked three things — that the id exists, that the location is
not `isSystem`, and that it is not the last default of its type
(`storage-orchestrator.service.ts:588`). Nothing stopped deleting a location
that still held the archive.

That is not theoretical. This hub carries **2 131 ghost `recordings:high`
segments**: index rows naming a location the record no longer has.
`collectRangeSegments` drops every row whose `locationId` it cannot resolve
(`recording-provider.ts:404`), and playback does not `stat` — that syscall per
segment was removed deliberately (`recording-provider.ts:425`). So the operator
does not get an error. They get a **silent black window**, months later, with
nothing pointing back at the delete.

It is the most direct way to lose an archive mid-migration, and a non-blocking
migration makes it *more* reachable: the source location sits drained-looking
and no longer default for the whole drain, which is exactly when someone tidies
it away.

**What does not work as the check.** `storage-evictable.getEvictableUsage` is
the obvious existing seam and is wrong twice over: `domainOf` SUBTRACTS
read-only members (a location marked read-only for a drain reports 0 bytes) and
it aggregates the whole physical-root DOMAIN, so it over-reports for one alias
and under-reports for another. A cap that answers "how much is evictable here"
cannot answer "is anything here".

## Decision

**`deleteLocation` consults an occupancy probe and removes the record only on a
verified `'empty'`.** The probe is tri-state, and the third state is the point:

- `'occupied'` — refuse.
- `'empty'` — proceed.
- `'unknown'` — **refuse.** A read that failed has not established that a
  location is empty (D49). A `null` probe and a probe that throws both answer
  `unknown`, so a service wired without one refuses rather than permits: a check
  that defaults to "permit" is a paragraph, not a guard.

**`force: true` overrides both refusals, and is logged with what the check
saw.** This is deliberate, not a hedge. The probe is best-effort by
construction — a location on another node, behind a remote provider, or on a
disk that was physically pulled answers `unknown` *forever*. A refusal an
operator cannot override is its own failure mode, and it would make a removed
disk unremovable from the UI. The override is reachable where the refusal is:
both admin-UI delete flows catch the refusal and offer a second, explicit
"Force delete" confirm carrying the orchestrator's own message.

## Consequences

- **The probe measures BYTES ON DISK, not durable rows.** It is a shallow
  `readdir` of the location's `basePath` — one syscall, never a walk, because a
  `find`-style walk of a saturated recordings volume is itself an outage (one
  hung on this hub on 2026-08-29). So it refuses a location holding orphan files
  no index names, and it would permit a location with rows but no bytes. Both
  directions are the safe one for the failure this exists to prevent, and
  `force` covers the first.
- **What it cannot see is `unknown`, never `empty`:** a location pinned to
  another node, a remote provider, a location with no `basePath`. A missing root
  (`ENOENT`) IS `empty` — if the record's own path does not exist there is
  nothing this delete can strand. Every other errno refuses.
- **`deleteLocation` is now async**, and the `storage` cap's input carries an
  optional `force`. Existing callers keep compiling; existing behaviour changes
  only in that a delete can now be refused.
- **`force` does not override the last-default guard.** Deleting the only
  default of a type leaves consumers with nothing to fall back to, which is a
  different failure and stays absolute.
- **A migration still must not delete its source.** This guard makes the mistake
  refuseable, not impossible — the coordinator has never deleted a location and
  must not start.

## Enforcement

`packages/system/src/builtins/storage-orchestrator/__tests__/storage-orchestrator.spec.ts`
— seven cases: empty permits, occupied refuses, unknown refuses, no-probe
refuses, a throwing probe refuses, `force` overrides, and `force` does NOT
override the last-default guard. Each was disarmed: reverting the occupancy
branch fails four, reverting `null → 'unknown'` fails one, reverting the catch's
`'unknown'` fails one, reverting the `force` branch fails one.

Nothing enforces that the PROBE stays cheap. If it ever becomes recursive it
becomes an outage on a full recordings volume; that is review-only.
