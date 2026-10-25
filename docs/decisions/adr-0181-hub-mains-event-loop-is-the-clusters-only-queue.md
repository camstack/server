---
id: D181
title: hub-main's event loop is the cluster's only queue — no read on it may cost more than its answer
status: accepted
date: 2026-08-19
supersedes:
applies-to:
  - packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts
  - packages/system/src/builtins/device-manager/device-meta-store.ts
  - packages/system/src/builtins/device-manager/device-queries.ts
  - server/backend/src/core/addon/single-flight-refresh.ts
---

## Context

[D179](adr-0179-start-means-the-intake-is-open-not-that-the-back-fill-has-finished.md)
left one measurement unexplained. The notification centre's six start reads run
in PARALLEL and all six resolved **in the same millisecond, at t+44.7 s**. That
shape is not latency — distributed latency spreads six answers out. It is a
QUEUE that was 45 s long and then drained in under a millisecond, and the open
question was what the queue was.

**It is not the store booting.** On the 14:57 boot, `sqlite-settings`
initialised at t+1 s — 58 s BEFORE the reads that waited 44.7 s were even
issued. The engine was up the whole time.

**It is not deterministic either, which is what rules out a timeout.** The very
next boot resolved the same six reads in **2.97 s**, and moved the 123 s
somewhere else in the same addon. There is no 45 s constant to find; there is a
saturated resource and a queue position.

**It is hub-main's event loop, and it is 99.9% busy.** `settings-store` is a
singleton owned by `storage-orchestrator`, an IN-PROCESS builtin, dispatching
to `sqlite-settings`, also in-process, on `better-sqlite3` — which is
synchronous. So every store call from every runner and every agent executes on
hub-main's single JS thread, the same thread that answers every UDS handshake
and every cross-runner cap call. A V8 CPU profile of a boot (75 s, 43 639
samples, taken live by `kill -USR1` on hub-main and driving `Profiler.start`
over the inspector socket) says:

| | share of hub-main's JS thread |
| --- | --- |
| `(idle)` | **0.1 %** |
| `getAllAddon` (inclusive) | **64.1 %** |
| `parseJsonUnknown` (self) | 22.7 % |
| `(garbage collector)` | 10.4 % |

Not one 5-second bucket of that profile fell below 62% inside `getAllAddon`.
The same boot logged **128 `UDS request timed out after 60000ms`**, across
pipeline-analytics, recorder, pipeline-orchestrator and the widgets
aggregator — a fully saturated server queues without bound, and 60 s is simply
where the transport gives up.

Attributed to callers, ~89% of that 64% entered through **one class**,
`DeviceMetaStore`, and the reason is arithmetic, not accident:

- `addon-settings` holds 627 KB in 24 rows on the live hub, and **625 KB of it
  is device-manager's three fleet blobs** (`deviceMeta` 467 KB,
  `deviceMetadata` 87 KB, `deviceIndex` 70 KB).
- `getAllAddon` selected on `json_extract(data, '$.addonId')`. That cannot use
  an index, so it pulled every row's `data` out of SQLite and ran a JSON
  extraction over all 627 KB — **for every addon**. A four-key addon's config
  read cost 0.79 ms instead of 0.009 ms, and `getAddonConfig` is on the boot
  path of every `BaseAddon`.
- `DeviceMetaStore` then re-read and re-parsed that 625 KB **per field**.
  `listAll` asked three times (`readMeta`, `readMetadataMap`, `readIndex`), and
  `resolvePersistedById` parsed the whole 974-device map to return one row.
- `listAll` is a FULL-FLEET rebuild wired to `DeviceRegistered`,
  `DeviceMetaChanged`, `DeviceUnregistered` and `DeviceProvisioned` with no
  gate (`AddonRegistryService`'s scope mirror). A 974-device boot fires those
  events once per device, so the hub rebuilt a 974-row mirror roughly a
  thousand times, at three full parses each.

`getAllAddon` also disagreed with its own writer. `setAllAddon` has always
owned the `"<addonId>.<key>"` PRIMARY KEY range — it deletes that range and
re-inserts into it, through `prefixWhere`. Selecting on the JSON body is a
SECOND authority for "this addon's rows", and it is wrong in both directions: a
row inside the JSON's idea of the addon but outside the key range was READ and
never DELETED, and one unparseable row anywhere in the table aborted the
statement, taking out every addon's config read at once.

## Decision

**Nothing that runs on hub-main's event loop may cost more than the answer it
returns, because that loop is the only queue the cluster has.** Three rules,
each of which was violated above:

- **A scoped read uses the SAME key range its writer uses.** `prefixWhere` /
  `prefix-range.ts` is that authority for `addon-settings`,
  `addon-device-settings` and every `"<scope>.<key>"` table. A second predicate
  over the row BODY is not an optimisation question — it is a second definition
  of which rows belong to a scope, and the two definitions drift.
- **A projection of a blob is read once per QUESTION, not once per FIELD.** A
  caller that needs `deviceMeta` and `deviceIndex` asks once and destructures
  (`DeviceMetaStore.readAll`); concurrent callers join the read already in
  flight. Neither is a cache — nothing survives settlement, and a joiner sees
  the snapshot it would have seen anyway.
- **An event that means "something changed" triggers ONE total rebuild, not one
  rebuild per event.** The gate is
  `createSingleFlightRefresh`: one run in flight, at most one queued behind it.
  **No timer.** A debounce would delay the FIRST rebuild, and this particular
  mirror backs scope enforcement — the gate must remove waste, never add
  latency to a fresh grant.

## Consequences

Measured against the live hub's own `addon-settings` table:

| | before | after |
| --- | --- | --- |
| `getAllAddon('device-manager')` | 2.87 ms | 1.98 ms |
| `getAllAddon('provider-wyze')` (4 keys) | 0.79 ms | **0.009 ms** |
| `listAll`'s store cost (3 reads → 1) | 8.67 ms | **1.95 ms** |

Projected onto the profile's own attribution, that is **~37 points of a
fully-saturated hub-main**, before the GC that the discarded parses were
feeding and before the ~1 000 fleet rebuilds the gate collapses. The point is
not the percentage: a queue's delay goes as ρ/(1−ρ), so the whole 45 s is a
consequence of ρ sitting at 1.0, and it is bounded again the moment it is not.

What now has to stay true:

- **`readAll` must stay a read, not a cache.** The moment something survives
  settlement, every writer in `device-meta-actions.ts` — which writes through
  `pctx.settings`, not through the store — becomes an invalidation site, and a
  missed one is a config change that never takes effect. The in-flight join is
  safe precisely because it cannot outlive the read it joined.
- **The mirror gate must never become a debounce.** It backs
  `getPersistedAncestors`, which decides whether a grant on a camera reaches
  its accessory children. Delaying the first rebuild would deny access for the
  window; the current shape cannot, because the first request runs immediately.
- **A new `"<scope>.<key>"` reader goes through `prefixWhere`.** Everything in
  `SqliteSettingsBackend` now does; `getAllAddon` was the last holdout, and it
  was the expensive one because device-manager's blobs live in its table.

## Enforcement

Tests, each confirmed RED by removing its fix:

- `packages/system/src/builtins/sqlite-storage/__tests__/addon-settings-scoped-read.spec.ts`
  — a key `setAllAddon` cannot delete is never returned, and an unparseable row
  belonging to ANOTHER addon cannot break this addon's read. Both fail on the
  `json_extract` predicate; neither can be made to pass while it survives.
- `packages/system/src/builtins/device-manager/__tests__/meta-store-read-amplification.spec.ts`
  — counts `readAddonStore` calls: one per `readAll`, one for four concurrent
  projections, and **two for two sequential reads** (the test that fails if
  anyone turns the join into a cache). A rejected read is not latched.
- `server/backend/src/core/addon/__tests__/single-flight-refresh.spec.ts` —
  the first request runs with no timer, a burst during a run collapses to one
  follow-up, and a rejected run still releases the slot. Neutralising the gate
  fails two; neutralising only the follow-up fails three.

No guard script. "Is this read proportional to its answer?" is not
mechanically decidable, and the shape that was wrong here —
`json_extract` in a `WHERE`, an `await` per field — is legitimate elsewhere.
Review, against this record. What a future session should do instead of
re-deriving the analysis is take the profile: `docker exec CamStack kill -USR1
7`, then drive `Profiler.start` / `Profiler.stop` over
`http://127.0.0.1:9229/json/list` from inside the container. Seventy-five
seconds of a boot answered in one pass a question that two sessions of log
correlation had misattributed twice.
