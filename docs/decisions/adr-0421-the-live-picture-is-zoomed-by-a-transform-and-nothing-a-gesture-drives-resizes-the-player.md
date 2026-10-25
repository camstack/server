---
id: D421
title: The live picture is zoomed by a UI-thread transform, and nothing a gesture drives may change the player's frame per frame
status: accepted
date: 2026-09-09
supersedes:
applies-to:
  - camstack/src/live/use-stream-zoom.ts
  - camstack/src/screens/CameraDetailScreen.tsx
---

## Context

The operator reported the live-view zoom as "veramente scattoso e abbastanza
inutilizzabile, torna indietro durante i tap e non è molto reattivo", and asked
whether a known library should replace it. The libraries are already there:
`react-native-gesture-handler` and `react-native-reanimated` drive the pinch on
the UI thread, with no React state in the gesture. So the question was not the
library; it was what, on iOS, sits under the transform.

On iOS the live picture is a **WKWebView** (`LiveViewWebView`, because
`react-native-webrtc` cannot decode H.265). A `transform` on a wrapper around
it is applied by Core Animation to the hosted layer tree — GPU-composited, no
re-rasterisation. A change to the wrapper's **frame** is something else
entirely: a WebKit re-layout, an IPC to the content process, and a `fit()`
injected into the page so the `<video>` follows. Two records already said as
much without naming it:

- 432ce6d (2026-07-31) hypothesised "WebView layer re-rasterises" and added a
  scale sampler to tell chunky maths from chunky pixels.
- aa40815, twenty minutes later, localised the stepping to "portrait with the
  growing panel, **never landscape**" — the same WebView, the same transform,
  smooth in landscape where the box is a fixed fill. The "growing panel" is the
  opt-in `pinchExpandsHeight`, where the SAME pinch also drives the box's
  `height` and the wrapper's `width/height/left` **per frame** — a Fabric
  layout commit per frame, a WKWebView frame change per frame.

That first fix froze the viewport for the gesture; f22e8a9 (2026-09-06) then
added an end-of-gesture "settle" plus a settle on every `onLayout` because a
pinch-OUT now ended past its edge. Each patch hid the loop rather than
removing it, and the settle-on-layout was wrong on arrival: a shared value
written from JS is `scheduleOnUI` while a read is synchronous, so "write the
layout, then clamp against it" clamped against the **previous** layout. The
operator's log quoted in f22e8a9 (`panExtentX 131, tx 198`, a box that
shrank after a pinch-out) shows the feature is ON for them.

Two further defects were measured in the same pass, both independent of the
feature:

- **Neither `useStreamZoom` nor `CameraDetailScreen` is compiled by the React
  Compiler** (bailouts on shared-value writes / refs in render — verified by
  running the plugin with a logger). The hook returned a fresh object every
  render; the screen keys its five-gesture tree on it in a `useMemo`; so
  every re-render of the screen — which re-renders on each playhead tick —
  rebuilt the tree, and Gesture Handler's `updateHandlers` reconfigured five
  native handlers and re-shipped every worklet to the UI thread each time.
- The double-tap step ran `runOnJS(zoom.stepZoomAt)`: UI → JS → UI for a
  computation whose every input is a shared value, behind a 2 500-line
  screen's JS thread. Five synchronous cross-thread reads and six scheduled
  writes per tap.

The alternative the question pointed at — moving the transform **into** the
embedded page as a CSS transform — was rejected. It needs a per-frame
UI → JS → `evaluateJavaScript` → content-process hop (three thread crossings
and an IPC every frame, which is the latency the report complains about),
and it desynchronises the detection overlays that ride inside the RN wrapper
so they scale with the video. A zoom library would not have touched any of
this; there was never a JS-thread gesture to replace.

## Decision

The live picture is zoomed by a `transform` on its wrapper, computed and
applied on the UI thread. **Nothing a gesture drives may change the player's
frame per frame.** Concretely:

1. The box's height is ONE rule the screen owns —
   `zoomBoxHeightFor(committedScale)`, a worklet — read by two consumers: the
   zoom hook as its viewport, and `liveBoxHeight`, which animates the box to
   the rule's value **after** the gesture (`withTiming`). The box is a
   function of the **committed** scale, never of the live pinch, so it cannot
   move under the fingers, and the hook never measures a box of its own
   (`onLayout` gone, "frozen viewport" gone, settle-on-layout gone).
2. A pinch clamps against the box as it IS and, at its end, against the box
   the screen will animate TO (`clampPan` with `heightFor(committedScale)`).
   That is what closes the pinch-out-past-the-edge without a settle.
3. The hook's result is one memoised object for the life of the component, so
   the screen's gesture tree is stable across re-renders.
4. The double-tap step is a worklet, called from the tap gesture's `onEnd`
   without `runOnJS`.

## Consequences

- With `pinchExpandsHeight` on, the box no longer grows **under** the fingers;
  it grows once they lift, over the default `withTiming` duration. During
  that ~300 ms the WKWebView's frame does change per frame — bounded, not
  under a gesture, and the next thing to remove if it still reads as a step:
  size the wrapper to the maximum cover box once and fold the growth into the
  transform (`scale' = s·h/H_max`), so the player's frame never changes at
  all. Not done here because it re-plans `videoCoverStyle`, and that file
  carries three documented reanimated "stuck property" traps.
- The hook's signature changed: `useStreamZoom({ fit, viewport: { width,
  heightFor } })`, `committedScale` exposed, `onLayout` removed.
- None of the perceived-smoothness claims above were measured on a device in
  this pass. What was measured: the compiler bailouts, the Gesture Handler
  update path, the Reanimated 4.5 guest-side read/write semantics, and the
  on-record July symptom split (landscape smooth, growing panel stepping).

## Enforcement

- `camstack/src/live/__tests__/use-stream-zoom.spec.ts` (jsdom, drives the
  pinch through the gesture stub): result identity across re-renders; clamp
  against the committed box mid-gesture; settle against the destination box
  at the end. Each of the three was disarmed and went red.
- `camstack/src/screens/camera-detail/__tests__/zoom-box-follows-commit.spec.ts`
  (source guard, comments stripped): `liveBoxHeight` reads `committedScale`
  and animates; one `heightFor` rule for both readers; no `runOnJS` around
  the step; no `onLayout` in the hook.
