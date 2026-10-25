---
title: Plan — static detection becomes burst-based, and promotion by continuity falls
date: 2026-08-28
status: proposed
---

# Static detection becomes burst-based

> **For whoever implements:** REQUIRED SKILL — `superpowers:executing-plans` or
> `superpowers:subagent-driven-development`. The steps use checkboxes (`- [ ]`).
> **Every step writes the test BEFORE the implementation**, and every step declares
> what it does **not** solve.

**Goal.** Replace the birth of a stationary entry: no longer *«a
track stayed alive and still for 30 s»*, but *«the same thing was seen
in the same spot in different passes»*. The registry, the suppression and the
expiry stay — **only how an entry is born** changes.

**The constraint that decides the design.** A criterion anchored to **track
continuity** is fragile exactly where it matters: a single gap in the detector
is enough to break the track and restart the clock. The new criterion must use
**repetition**.

**The two things the brief could not know, and that change the order of the steps.**
They emerged while measuring, and each invalidates a piece of the obvious plan:

1. **The burst does not run. Ever. Zero times in seven days** (§0.2). The mechanism
   exists, is switched on on all 29 cameras, and is **unreachable by
   construction** — the third occurrence of the same defect as D144 and D261.
   So «the burst is already there, zero cost» is **false**, and the cost must be paid and
   quantified.
2. **The 30 s immobility test does TWO jobs** — it creates an entry **and** closes the
   session — and only the first is destructive (§1.3). Removing them together, every
   session of every camera that sees a parked car runs to the ceiling, forever.
   The plan therefore **separates the two jobs before touching anything else**.

---

## Part 0 — What REALLY exists already (measured, not deduced)

> All the measurements are from **2026-08-27 ~23:25 CEST**, read-only, via tRPC
> on the hub and `count_over_time` on Loki (the helper truncates at 1000 lines: no
> count comes from a result length).

### 0.1 · The stationary knobs — all five exist, with UI

`packages/addon-post-analysis/src/pipeline-analytics/stationary-settings.ts` (lines 20-37),
per-device, all with a form entry in
`packages/addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts` (lines 543-609):

| field | default | bounds | who reads it at runtime |
| --- | --- | --- | --- |
| `enabled` (`:23`) | `true` | — | `index.ts` (lines 6028) (promotion) **and** `index.ts` (lines 10088) (per-frame gate) |
| `suppressIou` (`:26`) | 0.6 | 0.3–0.9 | `index.ts` (lines 10098) → `stationary-match.ts` (lines 187) |
| `wakeAssocIou` (`:30`) | 0.1 | 0.02–0.5 | `index.ts` (lines 10099) → `stationary-match.ts` (lines 181) |
| `promotionWindowMs` (`:33`) | 30,000 | 5,000–120,000 | **only one:** `index.ts` (lines 6035) |
| `entryTtlMs` (`:36`) | 300,000 | 60,000–**1,800,000** | `index.ts` (lines 2710) → `stationary-registry.ts` (lines 388,395) |

**No device has an override**: `addonSettingsRaw.getDeviceOverrides` for
`pipeline-orchestrator` answers `{}` on **all 30 cameras**. Everything that
runs is the default.

And **no guard verifies that these fields have a form entry**. The
schema↔form coverage exists but it is a vitest test,
`__tests__/tracking-settings-form-coverage.spec.ts` (lines 33), which inspects **only
`TrackingSettingsSchema`**. It does however build `formKeys` from *all* the sections:
**widening the set of needles is one line**, and it is the cheapest guard
available here. It must be done **before** renaming a field.

### 0.2 · The burst exists, is on everywhere, and has NEVER started

`occupancyRecheckEnabled = true`, `occupancyRecheckSec = 300`,
`occupancyRecheckFrames = 4` — **identical on all 30 cameras**, all defaults
(`pipeline-runner.cap.ts` (lines 247-248)).

And in **7 days** each of these lines counts **zero**
(`packages/addon-pipeline/src/pipeline-runner/index.ts`):

| line | src | 7 d |
| --- | --- | --- |
| `occupancy re-check: starting burst` | `:4587` | **0** |
| `occupancy re-check: burst complete` `{collected, found}` | `:4429` | **0** |
| `occupancy re-check: tapping live analyzer motion frames (no dial)` | `:4459` | **0** |
| `occupancy re-check: safety timeout reached` | `:4601` | **0** |
| `occupancy recheck skipped — battery camera is sleeping` | `:4379` | **0** |

**The zero is real, not a log-level problem.** `debug` reaches Loki —
~100,000 lines/h — and in particular the `debug` **of this very file**:
`onboard-analyzer: opened motion-frame subscription` (`:3238`) counts **13,937 in
24 h**.

**Why, traced:** the timer is a 300 s `setInterval` created in
`registerCamera` (`runner.ts` (lines 508-524)) and **destroyed in `unregisterCamera`**
(`:793-796`). But on an `on-motion` camera the registration lasts as long as one
session — the comment says so itself at `pipeline-runner/index.ts` (lines 400-402):

> «an `on-motion` camera is not driven by the phase gate: the orchestrator dispatches
> a session on motion and calls `detachCamera` a `motionCooldownMs` later»

Corresponding measurement, 24 h: `attachCamera` **14,159**, `detachCamera` **14,099**,
paired sessions **14,040**, median duration **11.9 s**. And `motion gate opened —
phase=active` / `motion gate closed — phase=watching` (`runner.ts` (lines 905,927),
both `info`) count **0**. A registration lives ~12 s + 30 s of cooldown;
**the interval it needs is 300 s**. It cannot fire, and `occupancyArmed` — which
is switched on only in `transitionToWatching` — is never switched on.

**Third occurrence of the same defect**: two packages that do not name each other, two
correct constants, and an arithmetic between them that makes a branch unreachable.
D144 (4 positions in 30 s against a 45 s poll), D261 (30 s window against a
10 s floor), and now 300 s against a 42 s registration.

**Consequences for this plan, all heavy:**

- The burst is **not free**: it must first be made to exist, and this is new load.
- **It is not even repairable where it is.** A per-camera timer inside the runner cannot
  survive a camera that is registered only during a session. The burst
  must be born where the camera is known **stably** — the orchestrator (§2.2).
- D136's **occupancy re-check** has never worked either. This plan
  repairs it as a side effect, and the two uses must remain **a single
  mechanism with a single knob**, or it is a second source of truth (D62).

### 0.3 · The real cost of a burst, measured on its components

The burst never started, so its duration **cannot be measured**. The two
components can:

**(a) The dial.** `session-decode: detection first frame`, field `firstFrameMs`:

| node | median | p90 | cold dials / 24 h |
| --- | --- | --- | --- |
| mac-mini | 4,504 ms | 6,442 ms | 3,963 |
| hub | 4,960 ms | 7,187 ms | 2,122 |
| agent-a | 5,050 ms | 6,857 ms | 1,033 |

⚠ **It collides with its own timeout.** `OCCUPANCY_BURST_SAFETY_TIMEOUT_MS = 8 000`
(`pipeline-runner/index.ts` (lines 333)), and out of 7,118 cold dials in 24 h **328 (4.6 %)
exceeded 8,000 ms** and **1,646 (23.1 %) exceeded 6,000 ms** before the
first frame. One burst in twenty would collect **zero**, and one in four would have
less than 2 s to collect 4 frames.

⚠ **And the cheap path is not available.** The tap on already-decoded frames
requires `motionSources` with `analyzer`: **28 cameras out of 30 have `["onboard"]`**,
2 have `["analyzer"]`. On 28 cameras the burst is **always a dial**.

**(b) The 4 inferences.** 102 measures **104.4 ms/frame** (the most expensive camera
of the fleet, 4K) → ~418 ms. Fleet average 43.5 ms → ~174 ms.

**Total per burst ≈ 5.0 s of a decoder slot + 0.2–0.4 s of inference.**

### 0.4 · The phantom cells — they run, and 102 dominates them

`pipeline/stationary/phantom-cells.ts`: `PHANTOM_CELL_PX = 32` (`:65`), 24 h window
(`:74`), `PHANTOM_SUSPECT_MIN_CLOSES = 3` (`:83`), ceiling 0.9 (`:95`), 512
cells per device (`:104`). Producer `noteShortMotionlessTrack`
(`index.ts` (lines 7222-7311)) from the `onTrackClosed` hook (`index.ts` (lines 1898)); consumer
`spawnBar` (`index.ts` (lines 7090-7098)) on `confirmation-gate.ts` (lines 257).

The mechanism is **alive**, and already says where the problem is:

| line | 24 h | 7 d |
| --- | --- | --- |
| `phantom cell armed — spawn bar raised here` | **75** | 480 |
| `phantom cell cleared — a real subject moved through it` | **109** | 928 |
| `short motionless track closed` (the feeder) | **431** | — |
| `phantom cells capped` | 0 | **0** (the cap has never been touched) |

Per device: **102 `vehicle` arms 62 times and is cleared 41 times a day** —
a bar raised and knocked down about every hour, which never settles. The other
armings in 24 h are 3829:8, 101:3, 104:2, and nothing else. `short motionless
track closed` on **102 `vehicle` = 138/day**, the single largest bucket
of the fleet.

**Verdict: it is NOT the evidence registry, and reusing it as such would be a mistake.** Five
reasons from the code, the third confirmed by those 41 clearings a day:

1. **It does not record geometry.** It holds `closes: number[]` and nothing else (`:107-115`); the
   32 px were chosen on purpose so that the box is **not** reconstructible
   (`:59-65`), whereas suppression is by IoU (`stationary-match.ts` (lines 172-188)).
2. **Its product is a scalar**, not an entry.
3. **Its admission predicate is inverted.** `isShortMotionlessTrack`
   requires `lifeMs <= 25_000` (`store/short-motionless.ts` (lines 22,50)), and the
   `else` branch calls `noteMovingClose`, which **deletes** the cell
   (`index.ts` (lines 7238-7249)). On 102 the `vehicle` tracks have a median of 8.3 s but a p90 of
   27.3 s: **about one in ten exceeds 25 s and erases the memory of its
   own parking spot.** These are the 41 clearings a day.
4. **Its revocation is inverted**: «a real subject is enough to revoke it» (`:44-50`).
   For a parked car the right revocation is the two-reading wake (D49).
5. **Its write is fire-and-forget** (`index.ts` (lines 7289) `void`), motivated by
   «a lost write costs an undercounted cell». A registry that decides whether
   a durable entry is born cannot be wrong in that direction.

**What must be copied wholesale**, because it is already validated: the `DurableLedger` wrapper
with `declare/load/put/forget` (`:211-269`), the **synchronous read from RAM** with
its D49 rationale (`:317-328`), the pruning of the window on touch
(`:128-134`), the per-device LRU cap (`:345-356`), the `@durable` block
(`:152-157`) and the reseeding log at boot (`index.ts` (lines 2753-2756)).

### 0.5 · The precedent already shipped: the same design, for parcels

`pipeline/package/package-stillness-tracker.ts`, born a month ago from the same
problem for another class (D144):

> «the track DIES between one round and the next → re-association is by POSITION
> (IoU), never by trackId; a round can be minutes apart → there is no
> look-back window, only a count of distinct FRAMES» (`:29-32`)

`MIN_HITS = 3` (`:63`), `ASSOC_IOU = 0.3` (`:87`), `TTL = 5 min` (`:79`).
**This plan generalises that path**: it does not invent a mechanism.

### 0.6 · The state of the registry, now

`zoneAnalytics.getCurrentSnapshot { deviceId }` → `.stationaryObjects`, on all
30 cameras. **Six entries in the whole fleet**; 24 cameras have zero:

| dev | class | last confirmation | age of the non-confirmation |
| --- | --- | --- | --- |
| 592 | person | 21:23:42Z | 113 s |
| **102** | **vehicle** (`Car`) | 21:17:09Z | 506 s |
| 1439 | vehicle | 16:18:27Z | **5.1 h** |
| 1441 | vehicle | 21:25:02Z | 33 s |
| 3629 | vehicle | 2026-08-18 14:27Z | **9.3 days** |
| 3829 | vehicle | 21:25:35Z | 0 s |

**102 has exactly ONE entry**, against three cars seen by the operator — the starting
fact, confirmed.

And the registry is **regrinding the same car**: 102 in 24 h makes **21 promotions**
(all `vehicle`) and **20 retirements** (18 `departed`, 2 `ttl`), to end up with
one entry. Fleet-wide: **208 promotions in 24 h** — **176 `person`, 30 `vehicle`, 2
`animal`** — and 201 retirements. In 7 days: 1,381 promotions, of which 146 on 102.

The work that suppression does anyway, when an entry exists, is real: on
102 **40,750 detections absorbed in 24 h** (median 178 per sweep, maximum 2,089),
280,058 in 7 days. Fleet: 3829 66,253, 1443 31,468, 592 21,352.

### 0.7 · Live defects found walking this code

None is caused by the plan; all of them touch it.

1. **The phantom cells write and read different points.** The write passes
   `positions[0]` (`index.ts` (lines 7231)), which is the **centroid** (`index.ts` (lines 5669)); the
   read passes `candidate.bbox.x/y` (`index.ts` (lines 7094-7095)), which is the **top-left
   corner** (`confirmation-gate.ts` (lines 94-99)). At 32 px, any box
   larger than 32 px **lands in a different cell on read**.
   `phantom-cells.spec.ts` (lines 120-145) does not cross the boundary: it calls write and
   read with the **same literal coordinates**. The fake supplies the agreement that
   production does not have.
2. **A birth suppressed by the confirmation gate still keeps the
   session open.** `suppressedBirths.isRejected` (`index.ts` (lines 5654)) skips only the upsert
   on the trackStore: the rejected track **stays in `result.tracked`**.
3. **Two stationary entries have not been retired for days** (§0.6: 3629 at 9.3
   days, 1439 at 5.1 h). The TTL counts **observed** time, and on a camera that
   produces no frames it does not advance — it is the design, not a bug, but it means that
   the overlay shows a car from nine days ago. §4.3 makes it worse and declares it.
4. **`docs/design/2026-08-21-group-entity-and-group-media.md` (lines 290)** states that
   `closedReason: 'stationary-promotion'` is written from a single place. It is false: the
   producers are **two** (§5.1).
5. **`enabled` is claimed twice in the same flat key space**:
   `settings-schema-sections.ts` (lines 552) (stationary) and `settings-schema.ts` (lines 701)
   (global face kill). Pre-existing.

---

## Part 1 — The session fix (D261): **it stays**. Decided.

The reason is **no longer** «to get the track to the promotion window».
It is the operator's, and it is stronger:

> **While a session is open the detection runs anyway. Every observation of a
> still object is a confirmation at zero marginal cost.** We do not pay uptime for the stationary ones:
> we collect evidence that we were already producing.

Plus two reasons of its own, measured in D261 and valid anyway: **223 tracks out of 312
(71.5 %) died at the instant of the teardown** after a median of 6.27 s of immobility,
and **86 % were still observed AFTER the falling edge** (median +2.78 s).

⚠ ** It is NOT in production.** Committed at 23:11 on 2026-08-27,
eleven minutes before this measurement. Proven in three independent ways: the
strings it introduces (`held open — subject still present`, `max-hold cap`) do not
appear in 7 days; the closing line in production carries neither `openForMs`,
`sinceSubjectSeenMs` nor `subjectPresent`; and production still emits
`detection session: held open — active non-stationary track` (50 times in 24 h),
which that commit **deletes**. **So everything D261 says about uptime
(7.9 % → 14–18 %) is a PROJECTION, not an observation**, and P0 must be redone after
the deploy.

### 1.1 · The starting state, measured now

14,040 paired sessions in 24 h, reconstructed by pairing `dispatched on motion`
→ `closed on motion clear` / `closed after motion cooldown` by `tags.deviceId`:

| | median | p90 | **p99** | ≥30 s |
| --- | --- | --- | --- | --- |
| fleet (n=14,040) | 11,855 ms | 32,233 ms | **98,084 ms** | 13.22 % |
| **102** (n=504) | **10,192 ms** | 18,150 ms | — | **3 (0.6 %)** |

Closing reasons: `motion_cleared` **97.7 %**, `cooldown` 2.3 %, **`hold` 0**,
**ceiling `maxSessionHoldMs` 0**.

**102 reproduces D261 almost exactly** (504 sessions against 503, median
10,192 against 10,221, 503/504 on `motion_cleared`): the distribution is still
glued to the 10,000 ms floor.

**Detection uptime today** (Σ durations ÷ window): **fleet 12.93 %**, **102
7.45 %**. But the tail is high: **104 at 54.6 %, 103 at 52.6 %, 1443 at 51.9 %**.
Three cameras are **already** above 50 %, which makes the 70 % ceiling of §1.3
much closer than it seems.

### 1.2 · The chain that keeps a session open, and its ONLY valve

```
frame-processor.ts:624-641   the stationary gate removes the suppressed detections
                             BEFORE tracker.update (:645) → they can never be in `tracked`
frame-processor.ts:825,991                          →  result.tracked
index.ts:6719                const hasLiveTrack = result.tracked.length > 0
orchestrator-subscriptions.ts:362                   →  controller.noteSubjectPresent(deviceId)
session-dispatch-controller.ts:940-954              →  decideSessionLifecycle(...)
dispatch-reconcile.ts:369-384                       →  'hold' | 'defer-floor' | 'close'
```

Constants: `MIN_SESSION_OPEN_MS = 10_000` (`session-dispatch-controller.ts` (lines 103)),
`DEFAULT_MAX_SESSION_HOLD_MS = 120_000` (`:77`),
`SUBJECT_PRESENT_STALE_MS = 4_000` (`:122`), `SUBJECT_PRESENCE_RECHECK_MS = 2_000`
(`:130`), `maxSessionHoldMsField.default = 120_000` (`pipeline-runner.cap.ts` (lines 219)).

Verified one by one, **nothing else removes a still object from `result.tracked`**:

| candidate | file:line | verdict |
| --- | --- | --- |
| stationary suppression | `frame-processor.ts` (lines 638-641) | **the only one**, and it applies only to an object that **already** has an entry |
| `maxTrackLifetimeMs` (300,000) | `sort-tracker.ts` (lines 208,712-725) | **it is not a valve.** It retires and the track is reborn in the **same** `update()`; it returns to `tracked` after `minHits = 3` ≈ **300 ms** at 10 fps, against 4,000 ms of staleness |
| static gate of the key events | `key-event-scoring.ts` (lines 198-208) | **no.** It runs at CLOSE and writes only `importance` |
| phantom cell bar | `index.ts` (lines 7090-7098) | **no**, and in fact §0.7.2 |

### 1.3 · The calculation that decides the order of the steps

Car parked permanently, `detectionFps` 10, measured warm-up 6,000 ms:

| scenario | session duration | uptime 102 (504 sessions/24 h) |
| --- | --- | --- |
| **(a) today + D261 deployed** — first session: promotion at ~36 s, presence expires in ≤ 6 s → **~42 s**; later sessions suppressed from frame 1 → **10 s** | 42 s then 10 s | 14–18 % (**projection**) |
| **(b) promotion removed, no replacement** — presence **never** decays | **120 s, the ceiling, on EVERY session, forever** | 504 × 120 / 86,400 = **70.0 %** |
| **(c) promotion replaced by an evidence rule** | **identical to (b) for the whole ramp**, then 10 s | K × 120 s per object, per camera |

That 70 % is the «hard ceiling» that D261 names, and that it explicitly calls *a failure
worse than the defect* (`dispatch-reconcile.ts` (lines 347-349)). On 104 and 103, already
above 50 %, the margin is even smaller.

**Conclusion: an evidence rule is NOT by itself a replacement.** The jump from 42 s
to 120 s is not tuning, it is structure. A **second valve, independent
of the evidence,** is needed, which removes a still object from the presence signal **before**
the first entry is born.

### 1.4 · The second valve: the 30 s criterion does not die, it is DEMOTED

The immobility test does **two jobs**, and only one is destructive:

| job | destructive? | how much evidence it deserves |
| --- | --- | --- |
| **creating an entry** → suppresses, declares scenery, **blinds** | **yes** | repetition across passes (§3) |
| **ceasing to keep the session open** | **no** — if it is wrong, the session closes 30 s early and the next movement reopens it | one reading of recent immobility |

**So the 30 s criterion stays and is rewired from the registry to the presence
signal:**

```
index.ts:6719   const hasLiveTrack = result.tracked.length > 0
                ↓
                const hasLiveTrack = result.tracked.some((t) => !trackIsStill(t))
```

where `trackIsStill` is **`evaluateStationaryPromotion` renamed**: same
positions from `trackStore.peekActive` (`track-store.ts` (lines 889-903)), same
`computeStaticTrackMetrics` (`static-track-gate.ts` (lines 49-72)), same
`STATIC_DISPLACEMENT_FRAC` / `STATIC_SPAN_FRAC` (`key-event-scoring.ts` (lines 38,41)).

What it buys:

- **The session closes at ~42 s as in (a)**, even before an entry exists. The
  70 % never materialises.
- **`promotionWindowMs` does not become orphaned**: it is renamed
  `sessionStillnessWindowMs`, same bounds, honest meaning.
- **`processor.dropTrack` is no longer needed.** `index.ts` (lines 9904) is **the only production
  caller**; `FrameProcessor.dropTrack` and `SortTracker.dropTrack` become
  dead code and go away with it.
- **The guard stays armed**, the target changes (§5.5).
- **And `person` can be excluded from promotion without paying uptime** (§6.3),
  which is the main reason this step is worth it.

**The cost, declared.** A still track stays alive until the teardown, so it
pays for the detail plane for ~42 s — as much as today. And it closes with the normal
teardown reason instead of `stationary-promotion`, so it **enters the Events
gallery and becomes groupable**: it must be marked (§5.1).

### 1.5 · `maxSessionHoldMs`: it is NOT lowered, and now there is the measurement

The brief asked whether to shorten the window now that it no longer has to cover 30 s.
Answer, from the measurement: **no**.

- **`SUBJECT_PRESENT_STALE_MS` = 4,000 ms** is not a second promotion clock, it is
  the tolerance on the freshness of the signal; the tail after a
  subject leaves is 4–6 s. It stays.
- **`maxSessionHoldMs` = 120,000 ms.** The **measured p99 of `openForMs` on
  sessions closed by `motion_cleared` is 98,084 ms**. The ceiling sits at **1.22× the
  p99**: lowering it would cut real subjects, and the gain would be marginal
  because with §1.4 the ceiling is **no longer the mechanism that closes a session with
  a parked car** — the immobility valve is, at ~42 s.

---

## Part 2 — The design: ONE evidence registry, TWO producers

```
                 ┌── motion session ──────┐        ┌── periodic pass ──────┐
                 │ detection already      │        │ dispatched            │
                 │ running                │        │ by the                │
                 │ marginal cost: ZERO    │        │ ORCHESTRATOR          │
                 │ 14,040 a day           │        │ ~5.4 s, 4 frames      │
                 └───────────┬────────────┘        └──────────┬────────────┘
                             │        one PASS = one point    │
                             └──────────────┬─────────────────┘
                                            ▼
                        StationaryEvidenceLedger        ← THE NEW PIECE
                    (deviceId, className) → candidates anchored to a BOX
                       { t, source: 'session'|'burst', bbox }
                                            │
                                  refined criteria (§3)
                                            ▼
                          StationaryObjectRegistry (unchanged)
                     entry → suppression, occupancy, TTL, wake
```

### 2.1 · Sessions are the main producer; the burst is the complement

Sessions confirm for free, when they exist. **And there are many**: 14,040 in
24 h on the fleet, 504 on 102. The burst covers what the sessions do not see.

How little the sessions are enough, measured on 102 (`pipelineAnalytics.getObjectEvents`,
one hourly bucket at a time so that the 1000 limit never truncates):

| window | `vehicle` events | distinct `vehicle` trackIds |
| --- | --- | --- |
| night (22:29→06:29, 8 h) | **66** | **27** |
| day (06:29→22:29, 16 h) | **794** | **269** |

**The operator's night hypothesis is only partially confirmed, and the correction
matters.** The detector *keeps* firing on parked cars at night
— the 01:29 hour produces 16 events on 5 tracks with no plausible arrival —
but the night volume is **8 % of the day volume**: the night is above all
**silence**, not flicker. The dominant churn is **daytime**.
Direct consequence: **at night the burst is not a complement, it is the only
source**, and the evidence window must be sized on the night rate (§3).

### 2.2 · The burst must be RE-LOCATED, not just switched on

§0.2: a per-camera timer inside the runner cannot survive a camera
registered only during a session. The burst must live where the camera is known
stably — **`SessionDispatchController` in the orchestrator**, which already decides
attach and detach and already knows the complete list.

Form: **a mini-session dispatched on a cadence**, with `frames` frames and then
detach. It fully reuses the existing dispatch path; it does not introduce a
second way of getting frames to arrive.

Three properties that go with the re-location:

1. **It skips the camera that has an open session** — it is the operator's explicit
   request, and here it must be written by hand (in the runner it was implicit in
   `phase === 'watching'`, `runner.ts` (lines 516)).
2. **No arm/disarm.** The `occupancyArmed` / `emptyBurstStreak` state machine
   (`runner.ts` (lines 745-757,923)) is **precisely what killed
   the mechanism**, and at the cadence of §2.3 the cost does not justify the risk. A
   burst on an empty camera costs 5.4 s of a slot every half hour. **Removing it
   also eliminates the risk «the burst switches itself off precisely at night»**, which would
   have been the most insidious risk of this plan.
3. **The battery gate stays** (D173, `pipeline-runner/index.ts` (lines 4376-4384)): a
   sleeping camera is not woken up to be looked at.

⚠ **The old timer must be removed, not left alongside.** Two mechanisms for the
same question are a second source of truth (D62), and one of the two has never
worked. `occupancyRecheckSec` / `occupancyRecheckFrames` /
`occupancyRecheckEnabled` **remain the knobs**, only the owner changes — so
D136 (the occupancy re-check) is repaired by the same work, instead of
staying broken next to a new thing that works.

### 2.3 · The cadence: **1,800 s**, and where it comes from

The burst is the **complement**, so it is sized on «how often is a piece of evidence needed
for an object that the sessions are NOT already confirming», not on «how often
do I want to know what is still».

| cadence | one burst every | average occupancy of ONE slot (out of 3) | outcome |
| --- | --- | --- | --- |
| 300 s (today's default, never executed) | 10.3 s | **~52 %** | too much, and for nothing |
| **1,800 s (proposed)** | 62 s | **~8.7 %** | 12 passes in 6 h, 4× the need |
| 30 s (tried on 2026-08-13) | 1.03 s | **> 500 %** — beyond the three slots | **starved the decode path; reverted the same evening** |

Derivation: the criterion needs **3 passes within `EVIDENCE_WINDOW_MS`**
(§3). With the window at 6 h, a cadence of 1,800 s provides **12** — four
times the necessary, which is the margin that absorbs the 4.6 % of dials that timed out
(§0.3) and the battery gate. Cost: 29 × 5.4 s / 1,800 s = **8.7 %** of a decoder slot
(≈ 2.9 % of the pool of three), against 52 % of a slot at 300 s.

⚠ `occupancyRecheckSec` has `max: 300` in the schema. Raising it to 3,600 **widens a
BOUND**, and it is **tied to the train**: the host validates `attachCamera` against its own
copy of the schema. Widening UPWARDS is the safe direction — the starvation
of 2026-08-13 came from lowering it.

### 2.4 · The safety timeout must be raised, and the measurement says by how much

`OCCUPANCY_BURST_SAFETY_TIMEOUT_MS = 8 000` against a `firstFrameMs` with a median of
4.5–5.1 s and **p90 6.4–7.2 s**; 4.6 % of the dials exceed 8,000 ms. A burst must
cover *the first frame* plus *4 frames at `detectionFps`*: p90 7,200 + 400 =
7,600 ms, with margin → **12,000 ms**. Below that, one burst in twenty collects zero and
one in four has less than 2 s.

### 2.5 · A SINGLE registry, or today's defect returns in another form

A session observation and a burst one **count towards the same entry**:
same candidate, same count, same threshold. If they fed two separate
counters, an object confirmed half by one and half by the other would not be
promoted by either — the current defect in disguise.

The burst frames arrive at post-analysis **like any other frame**
(`source: 'pipeline'`, `pipeline-analytics/index.ts` (lines 5387-5390)), on the same
`FrameProcessor`. **The evidence producer is a single call site**, where
today the promotion loop sits (`index.ts` (lines 6018-6066)).

### 2.6 · A PASS, not a frame

A pass contributes **at most one point** per candidate. Without this, a
42 s session at 10 fps would be worth 420 pieces of evidence and we would have rewritten today's criterion
with more steps.

**How a pass is recognised**, two ways, in this order:

- **Path A — the source declares itself (authoritative).** The orchestrator knows whether it is
  dispatching a motion session or a periodic pass. An additive field
  `pass: { kind: 'session' | 'burst', id }` is stamped on the payload.
  ⚠ `PipelineInferenceResultPayload` is in
  `packages/types/src/interfaces/event-bus.ts` (lines 337) — **framework, tied to the
  train**. But §2.3 already is, so **A and the cadence travel together** and
  path B serves only as a bridge.
- **Path B — inference from the gap (addon only, shippable immediately).** An interval
  `> PASS_GAP_MS` from the last processed frame opens a new pass.
  `lastFrameAtByDevice` already exists (`stationary-registry.ts`, `noteFrame`).
  `PASS_GAP_MS = 15_000`: above the longest interval *within* a pass (the
  timeout of §2.4 raised to 12,000 ms) and below the shortest *between* passes.
  ⚠ The second end is **not guaranteed**: `motionCooldownMs` has `min: 0`
  (`pipeline-runner.cap.ts` (lines 214)), even though **all 30 cameras have it at
  30,000** today. It errs on the conservative side: it merges two passes into one, hence
  less evidence, slower birth, **never a false birth**.

**A and B must agree, and disagreement is a log line.**

### 2.7 · The evidence carries the mark of its source

Every observation carries `source: 'session' | 'burst'`. It serves to answer, a
month from now, **«is the burst on this camera really needed?»**: if on 102 100 % of
the evidence is `session`, the burst there is wasted work and is switched off per camera. Without
the mark that question has no answer — and that is exactly how the
mechanism of §0.2 ended up, switched on everywhere and never executed, for weeks, without
anyone being able to notice.

The count by source comes out in **one line per sweep, per device** (never per
frame — precedent: `stationary registry absorbed detections`), with
`tags: { deviceId }`.

---

## Part 3 — The refined criteria, and which measurements the thresholds come from

Today the criterion is four AND-ed conditions anchored to the track
(`stationary-match.ts` (lines 248-275)). For **closing the session** they remain valid and
remain in service (§1.4). For **creating an entry**, none survives.

### 3.1 · The measurement from which everything else descends

102, 24 h, `pipelineAnalytics.listTracks` (positions in absolute pixels, frame
3840×2160; birth = `positions[0]`): **153 tracks — 126 `vehicle`, 25 `person`,
2 `audio`.**

Life of the `vehicle` tracks: median **8,307 ms**, p75 16,697, p90 27,287, **max
66,898 ms**. **Every vehicle track dies within 67 s** — none can reach,
on its own, a proof of immobility that wants to last minutes.

**Histogram in 32 px cells, 102 `vehicle`: 126 births in 70 distinct cells.**

| cell | ≈ px | births |
| --- | --- | --- |
| **101,16** | 3232, 512 | **13** |
| **112,31** | 3584, 992 | **9** |
| **102,16** | 3264, 512 | **6** |
| 113,31 · 102,17 · 58,13 | | 4 each |
| 78,4 · 114,32 · 113,32 · 58,14 · 112,30 | | 3 each |

**Two neighbourhoods dominate:** `{101-102, 16-17}` ≈ px (3232-3296, 512-544) = **23
births**, and `{112-114, 30-32}` ≈ px (3584-3680, 960-1056) = **22 births**. They are
**two parking spots rediscovered ~20 times a day each.**

**And the registered entry sits at a THIRD spot** (bbox x 1278, y 7.2): the registry
holds the only car it managed to capture, and **neither of the two heaviest
rebirth points**. The two cars the operator sees and the system does not are
**localised**, and they are exactly the two neighbourhoods above.

**102 `person`: 25 tracks in 25 distinct cells, no cell with ≥ 2.** The
signal is class-specific.

### 3.2 · The granularity: the cell is an INDEX, the identity is the IoU

Sensitivity to the cell size, measured twice — on 102 and on the whole
fleet (share of births that fall in a cell with ≥ 2):

| cell | 102 vehicles: top-5 | fleet `vehicle` | fleet `person` | contrast |
| --- | --- | --- | --- | --- |
| 16 px | 9,6,5,4,4 | 43.9 % | 5.5 % | 8.0× |
| **32 px** | **13,9,6,4,4** | **55.6 %** | **17.8 %** | **3.1×** |
| 64 px | 18,16,10,9,6 | 74.4 % | 42.1 % | 1.8× |
| 96 px | 22,16,12,11,10 | 83.9 % | 58.9 % | 1.4× |
| 128 px | 26,19,12,7,7 | 88.3 % | 70.7 % | 1.25× |

**The conflict:** at 32 px a parking spot **splits across 2-3 adjacent cells** — the
threshold undercounts by about **2×** relative to the physical spot. At 64-96 px the spots
merge into single cells of 16-22 births, but **the vehicle/person contrast
collapses from 3.1× to 1.4×**: a coarse grid would mark ordinary human traffic as
repetition.

**Resolution, and it removes the problem instead of choosing a compromise: the cell
is not the identity.** As in the parcel path already shipped, **the identity is the IoU
against the candidate's anchor box**; the 32 px cell remains only an **index**
so as not to scan all the candidates at every observation. Two adjacent cells whose
boxes agree are **the same candidate**. One gets the merge of the 64-96 px
without losing the separation of the 32 px, and no new constant is introduced.

### 3.3 · The conditions

An entry is born when **all** hold:

| # | condition | `vehicle` and similar | `person` | from which measurement |
| --- | --- | --- | --- | --- |
| 1 | distinct passes in the window | **≥ 3** | **≥ 5** | see below |
| 2 | span between first and last pass | **≥ 120,000 ms** | **≥ 600,000 ms** | see below |
| 3 | box agreement, IoU against the anchor | **≥ 0.3** | ≥ 0.3 | the 101 doormat re-detected at 4 minutes measures **IoU ≈ 0.98**; from there the parcel path chose 0.3 (`package-stillness-tracker.ts` (lines 80-87)). **The same number is reused** |
| 4 | on by default | yes | **no** (opt-in) | §6.3 |
| 5 | plausible box | `isPlausibleThumbnailBox` | same | gate already armed (`index.ts` (lines 9877)), 4 other users, survives anyway |

**Condition 1, `vehicle` ≥ 3.** The two real parking spots of 102 make **13, 9 and 6**
births in 24 h; the useful tail drops to 4 and 3. A threshold at 5 would lose the spots with
4 births — **fleet-wide only 3 `vehicle` cells reach ≥ 5**, against 14
that reach ≥ 3. And 3 is also the number that two independent mechanisms of this
repo have already chosen from data (`PHANTOM_SUSPECT_MIN_CLOSES`,
`PACKAGE_STILLNESS_MIN_HITS`).

**Condition 1, `person` ≥ 5, and it is a measurement, not a precaution.** Fleet-wide,
in 24 h, out of 963 `person` births in 868 cells: **the absolute maximum is 5**, and
**a single cell** reaches it. A threshold at 5 admits at most **one** person cell
a day on the whole fleet; a threshold at 3 would admit **14**,
as many as the vehicle ones. **Three does not separate the two classes; five does.**

**Condition 2, span ≥ 120,000 ms.** It is `DEFAULT_MAX_SESSION_HOLD_MS`
(`session-dispatch-controller.ts` (lines 77)): the maximum duration that ONE session can
have. Chosen like this because **a single session must not be able to promote on its own**,
however long — it is today's error in a new form. Also supported by the
distribution: the measured session p99 is **98,084 ms**, below the 120,000.
For `person`, 600,000 ms: ten minutes of immobility is the proof that a
blinding decision deserves.

### 3.4 · The evidence window: **6 h**

`EVIDENCE_WINDOW_MS = 21 600 000`. Derivation from the **worst** case, that is a
camera where the burst does not arrive (sleeping battery, dial timing out) and the only
evidence is the sessions: the hottest cell of 102 produces **13 births in 24 h =
0.54/h**, so **3 passes require ~5.5 h**. Six hours cover that case with a
minimal margin, and with the burst at 1,800 s they contain **12**, four times the
need.

Deliberately **much** shorter than the 24 h of the phantom cells: that
window describes a property of the **scene**, this one describes an object that
**can leave**.

### 3.5 · The latency this criterion introduces, in plain terms

Car parking on 102, with the proposed values:

| pass | when | why |
| --- | --- | --- |
| 1 | t + ~5 s | the session opened by the parking itself (median warm-up 5.3 s) |
| 2 | t + ~3 min | the first subsequent movement in the scene (102 makes 504 sessions/24 h ≈ one every 171 s) **or** the first burst |
| 3 | ≥ t + 120 s for condition 2, in practice t + ~6 min | same |

**Birth ≈ t + 6…60 minutes**, against the ~36 s of today. The high end is the case
in which the only evidence is the bursts — two cadences of 1,800 s after the first pass —
that is, the night, when sessions are worth 8 % of the day. It is a
**deliberate** worsening: half an hour of immobility is much stronger evidence
than thirty seconds.

**And it costs no uptime**, thanks to §1.4: the session closes anyway at ~42 s.

### 3.6 · What it does NOT solve

It does not solve the camera that the detector **never sees**. On 102 the hypothesis holds —
66 `vehicle` events on 27 distinct tracks in the 8 night hours are more than
enough for 3 passes — but on another camera it might not hold, and **P0 verifies it
per camera** before a line is written.

---

## Part 4 — «They match»: type + box, and the expiry of an entry

### 4.1 · The matching rule already exists, is measured, and must not be reinvented

Point 4 of the brief — «the pipeline ignores the frames that match type and box
of the current stationary ones» — **is already implemented**, in
`stationary-match.ts` (lines 151-218), and is the fix of 102's parking-lot flood.
For each entry, on the detection **of the same class** with the best overlap:

| condition | verdict |
| --- | --- |
| IoU ≥ `suppressIou` (0.6) | **suppressed**, entry confirmed, **and the box is re-anchored** (D174) |
| `wakeAssocIou` (0.1) ≤ IoU < 0.6 **and centroid INSIDE the box** | **suppressed** — detector jitter |
| `wakeAssocIou` ≤ IoU < 0.6 **and centroid OUTSIDE** | **departing** — arms; a second agreeing reading is needed (D49) |
| IoU < `wakeAssocIou` | miss — the TTL decides |

The gate is **class-first** (`stationary-match.ts` (lines 171):
`if (det.className !== entry.className) continue`): a parked car cannot
absorb a person walking in front of it. It is the most important protection of
§6.3 and already holds today.

Suppression happens **before the tracker** (`frame-processor.ts` (lines 638-641), before
`tracker.update` at `:645`), so a suppressed detection never appears in
`result.tracked` — it is the mechanism on which the whole of §1 rests.

**And it works, measured:** on 102 the suppression absorbed **40,750 detections
in 24 h** (280,058 in 7 days) with **a single active entry**. This is the work
that the two missing cars are **not** letting us save.

### 4.2 · The car that moves forward half a metre: same or new?

The code's answer, and it is the right one:

- **The criterion is the CENTROID against the entry's box, not a distance.**
  As long as the observed centre stays inside the box, it is the same thing. The point of
  no return is **~half of the box's minor dimension**: 102's entry measures
  1,286 × 904 px on a 3840 × 2160 frame, so the centroid must move by
  **more than ~450 px** to leave it. Half a metre, in that scene, is worth a few
  tens → **same**.
- **And the box follows it.** An unambiguous reading (IoU ≥ 0.6) **re-anchors** `bbox`
  (`stationary-registry.ts` (lines 307-312)); without it, the object's slow drift takes it
  out of a frozen box and it is read as a departure — the defect D174
  fixed.
- **A car that moves forward a full length** takes the centroid outside: first
  reading arms, second confirms, the entry retires, the detection is released
  and a normal track is born. **New.**

That the departure path works and is frequent is told by the measurement: **out of 201
retirements in 24 h, 180 are `departed` (at two readings) and 21 `ttl`** — 89.6 % goes
through the fast door, not through expiry.

### 4.3 · The expiry — and here the plan changes a default

Two paths, both remain:

1. **Observed departure**, two agreeing readings (D49) — 89.6 % of retirements.
2. **TTL on OBSERVED time** (`entryTtlMs`, 300,000 ms,
   `stationary-registry.ts` (lines 382-395)): not wall-clock, so the minutes of silence of
   a session-based camera age nothing. Locked by
   `stationary-registry.spec.ts` (lines 147), which with this plan counts **more**.

**The defect the plan would introduce by leaving the TTL at 300 s.** With the evidence
arriving in groups (a session, a burst), if the object is not detected
for two consecutive passes `observedAt − lastConfirmedAt` exceeds 300 s and **the
entry is retired**. We would have moved the defect, not solved it.

**New default: `entryTtlMs = 1 800 000` (30 min).** And it is **already the maximum
allowed by the schema** (`stationary-settings.ts` (lines 36)): no bound to
widen, no train constraint.

**The derivation is in observed time, not wall-clock**, and it is this: the measured
detection uptime is **7.45 % on 102** and **12.93 % on the fleet**, so 30
minutes of *observed* time are worth **4–7 hours of clock**. An entry survives a
whole night of intermittence — at a cadence of 1,800 s, **on the order of eight
consecutive missed passes** before the TTL touches it.

⚠ **The cost, and it must be faced because it is already visible today.** §0.7.3: two
entries in production have not been confirmed for **5.1 hours and 9.3 days**. The TTL on
observed time does not touch them because those cameras produce no frames. Raising it to
30 minutes **worsens that tail**. It is acceptable only because path 1 covers the real
case — a car leaving **is** movement, opens a session, and is seen
leaving in two frames — but **an entry not confirmed for days must be flagged**: one
line per sweep when `observedAt − lastConfirmedAt` exceeds the TTL *in clock time*
while the observed time has not advanced. Today that case is mute.

---

## Part 5 — What falls with the promotion (and what must NOT fall)

### 5.1 · `closedReason: 'stationary-promotion'` — it has TWO producers, not one

It must be said first because it refutes the natural assumption.

| producer | file:line | condition |
| --- | --- | --- |
| P1 — the promotion | `index.ts` (lines 9905-9919) (`enqueueLiveGroup`) + `:9935` (`closeActive`) | **dies with this plan** |
| P2 — the closing of a short scenery track | `store/track-store.ts` (lines 925), in `expireStale`, gated at `:917-923` by `isShortMotionlessTrack` (life ≤ 25 s, net ≤ 40 px person / 8 px vehicle) | **survives intact** |

So **no consumer is left orphaned**: `TRACK_CLOSE_REASONS`
(`track-store.ts` (lines 64)), the `whereNot` filters (`:1774`, `:1989`),
`group-clusterer.ts` (lines 50), the `stationary: true` flags (`index.ts` (lines 3775,3815)) and
`summary-selection.ts` (lines 170) remain fed.

**What changes is WHICH rows carry it**: only scenery ≤ 25 s, never a parked
car again. A consequence to fix in the same commit:

> Without P1, the parked car's track is queued normally at
> `index.ts` (lines 5678) at every frame and **becomes groupable**, and appears in the
> Events gallery.

**Fix:** the track that §1.4 declares still must be closed with the same
marker. No new reason is needed — `stationary-promotion` is already in the list and
already filtered wherever needed — and the condition is the same as §1.4.

### 5.2 · What falls

| what | file:line | verified |
| --- | --- | --- |
| the «Promotion decision» section | `stationary-match.ts` (lines 222-275) | **a single production caller** (`index.ts` (lines 6046)). **NOT deleted: renamed** to `trackIsStill` and rewired onto §1.4 |
| `DEFAULT_PROMOTION_CONFIG` | `stationary-match.ts` (lines 31-36) | follows the rename |
| `PROMOTION_MIN_POINTS` | `stationary-types.ts` (lines 129) | also read by `package-stillness-tracker.spec.ts` (lines 12,73), which uses it to **prove** that the generic criterion is unsatisfiable. Follows the rename |
| the promotion loop | `index.ts` (lines 6018-6066) | replaced by the evidence producer |
| `promoteToStationary` | `index.ts` (lines 9849-9980) | the body **splits in two**: «close and mark the track» → §5.1; «create the entry» → the evidence path |
| `processor.dropTrack` / `SortTracker.dropTrack` | `frame-processor.ts` (lines 420-422), `sort-tracker.ts` (lines 1059) | `index.ts` (lines 9904) is **the only production caller**; with §1.4 it is not needed → **dead code** |
| the occupancy timer in the runner | `runner.ts` (lines 508-524,745-757,923) | never executed (§0.2); re-located in §2.2, **not placed alongside** |

### 5.3 · What does NOT fall

| what | file:line | why it stays |
| --- | --- | --- |
| `computeStaticTrackMetrics` | `static-track-gate.ts` (lines 49-72) | **three callers**: the promotion (which is renamed), `track-close.ts` (lines 705) and `key-event-query.ts` (lines 50) — these two are the static gate of the key events |
| `averageBboxDiagonal` | `static-track-gate.ts` (lines 76-81) | used only by `key-event-query.ts` |
| `STATIC_DISPLACEMENT_FRAC` / `STATIC_SPAN_FRAC` | `key-event-scoring.ts` (lines 38,41) | their home is `key-event-scoring.ts` (lines 198-208) |
| `residents.keyFrameKey` | `track-resident-state.ts` (lines 318) | 7 other callers |
| `isPlausibleThumbnailBox` | `best-thumbnail-guard.ts` (lines 55) | 4 other users, including the purge of `stationary-registry.ts` (lines 196) |
| `stationaryRegistry.promote()` | `stationary-registry.ts` (lines 360-367) | **it is the birth API** that the replacement calls |
| the registry + `partitionDetectionsAgainstRegistry` | — | it is point 4 of the brief, already done and **measured**: 40,750 absorbed/day on 102 |
| `enabled`, `suppressIou`, `wakeAssocIou`, `entryTtlMs` | `stationary-settings.ts` | 4 out of 5 remain; the fifth is **renamed** |
| `occupancyRecheck*` | `pipeline-runner.cap.ts` (lines 247-248) | the knobs remain, the owner changes (§2.2) |

⚠ The docstring of `enabled` (`stationary-settings.ts` (lines 21-23)) says «no
promotion **and** no suppression»: after the plan it has a single reader
(`index.ts` (lines 10088)) and the first half is false. It must be rewritten.

### 5.4 · The tests — which fall, which do not (verified by running them)

`npx vitest run --root packages/addon-post-analysis src/pipeline-analytics/pipeline/stationary`
→ **64 tests, 4 files, green**.

| file | tests | what happens |
| --- | --- | --- |
| `stationary-match.spec.ts` | 24 | **19 intact** (geometry, partition, the five D49 cases, the class gate). The **5** of `describe('evaluateStationaryPromotion')` (`:307-380`) **follow the rename** |
| `stationary-registry.spec.ts` | 19 | intact. `:147` («sweep never expires entries while NO frames flow») is **load-bearing** for §4.3 |
| `phantom-cells.spec.ts` | 16 | intact — but §0.7.1: the suite **does not cross** the write/read boundary, and that is why the defect is alive |
| `stationary-zones.spec.ts` | 5 | intact |
| `stationary-settings.spec.ts` | — | **3 red assertions** (`:20,34,41,50,55`); follow the rename |
| `session-holds-until-stationary-promotion.spec.ts` | 20 | **18 intact.** `(1)` (`:339`) survives but the NAME becomes false. **`(2)` (`:357-374`) must be DELETED, not left green**: it fakes the promotion simply by not calling `noteSubjectPresent`, so it **keeps passing while the invariant it names becomes false in production**. `(3)` (`:376`) becomes **the only thing between the fleet and a permanent session** |
| `frame-tracked-presence.spec.ts` | 7 | `:246` («a suppressed detection never reaches the tracked set») **counts more than before**. `:225` («dropTrack … empties the tracked set») passes but the premise is dead → **rewrite on §1.4** |
| `package-stillness-tracker.spec.ts` (lines 12,73) | — | imports the two constants → **compile error** if they are deleted instead of renamed |
| `runner-occupancy-arm.spec.ts` | — | ⚠ **green on a mechanism that never started in production** (§0.2). It is the case study: the test verifies arm/disarm in isolation and could not see that the registration lasts 42 s against a 300 s interval |
| `static-track-gate.spec.ts`, `key-event-scoring.spec.ts` (lines 294-316) | — | **intact** |
| `group-clusterer.spec.ts` (lines 91-350), `group-live-assigner.spec.ts` (lines 192) | — | pass, but the live path they mirror changes → §5.1 |

### 5.5 · The guards — rewrite, do not delete

`scripts/check-stationary-promotion-reachable.ts`, in CI at
`.github/workflows/ci.yml:221`, documented in `docs/reference/guards.md` (lines 75).

| # | line | after |
| --- | --- | --- |
| 1 | `:143-149` | **stays, on the new name**: the immobility window that closes the session must be below the ceiling |
| 1b | `:151-156` | **identical** |
| 1c | `:158-163` | **identical**, on the new name |
| 2 | `:166-186` | **identical** — it is the half that has real value |
| 3 | `:189-203` | **identical** |
| 4a | `:206-211` | **to be re-pointed** at the new form of §1.4 — it is the only weapon that protects the 70 % |
| 4b | `:212-217` | **fails hard** (`promoteToStationary … processor.dropTrack`). Replaced by: *«the presence signal excludes a track that the immobility test declares still»* |

New assertions — the arithmetic between packages that do not name each other, **and this
time three occurrences are known, not two**:

- **`EVIDENCE_WINDOW_MS ≥ MIN_PASSES × burstCadenceMax`** — or the window is
  narrower than the time needed to collect the evidence, with **every constant
  correct**.
- **`entryTtlMs.default ≥ 3 × burstCadenceMax`** (§4.3).
- **`EVIDENCE_SPAN_MIN_MS ≥ DEFAULT_MAX_SESSION_HOLD_MS`** (§3.3, condition 2).
- **The new one, and the most important: the burst cadence must be REACHABLE
  within the life of its container.** The defect of §0.2 is exactly this, and
  no guard covered it: a 300 s interval on an object that lives 42 s. The
  form of the assertion is *«the burst period is shorter than the life of the
  object that hosts it»*, and after §2.2 the host is the orchestrator, which lives
  as long as the process.

`scripts/check-package-promotion-satisfiable.ts` (CI at `:220`) **breaks
mechanically in three places**: `:157-158` read the two constants with a helper
that does `process.exit(1)` if the declaration disappears (`:110-114`); `:206-215`
denylists three symbols that change name; `:220-225` demands the literal string
`if (packageClasses.has(t.className)) continue`, which dies with the loop.
D144's premise remains true; its **rationale** must be rewritten now that the
generic criterion also becomes repetition-based.

### 5.6 · Verification, not presumption

No entry is removed because it «seems unreachable» — **and §0.2 is the reason
this line is not a formality**: a mechanism switched on on 29 cameras
did not execute a single line in seven days, and nothing said so. Every removal requires
the grep that proves it, **including the viewer repo** (`camstack/`), and everything
that stays alive requires **a log line that proves it**.

Documents to update: the record docs/decisions/adr-0261 (accepted **yesterday**, and its
`applies-to:` arms staleness on four files),
`docs/architecture/post-analysis.md` (lines 192,238),
`docs/architecture/object-detection.md` (the table of the two producers **and** the
section on `occupancyRecheckSec`, which describes a mechanism never executed),
`docs/reference/guards.md` (lines 75), `docs/design/track-persistence-gates.md` (lines 24,223),
`docs/design/2026-08-21-group-entity-and-group-media.md` (lines 273-291) (already false today),
`docs/design/2026-08-24-live-group-tracking.md` (lines 88),
`docs/decisions/adr-0144.md` (lines 28-29), the record docs/decisions/adr-0136, `docs/roadmap.md` (lines 104,723). <!-- drift-ok: moved to the private planning repo -->

---

## Part 6 — The risks, quantified

### 6.1 · A load proportional to the cameras

**The invariant calls it a defect**: *«`pipeline-analytics` must grow with the USEFUL
detections; it is a defect if it grows with the frames»*
(`docs/architecture/load-ledger.md`).

**And this time the load is REAL, not inherited.** §0.2: the burst does not run, so
making it run is new work, proportional to the **cameras** and not to the sessions. The
count, with 29 `on-motion` cameras (measured: 29 `on-motion`, 0 `always-on`, 1
`disabled`; 25 actually attached in 24 h) and ~5.4 s per burst (§0.3):

| cadence | one burst every | average occupancy of ONE slot (out of 3) | inference frames/s |
| --- | --- | --- | --- |
| 300 s (today's default) | 10.3 s | **52 %** | 0.387 |
| **1,800 s (proposed)** | 62 s | **8.7 %** (≈ 2.9 % of the pool) | **0.064** |
| 30 s (2026-08-13) | 1.03 s | **> 500 %** | 3.87 |

Measured points of comparison:

- a **single** camera in session runs at `detectionFps` = 10; the whole fleet
  burst at 1,800 s is worth **0.64 %** of one active camera;
- the fleet processes **2,042,233 frames in 24 h** = 23.6 frames/s. The burst
  adds **0.064 frames/s = +0.27 %**;
- **the margin is there, measured**: `queueDepth` is **0 on all three nodes**, the
  drop rate is **0.191 %** (3,901 out of 2,042,233) and the queue wait is 5–6 ms
  against 26–94 ms of inference. The pool is **not queue-bound**.

**The dominant cost is not the inference, it is the DIAL** — 5.0 s of a decoder slot
against 0.2–0.4 s of inference — and it is what blew up on 2026-08-13. And
**the cheap path is not available**: 28 cameras out of 30 have
`motionSources: ["onboard"]`, so no tap.

Two residuals to instrument (**P6**):

- The burst **competes** with the live detection: same
  `maxConcurrentInferences` semaphore, and *«a pool is shared by every camera of the node»*
  (`docs/architecture/detection-execution.md`). To be measured: the `dropped` field
  of the `pipeline stats` line during a burst window, against the 0.191 %
  baseline.
- **102 is the most expensive camera of the fleet** (104.4 ms per inference, 4K, against
  43.5 ms on average) and is also the one that most needs the burst.

### 6.2 · Suppressing by type+box can hide a NEW object in the same spot

The protections exist and the measurement says they work: **180 retirements out of 201 in
24 h go through the two-reading wake**, not through the TTL.

The real residual: **a different car that parks in the same spot after the
first one left unobserved.** Same class, high IoU against the old entry
→ silently suppressed, and **it inherits `label`** — which on a parking lot is a
**licence plate**. 102's entry carries `label: "Car"` today, but the field is designed for
an identity. A wrong identity is worse than no identity.

**Mitigation (P5):** the `label` and `keyFrameMediaKey` of an entry are **cleared**
at the first arm→re-anchor cycle — the exact signature of «something changed here».
An entry without a label keeps suppressing; one with the wrong label lies.

**And they must be reproduced.** Today they have **a single producer** (`index.ts` (lines 9899-9900)) and
are never refreshed (`stationary-registry.ts` (lines 307-312) stages only
`lastConfirmedAt` and `bbox`). Born from evidence they would be `undefined` forever, and the
consumers are real:

| consumer | file:line | degradation |
| --- | --- | --- |
| **admin-ui `StationarySection`** | `:60` (`row.label ?? row.className`), `:41-44` (parses `track:<id>:keyFrame:<ts>` → `useAuthedImage`) | **every card becomes a grey icon with no image**, caption from licence plate to `"vehicle"` |
| Viewer `StationaryBoxesOverlay` | `camstack/src/components/camera/StationaryBoxesOverlay.tsx` (lines 85) | caption on the class taxonomy |
| cap schema | `zone-analytics.cap.ts` (lines 63,65) | optional, the wire holds |

**So the evidence registry keeps the `trackId` and `keyFrameMediaKey` of the
pass with the best box**, and that is what the entry inherits at birth.

### 6.3 · A false stationary is BLIND — the most serious risk

**The data that decides, and now it is a fresh measurement, not a quotation: of the 208
promotions of the last 24 h, 176 are `person` (84.6 %), 30 `vehicle`, 2
`animal`.** In 7 days: 1,381 promotions, dominated by the same indoor cameras
(1443: 346, 104: 335, 587: 159). The current mechanism, which nobody considered
risky, spends **five sixths** of its time declaring **people** to be scenery.

The asymmetry the plan protects, and the principle it descends from — **D49
applied in the right direction**:

> D49 says that the reading that **DESTROYS work** needs two agreeing
> readings. For a car, what destroys is the **retirement** of the entry (the
> flood returns). For a person, what destroys is the **birth** of the entry
> (we stop seeing them). **The protected direction differs by class**, and it is not
> an exception to D49: it is D49 read correctly.

| | `vehicle` and similar | `person` |
| --- | --- | --- |
| passes to be born | 3 | **5** — *fleet-wide the measured maximum is exactly 5, in a single cell out of 868* |
| minimum span | 120 s | **600 s** |
| departure | 2 readings (D49) | **1 reading**, no arming |
| TTL | 1,800,000 ms | **300,000 ms** |
| by default | on | **off**, opt-in per camera |

A precedent in favour of the asymmetry instead of the flat ban: the phantom cells
include `person` **by the operator's decision of 2026-08-20**, and it is safe
because **a moving subject revokes the cell instantly**
(`phantom-cells.ts` (lines 40-49)). Here the revocation is the departure at a single reading.

Protections already valid: the gate is **class-first** (§4.1), so a person
cannot be absorbed by a `vehicle` entry, and a person **inside** a parked car
is a `person` detection.

**And thanks to §1.4 this asymmetry is NOT paid for in uptime.** In the naive design,
excluding `person` meant that every session with a still person ran
to the ceiling — on 104 (54.6 % uptime, 335 `person` promotions in 7 days)
it would have been disastrous. With immobility rewired onto the presence signal, a
still person stops keeping the session open **without anyone declaring them
scenery**.

### 6.4 · The risk that the burst switches itself off — eliminated, not mitigated

In the first draft this was the most insidious risk: `reportOccupancyBurstOutcome`
disarms after 2 empty bursts (`runner.ts` (lines 745-757)) and rearms only at the closing of a
session (`:923`), so on a night parking lot without movement the burst
would have been dead until morning.

**§2.2 takes it out of the way: the arm/disarm machine is not re-located.** It is
literally what made the mechanism unreachable, and at the 1,800 s cadence the cost of a burst on an empty camera (5.4 s of a slot every half hour)
does not justify a state machine that can switch itself off and not say so.

**This is the only part of the plan that simplifies instead of adding**, and it must be
noted: the solution to «the mechanism switched itself off» was not a re-arm probe
with an invented factor, but **removing the thing that switched it off**.

### 6.5 · The risks that remain open, named

- **The burst is new load proportional to the cameras** (§6.1). Quantified at
  +0.27 % of frames and 8.9 % of occupancy of the three slots, with the measured pool not
  queue-bound. **But nobody has ever seen this mechanism run**, so
  the number is a prediction until P6.
- **The dial timing out** (§0.3): at the current timeout 1 burst in 20 collects zero.
  §2.4 raises it to 12,000 ms; if after P6 the tail remains, the next lever is
  `motionSources: ['analyzer']` on the cameras that matter, which enables the tap.
- **The inconsistency of 296 against 126 tracks** on 102 (`getObjectEvents` against
  `listTracks` on the same window, with 264 events without `bbox` even at
  `projection:'full'`): not explained. The thresholds of §3 are derived from
  `listTracks`, and **126 must be read as a lower bound**. It must be clarified before
  anyone re-derives a threshold from the other source.
- **D261's projection has never been verified** (§1): the commit is not in
  production, so 14–18 % is a calculation. Three cameras are already above 50 %.

---

## The steps

Ordered so that **every step leaves the system shippable**, and so that the
structural risk of §1.3 is closed **before** anything is removed.

> **Starting baseline, verified on a clean `main` on 2026-08-28.**
> `npx vitest run --root packages/addon-post-analysis` → **7 red out of 5,020**, in
> 3 files, **all pre-existing and none related to the stationary ones**:
> `group/__tests__/group-sealer-boot.spec.ts` (4, textual assertions on the
> source) and `__tests__/frame-processor.spec.ts > appearance events` (2) — and the
> latter is **precisely the file that P2/P5 touch**: they must not be mistaken for
> our own damage nor declared fixed. `npx vitest run --root packages/addon-pipeline`
> → **1 red out of 3,974**, also pre-existing. The `stationary/` suite (64 tests)
> is green and `tsc --noEmit` is clean on both packages. Both guards
> pass today.

### P0 · Measure — and redo it AFTER the deploy of

- [ ] **Test:** none. The product is an update to
      `docs/architecture/load-ledger.md` with the starting numbers. Those of
      this document are the **before**; we also need the **after** of D261.
- [ ] Redistribution of `openForMs` by closing reason **after** the deploy, and
      how many times the ceiling closes over a subject that is still present (the warn at
      `session-dispatch-controller.ts` (lines 1047-1050), today **non-existent in
      production**). Uptime per camera: today fleet 12.93 %, 102 7.45 %, but **104
      54.6 % / 103 52.6 % / 1443 51.9 %**.
- [ ] Repeat the cell histogram **for every camera with ≥ 1 stationary entry**,
      not just 102, and for `person` as well as `vehicle`. The thresholds of §3.3 are
      derived from 102 + fleet; a camera with a different geometry may want
      a different threshold, and this must be discovered now.
- [ ] Clarify the 296 / 126 inconsistency (§6.5) before anyone re-derives a
      threshold from the wrong source.

**Does not solve:** nothing. It makes the thresholds re-derivable.

### P1 · The second valve — immobility stops creating entries and starts closing sessions

**Ship it alone, and before everything else.** Alone it changes nothing
visible; it is what makes every subsequent step reversible.

- [ ] **Test first:** (a) a track still for `sessionStillnessWindowMs` does **not**
      count as presence, and the session closes without any entry existing;
      (b) the same track that moves again counts again **within one
      frame**; (c) a suppressed track continues not to count
      (`frame-tracked-presence.spec.ts` (lines 246), unchanged); (d) with the registry **off**
      (`enabled: false`) the valve works all the same.
- [ ] Widen **first** `tracking-settings-form-coverage.spec.ts` (lines 33) to
      `StationarySettingsSchema` (§0.1). It is one line, and it is the only thing that will prevent
      a schema field and its form entry from diverging.
- [ ] Rename `evaluateStationaryPromotion` → `trackIsStill`,
      `PROMOTION_WINDOW_MS` → `SESSION_STILLNESS_WINDOW_MS`, `promotionWindowMs` →
      `sessionStillnessWindowMs` (schema + form + docstring, same bounds), and
      move the consumption from `index.ts` (lines 6046) to `index.ts` (lines 6719).
- [ ] Mark the closing of a track declared still with
      `closedReason: 'stationary-promotion'` (§5.1), or it stays in the gallery.
- [ ] Re-point the guard `:206-217` at the new form, **and verify it by
      disarming it**.

**Does not solve:** it does not make any entry be born and does not recover the two cars. It closes the
structural hole of §1.3.

### P2 · The evidence registry — structure and pure decision, without producers

- [ ] **Test first:** `stationary-evidence.spec.ts`. Three passes with IoU 0.9 between
      them and span 200 s → **promotes**; the same with span 60 s → **no** (cond. 2);
      three with IoU 0.15 → **no** (cond. 3); **300 observations within a single
      pass → no** (§2.6); two **adjacent** 32 px cells whose boxes agree →
      **a single candidate** (§3.2); `person` with 3 passes → **no**, with 5 and span
      600 s → **yes**. And a test that **crosses the write↔read boundary with
      different coordinates**, which is what the phantom cells lack (§0.7.1).
- [ ] `pipeline/stationary/stationary-evidence.ts`: **pure** decision, injected clock,
      modelled on `package-stillness-tracker.ts`. **The cell is an
      index, the IoU is the identity** (§3.2).
- [ ] `StationaryEvidenceLedger` on `DurableLedger`, copying from
      `phantom-cells.ts` (lines 211-269,317-328,345-356) what §0.4 lists. **Not**
      fire-and-forget: here a lost write shifts a birth. `@durable` block
      with the retention classification — `never-orphaned` is **not
      a given**: a piece of evidence describes an **object**, not the scene.
- [ ] Every observation carries `source`, `bbox`, and the `trackId` /
      `keyFrameMediaKey` of the best pass (§6.2).

**Does not solve:** nothing is wired up. The system behaves as after P1.

### P3 · Re-locate the burst into the orchestrator, and make it RUN

- [ ] **Test first:** (a) the cadence fires on a camera without an open session;
      (b) it does **not** fire on a camera with an open session; (c) it does not fire on a
      sleeping battery camera (D173); (d) the new guard of §5.5 —
      *«the burst period is shorter than the life of its host»* — **fails**
      on today's code (`runner.ts` (lines 508-524)), which is the proof it would have been needed.
- [ ] Move the dispatch into `SessionDispatchController` (§2.2), **removing** the
      runner's timer. Do not place it alongside.
- [ ] `OCCUPANCY_BURST_SAFETY_TIMEOUT_MS` 8,000 → **12,000** (§2.4).
- [ ] Cadence at **1,800 s**; ⚠ widening `occupancyRecheckSec.max` from 300 to 3,600
      is **tied to the train** (the host validates `attachCamera` against its own copy
      of the schema).
- [ ] **A log line on EVERY burst**, with `tags: { deviceId }`, `collected` and
      `found`. The defect of §0.2 lasted weeks because there was nothing to
      count — and the only lines that would have existed were at `debug` on a branch
      that was never reached.
- [ ] **Exit gate:** after 24 h, `sum by (dev) (count_over_time(...))` on the
      new line must give **≈ 48 bursts per camera**. If it gives zero, §0.2 has repeated
      itself and we do not proceed.

**Does not solve:** the burst produces frames but still no evidence. **But it repairs D136
on its own**: the occupancy re-check never worked, and a camera with a
parked car was invisible to every occupancy rule between one movement and the
next.

### P4 · Wire up the two producers — in shadow, with the promotion STILL ALIVE

- [ ] **Test first:** the ledger receives a piece of evidence from a session frame and one from
      a burst frame; both end up in the **same** candidate (§2.5).
- [ ] Feed the ledger from the current call site (`index.ts` (lines 6018)),
      **without removing** the promotion loop. Pass identity: **path B**
      (§2.6), `PASS_GAP_MS = 15_000`.
- [ ] Per-sweep diagnostics: how many entries the new criterion **would have** produced
      against how many the old one produces, **broken down by source**, per device.
- [ ] **Exit gate:** on 102, in 24 h, the new criterion must produce
      **≥ 3** candidates (the old one produces 1) and **at least one must fall in
      each of the two neighbourhoods of §3.1** — `{101-102,16-17}` and `{112-114,30-32}`.
      If the candidates are not there, we have not found the operator's cars:
      back to P0. **The threshold is not tuned until the number comes back.**

**Does not solve:** it does not yet change any behaviour. It is the before/after that
`load-ledger.md` demands, obtained **without risk**.

### P5 · The swap — birth passes to the evidence

- [ ] **Test first:** (a) the birth from evidence closes the source track
      persisting it with `closeActive` (D161 — a failed persist orphans media,
      events and CLIP vector: 18.9 GB of the hub are this defect); (b) `label` and
      `keyFrameMediaKey` come from the best pass and are **cleared** on the
      arm→re-anchor cycle (§6.2); (c) the rewritten guards **fail** when
      disarmed by hand.
- [ ] Split `promoteToStationary` (`index.ts` (lines 9849-9980)) according to §5.2; remove
      the loop `:6018-6066`; remove `dropTrack` from the two definition points
      after the grep that proves no caller remains.
- [ ] `entryTtlMs` default → 1,800,000 (§4.3), **with** the line that flags an entry
      not confirmed for days in clock time (§0.7.3: today there are two, one of 9.3
      days, and nobody says so).
- [ ] Rewrite `check-stationary-promotion-reachable.ts` (§5.5) and repair
      `check-package-promotion-satisfiable.ts` in the three places that break.
- [ ] **Delete** guarantee (2) of
      `session-holds-until-stationary-promotion.spec.ts` (lines 357-374) instead of leaving it
      green, and rename the file. Rewrite `frame-tracked-presence.spec.ts` (lines 225).
- [ ] Update the documents of §5.6; fix §0.7.4 while there.
- [ ] A new record (**D262**) that **partly supersedes D261**: the session fix
      stays, the justification changes, and what ends the wait is no longer
      the promotion but the **rewired immobility test**. D261 is from yesterday and its
      `applies-to:` arms staleness on four files.
- [ ] A separate record for §0.2 — **a periodic mechanism must be shorter
      than the life of its container** — because it is the third occurrence of the
      same class of defect and deserves a rule, not a note.

**Does not solve:** the birth latency goes from ~36 s to 6–60 min (§3.5). It is a
choice, and it costs no uptime thanks to P1.

### P6 · Instrument, and close the before/after

- [ ] The `dropped` field of `pipeline stats` correlated with the burst windows
      (§6.1), against the measured baseline of **0.191 %**.
- [ ] Before and after on `docs/architecture/load-ledger.md`: uptime per camera
      (baseline: fleet 12.93 %, 102 7.45 %), tracks born per day on 102 (baseline: 126
      `vehicle`), detections absorbed (baseline: 40,750/24 h), entries in the registry (baseline:
      6 on the fleet, 1 on 102), and **the breakdown of evidence by source** —
      the number that will say whether the burst is needed.
- [ ] **The question that closes the plan:** on 102 does the registry hold 3 entries in the two
      neighbourhoods of §3.1, or does it still hold just one?

### P7 · The authoritative pass field

- [ ] `pass: { kind, id }` on `PipelineInferenceResultPayload`
      (`packages/types/src/interfaces/event-bus.ts` (lines 337)). It travels with the
      bound widening of P3: **both are already tied to the train**.
- [ ] Path B (P4) becomes the fallback; **A and B log the disagreement**.

### P8 · The live defects found along the way

- [ ] §0.7.1 — the centroid/origin agreement of the phantom cells, **with the test that
      crosses the boundary**. It goes **before P0**, or the threshold «3» is reconfirmed on
      a dirty distribution.
- [ ] §0.7.2 — a birth suppressed by the confirmation gate stays in `result.tracked`
      and pins the session to the ceiling.
- [ ] §0.7.3 — an entry not confirmed for days does not say so.
- [ ] §0.7.5 — `enabled` claimed twice in the same key space.

---

## The open questions for the operator

1. **The burst has never started** (§0.2), so it is not free: re-locating it
   into the orchestrator is real work, and at 1,800 s it costs **+0.27 % of frames** and
   **8.9 % of occupancy** of the three decoder slots. The pool has margin (queue 0,
   drop 0.191 %). Do we proceed?
2. **The 30 s criterion demoted instead of removed** (§1.4): immobility
   stops **creating entries** (destructive decision → repetition) but continues to
   **close sessions** (reversible decision). It is the main deviation from the
   brief, and it is what makes the rest safe — without it, 102 goes to **70 %** of
   uptime and 104 and 103, already above 50 %, do worse.
3. **`person`** (§6.3): included but **off by default**, 5 passes instead of 3 —
   a **measured** number, not a prudential one: the maximum `person` repetition on the
   fleet in 24 h is exactly 5, in one cell out of 868. The alternative is the flat
   ban.
4. **The birth latency of 6–60 minutes** (§3.5): the high end is the night,
   when sessions are worth 8 % of the day. Reducing it means raising the burst
   cadence, which is the thing that starved the decode path on 2026-08-13.
5. **`maxSessionHoldMs` is NOT lowered** (§1.5): the measured p99 of `openForMs` is
   **98,084 ms** against a ceiling of 120,000, that is 1.22×. Lowering it would cut real
   subjects for a gain that §1.4 makes marginal. Do you confirm?
