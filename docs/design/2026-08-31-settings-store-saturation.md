# The ~15 s constant behind every settings-store call

> **Status.** Investigation, 2026-08-31. Read-only against the live hub.
> No code changed, nothing deployed. Read this before "optimising" another
> store round trip, and before believing any latency number taken against
> `settings-store` since 2026-08-29.
>
> **Acted on, 2026-08-31 — [D320](../decisions/adr-0320-a-walk-that-answers-a-question-is-bounded-single-flighted-and-never-on-a-timer.md).**
> §5 R1 (no timer, plus an operator Refresh with the time the number was taken)
> and R2 (single flight per `(mode, target)`, a 20 000-row / 20 s budget that
> answers `null` and STOPS READING, and an explicit `cancelCensuses`) are done.
> §6's separate defect — `loadPrefixed` serving a truncated `readDeviceStoreBatch`
> — is done: the read pages with an explicit `limit` and a keyset cursor, or
> throws. **R3 is NOT done and is still owed**: the seal is stopped, and until
> it lands the media lane's residue on this fleet answers "unknown" rather than
> a number. §7 is unchanged — nothing here observed which client started the
> censuses, and `HttpRequestCensus` is still not armed.
>
> Companion records: [D181](../decisions/adr-0181-hub-mains-event-loop-is-the-clusters-only-queue.md)
> (hub-main's loop is the cluster's only queue), [D233](../decisions/adr-0233-hub-local-isolated-infra-is-proxied.md)
> (the isolated engine is proxied), [D294](../decisions/adr-0294-an-addon-settings-view-resolves-its-backend-per-call-because-the-doors-owner-is-built-first.md)
> (the door resolves per call), [D295](../decisions/adr-0295-the-ledger-is-the-archive-the-ram-index-answers-only-about-what-is-resident.md)
> (an unanswerable census is `null`, never zero).

---

## The reframing — read this first

Over 2026-08-29/30/31 five real defects were fixed, and every one of them was
fixed by reducing the **number of sequential store round trips**:

| Defect | Shape | Cost before |
| --- | --- | --- |
| `getAllBindings` | 1 + 1019 reads → 2 | **740 s** |
| `projectChildren` | one read per child, 896 children | one tick per child |
| the OSD catalog | 1 + 1019 | one tick per device |
| the event-media seal | one write per row | **2.3 rows/s** → 2.5 days for 464 902 rows |
| `footprintByDevice` | whole-table `OFFSET` paging | one tick per page |

All five were genuine and all five were worth doing. But every one of them was
**dividing by a constant of ~15 s that nobody had asked about**. A single
71-byte `settingsStore.get` costs the same ~15 s as a 3 893-byte `query`. That
constant is the subject of this document, and it is not a property of SQLite,
of the disk, or of the transport.

**It is one query shape, issued by one code path, consuming 88.7 % of the
engine's wall-clock, 24 hours a day.**

---

## 1. Measurements

Everything in this section is **measured** unless the row says otherwise.
Probes marked *(prior)* were taken by the previous session and are reproduced
verbatim; probes marked *(this session)* were taken 2026-08-31 06:50–07:20 CEST
from the Mac over HTTPS to `https://<hub-ip>:4443`.

### 1.1 Per-leg latency, each leg against its own endpoint

| Probe | What it exercises | Measured |
| --- | --- | --- |
| `nodes.getNodeAddons({nodeId:'hub'})` *(prior)* | HTTP + auth + hub-local registry, **no store** | **14 / 34 / 39 ms** |
| `nodes.getNodeAddons({nodeId:'hub'})` *(this session)* | same, incl. ~250 ms `node` process start | **460 ms** |
| hub `$process.list` incl. its forked `ps` *(prior)* | hub-main + a fork, no store | **92 ms** |
| one remote `$agent.status` *(prior)* | Moleculer hop to `agent-a` | **170–220 ms** |
| `settingsStore.get` — 71 bytes *(prior)* | the store | **14 846 / 14 999 / 15 178 ms** |
| `settingsStore.query` — 3 893 bytes *(prior)* | the store, different collection | **15 256 / 15 557 / 18 349 ms** |
| `settingsStore.get` — single key *(this session)* | the store | **16 052 ms** |
| `nodes.topology` *(prior)* | two **sequential** store phases | **30 483 ms** ≈ 2 × 15 557 |

Three properties, all measured:

1. **Cost does not depend on the question.** 71 B and 3 893 B cost the same,
   across two different collections.
2. **Concurrent calls end together.** Three store calls issued concurrently
   finished within **1 ms** of each other (**18 349 / 18 348 / 18 349 ms**)
   while a hub-local read in the same wave answered in **1 814 ms**.
3. **A caller pays one tick per *sequential* store phase.** Nothing else it
   does matters.

### 1.2 The probe that settles queue-vs-barrier *(this session)*

Two `settingsStore.get` calls, the second issued 6.0 s after the first:

```
A  issued@0ms      done@16 842ms   dur=16 842ms
B  issued@6 007ms  done@21 569ms   dur=15 562ms
```

**B finished 4.7 s AFTER A.** A periodic barrier would have released both at the
same instant. This is a **FIFO queue of roughly constant depth** — each arrival
waits out the backlog standing in front of it. This single probe refutes the
entire "something periodic on a ~15 s cadence" family (timer, batch, debounce,
checkpoint, maintenance pass).

### 1.3 The profiler's own view — `SqliteOpProfiler`, `sqlite engine busy`

359 consecutive 60 s windows, `hub/sqlite-settings`, 2026-08-31 **01:03:31 →
07:02:41 UTC**:

| | Measured |
| --- | --- |
| `busyPct` (share of wall-clock inside SQLite) | min **61** · p50 **91** · p90 **92** · max **94** |
| statements per window | 3 950 – 7 503 |
| top-1 `(op, collection, shape)` | the SAME in **359 of 359** windows |

The top-1 shape, in every window:

```
query pipeline-analytics:media
  SELECT … FROM <t> WHERE "timestamp" BETWEEN ? AND ?
                    ORDER BY "timestamp" ASC LIMIT ? OFFSET ?
```

| Over the 6 h window | Measured |
| --- | --- |
| engine time in that ONE shape | **19 110 s** of 21 540 s wall = **88.7 % of wall-clock** |
| share of all *profiled* engine time | **99.0 %** |
| next shape down (`set pipeline-analytics:stats-5m`) | 111 s |
| calls per window | 1 071 – 2 073 (≈ **31.9 pages/s**) |
| rows returned per window | 215 271 – 416 673 (**201 rows/call**, `PAGE_SIZE = 200` + the row-cap sentinel) |
| `maxMs` per window | 108 – 494 ms typical; 2 136 / 3 357 ms outliers |

Bucketed at 30 min, the condition is **unbroken back to 2026-08-30 14:17 UTC**
(where Loki's 1 000-line result cap stops), avgBusy 79–93 % in every bucket.

**No single statement is slow.** No profiler slow-call WARN and no
`UDS request timed out` line in 2 h. The 15 s is queueing, not a statement.

### 1.4 The engine process *(this session)*

`/proc/211/stat` inside the container, sampled 10.05 s apart:

| | Measured |
| --- | --- |
| CPU consumed | 916 ticks = 9.16 s over 10.05 s wall = **91.1 % of one core** |
| runqueue wait (`schedstat` field 2, lifetime) | 78.8 s of 41 766 s = **0.19 %** — not host-CPU-starved |
| state at sample | `R (running)`, 8 threads |
| cmdline | `node --max-old-space-size=1024 …/@camstack/system/dist/addon-runner.js` |

`hub/pipeline-analytics` (pid 66319) over the same kind of window: **6.1 % of
one core** — consistent with a client that is I/O-bound on 32 round trips/s and
decodes ~6 400 rows/s of MsgPack, and inconsistent with it being the bottleneck.

`hub-main` is **healthy**: `loopP50=0ms`, `loopP99` 6–206 ms, `loopMax` ≤ 1 024 ms,
`rss≈4 270MB`, `children=38`.

### 1.5 Where the database lives *(this session)* — established

| | Measured |
| --- | --- |
| path in container | `/data/addons-data/sqlite-settings/camstack.db` |
| bind mount | `/mnt/mixed/camstack/addons-data/sqlite-settings` → `/data/addons-data/sqlite-settings` (its **own** mount, created 2026-08-25 16:43) |
| host filesystem | `/mnt/mixed` = **`/dev/sdb1`, xfs**, `rw,noatime,nouuid,inode64,logbufs=8,logbsize=32k,noquota` |
| device | **Samsung SSD 870 QVO 2TB, SATA, `ROTA=0`** |
| file sizes | `camstack.db` **1 222 311 936 B (1.222 GB)** · `-wal` **5 751 552 B** · `-shm` 32 768 B |
| `iostat -x` on `sdb`, two samples | `r/s` 56.9 / 186.0 · `r_await` **1.04 / 0.98 ms** · `w_await` 2.46 / 0.81 ms · `f_await` 8.66 / 0 · **`%util` 3.28 / 3.70** |

For contrast, on the same host at the same instant:
`/mnt/disks/recordings-2` = `/dev/sdm1`, **btrfs**, TOSHIBA MQ04UBD200 **USB** —
`f_await` **1 161.87 ms**, `%util` 110.35. `/mnt/cache` = `nvme0n1p1`, btrfs.

**The database is on neither of them.** It is on a lightly-loaded SATA SSD.

### 1.6 Engine configuration is live and correct

Boot line `sqlite connection sized from the database on disk`, hub, 2026-08-30 19:21:

```
dbSizeMb=1142  pageCacheMb=256  mmapMb=1428  mapsWholeFile=true
liveMb=1142    freeMb=0         freePct=0
```

The 2026-08-25 mmap-expiry failure documented in `sqlite-pragmas.ts` (70 % of the
file outside the map, 418 synchronous page-ins/s, `D=41 %`) **is fixed and
verified live**. `freePct=0` also means a `VACUUM` would reclaim nothing: the
file is live rows. Growth is real — 858 MB (08-25) → 1 142 MB (08-30) → 1 222 MB
(08-31), ≈ 60 MB/day.

---

## 2. The mechanism

**Determined.** The evidence names it, and the code path is a single unbroken
chain in this repository.

```
StorageMigrationSection.tsx:416   refetchInterval: 10_000  →  storageMigration.residue
  → StorageMigrationCoordinator.residue()            storage-migration-coordinator.ts:521
    → participants.analytics.residue(...)            storage-orchestrator.addon.ts:431
      → pipelineAnalytics.countRelocatableMedia      index.ts:13403
        → MediaRelocateEngine.countSelectable        media-relocate-engine.ts:395
          → countSelected(mode, target, () => false) media-relocate-engine.ts:433
            → pageRows(collection, 'timestamp')      media-relocate-engine.ts:357
```

`pageRows` emits exactly the profiled shape — `whereBetween` on the order field,
`orderBy` ascending, `limit: PAGE_SIZE` (200), `offset: offsetAtCursor`. The
backend appends `OFFSET ?` **only** when `filter.offset !== undefined`
(`sqlite-settings-backend.ts:987`), so the shape is unique to this call site.

Four properties of that walk, all in the source:

- **It is a full-collection walk.** `pipeline-analytics:media` is ≳1.26 M rows.
  6 300+ pages per pass. `collectionsFor('move')` walks `media` **and**
  `retrain-frames`; `collectionsFor('gallery')` walks `media` again. One
  `residue()` is therefore **two full walks of `media` plus one of
  `retrain-frames`** ≈ 12 600+ store round trips.
- **It cannot stop.** `countSelectable` passes `stop: () => false`. There is no
  deadline, no page cap, no abort signal, and an aborted HTTP request does not
  cancel the server-side generator.
- **It is not single-flighted.** Every caller starts its own walk.
- **The cost claim in the source is stale.** `countSelected`'s comment says the
  `move`/`gallery` predicates cannot be pushed into the store (true —
  `mediaRowLocation` folds `NULL` into the default location, so
  `whereNot: {locationId: target}` has the wrong meaning when the target *is*
  the default; and `gallery` needs a `NOT IN` over three `ownerKind` values the
  filter vocabulary cannot express) and then adds *"Neither has a measured cost
  problem."* **That sentence is the defect.** It is now the single largest
  consumer of the cluster's only queue.

### The runaway

The engine is single-threaded and synchronous. A walk's next page waits out the
whole backlog, exactly like every other caller — so **a walk can never finish
while other walks are running**, and each poll adds one that never retires.
Steady state is the engine's throughput ceiling with a standing FIFO backlog.

**Inferred**, from two measured rates:

- concurrent censuses ≈ 31.9 pages/s ÷ (1 page per 15.6–16.8 s per walker)
  ≈ **480–530 in flight**.
- total outstanding store requests, Little's law: λ·W ≈ 114/s × 16 s
  ≈ **1 800**.

Both are arithmetic, not counts. What they explain that nothing else does: why
one walker at 32 pages/s coexists with a 16 s per-request latency (it cannot —
there must be hundreds), and why three concurrent probes land within 1 ms of
each other (they occupy three adjacent slots at the tail of one FIFO and are
each served in ~0.26 ms).

---

## 3. Candidates refuted, and how

Each of these is refuted by a measurement above; none needs re-taking.

| Candidate | Refuted by |
| --- | --- |
| **fsync behind the stalled USB btrfs volume** (`/recordings`, `f_await` 1 178 ms, `btrfs-transaction` in D state, host load ~30) | The DB is **not on it**. §1.5: `/dev/sdb1`, xfs, SATA SSD, `%util` 3.3–3.7 %, `r_await` ≈ 1 ms. And the engine is **91 % CPU**, `R (running)` — not blocked in D. |
| **A WAL checkpoint blocking readers periodically** | WAL is **5.75 MB** against `WAL_HIGH_WATER_BYTES` = 64 MiB, so `WalMaintenance` never escalates past `below-high-water`. **Zero** `WAL truncating checkpoint completed` / `WAL checkpoint deferred` lines from the hub in 24 h. And a checkpoint is a *barrier* — §1.2 refutes every barrier. |
| **Anything periodic on a ~15 s cadence** (timer, batch, debounce, maintenance) | §1.2. B issued 6.0 s after A finished 4.7 s after A. A barrier releases both together; a queue does not. |
| **The door's queue / the UDS hop / hub-main** | A hub-local call that never touches the store is 14–39 ms (460 ms incl. process start); `$process.list` through a fork is 92 ms; hub-main's loop is `loopP50=0ms`, `loopP99` ≤ 206 ms. The delay is specific to the sqlite child. |
| **One long statement serialising the runner** | No profiler slow-call WARN in 2 h. Per-window `maxMs` is 108–494 ms. The 68 s stall of 2026-08-25 was likewise never one statement. |
| **The mmap / page-cache constants having expired again** | §1.6: `mapsWholeFile=true`, `mmapMb=1428` on a 1 142 MB file, `pageCacheMb=256`. Autoscale is live. |
| **The relocate JOB itself** (`MediaRelocateEngine.run`, which uses the same `pageRows`) | `relocate progress` lines run **01:05:37 → 01:24:31** and stop with *"the source is NOT empty — this job moved a FRACTION…"*. The saturation both predates (back to 08-30 14:17) and outlives them. `start()` refuses a concurrent job, so a job can hold **one** walk — 1 page per 16 s, not 1 912 per minute. |
| **A `sqlite-vec` KNN scan sharing the handle** | Never appears in any of the 359 windows' top-5. |
| **`ANALYZE` / the `dbstat` storage report** | Both are one-shot and gated; neither appears in 24 h of hub logs. |

**A correction for `sqlite-pragmas.ts`:** its 2026-08-25 reasoning rules out disk
by observing *"the NVMe was idle (`%util` 1.5–8 %, `r_await` 0.14 ms)"*. The
database is not on the NVMe. It is on `/dev/sdb1`. The conclusion still holds
today (sdb is at 3 % util), but the premise names the wrong device and should be
fixed before someone reuses it.

---

## 4. The floor — what these probes cost against a healthy store

Remove the one shape and the engine's own numbers give the answer directly.
Non-media work in a typical window is **1 263 ms of 60 000 ms = 2.1 % busy**,
across 4 951 statements — **0.26 ms average service time**.

| Probe | Today | Floor (**inferred** from §1.3/§1.1) |
| --- | --- | --- |
| `settingsStore.get`, 71 B | 14 846–16 052 ms | 0.26 ms engine + 2 UDS hops ≈ **2–5 ms in-cluster**; **~15–40 ms** end-to-end over HTTPS from the Mac, i.e. the same envelope as the `nodes.getNodeAddons` control |
| `settingsStore.query`, 3 893 B | 15 256–18 349 ms | same envelope — the payload was never the cost |
| `nodes.topology` (2 sequential phases) | 30 483 ms | **~30–80 ms** |

That is a **400–1000×** reduction, and it is the constant that all five of the
round-trip fixes listed at the top were being divided into.

---

## 5. Remedies, ranked by risk

The operator's standing rule applies: **remove the cause.** Do not raise a
timeout, do not cache the answer in a consumer, do not give the engine more RAM.

### R0 — operator action, now, no code (relief, not a fix)

The ~500 in-flight censuses hold **no stop signal** (`stop: () => false`), so
nothing retires them: they survive the browser tab, the HTTP abort, and any UI
change. The only way to clear them is to **respawn `hub/pipeline-analytics`**
(D5 — lifecycle is a respawn) and close any admin-UI tab on
Recordings → Management.
*Risk:* one runner respawn, seconds, no durable state involved.
*Limitation:* one page visit restarts the runaway.

### R1 — smallest code fix: stop polling a table walk (`addon-admin-ui`)

Drop `refetchInterval: 10_000` from `StorageMigrationSection.tsx:416`. The
component already refetches after every action it takes
(`residueQuery.refetch()`, line 437), so nothing operator-visible is lost.
*Risk:* near zero; UI-only; no semantics change.
*Not sufficient alone:* **one** census still occupies ~96 % of the engine for its
whole duration. This removes the unbounded accumulation, not the cost.

### R2 — bound and single-flight the census (`media-relocate-engine.ts`)

At most one census in flight per `(mode, toLocationId)`; concurrent callers join
the walk already running (D181's rule — a joiner sees the snapshot it would have
seen anyway; this is **not** a cache, nothing survives settlement). Plus a hard
budget in pages or ms, past which the census returns **`null` = unanswerable**,
which D295 already blesses and which `residue()` already renders correctly
(`items: null` still lists the class, so the drain affordance survives).
*Risk:* low, but it changes an operator-visible number from exact to "unknown"
on a large table — a decision worth an ADR.
*Enforcement:* a test that fails when the budget is removed. Per CLAUDE.md,
confirm it RED by deleting the fix.

### R3 — structural, and the only one that makes the question cheap

Make the media-lane residue an **indexed `COUNT(*)`**. The blocker is that a
`NULL` `locationId` means "the default location", which is precisely what the
event-media seal was built to remove: stamp every row, and `move` residue
becomes `COUNT(*) WHERE locationId <> ?` — the `locationId IS NULL` index
already exists for the other half. `gallery` additionally needs an `ownerKind`
index or a stored flag.
*Risk:* highest. The seal is a 464 902-row write pass and is **currently
stopped**; it must be re-planned under D58/D54 rather than smuggled in behind
this fix.

### Rejected outright

A longer client timeout, a consumer-side cache of the census, a bigger SQLite
page cache, or a second engine. Each hides the stall; none removes it.

---

## 6. A separate defect found on the way — do not fold it into the above

`settings-store query truncated by a defensive row cap` fired **138 times in 2 h**
(≈ every 52 s), every one of them:

```
collection: addon-device-settings   rowCap: 2000
boundSource: default-cap            requestedLimit: null
hasWhere: false  hasWhereIn: false  hasWhereBetween: true
```

That is `loadPrefixed` in `packages/system/src/kernel/settings-door-view.ts`
serving `readDeviceStoreBatch` over a `<addonId>:` prefix range with **no
`limit`**. On a ~970-device fleet an addon with three device keys already
exceeds 2 000 rows, so the batch read **silently returns a partial answer** —
a correctness bug, not a performance one, and unrelated to the stall. It needs
its own fix (page the prefix range, or declare a bound the caller can see).

---

## 7. What is NOT determined

Stated precisely, with what would settle each:

- **Which client starts the censuses.** `storageMigration.residue` is
  `adminProcedure`, and the admin UI's 10 s poll is the only timer-driven caller
  **in this repository** — but that is a code fact, not an observation. No log
  line names a `countRelocatableMedia` call, and `HttpRequestCensus` is **not
  armed** (`transport census` returned 0 lines over 1 h). Repeated aborted/retried
  requests, several open tabs, and an external script are all equally consistent
  with what was measured. **Settles it:** arm `HttpRequestCensus` on the hub for
  one window and read the `transport census` line — it carries per-procedure
  counts and caller groups. That is a hub-side change this session did not make.
- **When the runaway began.** Loki's 1 000-line result cap stops at
  2026-08-30 14:17 UTC, and the condition was already at 91 % there.
  **Settles it:** a narrower LogQL query (pin `{node="hub"}`, `|= "sqlite engine
  busy"`, `| json`, 7 d) walked backwards page by page.
- **The exact concurrency.** 480–530 is arithmetic from two measured rates, not
  a count. **Settles it:** a debug line in `countSelected` reporting censuses in
  flight, or a heap snapshot of `hub/pipeline-analytics` counting live
  `pageRows` generators.
- **Whether anything else contributes once the walk is gone.** The floor in §4
  is projected from the profiler's non-media residual (2.1 % busy). It has not
  been observed, because observing it requires removing the walk.

---

## 8. Reproducing this without re-paying for it

Everything above came from three sources, none of which touches the production
SQLite with a query tool — and **nothing here ever should**: opening it through
`/mnt/user` corrupted this database on 2026-08-19, read-only and `mode=ro`
included.

1. **Loki** — free, no load on the hub.
   `hl loki-query '{job=~".+"} |= "sqlite engine busy"' 6h` is the whole
   diagnosis. `SqliteOpProfiler` is always on and reports to the log, not to an
   API.
2. **Host/container metadata** — `docker inspect` mounts, `findmnt`, `lsblk -d -o
   NAME,ROTA,MODEL,SIZE,TRAN`, `stat`, `iostat -x -d 2 2`, `/proc/<pid>/stat`.
   No `find`/`du` on `/recordings` or `/mnt/disks/recordings-2`; `hdparm -t`
   hangs unkillable on this host.
3. **Exactly three store calls**, and they are the expensive ones — each costs
   ~16 s and queues behind everyone else. A measurement loop is itself an
   outage.
