---
id: D409
title: A birth verdict is measured in a bounded ledger, not a log line
status: accepted
date: 2026-09-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/birth-decision-record.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/motion-onset-registry.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/birth-decision-ledger-store.ts
  - packages/types/src/interfaces/birth-decision-ledger.ts
---

## Context

On 2026-09-08 the operator marked eleven tracks for review and five of them said
"traccia partita in ritardo" — the track appears to begin long after the subject
entered the scene. Two causes were proposed and neither was ever measured.

The first, the confirmation gate's `maxDeferralMs` (2 s), is now **disproven as
a cause of a late timeline**: a track's `firstSeen` and its first position are
the CANDIDATE's first frame, not the confirmation's. Verified on `d035f251`
(device 3829), where the first position equals `firstSeen` and the confirmation
landed 2 163 ms later. The deferral moves media (D408), not the start instant.

The second — the detector simply not firing until the subject is well into the
scene — is the live hypothesis and had no instrument at all.

A third, separate defect is also unquantified. The deferred-birth re-offer in
`index.ts` takes the candidate from `result.tracked` with **no
`matchedThisFrame` check**, so a birth can be confirmed on a frame the subject
was never observed in. D379's carried birth evidence means some of those
confirmations rest on a real observation of the birth instant anyway, and how
often is exactly what nobody knows — which is also why nobody can say whether
adding the missing check would cost real tracks.

The obvious instrument was a richer log line. It does not work here. `logs.query`
is an in-memory ring, and on this hub it measured **40 000 entries covering 38
minutes** of fleet traffic. Every question above is asked per camera over days:
a fourteenth field on a line that is gone by morning answers none of them, and a
previous investigation in this repo was blocked for precisely this reason.

## Decision

A resolved track-birth verdict is appended to a **bounded, declared SQLite
ledger** (`pipeline-analytics:birth-decision-ledger`), one row per decision,
carrying the verdict, the deferral it used, whether the DECIDING frame was
matched or coasted, whether D379 evidence was available and whether it decided,
and the birth-latency proxy. It is read through
`pipelineAnalytics.listBirthDecisions`. It is a measurement: nothing gates on
it, no runtime path reads it, and no behaviour of the gate changed.

The ledger is bounded by **row count (30 000), never by age**, trimmed
oldest-first on append and amortised one ceiling check per 100 appends. Rows are
classified `never-orphaned`: most describe births that were SUPPRESSED and
therefore never had a track, and the confirmed ones must outlive theirs — a
cascade would shorten a miss rate's denominator while leaving its numerator
behind. The column is `sourceTrackId`, not `trackId`, so the ownership
derivation cannot reach it.

The birth-latency proxy is **motion onset**, and it is offered with its error
bars attached rather than as a fact. Two alternatives were rejected: the
recording/pipeline session start (opens at process start on a
`detectionMode: 'always'` camera — it measures nothing), and the first detection
of the burst (**circular** — a track's `firstSeen` IS the first detection of
that object, so for the burst-opening track, the only one the operator is
complaining about, the latency is 0 by construction). Motion onset is the only
in-process signal produced by a different mechanism from the object detector,
and the motion handlers and the frame path are gated to the same designated
post-processing node, so the mirror is never absent where the births are.

## Consequences

- **Cost.** One INSERT per birth decision — never per frame, never periodic,
  never an update. Measured fleet-wide on the live hub 2026-09-08: 31 decided
  births in 38 minutes = ~49/hour = 0.014 writes/s. The write amplification the
  runtime-state guard exists to prevent is 12–19 writes/s rewriting 2.6–5 GB/day
  to maintain 161 KB; this is three orders of magnitude below it and a different
  shape, because every row is new and nothing rewrites an unchanged slice. At
  ~200 bytes a row the ceiling is ~6 MB, which is ~25 days at the measured rate
  and ~5 days at five times it.
- **The append is best-effort.** It logs with `tags: { deviceId }` and swallows.
  A failed measurement must never fail — or delay — the birth it measures. That
  is the opposite of the debug-note archive, which throws, and deliberately: that
  table holds the only copy of something a person typed.
- **`birthLatencyMs` is a distribution, not a per-track fact.** It is `null`
  rather than a large number when the onset is older than 60 s, and NEGATIVE
  values are stored as measured — clamping them would delete the very evidence
  that the proxy is unreliable. It must never be rendered next to a track as
  "this track started N ms late".
- **The re-offer defect is measured, not fixed.** `decidedOnCoastedFrame` counts
  it; nothing refuses those frames. Whether to add the `matchedThisFrame` filter
  is a decision for after the first week of data, and the reason to wait is that
  refusing a coasted frame that D379 evidence had already vouched for would kill
  real tracks.

## Enforcement

Nothing structural, review only — which is itself the point: this record adds no
rule the frame path must obey, because it adds no behaviour. What is pinned by
tests is the ledger's own contract: the verdict taxonomy (including that
exhaustion attached to a suppression is discarded), that a suppressed birth
carries no `firstSeen`, the three ways the latency proxy declines to produce a
number, the count bound with its amortised trim, and that the append never
throws. Both decisive lines were removed and confirmed red before restoring.
