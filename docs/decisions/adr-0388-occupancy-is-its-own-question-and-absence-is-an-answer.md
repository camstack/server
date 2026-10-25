---
id: D388
title: How much CamStack holds on a location is its OWN question — and absence is an answer
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/types/src/capabilities/storage-occupancy.cap.ts
  - packages/types/src/interfaces/storage-location.ts
  - packages/system/src/builtins/storage-orchestrator/location-occupancy-slice.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts
  - packages/system/src/builtins/backup-orchestrator/backup-orchestrator.addon.ts
  - packages/addon-pipeline/src/recorder/storage-evictable-provider.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-occupancy.ts
---

## Context

`storage.listLocations` stamps `capacity` — the volume's total and free, from
statfs. It has never carried the other half of the operator's question: of that
volume, how much is OURS? The admin UI paints that as a distinct segment of each
location's capacity bar and could only do it for `recordings` and
`recordingsLow`, because `recording.getStorageUsage().locations[].usedBytes` was
the only source that existed. For `backups`, `eventMedia` and artifact locations
the UI omitted the segment entirely — correctly, since a share drawn at zero
claims we occupy nothing.

The obvious move was to reuse `storage-evictable.getEvictableUsage`, which looks
like the same question. It is not, in two ways, and both of them are worst
exactly where the figure is most wanted:

- **it reports the eviction DOMAIN, not the location.** `recordings:default` and
  `recordingsLow:default` deliberately share one root and evict as one
  oldest-first pool, so both answer with the same combined total. Stamped as
  occupancy that double-counts the disk.
- **it reports ZERO for a location whose eviction policy is `never`** (D385) — a
  `readonly` or `disabled` disk. Those are the disks an operator retiring
  hardware is staring at, and the answer would have been "empty".

And backups cannot register `storage-evictable` at all: nothing there is
evictable under disk pressure, retention is by COUNT. A cap whose contract is
"what may I delete" has no honest answer for it.

## Decision

Occupancy is its own contract: a new internal collection cap
`storage-occupancy`, one method, `getOccupancy({ locationIds })`. Its quantity is
**bytes HELD** on that location — not the eviction domain's, not net of what the
owner would be willing to delete. A provider that can only answer "evictable"
must not register: a number that silently means different things per class is
worse than no number.

The orchestrator merges every provider's reports and stamps
`StorageLocation.owned` next to `capacity`, so every surface reads one row.

**Absence is the answer (D315).** A location no provider reports for is
UNKNOWN. There is no `?? 0` anywhere on the path: a provider that throws
contributes nothing and is logged; a provider that holds nothing on a location
OMITS it; the slice has no entry; the orchestrator omits the field. `owned` is
an OBJECT (`{ bytes, measuredAtMs }`) rather than a bare number specifically so
that a `?? 0` on the consuming side has to be written out loud instead of
appearing by accident. `measuredAtMs` is the OLDEST contributing measurement —
honest about the whole figure rather than about its freshest part.

**Cost: the slice has a window, the read never waits (D224).**
`listLocations` is on the admin UI's hot path, so it serves from the last
completed refresh and kicks a background one when that is older than 60 s. A
read is answered from the slice — empty included — and never joins a refresh in
flight, so a slow or dead addon costs a stale figure and never the screen. No
provider walks a filesystem: the recorder sums the hour ledger, analytics runs
one indexed aggregate per location, backups sum each destination's own manifest.

Legacy `eventMedia` rows stamped `locationId: null` are attributed by the same
rule `resolveRef` uses — sole location of the type, else the `:default`-slugged
one — and by NOTHING else. When neither applies, the bytes are reported nowhere
and logged. Spreading unattributable bytes over the candidates would put a
number on a screen that no disk agrees with.

## Consequences

- Three providers register: the recorder (footage), pipeline-analytics (event
  media, including the gallery location) and the backup orchestrator (archives).
  A location owned by none of them — an artifact or model location — stays
  unknown, and the UI omits the segment. That is the designed outcome, not a
  gap: adding a class is adding a provider.
- The recorder's `StorageEvictableProvider` now implements two caps over one
  archive. They stay separate caps because they are separate quantities; the
  class docblock says so, and `getOccupancy` names the two differences.
- **The UI's `resolveOwnedBytes` / `MEASURED_USAGE_TYPES` gate collapses.** That
  seam exists only because `recording.getStorageUsage()` was the sole source and
  only covered two types. With `owned` stamped it becomes a read of the stamped
  value, and `MEASURED_USAGE_TYPES` goes away — a location is measured when it
  carries `owned`, not when its type is on a list. **Whoever merges must not
  leave both alive**: two sources for one figure is how they start disagreeing.
- `@camstack/types` and `@camstack/system` ship inside the published
  `@camstack/server` closure, so the cap and the stamp are not live until a
  server containing them is installed on all three nodes. The two addon
  providers additionally need their addons deployed.

## Enforcement

Tests. `packages/system/src/builtins/storage-orchestrator/__tests__/location-occupancy-slice.spec.ts`
pins the distinction that matters — a location nobody reported for, and a
provider that threw, are both UNKNOWN and never zero — plus the merge, the
oldest-measurement rule and the serve-and-revalidate discipline (a read answered
while a refresh is in flight).
`packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-occupancy.spec.ts`
pins the legacy attribution, including the refusal to place bytes it cannot
place.

No guard script: the shape that prevents the bug is the TYPE — an optional
object field with no default — and a grep for `?? 0` across the repo would be
noise. If a `?? 0` ever appears on this path it will be in a diff that also
changes `owned`, which is where review can see it.
