---
id: D850
title: Numeric history has one mechanism — device-history, fed by cap history blocks and addon-declared series; rollups are computed by the owner only
status: accepted
date: 2026-10-14
supersedes: D132 (point 4 only — the five-minute LTS tier)
applies-to:
  - packages/types/src/capabilities/capability-definition.ts
  - packages/system/src/builtins/native-metrics/**
  - packages/system/src/builtins/device-history/**
---

## Context

Numeric history exists in four places that do not know about each other: two
byte-identical `LtsAggregator` copies (the guard keeps them identical because
addons cannot share code) writing `pipeline-analytics:stats-5m` and
`pipeline-orchestrator:stats-5m`, the node load and memory sample tables of
`native-metrics` (6 h by age), and the audio LEVEL rows of
`pipeline-analytics:audio-events`. None covers a generic device value: a
thermostat's temperature or a plug's power has no history at all, and the
roadmap item "LTS for generic device values" could only be met by a fifth copy.

The LTS tier of D132 was the first attempt. It works for the series it was built
for, but every new series means a new owner-specific table, a closed enum in a
cap, and a reader method on that owner's cap. A TSDB (Influx 2/3, VictoriaMetrics,
Timescale, QuestDB) was evaluated and rejected: either a second server to run and
back up, or downsampling that is not in the free tier, for a fleet whose ~1.3 M
points/day SQLite already handles.

## Decision

**Every numeric history goes through the `device-history` addon and its store,
and only that addon computes rollups.** A device value is recorded because its
capability says so: an explicit `history` block in the `*.cap.ts` (`'none'` is an
explicit answer, a guard requires one on every cap with `runtimeState`), captured
hub-side from `DeviceStateChanged` as change-only points and reconciled every
5 minutes from the state mirror. Any other series is DECLARED by the addon that
produces it (`declareSeries`, per key and device or node) and fed by points
(`record`, low rate) or by closed 5-minute buckets aggregated in the producer
(`recordBuckets`, an idempotent upsert keyed by series and bucket start).
Rollups 5m / 1h / 1d are derived by device-history alone, always by recompute
from the lower tier. Real devices only (not `hub`, not `container`); default on,
per-device opt-out owned by device-history; global retention raw 7 days, 5m
14 days, 1h 1 year, 1d forever. No other addon declares a statistics table.

## Consequences

- Both `LtsAggregator` copies, both `stats-5m` tables and the node sample tables
  are deleted; their data is converted once by the offline split (D853).
- `pipelineAnalytics.readLongTermSeries` survives as a read of device-history, so
  the viewer does not change with the hub.
- A producer that samples faster than once per 10 s per series must aggregate in
  its own process (the pure bucket accumulator in `@camstack/types`); `record`
  refuses a sustained higher rate.
- Audio LEVEL-only rows become a series; the live `audio-metrics` slice and the
  notification level feed are unchanged. Level-only entries leave the event
  timeline.
- device-history is hub-only; producers on agents reach it through the cap.

## Enforcement

The new guard `check-cap-history-declared` (every `runtimeState` cap declares
`history`; fields exist, are top-level and numeric or boolean) and
`check-history-single-mechanism` (no `LtsAggregator`, no `stats-5m`,
no declared collection with a `bucketStart` column outside device-history), both
in the Checks workflow and the pre-commit hook. Planned in
(planning repo: superpowers/plans/2026-10-15-lts-device-history-and-events-db.md) — not
yet built.

## Notes from P2 (the `history` block, 2026-10-15)

The block is `history: 'none' | { fields }` on every one of the 69 `runtimeState`
caps. It names top-level or fixed-object (`a.b`) `runtimeState` paths — never an
array or a record keyed by runtime ids. A series is `gauge`, `counter` (monotonic
hardware meters only) or `boolean`; it carries a `unit` or a `unitFrom` (sibling
field holding the device's own unit), an absolute `deadband` and/or a relative
`deadbandPct`, `minIntervalMs` (capture floor 10 s for gauges and counters, 30 s
for power-meter fields, none for booleans) and `excludeDeviceTypes`
(`motion.detected` is not captured for cameras). Availability has one series,
`device-status.online`. Actuator fields are in v1. The full list and reasoning:
(planning repo: superpowers/plans/2026-10-15-lts-p2-history-proposal.md), "Decisions".
Enforced by `scripts/check-cap-history-declared.ts`; projected into
`packages/types/src/generated/history-catalog.ts`.

## Notes from P3 (the addon, 2026-10-16)

Accepted with the device-history addon. Architecture: `docs/architecture/device-history.md`.
What P3 decided or found, beyond the plan:

- **An INTEGER primary key cannot carry a caller's value.** The engine assigns it
  (D473) and drops a supplied one, so plan §4's `device_id INTEGER PRIMARY KEY`
  opt-out table could never be written through the door (every row got id 1, 2,
  ...). Found by a spec over the real router, not by the in-memory spec that had
  passed. The opt-out table is `id INTEGER PRIMARY KEY` plus `device_id INTEGER
  NOT NULL` with a unique index (the upsert's conflict target). The other three
  integer keys (`series.id`) are engine-assigned by design.
- **`caller: 'addon'` does not exist.** Ownership of a producer's key is the
  `callerAddonId` the transport stamps (as the keychain does), read off the call;
  an unstamped call is refused `not-owner`. The producer methods are `admin` tier
  so a signed-in non-admin session never reaches them; an addon's `ctx.api` call
  is not tiered.
- **A change inside the capture floor is deferred, not dropped.** It is kept
  pending and emitted when the floor ends, stamped there, so the end of a burst
  is never lost (`trailingEmitted`). Reconcile ignores the floor.
- **Held values.** Rollups credit a quiet bucket with the value in force
  (`carryIn`), at 5m and when combining upward; without it an hour at 10 for 55
  minutes and 100 for 5 would average over the last five alone. The held value
  also counts toward `min`/`max` when in force at a bucket start.
- **Additions to the cap.** A refusal reason `out-of-range`; `query` returns
  `before` per series (the last point before the window, for a step chart);
  `getStatus` carries the counters of everything dropped or refused (D391).
  Type names are `DeviceHistory*` (a `HistoryResolution` already exists in the
  pipeline-analytics cap).
- **Retention is stateless where a timer would have been lost**: the purge of a
  departed device is a scan of series against the last device listing, not a
  24-hour timer armed by `device.unregistered`; retention visits a series again
  only after its cutoff has advanced by a step.
- **Review fixes (2026-10-16).** A purge is decided by a persisted per-device
  "absent since" clock fed only by successful listings, 7 days of unbroken absence,
  never by the series' own last write (a partial but successful listing after a hub
  restart would otherwise have deleted live, stable history for good, D49). The
  device reads take a flat top-level `deviceId` so the scope gate sees them; node
  reads are separate admin methods. A dropped point makes the capture engine forget
  the value it never stored; deletes are sliced by time with a yield; row counts are
  one boot-time count plus an in-process delta; a re-marked rollup bucket is not
  erased by the recompute that was running.
- **Not measured yet.** Rows and bytes per tier after 24 h on `.50` are recorded
  in (planning repo: sessions/sessions.md) once measured; `getStatus.tiers` reports rows <!-- drift-ok: moved to the private planning repo -->
  (counted every 30 minutes) and an approximate size.
