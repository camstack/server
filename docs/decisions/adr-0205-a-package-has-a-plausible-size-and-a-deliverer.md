---
id: D205
title: A package has a plausible size, a deliverer, and a witnessed pick-up
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-area-gate.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-stillness-tracker.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
---

## Context

Device 101 — the only camera with a package zone — produced ~23 false
delivered/picked-up notification pairs a night. The 21-day event corpus showed
348 of 350 false detections were ONE static object: the streetlight's light
wedge on the granite paving (a commit had mislabelled it "the doormat"), at
7.96–9.47% of the frame. Meanwhile a true parcel on 2026-08-18 13:41 was
silently missed, and another on 2026-08-20 18:15 never even reached a
detection above threshold.

The thing that was tried first and did not work: **confidence**. The step's
`minConfidencePackage` slider even advertised "raise it against static porch
furniture" — but the wedge scored up to 0.877 and the one true parcel scored
0.885. There is no threshold between them. The measured separator is AREA:
real parcels measured 1.14% and 1.72% of the frame; the wedge never below
7.96%.

The second signature of the wedge: nobody ever precedes it. A real delivery
is a person (and usually a vehicle) in frame within minutes before the box
first appears; the wedge "reappears" out of TTL-flicker with an empty scene —
and "vanishes" the same way, which the detector had been reporting as a
pick-up, re-arming the loop with a fresh candidate id every cycle.

## Decision

Three gates, each of which the wedge fails and every measured real parcel
passes:

1. **Size ceiling** (`packageDropMaxBboxAreaFrac`, default 0.04): a
   package-class sighting whose bbox exceeds the ceiling is dropped BEFORE a
   stillness candidate can open (`package-area-gate.ts`), and the same bound
   is enforced at the detector's size gate for entries from any producer.
   The dropped sighting is logged (`tags: {deviceId}`), throttled to one line
   per 5 minutes per device.
2. **A parcel needs a deliverer** (`packageDropActivityWindowSec`, default
   300, 0 = off): a candidate only promotes to `delivered` if a NON-package
   track was active on the device within the window before the box first
   appeared. Fixed at candidate open — a passer-by arriving later never
   retroactively validates scenery. The package class itself never stamps the
   activity mirror, so an FP cannot vouch for its own delivery.
3. **A pick-up needs a witness**: a promoted box that stops being observed
   with nobody around the disappearance (no activity at/after its last
   sighting, one round-gap of slack) is NOT a pick-up — it is logged and
   remembered (D206), never bridged to the `picked-up` event.

And the failure mode that hid both real misses is closed: an unpromoted
candidate that expires now logs WHY (rounds, dwell, no-activity).

## Consequences

- A parcel delivered while the camera saw no prior activity (e.g. dropped
  during an outage, or beyond the window) will not notify. That trade was
  accepted by the operator; the expiry log names the suppressed candidate.
- A box that physically stays but flickers out of detection produces a
  delivered with no paired pick-up — correct, since nothing was collected.
- The slider description in `step-definitions.ts` now states the measured
  truth: confidence is not the lever against a static FP; the size ceiling is.

## Enforcement

`package-area-gate.spec.ts` pins the REAL measured boxes: the light wedge
(9.46%), its widest variant (9.47%), and the daylight doormat blob (9.5%)
must be rejected; the true parcels (1.14%, 1.72%) and an A5 flyer must pass.
`package-drop-detector.spec.ts` pins the same fixtures at the event gate, and
`package-stillness-tracker.spec.ts` pins the activity gate (including "a
passer-by later must not validate the wedge"). All run in CI; each gate was
verified red with the gate removed before shipping.
