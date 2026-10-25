---
id: D186
title: A plate read is a VOTE across the track, never the argmax over OCR score
status: accepted
date: 2026-08-19
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/plate-vote.ts
  - packages/addon-post-analysis/src/pipeline-analytics/plate-recognizer.ts
  - packages/addon-pipeline/src/detection-pipeline/pipeline/plate-deskew.ts
  - packages/addon-pipeline/src/detection-pipeline/pipeline/executor.ts
---

## Context

An 11-track ground-truth audit of licence plates on cam 102 (2026-08) found
**0/11 exact reads in production**. Four independent causes, and the shape they
share is the reason this is one record rather than four bug fixes.

**The score was trusted.** `PlateRecognizer.holdBest` kept the single read with
the highest OCR confidence. That confidence ranks how sure the recognizer was
about the pixels it was given — not how much of the plate those pixels were. On
the audited tracks the top-scoring read was routinely the wrong one while two
lower-scoring reads agreed on the right glyph. Nothing about the pipeline knew
that: five reads of the same physical plate arrived, four were thrown away, and
the one kept was selected by the one number that carries no information about
correctness.

**A boundary was reported as a measurement.** The deskew estimator swept ±30°
and returned its argmax unconditionally. On real crops the projection-profile
energy rose *monotonically* to the negative end — the profile never turned over,
there was no optimum inside the interval — and the estimator reported a
confident -27°. Six of eleven native crops were warped by an angle that was an
artefact of where the search stopped; a 59×47 tile came back 74×69, mostly fill.

**The wrong axis was gated.** The min-size gate floored the SHORT side at 20px.
A plate's information lives along its text run, so the long side is what decides
whether a glyph survives the recognizer's fixed-height resize. Every audited
tile cleared 20px on the short side (46 > 20) and none produced a correct read;
the gate logged 1 line in 3 days against ~200 OCR calls.

**The grammar was applied to the wrong string.** The DE grammar and the OCR
confusable table are both defined over uppercase alphanumerics; they were being
matched against the raw decode, which carries lowercase and spaces. The best
crop in the whole audit decoded to `"DN Ro3o9"` — the correct plate, in the
wrong alphabet — failed its own grammar for its case, and could not even be
offered the 0↔O repair, because lowercase `o` is not a confusable key.

Each of these is an estimator reporting a confident answer where it had no
measurement, and each was invisible because the code that discarded work said
nothing.

## Decision

**A plate read is a vote, not an argmax.** The reads a track produces are all
kept and decided per character, weighted by score, after aligning them to a
reference (Levenshtein traceback — a dropped leading district letter must not
shift every later column). Generalised: *when a quantity is measured more than
once, combine the measurements; do not rank them by a confidence that was never
calibrated against correctness.*

Three corollaries, in the same spirit:

- **An optimum on the edge of a sweep is not a measurement.** An estimator
  returns "unknown" (and the caller changes nothing) unless the optimum is
  bracketed by the search.
- **Gate on the axis that carries the information**, and pick the threshold from
  ground truth, writing the data into the constant's docblock.
- **Normalise before you validate.** A grammar, a lookup table and a distance
  all read the canonical form; only the gates that exist to catch junk read the
  raw form.

## Consequences

The stored plate text may be a string no single read produced. That is the
point, and it is why the gallery crop still follows the max-score read: the
operator reviewing a plate sees the sharpest frame the track produced, and the
text under it is the consensus. A vote that comes back implausible falls back to
the max-score read rather than storing an invention.

The vote needs the reads to arrive, so `cadence.maxPerTrack` on `plate-ocr` is
now load-bearing: reducing it to 1 silently reverts this record. The read list
is capped in ARRIVAL order, never by score — evicting the lowest-scoring read
would re-introduce the ranking the vote exists to distrust.

The 100px long-side floor means cam 102 stores no plates at all rather than
wrong ones. That is a deliberate trade: a wrong plate label is worse than none,
because a notification rule can match it. Recovering that camera needs bigger
plate pixels (a tighter plate box or a higher-resolution substream), not a
lower floor.

Every branch that now drops a plate read logs it with `tags: { deviceId }` (and
`trackId` where post-analysis has it). Intra-track concordance — "how many of
the five reads agreed?" — is the cheap per-camera measure of whether the pixels
are good enough, and it was uncomputable while only the winner reached the log.

## Enforcement

Tests, not guards:
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/__tests__/plate-vote.spec.ts`
locks that the lowest-scoring pair outvotes the highest-scoring read;
`plate-recognizer.spec.ts` locks it end-to-end through the store insert and
that the gallery crop still tracks the max-score read;
`plate-deskew.spec.ts` locks that a monotone energy profile returns 0°;
`executor-plate-min-size.spec.ts` locks that a 60×46 tile is skipped and that
every read is logged; `test_ctc.py` locks the normalisation.

No guard script catches a future `argmax` over a confidence in this codebase.
Review only — which is worth writing down, because this exact shape has now cost
one full ground-truth audit to find.
