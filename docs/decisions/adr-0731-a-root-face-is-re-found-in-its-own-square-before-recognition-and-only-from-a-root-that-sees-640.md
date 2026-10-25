---
id: D731
title: A root face is re-found in its own square before recognition, and only from a root that sees the frame at 640 px or more
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/types/src/pipeline/root-face-crop.ts
  - packages/types/src/catalogs/root-model-supply.ts
  - packages/addon-pipeline/src/pipeline-runner/root-face-refine.ts
  - packages/addon-pipeline/src/pipeline-runner/detail-subtree.ts
---

## Context

[D730](adr-0730-a-step-takes-its-result-from-the-root-model-when-its-flag-is-on-and-the-current-root-declares-it.md)
let a root model's `face` box stand in for `face-detection`, but stopped at the
face box: recognition was unavailable, because a root face box carries no
landmarks and an unaligned crop must never reach the embedder — one gallery,
one crop derivation (D52), and the gallery's derivation is the landmark
alignment.

Two things were measured by the face investigation before this was wired:

- Embedding the root box as cut (or a padded version of it) puts faces into the
  gallery that the aligned path would never produce — the failure D52 exists
  to prevent.
- A root that sees the frame at 320 px (the plus catalog base Coral model) loses
  about 60 % of the faces a 640 px root finds on the 4K cameras; letting such a
  root be the face source would silently cost most faces.

## Decision

**A root face box is only a location. Its face is re-found by the face step's
own detector in one face-scoped square around it, and only that face — with
its landmarks — is recognised. The supply is in force only when the root's
input side is at least 640 px.**

1. **One face-scoped crop function**: `deriveRootFaceRefineRect` — a square of
   1.6 × the box's longer side, centred on it, slid inside the frame. It is
   cut from the frame's NATIVE surface only; a dispatch without a frame handle,
   or a native miss, is dropped and logged.
2. **The detector at an effective 160 px input**: the square is shrunk to
   `ROOT_FACE_REFINE_INPUT_PX` (160) and laid in the top-left of a black canvas
   the size of the detector's input (YuNet's 640). The network is
   convolutional and the margin is empty, so this IS a 160 px input on the
   existing graph — no 160 px build of the model. The canvas maps back to the
   frame through a virtual rectangle (640/160 × the square), so result boxes,
   landmarks and the embedder's native re-cut stay exact through the existing
   mappings.
3. **The best face goes back to the same step** as its output
   (`runPipeline.suppliedRoot`, whose detections now carry optional
   `landmarks`), and the `face-embedding` child aligns it through the existing
   native-crop alignment. No face in the square ⇒ nothing is embedded, and the
   drop is logged (`root face refinement found no face in the square`). There
   is no fallback to an unaligned crop.
4. **The landmark-precision gate measures the face in the refinement input.**
   It already measures the face box in the image the executor ran on; on this
   path that image is the refinement canvas, where the face fills most of the
   160 px region. `recognitionMinFacePx` stays the auto-match floor on the
   native measurement.
5. **The 640 px gate**: `CROP_SUPPLY_SOURCES['face-detection'].minRootInputPx
   = 640`. `rootSuppliesOf` stamps the root's input side on every crop supply
   (`rootInputPx`, a fact of the model, never stored by an import), and
   `resolveRootSupply` reports a smaller or unknown input as
   `inactiveReason: 'root-input-too-small'`. The editor shows the flag as
   inactive with that reason; the face step then runs its own detector on the
   person, as before.

## Consequences

- On the operator's hub today the plus catalog base Coral model is 320 px, so root
  faces stay inactive there by design; the per-frame face box from such a root
  is not used either (the runner removes root child boxes of a supply that is
  not in force).
- The refinement floor is the face model's own pool floor (YuNet's 0.85). The
  investigation suggested 0.3–0.5 for refinement; the pool drops anything
  below the model floor before the executor sees it, and lowering that floor
  touches the live face path, so it was NOT done here. Measure on live trials
  first.
- Two `runPipeline` calls per refined face (detector, then detector output +
  embedder). YuNet costs ~6–7 ms; the dispatch cadence is unchanged.
- A periodic face-geometry refresh that skips the embedder (a track that is
  already named) runs only the refinement pass.

## Enforcement

Tests: `root-face-crop.spec.ts` (the square), `root-model-supply.spec.ts` (the
640 gate, with the real 320 px plus catalog Coral labelmap — removing the gate
fails two cases), `root-face-refine.spec.ts` (native-only, the 640 canvas with
the 160 region, best face back with landmarks, frame mapping, no face ⇒
nothing), `executor-landmark-floor.spec.ts` (a supplied face is embedded
without re-running the detector and gated in the refinement input),
`detail-dispatcher-root-supply.spec.ts`, `agent-step-editor-root-model.test.tsx`.
Review only for "no unaligned fallback": nothing structural forbids a future
caller from embedding a root box directly.
