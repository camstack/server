---
id: D466
title: A config read on the trigger path is served from the owner's own mirror, written through on the one write that changes it
status: accepted
date: 2026-09-11
applies-to:
  - packages/addon-pipeline/src/recorder/addon/config-mirror.ts
  - packages/addon-pipeline/src/recorder/addon/recording-provider.ts
last-verified: 2026-10-02
---

## Context

The hand-over was "`hub/sqlite-settings` takes ~3 560 requests a minute (≈59/s)
and returns ~10 MB/min; up to 45 kB per `query`. Who, and what for?" The first
thing the measurement did was correct two halves of that.

**The rate is higher than the brief, and the brief's instrument cannot answer
the question.** The `[mem] hub-main` socket census attributes per PEER, and
every settings call in the cluster has the same peer (`sqlite-settings`)
because hub-main is the router. The instrument that CAN answer it already
exists and has been printing the answer every minute for weeks: the engine's
own `sqlite engine busy` line (`query-profiler.ts`, D447's other half), keyed
by `(op, collection, owner, sql shape)`. Forty-four consecutive 60 s windows
(2026-09-11, 22:50–23:34 CEST, `docker logs --since 60m`) hold **214 500
calls, mean 4 875/min (81/s)** — the 59/s of the brief is a night-time floor,
not the number.

**The attribution, ranked by calls per minute** (a row seen in fewer than
44/44 windows only ranks into the profiler's top-5 when it is big, so its rate
is biased upward and is marked):

| calls/min | rows/call | windows | what |
| --- | --- | --- | --- |
| **1 833** | 0.7 | 44/44 | `get recorder:recording-configs` |
| 1 314 | 1.0 | 44/44 | `get device-manager:devices` |
| 323 | **707.7** | 9/44 | `query addon-device-settings` owner=`device-manager`, `WHERE "id" BETWEEN ? AND ?` |
| 315 | 0.2 | 8/44 | `query pipeline-analytics:media`, `WHERE "ownerKind" = ? AND "ownerId" = ?` |
| 310 | 0.3 | 10/44 | `get pipeline-analytics:addon-devices` |
| 111 | 1.0 | 13/44 | `set recorder:segment-hours` |
| 36 | 3.0 | 22/44 | `query pipeline-analytics:summaries`, `WHERE "sealedAt" IS NULL` |
| 13 | **1 096.0** | 43/44 | `query device-manager:devices`, `ORDER BY "deviceId" ASC` |
| 18 | 1.0 | 12/44 | `aggregate pipeline-analytics:media` (D447's, now 13–16 ms — fixed) |

**The 45 kB is not a settings read at all; it is a whole collection.** Two rows
explain every large response on this door and both return a collection to serve
a subset: `readDeviceStoreBatch` (`kernel/settings-door-view.ts`) scans the
`<addonId>:` range of `addon-device-settings` — **707.7 rows per call**, by
design, because the ids in a fleet listing are not contiguous — and
`RowMapStore.readAll` over `device-manager:devices` returns **1 096 rows per
call**. Both are documented trades that already replaced something worse (9 229
`query addon-device-settings`/min on 2026-08-25). Neither is the volume.

**The volume is one line, and it is a poll on a hot path.** `get
recorder:recording-configs` is 1 833/min — **37.6 % of every call the cluster
makes to the settings store** — in all 44 windows, and it finds a row only 70 %
of the time. The recorder's own `debug.storeCensus` had already attributed
8 693 of 8 733 reads in a 300 s window (2026-09-10) to ONE site,
`RowMapStore.read < loadDeviceConfig < load`, and stopped there: all six of
`RecordingController`'s config reads go through the same arrow function
(`index.ts`, `load: (deviceId) => loadDeviceConfig(this.configStore(), deviceId)`)
and the census keeps three stack frames, so the six collapse into one string.
**That census is blind here and the ratio says why** — three frames cannot see
past a one-line indirection.

Reading the six call sites closes it without another deploy. Three of them run
at EVENT-BUS RATE, one store round trip each, per event, per camera:

- `onAudioLevel` — one `PipelineAudioInferenceResult` per audio window per
  camera, purely to resolve which band's `audioThresholdDbfs` applies;
- `postBufferMsFor` — every qualifying motion / object / audio trigger;
- `evaluateDevice` — every reconcile beat and every trigger.

The corroboration is on the `[mem]` line: the event fan-out to `recorder` is
2 159–2 313 events/min in the same windows, and `audio-analyzer` pulls
2 747–2 750 audio chunks/min. 1 833 config reads sit exactly inside that
envelope. A row an operator edits every few weeks is being re-read from disk
several thousand times an hour to answer a question about an audio window.

**Rejected.** Deepening `CENSUS_STACK_FRAMES` to separate the six sites — it
needs a deploy to measure and the six sites are readable; the ratio against the
event fan-out is the measurement. Caching in the CONSUMER (D224) — there is no
consumer here to cache in: this addon owns the rows. A TTL on the last-known-good
fallback of `last-known-config.ts` — that fallback exists so a FAILED read never
becomes the shipped default (57 wrong post-buffers written on 2026-08-25), and a
TTL means "after N minutes, go back to writing the wrong number".

## Decision

**A config read on a trigger path is served from the mirror held by the addon
that OWNS the row, and the owner writes THROUGH that mirror on the one write
that changes it.**

`recorder:recording-configs` has exactly one writer — `saveDeviceConfig`, from
the `recording-archive` cap's own `setDeviceConfig` handler, in this process — so
`config-mirror.ts` is the owner keeping its own fact fresh, which is what D224
prescribes, not the second copy D224 forbids. `setDeviceConfig` hands the
persisted value to `onConfigSaved` **before** `onConfigChanged`, because
`onConfigChanged` reaches `evaluateDevice`, which reads the config straight
back: an operator's edit governs the very next decision, with no window and no
store read. `invalidate` covers a path that changes a row without holding the
new value.

The freshness window (`RECORDING_CONFIG_FRESH_MS`, 30 s) therefore bounds only
a write that reached the row without passing through this process — today, the
boot migration, which runs before the controller starts. It is a bound so such
a write converges without anyone having to remember this file exists, never a
delay on an operator.

ONE map holds the fact for both jobs. `last-known-config.ts` is deleted, not
kept beside this: two caches of one value in one addon is the failure this repo
keeps writing records about, and a leftover that describes the right design
reads as verification.

The operator-facing reads (`getDeviceConfig`, `getStatus`, `rescanStorage`,
`pruneFootage`) deliberately keep reading the row directly. They are a handful
a minute, and a UI that shows a config must show the persisted one.

## Consequences

- Steady state, `get recorder:recording-configs` falls from 1 833/min to at most
  **two per recording camera per minute** — ~24–30/min on this fleet — plus one
  per operator edit, which costs none. That is ~37 % of the whole cluster's
  settings-store traffic removed from a **synchronous** engine thread every
  configuration read in the cluster queues behind (D447).
- The trigger path no longer waits on `hub/sqlite-settings` to qualify an audio
  window. When that door freezes (2026-08-25: 57 × `UDS request timed out after
  60000ms` to the recorder alone), the qualification now answers from RAM
  instead of falling back.
- A decision may be made against a config up to 30 s old **only** for a write
  that bypassed this process. If a second writer of `recorder:recording-configs`
  is ever introduced, it must call `invalidate` or the window becomes a real
  staleness bug — the mirror's doc says so and this record is the reason.
- The mirror states what it served and what it cost once per 60 s window
  (`recorder: config mirror window`, `served` / `storeReads` / `fallbacks` /
  `devices`). Without it, a mirror that silently stopped mirroring and a mirror
  doing its job are both silence — and the only visible difference is 1 800
  calls a minute on a runner nobody is watching. `storeReads` climbing back
  toward `served` is the regression signal.
- This is `addon-pipeline` and ships with `camstack deploy addon-pipeline` —
  the large bundle, whose hot deploy has wedged the listener before (D447). The
  operator decides when.
- **Not fixed, and now named:** `get device-manager:devices` at 1 314/min
  (second by volume, caller unattributed — `device-manager` has no read census)
  and the two whole-collection reads (707.7 and 1 096.0 rows per call) that
  explain the bytes. Neither was touched.

## Enforcement

- `packages/addon-pipeline/src/recorder/addon/__tests__/config-mirror.spec.ts`:
  20 trigger-path reads over 10 s cost ONE store call; the window expires at
  `freshMs` to the millisecond; an owner write is served immediately; a report
  line states `served`/`storeReads`/`devices`; and the four last-known-good
  behaviours (fallback, rethrow-when-never-read, per-camera isolation,
  refresh-on-success) are carried over unchanged from the deleted module.
  Disarmed by forcing the freshness branch false: 4 red.
- `packages/addon-pipeline/src/recorder/addon/__tests__/config-mirror-write-through.spec.ts`,
  over the REAL settings engine on `:memory:`: `setDeviceConfig` is served on
  the next read with no store round trip, the mirror is updated BEFORE the
  re-evaluate, and a re-evaluate that throws does not cost the mirror its value.
  Disarmed by dropping the `onConfigSaved` call: 3 red.
