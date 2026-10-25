---
id: D198
title: A plate is rectified by its own quad, not by its bounding box
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/pipeline/plate-warp.ts
  - packages/addon-pipeline/python/postprocessors/ctc.py
---

## Context

Cam 102 ("Parking") read 0 plates. The 2026-08-19 audit (D186) concluded the
camera was unrecoverable below ~110px of native plate width and installed a
100px floor so it would stop storing wrong labels. That conclusion was drawn
from a chain that fed the recognizer an AXIS-ALIGNED box, and it hid the real
cause.

Measured on a fresh ground-truth set — 21 plate crops from 4K keyframes of cam
102, nine distinct vehicles, plates read by eye from the largest frames, plus 18
"junk" ROIs (false detector hits, clipped boxes, the weather OSD) to price false
positives:

- The plates on this camera sit at **24-31°**. The projection-profile deskew
  searches ±16° and correctly refuses an unbracketed optimum (D186), so it
  answers 0° on every single crop. The rotation is real and it never gets
  corrected.
- The detector's box is therefore the circumscribing rectangle of a tilted
  plate: **aspect 1.3-2.0 : 1** where the plate is 4.7 : 1. The recognizer
  normalises its input to a fixed 64px height preserving aspect, so a 1.5 : 1
  tile arrives ~96px wide — seven glyphs at ~13px each. Resolution was never the
  binding constraint; **geometry** was.
- Two things were tried first and did not work. Upscaling before the reader's
  own resize (2×/3×/4×, bicubic and lanczos) and contrast work (CLAHE,
  autocontrast, unsharp, gamma) each moved character accuracy by ≤2 points —
  they add no information the resize had not already kept. Re-detecting the
  plate on a native-resolution window (a "tighter box" second pass) produced a
  box statistically identical to the first (median width ratio 0.98, height
  0.99): the detector's box is as good as that detector gets.

What did work is treating the plate as its own quadrilateral. It is the one
thing in the ROI that is reliably a large, bright, convex blob.

| chain (same weights, same postprocessor)      | exact | char acc | false on 18 junk ROIs |
| --------------------------------------------- | ----- | -------- | --------------------- |
| deskew only, 100px floor (state before)       | 0/21  | 4.8 %    | 0                     |
| deskew + text-band + 3× upscale               | 0/21  | 16.3 %   | 0                     |
| **quad warp + seal-tolerant gate, 85px floor**| **4/21** | **42.9 %** | **0**             |

The four exact reads are four DIFFERENT vehicles at 91, 94, 95 and 98px native
plate width — every one of them skipped outright by the 100px floor.

A second finding fell out of it. Once the strips became legible the correct
decodes arrived as `DN.D7578`, `DN-P 1091`, `DN:HF 974` — the plate, exactly,
plus one punctuation glyph. That glyph is the plate's physical registration
SEAL. The blanket symbol gate (D186, added against live junk like `[miv4o)`)
threw away every one of them: the warp alone scored 1/21 instead of 4/21 purely
because of that line.

## Decision

The plate crop is rectified by its own quadrilateral before OCR:
`warpPlateJpeg` thresholds the tile (Otsu, floored at the 55th percentile),
takes the largest bright 4-connected component, reads its four extreme corners
and samples that quad onto a canonical **4.7 : 1 × 64px** strip. It runs FIRST;
`rectifyPlateJpeg` stays as the fallback for tiles with no plausible plate blob.
Neither fires on a quad it is not confident about — the un-warped tile is the
floor, never a guessed quad.

The CTC symbol gate exempts the plate SEAL, and only the seal: exactly ONE
seal-like glyph, strictly interior, nothing else non-alphanumeric left over, and
the normalised remainder must CONFORM to the region grammar. A read that does
not become a legal plate is not rescued.

The plate-OCR floor moves 100 → 85px: the largest floor that admits all four
newly-readable vehicles while still producing zero grammar-valid reads on the 18
junk ROIs.

## Consequences

This does NOT fix cam 102's own hardest case. The green Kia parked in the drive
(DN-RO 309), at 179-289px native — three times the floor — still reads
`NOKO309`: the leading `D` is lost and the seal decodes as a glyph. Worse, that
string CONFORMS to the DE grammar, where the old chain's `LOSO0` did not. On the
ground-truth set the change takes wrong-but-conforming labels from 5 to 9 while
taking correct ones from 0 to 4. **Geometry has been spent. What is left is the
recognizer** — `vgg_english_g2` is a generic English text model, not a plate
reader, and a plate-specific recognizer (roadmap L) is the only thing that
addresses a lost leading glyph.

Every constant here (aspect 4.7, the 55th-percentile threshold floor, the 4 %
left inset, the 85px gate) was swept against the ground-truth set. They are
calibrations, not preferences: changing one without re-running
`scratchpad/plate-audit` is a regression waiting to happen. The set, the truth
map and the replay harness live there.

The warp costs ~6ms per plate read (blob search is capped at a 200px longest
side) and runs at most `cadence.maxPerTrack` times per track.

## Enforcement

Unit tests only, no guard script. `plate-warp.spec.ts` pins the canonical strip
geometry, the blob/quad primitives and every refusal path;
`test_ctc.py::test_seal_*` pins that the seal exemption is grammar-gated and
that the 2026-07-22 junk stays rejected; `executor-plate-min-size.spec.ts` pins
the 85px floor and that a 90×45 tile now reaches OCR. The numbers in the table
above are NOT reproduced by CI — they need the real weights and the real crops,
which is what `scratchpad/plate-audit/` is for.
