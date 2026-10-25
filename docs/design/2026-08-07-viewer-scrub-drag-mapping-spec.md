# Viewer spec — velocity-adaptive scrub drag + instant timestamp label + timeline warm-up

> Status: to implement in the VIEWER app (the `camstack/` submodule →
> github.com/camstack/viewer.git, `src/`). The hub half is DONE on the
> `scrub-plan` work (D64): the feeder sweeps in both directions, reads GOPs by
> byte range, and answers `{t:'warm'}`; the embed bridge already exposes
> everything the viewer needs. This document is written so the viewer change
> needs no re-derivation — the mapping module is ported VERBATIM and the
> integration points are named by the bridge calls they already make.

## Why (measured)

48 h of feeder telemetry: 102 `mode=jump` pushes vs 3 `mode=sweep`. The
timeline maps ~8.8 s of media per px at default zoom while the feeder's sweep
window is 4 s — a careful 3 px move was a ~26 s jump, every time. The fix is
client-side mapping; the server half is live. Also verbatim from the operator:
"I want the timestamp to change quickly" — the label must follow the finger,
not the frame.

## 1. Port the mapping module (verbatim)

Copy `camstack/embed/src/scrub/drag-mapping.ts` (Viewer
repo) into the viewer as `src/utils/drag-mapping.ts` — the file is pure,
platform-free TypeScript with zero imports. Do not adapt it; its unit spec
(`embed/src/scrub/__tests__/drag-mapping.spec.ts`) can be copied alongside and
must pass unchanged. Public surface:

```ts
beginDrag(anchorMs: number): DragMapState
mapDragSample(state: DragMapState, sample: { dxPx: number; dtMs: number },
              config: { coarseMsPerPx: number }): DragMapState
// state.cursorMs = the scrubTo target AND the label value
// state.mode     = 'coarse' | 'fine' (useful for a UI affordance, optional)
```

Semantics: a fast drag keeps the absolute zoom mapping (reach preserved,
jumps are correct there); a slow careful drag becomes a jog dial at 1 px = 1 s
(capped 3.5 s/sample, inside the feeder's 4 s sweep window by construction),
in BOTH directions. Hysteresis (80 px/s enter, 240 px/s exit) keeps the mode
stable mid-gesture. Consequence to accept: in fine mode the cursor detaches
from the absolute finger→time position — that is the feature.

## 2. Wire the timeline pan handler

Locate the timeline drag handler: it is the code that today computes an epoch
from the pan gesture and calls the embed bridge `scrubTo(epochMs)` (find it
with `grep -rn "scrubTo" src/`). Replace its absolute px→time computation:

- on gesture GRANT: `dragRef.current = beginDrag(playheadEpochMs)` and call
  the bridge `scrubStart()` exactly as today.
- on every MOVE sample: with `dxPx` = horizontal delta since the previous
  sample (CSS px) and `dtMs` = time since the previous sample:

  ```ts
  dragRef.current = mapDragSample(dragRef.current, { dxPx, dtMs },
    { coarseMsPerPx: currentZoomMsPerPx })
  setDragLabelMs(dragRef.current.cursorMs)   // ← item 3, synchronous
  embed.scrubTo(clampToCoverage(dragRef.current.cursorMs))
  ```

  `clampToCoverage` is whatever the timeline already clamps with (coverage
  bounds); keep it AFTER the mapping so fine-mode deltas are what get clamped.
- on RELEASE: `embed.scrubEnd(dragRef.current.cursorMs)` — the commit uses the
  CURSOR, not the finger's absolute position (jog-dial semantics).

## 3. The timestamp label updates from the DRAG

The label component must render `dragLabelMs` (the mapped cursor) set
synchronously in the move handler — never the server `position` message and
never the rendered frame's timestamp, while a drag is active. Outside a drag it
falls back to the server position as today. This is a state-source change only;
no new messages. It is deliberately independent of everything else in this
spec — if any other part slips, ship this.

## 4. Warm the first scrub on timeline open

When the timeline UI becomes visible (the same place that today prepares the
scrub surface), call the NEW bridge function with the current playhead:

```ts
window.__camstackEmbed?.timelineWarm(playheadEpochMs)
```

It is fire-and-forget and safe while live is playing: server-side it pre-runs
locate + GOP byte-range fetch + demux into the session's fragment cache (and
warms the no-session fallback's index), so the first drag tick paints without
paying the 1–8 s locate chain. Call it again when the playhead settles
somewhere new while the timeline is idle (e.g. after a seek completes).

## 5. What the viewer does NOT need

- No new tRPC calls and no SDK regen: everything rides the existing embed
  bridge (`scrubStart/scrubTo/scrubEnd` + new `timelineWarm`) and the
  control data-channel behind it. (The `capMutate(client, cap, method, args)`
  idiom via `src/data/cap-query.ts` exists if some surface ever needs
  `recording.readGopBytes` directly — the timeline does not.)
- No changes to ack/credit handling — the embed's `RecordedTrackSession`
  already acks per rendered frame and the feeder charges whole sweep runs one
  credit.

## Ship-chain warning

The hub serves its own web viewer on a SEPARATE chain that has diverged
silently before (an OTA does not touch it). After landing this in the viewer
repo, realign BOTH chains: the mobile OTA and the hub-served web bundle, and
verify the running hub embed includes the `timelineWarm` bridge (it ships with
the `stream-broker` addon deploy, not with the viewer).

## Acceptance (drag a real timeline)

On a live hub, Loki `container="CamStack"`:
- a slow careful drag logs `scrub-feeder:pushed` with `mode=sweep dir=fwd`
  (forward) / `dir=back` (backward) — jumps only at the landing and on flings;
- `scrub-feeder:drag-end` shows `sweeps + backSweeps ≫ jumps` for careful
  drags (the 48 h baseline to beat: 102 jumps vs 3 sweeps);
- `recorded:warmed` appears when the timeline opens, and the first
  `scrub-feeder:pushed` of the next drag arrives without a preceding
  locate-length stall;
- the timestamp label moves with the finger with zero perceptible lag,
  including while frames are still in flight.
