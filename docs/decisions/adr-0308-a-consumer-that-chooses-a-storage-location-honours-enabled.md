---
id: D308
title: A consumer that CHOOSES a storage location honours `enabled`; one handed a named target does not
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/system/src/builtins/backup-orchestrator/write-targets.ts
  - packages/system/src/builtins/backup-orchestrator/backup-orchestrator.addon.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
  - scripts/check-storage-write-target-enabled.ts
---

> **Extended by [D383](adr-0383-the-enabled-locations-of-a-class-are-its-write-set-and-there-is-no-default.md)
> on 2026-09-07.** This record's rule still holds verbatim — a chooser honours
> `enabled`, a mover handed a named target does not. What changed underneath it:
> `enabled` is now the ONLY write authority (the default is deleted), so "the
> chooser" picks from a pool of several rather than from a pool the default
> could overrule, and the guard named in Enforcement also refuses the deleted
> default's API.

## Context

`StorageLocation.enabled` is the operator's write switch on the Storage screen.
Two consumers honoured it — the recorder's placement pool
(`roots.ts`, `placementPool`) and the event-media pick
(`media-locations.ts`, `pickWritableMediaLocation`). The backup orchestrator did
not, and worse: it had grown a **second** enabled flag of its own,
`backup_destination_policies.enabled`, seeded `true` for every newly-seen
location (`ensureDefault`). So a `backups` location an operator had switched off
was rendered as disabled on the Storage screen and still received the nightly
archive. That is the exact shape [D62](./adr-0062.md) forbids — *"a second
switch that disagrees with the first is worse than no switch"* — re-grown in a
different package, three months later, by omission rather than by intent.

The first framing tried was "every consumer of a storage location must filter on
`enabled`". It is wrong, and it is wrong in the direction that breaks things:

- **Reads, retention sweeps, disk-pressure eviction and drains must be
  unaffected.** A disabled location is *standby*, not *held*: it keeps serving
  playback and it must keep shrinking. Adding an `enabled` filter to
  `collectRangeSegments` or to `domainOf` would turn a retired disk into 2 131
  silently-black segments — the failure this repo already had once, from
  `deleteLocation` rather than from a flag.
- **The relocate movers do not choose.** An operator names `toLocationId`, and
  draining residue *onto* a big archive disk deliberately outside the write set
  is the supported way to retire a volume. Refusing it would force an operator
  to re-enable the very disk they are draining onto.

So the flag's scope is not "a consumer that touches a location". It is "a
consumer that **picks** one".

## Decision

**A consumer that CHOOSES which storage location to write to must exclude every
location with `enabled === false`; a consumer handed a location by name must
not, and logs when the named target is disabled. Reads, prunes, evictions and
drains never consult the flag at all.**

Three corollaries are not optional:

1. **Absent means active.** The test is always against `false`, never
   `=== true`. A location persisted before the flag existed carries no flag and
   stays a write target; a chooser that reads `enabled === true` silently
   retires every legacy row.
2. **The empty case is answered per consumer, and is never silent.** Where a
   class *must* keep writing, the consumer writes under protest and shouts —
   the recorder's `placementPool` falls back to the type defaults and
   `placement-service` warns, because a recorder writing NOWHERE is worse than a
   recorder writing somewhere unwanted. Where a class does not have to keep
   writing, the consumer **refuses** and names what it dropped: the backup
   fan-out throws rather than fan out to nothing, because an archive that landed
   on a retired disk is false safety, and zero enabled backup destinations is a
   legal (if sad) configuration. Event media already refuses loudly. What is
   forbidden everywhere is the third option — writing to a disabled location
   without saying so.
3. **The type default is the one unfiltered write target, and it stays enabled.**
   Every bare-type ref (`storage.write({ location: 'backups' })`) resolves
   through `getDefaultLocation`, which has no `enabled` branch — and must not
   grow one, because the same call serves reads. It is safe only because
   `resolveEnabled` refuses to leave a default disabled and `setDefaultLocations`
   force-enables its target. Hydrate bypasses both, so a persisted row can
   contradict it: the orchestrator reports such a row at boot
   (`reportDisabledDefaults`) and the migration coordinator refuses a drain onto
   it, rather than pouring a six-figure file count onto a disk the operator
   retired.

## Consequences

- `backup_destination_policies.enabled` survives with a **narrower** meaning:
  *this destination takes part in the unattended fan-out*. The location flag is
  the outer gate for every path, including an explicitly requested one. The
  policy flag is not deleted here — that is the design's Stage 4 — but it can no
  longer disagree with the switch the operator can see, and
  `listDestinations().triggerSupported` now reports both gates so a destination
  card cannot claim a sink the fan-out will skip (D62 clause 4).
- An operator who disables a `backups` location and has no other one now gets a
  refusal instead of a backup. That is the intended trade and it is stated on
  the error.
- The relocate mover accepts a standby target and logs a warn naming both
  location ids. A `readOnly` target stays a hard refusal — that flag means "do
  not touch these bytes", in either direction.
- `resolveTargets` no longer routes through `listDestinations()`, so a trigger
  stops reading every destination's `manifests.json` just to learn its own id
  list.
- This is phase 1 of the design *"Enabled locations are the write set"*
  (`docs/design/`, 2026-08-30)
  and deliberately changes nothing else: `isDefault` is untouched, no `hold`
  field is added, `config.readOnly` keeps its meaning. Stage 3 deletes the
  default, and corollary 3 above is exactly the prop that goes with it — the
  guard's `DEFAULT_READERS` list is the inventory that work starts from.

## Enforcement

`scripts/check-storage-write-target-enabled.ts`, wired into the Repository
guards step of `.github/workflows/ci.yml`. Three checks, all syntactic:

1. A non-test source file that enumerates storage locations either consults the
   flag or is listed in `READ_ONLY_LISTERS` with the reason it never picks a
   write target.
2. Every reader of `getDefaultLocation` is listed in `DEFAULT_READERS` with what
   it asks the default for.
3. The three write-target pickers still contain their filter expression, needle
   by needle — the tripwire for exactly the lines the specs disarm.

Plus the specs, each with an observed RED and a per-line disarm:

- `packages/system/src/builtins/backup-orchestrator/__tests__/disabled-location-receives-no-archive.spec.ts`
  — drives the REAL addon and asserts on which location ids reach
  `storage.beginUpload`.
- `packages/system/src/builtins/storage-orchestrator/__tests__/disabled-location-is-never-a-write-target.spec.ts`
  — the `isDefault ⇒ enabled` invariant, the hydrate shout, the drain refusal.
- `packages/addon-pipeline/src/recorder/__tests__/relocate-onto-a-standby-location.spec.ts`
  — the mover accepts a standby target and says so.
