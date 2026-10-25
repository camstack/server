---
id: D410
title: A stationary hold may CONTINUE a confirmed track; only a strong read is the parked object, and no hold ever OPENS a track
status: accepted
date: 2026-09-09
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-match.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker/spawn-refusal.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts
---

## Context

Device 102 is a street view with two permanently parked cars at the right edge
of the frame, both held by the stationary registry. On 2026-09-08 the operator
marked four vehicle tracks with the same note — *"la traccia muore appena arriva
a ridosso delle auto stazionarie"* — and the records agree with him to the
pixel: every one is a car entering at the top edge (x ≈ 2100–2400, y ≈ 0),
driving right and down, and its last stored box (right edge 3060–3175, bottom
104–702) is the first box that touches the parked entry at x 3001–3455,
y 325–730. Life 1.7–3.5 s, 5–10 positions.

For the one track still inside the log ring (`1a453f8c`, 20:02 UTC) the path is
complete: `detections: 3, tracked: 1` on its last frame (the SUV at IoU 0.129
with the parked car, released; the parked car read strongly, dropped), then
nothing for 4 s, then `track lost` — `maxMissedMs` exactly — with no
`tracker: detection dropped` line in the window and `reach: 0` on the sweep. The
footage (OSD ≈1.5 s behind the server clock, anchored on the first stored box)
shows why: for the next ~2 s the SUV's body covers first the dark parked car,
then the silver one, and then it leaves the frame at the bottom-right. Every
one of those boxes is a `detectionSwallowsEntry` shape — 2–4× the entry's area,
entry centroid inside — and while the SUV occludes the parked car the detector
reports ONE vehicle box, so it is the entry's best match in pass 1 and is held
there. The tracker, which had followed the car for ten frames, received nothing
and coasted out after the car was gone.

The two other tracks with footage (`63c6e83d`, `5e3f1f75`) end on the identical
geometry. The fourth (`0d527cec`) is a different complaint: its car drove AWAY
up the street and left the frame; the operator's note is about a late BIRTH,
and that is out of the ring and not decided here.

D275 anticipated over-suppression and priced it as "loses a frame or two while
it passes; the tracker coasts through that on `maxAge`". That is true of a parked
car in the middle of the frame. It is false of a parked car at the frame EDGE,
where the whole passage across its front is also the exit, and the hold lasts
until there is nothing left to coast to.

Alternatives weighed:

- **Lower `SUPPRESS_IOU`.** Changes nothing here — none of the killing boxes
  were strong reads; they were held by the swallow rule and the departing
  branch, both of which live below `suppressIou`. And it re-opens D275's leak
  (13 of 23 tracks at IoU ≥ 0.5) for no gain.
- **Release swallow reads.** Lets the pass live, and lets a parked car's
  bloated night box spawn — the jitter branch would still hold a box centred on
  the car, but not one that grew off-centre. Fixes one direction only.
- **Release a hold whose box MOVES relative to the entry.** The gate is
  stateless per detection and would have to re-implement association to know
  which of last frame's boxes this one is. The tracker already knows.

## Decision

A detection the stationary gate holds may never **open** a track, in any form:
not a spawn, not a rescue bind, not a resurrection. A **strong** hold — IoU ≥
`suppressIou` with a live entry — IS the parked object and never reaches the
tracker. A **weak** hold — a swallowing box, a jitter read, a departing read,
anything the gate holds below `suppressIou` — reaches the tracker flagged
continuation-only, and the tracker may use it for one thing: to CONTINUE a track
it has already confirmed (`hits ≥ minHits`), through the strict predicted-box
association and nothing looser. A weak hold that no confirmed track claims is
refused with reason `stationary-hold` and dropped. The gate's own decisions —
confirmation, re-anchoring, departure strikes — are untouched; only what
happens to the box after the decision changes.

This amends one consequence of D275 and leaves its rule intact. D275 said
suppression reaches every detection on a parked object; it still does, in the
sense D275 meant — none of them may open a track. What D275 called
"over-suppression … the tracker coasts through" is no longer left to the coast
budget: the moving car keeps its id through the pass.

## Consequences

- Measured on the four 102 tracks' real boxes: every box of the pass is a weak
  hold and every one is continuable; the SUV's trajectory keeps its id through
  four extrapolated covering boxes. The parked cars' own boxes and the D275
  leak signature (IoU 0.55, centroid inside) are suppressed exactly as before;
  the latter is continuable, and with no confirmed track to claim it the
  tracker refuses it a birth. The leak direction is structural, not a tuning:
  a held box has no spawn path at all.
- What a weak hold CAN do that it could not: update a confirmed live track. The
  bound on the wrong case — a parked car's partial box adopted by a passing
  car's track when the passing car's own box is missing for a frame — is the
  strict pass (`iouThreshold` 0.3 on the prediction; the real SUV prediction
  reaches 0.21 against the entry, so it would not bind) and the next strong
  read, which is dropped and leaves that track coasting. It cannot settle on
  the parked car, because the parked car's own box never arrives. The rescue
  pass would have bound at 0.129 ≥ `rescueIouThreshold` — which is why no
  salvage branch may see a held box.
- An unconfirmed track is not continued. A car born beside the parked cars,
  with fewer than `minHits` released frames before the overlap, still dies as
  before. The four measured tracks had 5–10.
- No new tunable. The strong/weak boundary is `suppressIou`, which already
  meant "this is the parked object" versus "this overlaps its spot".
- Telemetry: the registry's sweep line gains `continuable` (weak holds handed
  on) and `continued` (how many a confirmed track consumed, reported back by
  the frame processor); the tracker's dropped-detection line gains reason
  `stationary-hold`. `suppressed − continuable` is what never reached the
  tracker.
- Framework packages are untouched: the flag travels on
  `TrackerFrameContext`, not on `SpatialDetection`, so the fix is live on an
  addon deploy.

## Enforcement

Tests, all on the measured 102 boxes
(`__tests__/fixtures/device-102-parked-pass.ts`):

- `stationary-match-continuation.spec.ts` — the pass boxes are held and
  continuable, the parked cars' own boxes are held and not, the D275 signature
  stays suppressed, the departing branch is continuable, the two other tracks
  end on the same geometry.
- `sort-tracker-stationary-continuation.spec.ts` — the SUV keeps its id through
  the pass; a held box with no track is refused and reported; a held box never
  rescues (with the control showing the rescue pass WOULD bind it released),
  never resurrects, and never carries an unconfirmed track to `minHits`.
- `frame-processor.spec.ts` — the wiring: a weak hold continues a confirmed
  track and counts as `stationaryContinued`; on a fresh processor it opens
  nothing and reports `stationary-hold`.
- `stationary-registry.spec.ts` — the sweep line carries `continuable` and
  `continued`.

Removing the implementation with the tests in place fails 12 of them. No guard
script: the invariant is a predicate, and the tests assert it directly.
