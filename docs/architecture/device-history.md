---
title: device-history — the one mechanism for numeric history
last-verified: 2026-10-23
applies-to:
  - packages/system/src/builtins/device-history/runtime/history-runtime.ts
  - packages/system/src/builtins/device-history/capture/capture-engine.ts
  - packages/system/src/builtins/device-history/rollup/rollup-engine.ts
  - packages/system/src/builtins/device-history/query/history-query.ts
covers:
  - packages/system/src/builtins/device-history/**
  - packages/types/src/capabilities/device-history.cap.ts
  - packages/types/src/history/**
---

# device-history

Every numeric history in CamStack goes through the `device-history` addon and
its store, `history.db` ([D850](../decisions/adr-0850-numeric-history-has-one-mechanism-device-history.md)).
It is hub-only, runs in its own runner (never grouped, D29) and writes through
the settings door with `database: 'history'`, so its work is served by the
`history` thread of the engine and never queues behind configuration reads
(D851, [storage-files.md](storage-files.md)).

**Install state.** It ships as a protected system builtin inside
`@camstack/system` (same closure as the hub kernel — no separate addon deploy).
A hub without the builtin enabled has no `history.db` (the file is created by
the first declaration that names it) and no behaviour change.

## What it records

| Source | How a series comes to exist | Ingest |
| --- | --- | --- |
| A capability field | the `history` block of a `*.cap.ts`, projected into the generated `HISTORY_CATALOG` (P2). Key `cap:<capName>.<fieldPath>` | change-only points captured hub-side from `DeviceStateChanged` |
| An item of a keyed array | `history.items` of a `*.cap.ts` (D917), projected into `HISTORY_ITEM_CATALOG`. Key `cap:<capName>.<path>[].<field>`, SCOPE = the item's key | as a capability field, per item |
| A producer's series | `declareSeries` → `addon:<callerAddonId>/<name>` | `record` (points, low rate) or `recordBuckets` (closed 5-minute buckets) |
| Energy | `derived:energy.kwh`, computed at READ time from the device's power meter, never stored (below) | — |

Kinds: `gauge` (a level), `counter` (a monotonic meter; a drop is a reset),
`boolean` (0/1) and `enum` (a state, D896). An `enum` stores the ORDINAL of its
value in the metric's value list (`enum_values`), which is APPEND-ONLY: codegen
projects a `z.enum` field's values into the catalog and a boot appends the ones
the stored list lacks, so reordering a `z.enum` never changes what a stored
ordinal means. A `z.string` enum field (`enum-sensor.value`, whose options are
per device) learns its values as they are first seen, at most `MAX_ENUM_VALUES`
(1 024) per key across every device; past that a new value is refused and
counted `enum-overflow`. A learned value is stored before the first point that
uses its ordinal. Producers declare `gauge` / `counter` / `boolean` only.

A device is recorded only if it is a REAL device (not `hub`, not `container`),
default ON, per-device opt-out owned by this addon
(`getDeviceEnabled` / `setDeviceEnabled`; D62: the switch stores nothing elsewhere).

## Capture rules (cap fields)

`capture/capture-engine.ts`, decision in `capture/capture-filter.ts` (pure):

1. A cap or field with no catalog entry is ignored, uncounted (the common case).
2. Opted-out device: skipped, counted `opted-out`. Device type unknown: the slice
   is PARKED and replayed once `getDevice` answers (`unknown-device` if it never
   does). `hub` / `container`: skipped, counted `not-a-real-device`.
   `excludeDeviceTypes` (`motion.detected` is not recorded for cameras): counted
   `excluded-device-type`.
3. A value that is not a finite number (or boolean for a boolean field, or a
   non-empty string for an enum field) is not a reading: `null` is UNKNOWN and
   never becomes 0. A field with `skipWhenSet: '<sibling>'` is not read while
   that sibling is set (an `enum-sensor` with `timestamp: true` carries a timestamp).
4. Against the last RECORDED value (seeded from the newest raw row at boot, so a
   restart repeats nothing): the same value is `unchanged`; a change smaller than
   `deadband` (absolute) or `deadbandPct` (of the last recorded value) is
   `deadband` (a slow drift still adds up, because the comparison is against what
   was recorded, not what was last seen); a change inside the capture floor
   (`minIntervalMs`, default 10 s for gauges and counters, none for booleans
   and enums, 30 s on power-meter fields) is kept PENDING and emitted when the floor ends,
   stamped where the floor ended (`trailingEmitted`). The end of a burst is
   never lost.
5. Points are buffered and written with one batched `upsertMany` every 10 s. A
   failed write keeps the batch; points older than 60 s are dropped, and so are
   the OLDEST points once the queue passes 100 000 (a flush that hangs must not
   grow it without limit). A drop logs one ERROR with the count, one tagged
   `deviceId` line per device (at most 10, and not more often than every 10 s),
   and tells the capture engine, which forgets that it ever "recorded" those
   values: otherwise the next change-only comparison runs against a value that was
   never stored and the hole lasts until the value moves. The next reconcile
   re-emits them.

**Reconcile** every 5 minutes (D8, D49): `deviceState.getAllSnapshots` once; a
field whose value differs from the last recorded gets a point stamped `now`
(`reconciledPoints`); the capture floor does not apply to it. A FAILED read
changes nothing: it is counted (`reconcileFailures`), logged, and the next pass
tries again. The first successful reconcile after boot also writes the baseline
of every series that has none, and sets `ready`.

## Keyed arrays (D917)

`history.items: { path, key, label?, fields }` records one series per (item
field, item key) of an array such as `consumables.items`: the item key is the
series scope, so store, rollups, retention and queries treat it like any
scoped series. Item fields (and their `skipWhenSet`) are paths
INSIDE the item; the guard judges them against the item schema. An item with
no string key (or one over 128 characters) is skipped and counted
`item-key-invalid`; past 64 items per slice the rest are counted
`item-overflow`. An item that appears later gets its series on its first
reading. `listSeries` names an item series `<item label> · <field name>` from
the device's current slice, and falls back to the key when the item is gone.
`consumables` records `level` (%), `status` (enum) and `remaining.value`
(unit from the item's `remaining.unit`).

## Producer door

The capability's readiness (`system.ready-state`) is the STORE being open,
not the provider being registered: the provider registers at `onInitialize`,
answers "device-history is starting" until `onHubReachable` has opened the
runtime, and only then emits `ready` (`autoEmitReadiness` is off). A producer
declares its series on `ready`; the automatic emit at registration sent every
producer into "starting" on each boot.

`declareSeries`, `record`, `recordBuckets` are `admin`-tier methods; an addon's
`ctx.api` call bypasses the tier. Ownership is the transport-stamped
`callerAddonId` (never in an input schema): a key outside the caller's own
prefix is `not-owner`, as is an unidentified caller. Refusals are returned per
(key, reason) and counted: `undeclared`, `not-owner`, `opted-out`,
`not-a-real-device`, `rate` (more than one point per 10 s per series and
scope, sustained — a point may land up to 1 s before its slot, so a producer
ticking at exactly 10 s with timer jitter is never refused; the slot grid
advances from the slot consumed, so the slack is not a rate raise),
`ingest-mismatch`, `out-of-range` (future, older than the raw
retention, or a bucket not aligned to 5 minutes).

`recordBuckets` is an idempotent upsert keyed (series, bucketStart), written
BEFORE the call returns, so a store failure reaches the producer, which
re-queues (`BucketAccumulator` in `@camstack/types/history`, D58).

## Rollups

`rollup/rollup-engine.ts` (marks, ticks, recomputes) over `rollup/rollup-math.ts`
(pure). Every rollup is a RECOMPUTE from the tier below, never an increment, so a
restart, a repeat or a late write gives the same row.

| Tier | Built from | When | Alignment |
| --- | --- | --- | --- |
| 5m (point series) | raw rows of the bucket | bucket closed + 30 s | UTC |
| 1h | the hour's 5m rows | hour closed + 5 min | UTC |
| 1d | the day's 1h rows | hub-local midnight + 15 min | hub-local midnight (23, 24 or 25 h across DST) |

An `enum` row also carries `state_ms`, JSON `{ "<ordinal>": ms }`: the time
spent in each state over the bucket, the gap before it credited to the state
held into it, so an hour's states sum to the hour.

`tw_sum` / `tw_ms` give the time-weighted mean of a change-only gauge
(4m59s at 50 and 1s at 100 is ~50, not 75; for a boolean it is the fraction of
time true). A quiet bucket has no row, and the value in force across it is the
last one before: both operations are given that held value and credit the gap
with it, and it also counts toward `min`/`max` when it was in force at a bucket
start. A producer bucket has `tw_sum`/`tw_ms` NULL.

A write marks the bucket above dirty; a late `recordBuckets` into an already
rolled hour just marks it again. The dirty sets are memory: at boot
`bootRecompute` rebuilds the last 3 hours from raw (the still-open bucket
included, time-weighted up to now) and re-marks the 1h / 1d buckets of that
window. A tick handles at most 400 series per tier.

## Retention

Global addon settings, defaults raw 7 d, 5m 30 d, 1h 365 d, 1d forever
(`dayDays` 0 = forever). `retention/retention.ts` every 10 minutes: per series
and tier a PRIMARY KEY range delete (`series_id = ? AND ts BETWEEN 0 AND cutoff-1`;
a row exactly at the cutoff is kept), visiting a series again only after the
cutoff has advanced by an hour (raw, 5m) or a day (1h, 1d). Every delete is
SLICED by time (a day for raw and 5m, 30 days for 1h and 1d) with a yield to the
event loop between slices, so one statement never holds the history thread for a
backlog; a purge deletes tier by tier in the same slices before the series row.

**Purging a departed device (D49).** A device listing that answered is not a
complete one: after a hub restart a provider that is still booting leaves its
devices out of a successful `listAll`, and change-only capture means a stable
series was last written days ago while its device is alive. So a listing may only
move a clock (`retention/departure-tracker.ts`, table `device-departures` in
`camstack.db`): the first successful listing that misses a device records WHEN,
any listing that shows it clears the record, and a series is purged only after
the device has been absent from EVERY successful listing for 7 days. The clock is
persisted, so a restart neither resets it to now nor reads it as old, and the
series' own `last_ts` is never consulted. The `device.unregistered` event is not
used: it is telemetry that may be dropped, and a provider that restarts emits it
for devices that come back. An opted-out device keeps its history until retention
ages it out.

Per-series state (last recorded value, pending point, rate limit, dirty marks,
retention markers) is released when a series is purged.

**Orphan series (D917).** `listOrphanSeries` (admin) REPORTS device series no
longer linked to a device: `device-gone` while the departure clock above runs
for the device, `undeclared` when the `cap:` key is declared by no catalog
(a removed cap field, such as the pre-D915 `vacuum-control` tank levels).
Each entry carries its rows per tier, counted per series on the primary key
(asserted by `history-query-plans.spec.ts`), at most 200 per call
(`truncated`). `deleteOrphanSeries` (admin) deletes by id, re-judging each id
at that moment (a device that came back is refused `not-orphan`), tier by tier
in the retention slices, then the series row; every deletion logs one line
tagged `deviceId` with the rows deleted. `undeclared` is judged against the
catalogs, not the device's bindings. The admin sees them on System → History:
a notice drawn only from an answered, non-empty listing opens a review dialog
that deletes the selection in batches of 50 and shows each row's outcome
(`packages/addon-admin-ui/src/components/history/OrphanSeriesNotice.tsx`).

## Query

A device read takes a FLAT top-level `deviceId` (`listSeries`, `query`,
`getDeviceEnabled`): the generated device selector, and so the scope gate, only
sees top-level ids, and a principal limited to one device must not read another's
history. Node series are separate admin-only methods (`listNodeSeries`,
`queryNode`) whose subject is `forNodeId`: a top-level `nodeId` is the cap
ROUTING key, and `nodeId: 'agent-a'` used to send the read to that agent,
which hosts no device-history. `queryMany` (admin) answers up to 24 reads
(`{ deviceId | forNodeId, key, scope? }`) over one window, in order, one entry
per item (`{ ok: true, result } | { ok: false, error }`).

`query` with `resolution: 'auto'` picks the finest tier whose retention covers
`from` and whose point count fits `maxPoints` (a rollup tier by
`ceil(range / bucket)`, raw by reading `maxPoints + 1` rows). A series fed by
`recordBuckets` has no raw rows, so raw is never a candidate for it (an empty raw
read used to "fit" and answer an empty chart). The coarsest covering tier is the
last resort and is cut to its newest `maxPoints` (`truncated: true`). Each series
carries `before`, the last point strictly before the window in the chosen tier,
so a step chart can start at the held value.

A point is `{ t, samples, mean, twMean, min, max, last, delta, state, states }`.
`delta` is a counter's growth since the previous point or bucket (a drop is a
reset counted from zero; with no previous reading a bucket's own `last - min`).
For an enum, `mean` / `twMean` are null, `state` names `last` and a rollup's
`states` gives ms per state by name.

**Energy** (`derived:energy.kwh`, listed by `listSeries` for a device with a
power meter). The device's `cap:power-meter.kwhTotal` when it has that series
(its per-bucket `delta`), else the integral of `cap:power-meter.watts`
(`tw_sum` / 3.6e9 kWh). Never raw; `derivedFrom` names the source key. One place
makes the choice, so two charts of one device cannot disagree, and it covers
history recorded before the key existed.
`listSeries` reports the catalog `unit`. That symbol is the quantity's base
(°C, hPa, m/s, B, s). A series does not take its unit from a sibling field.
Weather fields each carry their own catalog unit. `cap:numeric-sensor.value`
has none: the label is `historyUnitFor` of that device's `SourceInfo.quantity`.
Points recorded before the base was fixed are not rescaled — the unit at
sample time was not stored. Two series are, because every old point was in
one known unit: `cap:pet-feeder.desiccantLeftDays` (days → seconds) and the
Unraid array counters on `cap:numeric-sensor.value` (GiB → bytes), applied
once at boot through the history connection.

## Node and storage series

`native-metrics` (hub only, from the bus that carries every node's snapshots)
records per RUNNER, never per pid: scope = the load fold's function key (the
runner's addon id, `__root__`, `__unattributed__`), keys
`addon:metrics-native/runner-{cpu-main-percent,cpu-gc-percent,cpu-lifetime-percent,rss-mib,processes}`.
A CPU split one process of the runner did not report is no point. Node totals
(scope `''`): `node-cpu-percent`, `node-memory-percent`, `node-cpu-temperature`,
`node-gpu-percent`, `node-gpu-temperature` (absent readings write nothing), at most
every 15 s per node; `container-current-mib` as before. The old `process-*` keys
(one series per pid, ~11.8k on the hub) are no longer written and age out.

`storage-orchestrator` records per location (scope = location id, subject = the
node it lives on; one writer per location): `location-used-percent`,
`location-free-bytes` from the same statfs probe `listLocations` serves, and
`location-owned-bytes` from the `storage-occupancy` slice; once a minute, an
unknown figure is no point (D393).

## Data model

`history-schema.ts` declares nine collections; a spec compares the DDL the real
engine writes with plan §4, plus two nullable columns D896 added (`enum_values` on
the metrics, `state_ms` on every rollup tier) — added IN PLACE by the engine on an
existing `history.db`, every row kept. One deliberate difference: §4 writes the opt-out key
as `device_id INTEGER PRIMARY KEY`, but the engine treats an INTEGER primary key
as a rowid alias it assigns itself (D473) and DROPS a supplied value, so the
device id could not be written through the door. The opt-out table is `id
INTEGER PRIMARY KEY, device_id INTEGER NOT NULL` with a unique index on
`device_id`. Opt-outs and departures live in `camstack.db` (configuration, nightly
backup). The other seven are in `history.db`, including `applied-scales`
(`id TEXT PRIMARY KEY NOT NULL`, `applied_at INTEGER NOT NULL`): one row per
base-unit rescale that has finished (D944 §4), so a restart does not rescale
the same series twice.

The metric row's key is its PRIMARY KEY, passed to the door as the record `id`:
without it the engine minted a random key, every boot added an unreachable row
per metric, and a learned enum list would not survive a restart. Rows with such a
key are deleted at load.

Every read and write is a PRIMARY KEY range on `(series_id, ts)` or
`(series_id, bucket_start)`; `history-query-plans.spec.ts` asserts the plan on the
statements the engine really prepares (D447). There is no `ts` index.

## Boot and timers

Boot waits for `onHubReachable` (the door and the device manager are hub caps).
`prepare()` declares, loads series, declares the catalog metrics, loads the
opt-outs, lists the devices, seeds the last-recorded map; the shell then
subscribes to `DeviceStateChanged`; `finishBoot()` rewrites the two legacy
series above (idempotent, marked in `applied-scales`), then rebuilds the
rollup window and reconciles. Timers: flush 10 s, rollups 60 s, reconcile 5 min, retention 10 min.

**Row counts.** One exact `COUNT(*)` per tier, once per boot, 90 s after start (a
full scan on the history thread, kept off the boot path). After it `getStatus`
moves the figure with the writes and deletes the addon itself makes (raw points
written, a rollup bucket newer than the series' newest known, rows deleted): an
ESTIMATE that drifts when a rollup row is rewritten for an older bucket. It is
re-anchored at the next boot. A persisted counter or `dbstat` would be exact but
the door offers neither cheaply.

**Logging.** Every drop or refusal is counted. Once per pass (rollup tick,
reconcile, retention run) one INFO names what was skipped, refused, deleted or
failed since the previous report (`parked-overflow`, `excluded-device-type`,
ingest refusals, retention deletes, flush failures) and stays silent when nothing
happened.

## Where it is read (UI, D899)

- **A device's History tab** (`?tab=history` on every real device) and the
  camera's **Live Stats** tab (fixed to the last 24 h) are one component,
  `DeviceHistoryView` (`packages/ui-library/src/composites/device-history/`):
  `listSeries`, then `queryMany` in batches of 24 with `resolution: 'auto'`.
  A principal `queryMany` refuses (it is admin-only) reads each device series
  through `query` instead. Sections follow `HISTORY_CATALOG` order, one chart
  per unit, one timeline per boolean/enum, energy as bars with the window total,
  the camera's occupancy as ONE chart of every zone × class scope.
- **System → History** (`/system/history`) overlays up to 24 series of any
  device or node over one window; node series are read with `forNodeId`. Saved
  panels and the charts an operator hid live in the ACCOUNT preference row
  `admin.history-panels` (D894).
- A rollup's enum bucket is drawn in its dominant state, while the time-in-state
  totals add the bucket's `states` milliseconds, so "open 2h 14m" is exact at
  every resolution.
- A statistic or integral helper (D944) reads one series through `query` on a
  schedule. It uses the tier whose retention is strictly longer than the
  window, and it does not fill a gap with zero.

## Traps

- A system-scope method that names a device must keep the id TOP-LEVEL or the
  scope gate cannot see it (`capabilities.md`). That is why the device reads are
  flat and the node reads are separate admin methods; producer methods keep the
  plan's `subject` object because they are admin-tier and addon-only.
- `callerAddonId` is the runner id of the caller. A producer inside a grouped
  runner is identified by the group; declare and record from the same addon.
- An enum ordinal means nothing without its metric's `enum_values`: never rewrite
  or reorder that list, only append (D896).
- The status row counts are an estimate and the bytes are `rows x` a fixed per-row size.
