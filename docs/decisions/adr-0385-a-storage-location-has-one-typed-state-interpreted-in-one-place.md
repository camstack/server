---
id: D385
title: A storage location has ONE typed state, interpreted in ONE place
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/types/src/interfaces/storage-location-mode.ts
  - packages/types/src/interfaces/storage-location.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts
  - packages/system/src/builtins/storage-orchestrator/location-store.ts
  - packages/system/src/builtins/storage-orchestrator/storage-cleanup-coordinator.ts
  - packages/system/src/builtins/storage-orchestrator/location-protection.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/location-resolve.ts
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-locations.ts
  - scripts/check-storage-location-mode-single-owner.ts
---

## Context

A location's state lived in two authorities that nobody had written down
together:

- `StorageLocation.enabled` — THE write switch since D383. A `false` location
  was not a write target, was still read, was still age-swept, and **was still
  evicted under disk pressure**.
- `config['readOnly']` — an untyped key on the provider config blob. Also not a
  write target, also still read, and **deliberately EXCLUDED from disk-pressure
  eviction**, because the relocate mover that empties a retiring disk must not
  race the evictor deleting oldest-first on the same disk.

So the two flags an operator sees as "off" and "draining" meant different things
to the evictor, and neither name said which. Six consumers re-derived the
difference by hand — the recorder's placement pool, the recorder's evictable
provider, the cleanup coordinator's `footageFrozen`, the relocate engine's
destination refusal, the event-media pick, the admin UI — and they did not
agree. Two examples that shipped:

- the relocate engine REFUSED a `config.readOnly` destination and ACCEPTED an
  `enabled: false` one with a warning. One question, two answers, in adjacent
  lines of the same function.
- `resolveLocationThresholds` and `resolveLocationMaxUsedBytes` iterated every
  location with no filter on either flag, so a location the operator had taken
  out of service still carried a live disk-pressure policy — which was correct
  for one flag and wrong for the other, by accident rather than by decision.

Adding a third flag for "drain until empty" to that pair was the change that
forced this: there is no combination of two booleans that expresses four states
without a table, and the table did not exist anywhere.

## Decision

A storage location has ONE state, `StorageLocation.mode`, with four values, and
exactly one module in the repo may interpret it —
`packages/types/src/interfaces/storage-location-mode.ts`. It answers three
questions and nothing else:

| mode       | write | read | eviction                        |
| ---------- | ----- | ---- | ------------------------------- |
| `active`   | yes   | yes  | `normal` (pressure + usage cap) |
| `readonly` | no    | yes  | `never`                         |
| `drain`    | no    | yes  | `drain` (paced, until empty — D386) |
| `disabled` | no    | no   | `never`                         |

`enabled` survives one release as a DERIVED mirror (`mode === 'active'`), and
`withLocationMode` is the only writer of either — which is what makes it
impossible for them to disagree. `config.readOnly` is DELETED at the stamp.

**The migration runs ONCE at hydrate**, the way the orchestrator already stamped
flagless `enabled` rows (D383): `config.readOnly === true` → `readonly` and the
key is removed; `enabled === false` → `readonly`; everything else → `active`.
Both legacy flags fold to `readonly` because that is the CONSERVATIVE direction
— a state change must never start deleting footage on its own (`drain` would),
and must never make footage that was still being served disappear (`disabled`
would). No legacy combination can produce `drain` or `disabled`; that property
is asserted exhaustively rather than by example, because it was independently
guessed the other way while this was being built.

On the live hub every location is enabled with no `readOnly`, so the migration
stamps `active` and changes nothing else. It is a no-op in practice and is built
as one — no versioning, no ceremony, no backfill job.

**A read that names a `disabled` location is reported UNAVAILABLE**, never as an
unknown location. `requireReadableLocation` is the one resolver and it says
which of the two it is. This is the single change in the model that can turn an
operator's own choice into what looks like a fault, so it has its own test file.

**One GB unit.** Every storage figure an operator types converts through
`gbToBytes` — BINARY, 1024³. The repo shipped both: the orchestrator's
`maxUsedGb` cap used 1024³ while the recorder's placement headroom used 10⁹ for
the same stored key, so a location with a cap set was silently 7.4% off
depending on which side of the pipe asked. The persisted values were entered
against the binary unit, so that is the one that stays; the new `minFreeGb`
uses it too.

**`minFreeGb` is the operator-facing protection criterion**, converted to the
percentage the pressure guard already speaks using the volume total the
orchestrator can already stat. `minFreeGb` wins over `minFreePercent` when both
are present and the redundancy is logged once per location per process.
`maxUsedGb` stays in the model but stops being an operator knob — it is the
internal lever the drain ratchet drives (D386).

## Consequences

- Two behaviours change, both deliberately, and neither can be preserved
  because the states they distinguished are now one state:
  - **The relocate mover refuses a non-`active` destination.** Draining residue
    onto an out-of-write-set archive disk used to be allowed-with-a-warning;
    it now requires making the destination `active` first. That is one click on
    the same screen, and the storage screen then agrees with where the bytes
    went instead of contradicting it.
  - **Placement REFUSES when a class has no `active` location** instead of
    "serving under protest" on a frozen one. Writing onto a disk the operator
    froze fights the relocate mover emptying it. The orchestrator refuses to
    leave a write-serving class with no `active` location, so this is reachable
    only through a hand-edited store — and it is loud, not silent.
- `resolveLocationThresholds` / `resolveLocationMaxUsedBytes` now skip only
  `disabled`. `readonly` and `drain` keep their entries: the map says what the
  policy IS, and the recorder's evictable provider is what refuses. Dropping the
  entry would make the map say "no policy here", which is a different claim.
- The pipe still carries `enabled` for one release, so a hub mid-upgrade behaves
  identically in both directions. When the mirror goes, `legacyModeOf` and the
  `stateOf` fold in `roots.ts` go with it.
- `@camstack/types` and `@camstack/system` travel inside the published
  `@camstack/server` closure, so **none of this is live until a server
  containing it is installed on all three nodes** — hub, the Unraid agent and
  the Mac Mini agent. Deploying the pipeline addon alone changes nothing.

## Enforcement

`scripts/check-storage-location-mode-single-owner.ts`, wired into
`.github/workflows/ci.yml`. It fails the build when anything in the
storage-location trees reads `config['readOnly']` or compares `enabled`
directly, and when the policy module stops exporting the three questions or the
fold. `packages/addon-admin-ui` is not scanned yet — the storage screen moves
onto `mode` in the same release train, and a guard that fails on the half that
has not landed teaches people to disable guards.

`scripts/check-storage-write-target-enabled.ts` (D383) still pins the exact
filter expression in each write-target picker; its needles were updated to the
policy calls.

Tests: the policy table state by state and the exhaustive legacy fold
(`packages/types/src/interfaces/__tests__/storage-location-mode.spec.ts`), the
disabled-location read
(`packages/addon-pipeline/src/recorder/addon/__tests__/disabled-location-read.spec.ts`),
and the GB unit plus the protection criterion
(`packages/system/src/builtins/storage-orchestrator/__tests__/location-protection.spec.ts`).
