---
id: D547
title: A parked object is an ENTITY — undecided frames are neutral, its tracks are not kept, and the recheck is armed where the sessions are
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence-ledger.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-track-disposal.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/short-motionless.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit.ts
  - packages/addon-pipeline-orchestrator/src/occupancy-recheck-controller.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
---

## Context

The operator reported dozens of "stationary events" a day from device 102
("Camera parking") and named the three stillness changes of 2026-09-19
as suspects. Read from the stored tracks and events, none of them was:

- D539 is inert on 102 (`stillnessSpeedFracPerSec = 0`, never calibrated);
  D543 is inert (`stationarySpeedPx = 2`). Both verified on the live hub.
- The step is **2026-09-15 at 11:00**: visible `idle` tracks went from 4–9 a
  day to 102 (then 36, 24, 31, 58). At 10:59 the census had been emptied by
  TTL retirements (`sessions.md`, same day, D501). At 21:23 (f44befc8d) and
  with D508 the next morning, agreement on a session frame started to require
  the tracker's `idle` verdict. Both are right; together they meant the census
  could not be rebuilt in reasonable time, and nothing else looks at a still
  scene.
- Every parked object was re-tracked on every motion session: 27 tracks in a
  day for the operator's own car (DNRG309), each ~35 s (the 30 s cooldown plus
  4 s of coasting), each reaching `idle` and persisting ~3.3 MB of media. The
  silver estate at the right edge produced 12 tracks until its entry was born
  at 17:30 and none after — census is silence; the data proves it.
- The evidence ledger needed **11.3 h, 1215/2631 agreements, ratio 0.493** to
  promote that car. Of the 21 tracks bound to the candidate, 13 never had the
  chance to reach `idle` (the session closed before the 10 s dwell) and the
  eight that did spent their first 10–20 s `entered` or settling. Every one of
  those undecided observations counted in M. Box breathing is no longer the
  driver: 325 of 345 idle tracks since 09-15 never flipped back to `moving`.
- The occupancy recheck — the mechanism D508 designed to census a still
  object in two bursts 300 s apart — had **no producer**. Every registration
  the runner received in 48 h was `detectionMode=always-on` (5 611 attaches, 0
  `on-motion`); the runner creates its recheck interval only for `on-motion`
  registrations (`runner.ts:704`); `pipelineRunner.getLocalCameras` answered
  `[]` between sessions; every stationary entry born in 48 h, on three cameras,
  carried `burstAgreed=0`. `assignment.reasons.detection = "armed:on-motion"`
  is an orchestrator-local label for a session camera between sessions
  (`camera-status-service.ts:387`), not the registration the runner holds.
- A second population was hidden under "Mostra stazionari": 107 rows in 48 h
  stamped `closedReason: 'stationary-promotion'` by `expireStale`'s
  short-motionless rule, 92 of which never reached `idle`, p50 0.5 s, each
  keeping a 2.4 MB key frame. Long-standing (68–116 a day since at least 09-13).

Measured cost on 102: 3.29 MB per parked-car track × 58 on 09-19 (~191 MB) plus
3.23 MB × 91 fragments (~294 MB) — about 0.5 GB/day and 44 % of the camera's
tracks, against 7.7 GB of media the camera holds.

The operator's direction: "Onestamente non ho bisogno di tracce stazionarie
affatto … Le entità devono esistere, solo le tracce stazionarie persistite come
tracce non sono necessarie, abbiamo comunque l'occupancy salvata." [Honestly I do not need stationary tracks at all … The entities must exist, only the stationary tracks persisted as tracks are not needed, we have the saved occupancy anyway.] And on the
recheck: "L'orchestrator deve valere equalmente in pipeline indifferentemente
dal tipo. Deve esistere perché elimina problemi precedenti." [The orchestrator must apply equally in the pipeline regardless of the type. It must exist because it eliminates previous problems.]

Alternatives considered and rejected:

- *Raise `SHORT_TRACK_MAX_MS` to cover 36 s sessions.* A patch that tracks the
  cooldown; the tracks would still be minted and stored, only hidden.
- *Lower `minAgreementRatio`.* Re-admits the drive-through case D508 measured.
- *Promote on one surviving track.* D264 rejected it for a reason that stands.
- *Register session cameras `on-motion` so the runner's own recheck runs.* The
  orchestrator detaches the camera on `motion_cleared`; `unregisterCamera`
  clears the interval. The recheck can only be owned by what survives between
  sessions.
- *Remove the recheck settings.* The operator wants the mechanism, uniform.

## Decision

1. **"Not yet decided" is not a disagreement.** `observationVote` answers
   `agree | disagree | undecided`; a session observation whose tracker verdict
   is `entered`, or `moving` while the analyzer's settled test has passed and
   the dwell is still running (`TrackedDetectionOut.settling`), folds into
   neither N nor M. A subject that is travelling still dilutes. The row counts
   `undecided` so "why is this candidate slow" is answerable from the row.
2. **A parked object is represented once, by its registry entry.** At
   promotion the tracks that carried its evidence — the one alive on the
   tipping frame and the persisted source of its best box — are disposed of
   through the retention cascade: row, events, media, crops, vector. The
   entry's key frame is spared, stays `track`-owned, is vouched for by the
   entry (the orphan audit asks the registry, `keptMediaKeys`) and is released
   when the entry leaves the registry. This supersedes the SCOPE of D161 for
   promoted tracks: D161 persisted the row so the media would keep an owner;
   the owner is the entry now, and what is not the entry's is deleted, not
   orphaned. `expireStale` DISCARDS a re-sighting of a censused box and a short
   motionless non-person fragment instead of stamping it — only when a caller
   can cascade (`onDiscard`); without one it persists and stamps as before,
   because an unpersisted track nobody deletes is D161's orphan. A short
   motionless **person** is never discarded: no entity holds it and its face
   read is the record.
3. **The occupancy recheck is armed by the orchestrator, on every camera
   however it is dispatched.** `OccupancyRecheckController`: a session that
   closed having tracked a subject arms a tick at `occupancyRecheckSec`; the
   tick attaches the camera on its session node with the session config
   re-shaped to `on-motion` + `motionSources: []` + audio/pre-roll off + the
   runner's own interval off, asks `pipelineRunner.requestOccupancyBurst`
   (frames labelled `'burst'`, which agree on IoU alone), and detaches after
   15 s unless a session took the registration over. Discipline kept from the
   runner: a found burst resets the streak, two consecutive empty bursts
   disarm, a sleeping battery camera is refused and disarmed (D173), any other
   refusal is retried next tick. A tick during an active session is skipped.

## Consequences

- A parked car is censused on the SECOND session that sees it still (span
  ≥ 120 s, unchanged), or on the second recheck burst if no session comes —
  minutes, not hours. From then on the gate absorbs its detections before the
  tracker: no track, no event, no media. The ≤ 2 tracks minted before that are
  deleted at promotion. Expected on 102 against the measured 0.5 GB/day: the
  191 MB of visible re-sightings collapse to at most two tracks per parking
  event, which are then deleted; the 294 MB of non-person fragments are
  discarded on expiry. Person fragments (rare on this camera: 1 of 82 idle
  rows on 09-19) keep the legacy stamp.
- Every session-dispatched camera with the recheck enabled now pays one
  bounded dial + `occupancyRecheckFrames` inferences per `occupancyRecheckSec`
  while something is parked in view, and nothing after two empty bursts. The
  runner's `requestOccupancyBurst` log line (`reason=orchestrator-recheck`)
  and the ledger's `burstAgreed` are the two places to read whether it earns
  its keep.
- The `undecided` column is new on `pipeline-analytics:stationary-evidence`;
  rows persisted before it read it as 0.
- A closed track's key frame can now outlive its row. Anything that infers
  ownership from "the track row exists" must ask `keptMediaKeys` first — the
  orphan audit does; nothing else deletes by owner without the cascade.
- `SessionDispatchControllerDeps.requestBurstOn` is optional; a controller
  built without it logs at boot that no camera will be re-sampled.
- Cost: post-analysis and pipeline-orchestrator deploys on the hub (both
  hub-only). No `@camstack/types` change; no server train.

## Enforcement

- `stationary-evidence-undecided.spec.ts` pins the three-way vote, the neutral
  fold, and the DNRG309 profile (censused on the second still session; a
  drive-through and a momentary stop still refused). Reverting the vote to
  `disagree` turns 2 of 5 red — verified.
- `stationary-track-disposal.spec.ts` proves, over the real fake stores, that
  both tracks and every other media row go and the entry's key frame still
  resolves (row and bytes). `track-store-closed-reason.spec.ts` pins discard
  with a sink, stamp-and-persist without one, and the person exemption;
  `orphan-audit.spec.ts` pins the kept-key-frame probe. Reverting the spare
  set, the discard branch and the probe turns 4 red — verified.
- `occupancy-recheck-controller.spec.ts` pins the registration shape, the
  arm/disarm discipline, the supersede rule, the refusal path, and the
  end-to-end path through `SessionDispatchController`. Reverting the arming
  turns 6 of 10 red — verified.
