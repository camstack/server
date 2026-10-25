---
id: D423
title: The player keeps one frame per layout mode; the picture box grows under the fingers from the live scale, and the growth is folded into the zoom transform
status: accepted
date: 2026-09-09
supersedes: D421
applies-to:
  - camstack/src/live/use-stream-zoom.ts
  - camstack/src/live/zoom-render.ts
  - camstack/src/live/zoom-trace.ts
  - camstack/src/screens/CameraDetailScreen.tsx
---

## Context

D421 (viewer 1.0.478) removed the per-frame WKWebView re-layout by making the
picture box follow the COMMITTED zoom — it grew after the fingers lifted, over
a `withTiming`. The operator, same day, on the phone: *"continua a ritornare
in avanti se pincho verso l'esterno al massimo, magari aggiungi dei logs?
Anche per capire il meccanismo di estensione della finestra, anche quello
funziona male."* [it keeps jumping forward if I pinch outward to the maximum, maybe add some logs? Also to understand the window extension mechanism, that works badly too.]

Read against the code that mechanism is not the clamp re-settling under the
growth (nothing re-clamps after a release in 1.0.478) — it is the growth
itself. With `pinchExpandsHeight` the video cover-fills the box, so a box that
goes from 242 to 466 pt is a picture that gets 1.93× bigger and whose centre
moves down by 112 pt. Deferring the growth to after the release therefore
made the picture keep zooming and sliding for 300 ms once the fingers were up,
by exactly the amount the box grew — largest at the maximum (the growth is
clamped at scale 2.5, so a pinch to 4× ends with the whole 242→466 pending).
"Torna in avanti" [It goes forward again] and "l'estensione funziona male" [the extension works badly] are one defect.

The two designs before it fail on the same axis from the other side: a box
that grows per frame is a WKWebView frame that changes per frame (WebKit
re-layout, IPC, `fit()`), which is the "scattoso" of the July report. What
must hold is BOTH: the box grows under the fingers, AND the player's frame
does not change.

## Decision

1. **The player's wrapper is a constant per layout mode** — the window in
   fill, the rail box on wide, the 16:9 box at rest on the stacked layout —
   and never reads the animated box height.
2. **The box's height is a pure rule of the LIVE pinch scale**
   (`zoomBoxHeightFor(scale)`, `growBoxHeight` in `zoom-render.ts`), applied
   per frame with no animation of its own. Nothing moves at a release.
3. **The growth is folded into the zoom transform** (`foldGrowth`): total
   scale = pinch × box/rest, centre offset (box − rest)/2 added to the pan.
   What is drawn is, by construction, the cover box of the grown height scaled
   by the pinch, centred on the box — pixel for pixel what a wrapper that grew
   would have drawn, so the pan clamp is unchanged.
4. **The focal anchor is computed with two centres and total scales**
   (`focalPan.centerAfter`), so the grabbed point stays under the finger while
   the box grows. The single-centre formula parks it half the growth away.
5. **One rule, three readers**: the same `heightFor` sizes the box, clamps the
   pan and folds the transform. The hook measures nothing.
6. **A zoom trace exists** (`zoom-trace.ts`), gated on debug mode: samples
   accumulate on the UI thread and cross to JS once per gesture, 600 ms after
   the release or at the next gesture's start, the box the screen actually
   drew included. One `live:zoom` entry, one line per sample, readable without
   the code. The operator reads it in Settings → Logs or on the hub.

## Consequences

- The remaining per-frame cost under a pinch is one Fabric layout commit for
  the box's `height` (and the column below it) — the cost of any animated
  header in this app — plus a composited transform. The WKWebView's frame is
  untouched from the first frame to the release.
- Things rendered INSIDE the wrapper (detection overlays, the paused poster,
  the disabled stage) are laid out at the rest size and scaled with the
  picture, exactly as they already were under the pinch itself.
- `focalPan` gained an optional `centerAfter`; existing callers are
  unaffected (it defaults to `center`).
- D421's "box grows after the release" is withdrawn. Its other findings
  stand: one memoised hook result, the step on the UI thread, the hook never
  measuring, the frame-change mechanism.
- Still not measured on a device. What is measured: the geometry (every
  claim in 3 and 4 is a unit test), the trace format, the worklet status of
  the new functions in the production babel output.

## Enforcement

- `camstack/src/live/__tests__/zoom-render.spec.ts`: the fold draws exactly
  cover(box)·scale centred on the box for every height and scale; the rule is
  rest at 1×, max from the grow scale up, monotone.
- `camstack/src/live/__tests__/zoom-steps.spec.ts`: the anchor holds when the
  centre moves with the box.
- `camstack/src/live/__tests__/use-stream-zoom.spec.ts` (jsdom, drives the
  pinch): the clamp and anchor are those of the box the LIVE scale asks for;
  a pinch-out stays inside the shrinking box and NOTHING moves at the release;
  at the maximum, spreading further and letting go both change nothing; the
  trace writes one entry per gesture and nothing when off.
- `camstack/src/screens/camera-detail/__tests__/zoom-box-geometry.spec.ts`
  (source, comments stripped): the box reads the live scale with no
  `withTiming`; the wrapper never reads the box height; one rule feeds the
  three readers; the step stays on UI.
