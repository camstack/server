---
id: D185
title: A forked addon's settings row holds CONFIG — a workload gets its own collection
status: accepted
date: 2026-08-19
supersedes:
applies-to:
  - packages/addon-pipeline/src/durable/row-map-store.ts
  - packages/addon-pipeline/src/recorder/addon/config-store.ts
  - packages/addon-pipeline/src/recorder/addon/export-store.ts
  - packages/addon-pipeline/src/recorder/addon/ops-log-store.ts
---

## Context

[D182](adr-0182-a-fleet-is-rows-not-a-blob-and-a-per-device-question-costs-one-row.md)
removed the device-manager's half of the blob problem. This record removes the
other half, which is the same shape reached through a different door.

A HUB BUILTIN's `ctx.settings` is `ConfigManager.createSettingsView`
(`getAllAddon` / `setAllAddon`, one row per key in the UNSCOPED
`addon-settings`). A FORKED addon's is `addon-context-factory`'s
`readBlob`/`mergeBlob('addon-settings', 'root', <addonId>)` — **one row**,
`<addonId>:addon-settings` / `root`, holding every top-level key the addon has
ever persisted. Two of those rows were carrying a workload:

| row | size | what was in it |
| --- | ---: | --- |
| `recorder:addon-settings` / `root` | **201 833 B** | `recordingOpsLog` 147 437 (500 rows) · `recordingExports` 50 441 (55) · `recordingConfigs` 2 468 (17) · `recordingPlacement` 1 405 |
| `stream-broker:addon-settings` / `root` | **33 155 B** | `probeSnapshots` 17 282 (109) · `rtspTokens` 13 147 (243) · `profileMap` 2 306 (29) · `deviceOverrides` 354 |

`BaseAddon.state(key, …)` hands out a `DurableState` over ONE key of that row,
but every `get()` parses the whole row and every `set()` rewrites it. So asking
what camera 102 records parsed 201 KB, and the export engine's once-a-second
`progressPct` patch read, parsed, re-serialised and rewrote 201 KB to move one
integer. `BaseAddon.resolveConfig` reads the same row.

The first fix was at the CALL SITE: the staging walk was taught to read the
config map once instead of once per device (2026-08-18), which took it from
267 s to 518 ms. That is the part worth recording — it looked like the fix, and
it left all 201 KB exactly where it was for every other reader.

There is a second failure the size hides. The blob's `safeParse` is
whole-value: one unparseable camera took `RecordingConfigsBlob` to its empty
fallback, which reads as **every camera unconfigured**. And a read-modify-write
of a shared row loses concurrent writes — on 2026-08-14 a `createExport` for
camera 101 landed between a progress patch's read and its write, the row was
erased, and the scheduler re-queued the vanished job forever.

## Decision

A key of an addon's `root` settings row holds CONFIGURATION — values an
operator sets, bounded by the number of settings the addon has. A key whose size
grows with cameras, jobs or events is a workload and gets its own declared
collection, one row per unit, through `RowMapStore`: `id` (the map key) + the
columns the owner projects + `value` (the validated payload as JSON).
Validation is per ROW. Six keys moved:

| collection | row | class |
| --- | --- | --- |
| `recorder:ops-log` | one operation | audit |
| `recorder:exports` | one export job | ledger |
| `recorder:recording-configs` | one camera | config |
| `stream-broker:probe-snapshots` | one broker | mirror |
| `stream-broker:rtsp-tokens` | one broker | ledger |
| `stream-broker:profile-map` | one camera | config |

`recordingPlacement`, `rtspEnabled` and `deviceOverrides` STAY blob keys, and
not because they are small. The last two persist by REPLACING the whole map
from a set that shrinks whenever a broker unregisters; on rows that is a prune
driven by a shrinking read, which is how an unbind becomes a wipe (D130, D49) —
and `rtspTokens` carries a comment about exactly that loss. Moving 0 bytes and
354 bytes is not worth buying it. The row survives regardless, because it is
also where `resolveConfig` reads the operator's fields.

## Consequences

- **A row fails alone.** One unparseable entry is skipped, loudly and with a
  count; the map is not lost. That is strictly better than what it replaced and
  it is why the schema is applied per row rather than per map.
- **A whole-map read must name its own bound.** `settings-store.query` caps an
  unbounded read at 2 000 rows SILENTLY. Every spec here sets `loadLimit`, and
  `RowMapStore.readAll` warns when the result comes back full — a truncated map
  the caller believes is complete is how a retention sweep deletes 5 000 of
  40 000 rows and reports success.
- **A per-row upsert does not order two writers of the SAME row.** It removed
  the cross-export clobber; `patchExport` is still read-merge-write, so the
  serialiser stays — now keyed per export id rather than per handle, so two
  exports no longer queue behind each other.
- **`replaceAll` is opt-in and it SAYS what it dropped.** Only an owner holding
  an authoritative set may call it (`profileMap`'s persister, the probe flush).
  The blob's whole-value write did the same deletions in silence.
- **`RowMapStore` is not `DurableLedger`.** The ledger exists for a value a
  DECISION is gated on, so it mirrors into RAM and never lets a fallible read
  change a verdict. These maps are read on demand and a keyed read is already
  one row; a mirror would add a staleness surface for nothing. A value that
  gates work still belongs on the ledger.
- **The payload column is `value`, never `data`.** A declared collection whose
  only non-PK column is `data` is the settings engine's KV-blob shape and would
  silently stop destructuring the projected columns. `id` + `value` is the
  existing `notification-center:meta` shape.
- **The cutover is not automatic.** `scripts/migrate-recorder-broker-blobs.mjs`
  is an offline pass run with the hub STOPPED. Each addon retires its own keys
  (`retireRootKeys`) at the first boot that finds the successor collection
  non-empty — never before, because until then the key is the only copy, and
  never on a read fault, because a fault answering "empty" would rewrite the row
  to `{}` and take the operator's config with it.
- **The purge runs in the OWNER, before any persister is wired.** It is a
  whole-row replace through `settingsStore.set`, which bypasses the kernel's
  per-(collection, key) read-modify-write serialiser; later in the boot a
  concurrent `mergeBlob` would be lost. The framework's own
  `purgeRetiredSettingsKeys` cannot do this job: it runs inside the settings
  engine, before any addon has declared anything, so the evidence check would
  find every successor unreadable forever.
- **A failed `declareCollection` is NOT swallowed here.** The segment-hour
  ledger's is, because it fails toward a disk walk. A recorder that cannot read
  `recorder:recording-configs` reads every camera as unconfigured and records
  nothing; a broker that cannot read `stream-broker:rtsp-tokens` reissues every
  token and kills every external NVR URL. Crashing is bounded by
  `CrashSupervisor` (D6); silence is not.

## Enforcement

- `packages/addon-pipeline/src/durable/__tests__/row-map-store.spec.ts` pins the
  read/write SHAPE against the real `SqliteSettingsBackend` on `:memory:`: one
  keyed `get` per entry question, one bounded `query` per map question, one
  `set` per write, the skip-one-row failure direction, the truncation warning
  and `tags: { deviceId }` off the projected column.
- `.../__tests__/retire-root-keys.spec.ts` pins the four refusals — empty
  successor, unreadable successor, failed root read, exact-match only. Removing
  the evidence gate fails two of them.
- `.../recorder/addon/__tests__/export-store.spec.ts` pins the per-ID
  serialiser: two patches of the same export. Removing it fails that test and
  nothing else, which is what makes it worth having.
- Every collection carries a `@durable` annotation, so
  `scripts/check-durable-state-declared.ts` fails a new one that does not say
  what class of fact it holds. `check-collection-namespacing.ts` fails a bare
  name; `check-collection-declarations.ts` fails a collection used but never
  declared.
- The blob shapes are unrepresentable: `RtspTokensSchema`, `ProfileMapSchema`
  and their types are deleted, so reintroducing them is a type error rather than
  a review catch.
