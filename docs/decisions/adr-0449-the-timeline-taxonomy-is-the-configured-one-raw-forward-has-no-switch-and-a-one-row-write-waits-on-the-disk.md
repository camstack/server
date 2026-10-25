---
id: D449
title: The timeline advertises the taxonomy a camera is CONFIGURED for, raw-forward has no switch, and a one-row write that holds the settings thread is waiting on the disk, not on an index
status: accepted
date: 2026-09-11
supersedes: D448 §3 (the env switch only)
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/services/event-kinds-config.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/transport/cap-routing-hints.ts
  - scripts/bench-uds-relay.mts
last-verified: 2026-10-02
---

## Context

Three findings of one morning, two of them the operator's instructions and
one measured after the D447 indexes went live.

**`listEventKinds` described 24 of 32 cameras as detecting nothing.** It
derived `enabledMacroClasses` from `pipelineOrchestrator.getCameraStatus`,
i.e. `status.detection != null` — a RUNTIME fact. An on-motion camera holds
no session between motion events: the orchestrator answers `detection: null`
with `reasons.detection: 'armed:on-motion'` (its own comment calls this
"healthy and waiting"), and the composer read that as "detection disabled".
Measured on the hub at 09:35 CEST: `getCameraStatuses` over the fleet gave
`armed:on-motion` for 24 cameras and a session for 7; `listEventKindsBatch`
named person / vehicle / animal for exactly the 7 with a session (104, 101,
102, 111, 3829, 3836, 3839) and for none of the 24 — camera 103, with
`resolvePipeline` reporting an enabled `object-detection` step and
`audio.enabled: true`, answered 34 kinds and not one detection class. The
Events page looked right only because it unions every camera and three of
them happened to hold a session; the single-stream timeline asks for one
camera and got the broken answer. The viewer shipped a sweep (1.0.484, a row
per observed class the taxonomy does not name) — it becomes inert with this
record and is not touched here. The principle was already written: a UI
claims something is ABSENT only from a query that ANSWERED with nothing
(D315); "no session right now" is not that.

**`CAMSTACK_UDS_RAW_FORWARD=off` was a knob with a scar.** D448 §3 shipped
it as a per-node way out of the raw-forward plane. The operator refused it,
verbatim: *"non renderlo parametrico, dobbiamo farlo diventare il
comportamento di default, o diventa l'ennesima variabile che settiamo e
dimentichiamo"* [do not make it parametric, we have to make it the default behaviour, or it becomes yet another variable that we set and forget]. The repository already carries the cost of that pattern —
`scripts/check-no-heap-dump-command.ts` records that the heap-dump flag "was
the whole failure: it was set `on` in production, so the lock was open and a
signal was enough" — and the way out of a bad release already exists and is
not an environment variable: `serverManagement.rollbackServerUpdate`, with
`previousVersion` kept. The one thing that LOOKS like the flag and is not —
the `rawForward` negotiation at `register` — is protocol compatibility
between peers of different releases and stays exactly as D448 built it.

**A one-row `set` held the settings thread for 4–12 s, and the D447 indexes
did not do it.** Once the covering indexes removed the aggregates (10 → 0 per
hour), `op=set … rows=1` at 1 000–11 752 ms on `recorder:segment-hours` and
`pipeline-analytics:media` became the loudest line, and the hand-over asked
whether the two new indexes had bought a faster read with a slower write. The
docker log answers with timestamps, which is the only way a causal claim is
made here (D447 §3):

- Slow sets are a phenomenon of THIS morning. In the 14 h of log, the first
  `set` over 1 000 ms is at **07:25:12**; between 22:22 and 07:25 there are
  **0** slow sets and **250+** slow aggregates on the same thread. The
  indexes landed at **09:17** (the last slow aggregate). 69 of the 81 slow
  sets precede them.
- The per-statement cost of a `set` did not move. The profiler's aggregate
  line after the deploy: `set pipeline-analytics:media calls=146 totalMs=156
  maxMs=44` (≈1 ms each), `set recorder:segment-hours calls=111 totalMs=52`.
  An index adds cost to EVERY write of its table, uniformly; what the log
  shows is a flat ~1–2 ms with single outliers (`calls=76 totalMs=2642
  maxMs=2197`: one call is 83 % of the minute). A uniform cost is an index; an
  outlier is a wait.
- The wait is inside `stmt.run` — `JSON.stringify` of the row happens
  BEFORE `measured()` in `SqliteSettingsBackend.set`, so a 30 KB `paths`
  column is not in the measured time — and a one-row upsert has exactly two
  things inside it that take seconds: the commit's fsync (`journal_mode =
  WAL`, `synchronous` never set, so the default FULL fsyncs the WAL on every
  commit) and the default auto-checkpoint (1 000 pages), which SQLite runs
  INSIDE whichever writer's commit crosses it. `WAL truncating checkpoint
  completed` fired 0 times in 14 h and the WAL sat at 15.9 MB, so every
  checkpoint the file gets is the one a writer pays for.
- The disk is the story. `camstack.db` lives on `/mnt/mixed` = `/dev/sdd1`, a
  **Samsung 870 QVO** (QLC SATA) that also carries `/media-fast`
  (`/mnt/mixed/camstack/media`, 444 GB, **5 485 files written in the last
  hour**) — the event-media plane and the settings database share one QLC
  drive whose write latency collapses once its SLC cache is exhausted, on a
  host at load average 33–40. The NVMe copy under `/mnt/cache` stopped being
  written on 2026-08-25 (D328): the database moved onto the media disk that
  day. A `deleteWhere` of 325 rows on `metrics:node-load-samples` took 9 989
  ms at 07:26:44 — the same wait on a different statement.
- **Not found:** what began at 07:25. Nothing in syslog, dmesg or the hub log
  at that minute names a job; the eviction/delete rate per hour rose from
  ~250 to ~400 at 07:00 and 09:00, which is consistent with more media churn
  on the shared drive and is not proof.

## Decision

1. **The taxonomy a camera advertises is the one it is CONFIGURED for.**
   `listEventKinds` / `listEventKindsBatch` read `resolvePipeline` — an
   enabled `object-detection` step and its `enabledMacroClasses`, and
   `audio.enabled` — and never `getCameraStatus`. The class list is
   `FIRST_LEVEL_MACRO_CLASSES` (`@camstack/types`), the authority the step's
   offer is already guarded against; an explicit non-empty
   `enabledMacroClasses` narrows it in the authority's order; anything in it
   that is not a first-level macro is dropped (a stored `'package'` never
   advertises the package lane — that lane keeps its zone-rule gate). A
   pipeline that cannot be read advertises nothing and says so at WARN with
   the device id; the cap's answer is a plain list with no room for
   "unknown", which is the residual of D315 this record leaves in place —
   the steady state is no longer in it.

2. **Raw-forward is the behaviour, and there is no switch.** The parent
   acknowledges `rawForward` to every child that declares it. The only
   decoded path left is for a peer that did not declare — a runner of a
   release before D448 — and that is protocol, not a knob. The way out of a
   bad kernel release is `serverManagement.rollbackServerUpdate`. The bench
   keeps its A/B by running the CHILDREN of the previous release (raw
   channels registering without `rawForward`), so the parent is the same code
   in both legs and nothing on it can be set and forgotten.

3. **A slow one-row write on `hub/sqlite-settings` is attributed to the
   disk before it is attributed to the schema, and the two indexes of D447
   stay.** They did not slow the writes: the evidence above is what "did not"
   means here. What the settings thread pays is the commit's fsync and the
   in-commit auto-checkpoint on a QLC drive shared with the media plane; the
   levers — `synchronous = NORMAL` under WAL, a periodic PASSIVE checkpoint
   off the write path, or the database back on the NVMe it left on 08-25 —
   are placement and durability decisions this record does not take. It
   names them so the next record starts from the measurement, not from the
   index.

## Consequences

- The taxonomy fix is `packages/addon-post-analysis`: `camstack deploy
  post-analysis`. Live the moment the runner respawns; the viewer's sweep
  (1.0.484) then adds nothing and can be removed on its own schedule.
- The switch removal is `@camstack/system` and rides the next published
  `@camstack/server` (D16). Until then the hub keeps the env read; nothing
  sets it, so behaviour is identical.
- `listEventKindsBatch` now issues one `resolvePipeline` per camera, all in
  flight at once — there is no batch form of it. Measured on the hub over 32
  cameras: 965 ms wall for the set, 227–367 ms for one; `getCameraStatuses`
  was 372 ms for the same set. If that cost ever matters, the batch method
  belongs on the orchestrator (a cap change, a server release), not a cache
  in post-analysis (D224).
- `resolvePipelineForDevice` blocks with backoff until the node's catalog
  answers. At hub boot a `listEventKinds` can therefore wait where it used
  to answer "nothing" instantly. Preferred: a late true answer over a fast
  false one.

## Enforcement

- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/event-kinds-config.spec.ts`:
  an armed on-motion pipeline advertises every first-level macro and audio;
  the list IS `FIRST_LEVEL_MACRO_CLASSES`; narrowing, the empty-means-all
  rule, the stored `'package'`, a disabled detector, an inactive binding, a
  re-rooted tree; and a source guard that `listEventKinds` /
  `listEventKindsBatch` no longer name `getCameraStatus`. Disarmed by never
  reading the detector's classes: 6 red; by never reading `audio.enabled`:
  2 red.
- `packages/system/src/kernel/__tests__/transport/raw-forward.spec.ts`: the
  ack a declaring child receives on the wire is `{ ok: true, rawForward:
  true }`. Disarmed by acking `{ ok: true }`: 2 red (this test and the opaque
  sibling forward, whose census reads `decoded`).
- `scripts/bench-uds-relay.mts` prints `fwd raw/decoded` per leg: the inline
  leg reads `0/N`, the raw leg `N/0`; a leg that reads otherwise is a
  negotiation that did not happen.
