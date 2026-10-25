---
id: D190
title: The snapshot service owns the tile for every camera state
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/system/src/builtins/snapshot/snapshot.addon.ts
  - packages/system/src/builtins/snapshot/snapshot-courtesy.ts
  - packages/types/src/capabilities/snapshot.cap.ts
---

## Context

D62 established that a camera which cannot produce a frame must still answer
with an image that SAYS so, and `snapshot-courtesy.ts` implemented it for
`disabled`, `sleeping`, `unreachable` and `waking`: the last real frame with the
state painted over it, the reason in `stateReason`, the reason in the ETag.

`offline` was left half-done, and the half that was missing is the one a client
notices. A camera the hub could not reach got the generated courtesy frame only
when there was **nothing cached**; when there was a cached frame — the normal
case, since the camera worked until it did not — the service returned the stale
photograph bare: no overlay, no `stateReason`, no change of ETag. Nothing in the
answer said the camera was gone, and a client that is handed an unlabelled frame
has no way to tell it from a live one.

So the client filled the silence, twice in two days. 2026-08-19 added a
`holdLastFrame` branch to `use-snapshot` plus a hand-drawn `WifiOff` chip in
`CameraCard`; 2026-08-20 added `CameraTileState.tsx` to make that bespoke
rendering agree with the sleeping one. Both were built on a third invention —
`shouldRequestSnapshot` refusing to even ASK for an offline camera — and all
three derived the camera's state from registry flags (`online`, `disabled`,
`sleeping`) rather than from the service that produced the pixels. Two sources
for one fact: the tile could say "offline" over a frame the hub had just
refreshed, or say nothing over a frame from an hour ago.

The operator's directive closed it: *"the viewer app should never manage these
tiles — the backend must provision the correct tile in every case."*

## Decision

**The snapshot service answers every camera state with an image, and names the
state in the response.** There is no camera condition for which a surface has to
invent a tile: `getSnapshot` and the media plane always return a frame — the
last good capture with the state painted over it, or the generated courtesy
frame when there has never been one — and `getSnapshotLinks.stateReason` plus
`ageMs` are the ONLY inputs a surface may render an inactive tile from. A client
may not derive an inactive state from `online` / `disabled` / `sleeping`
registry flags, and may not gate its snapshot request on them.

`offline` is a state reason but **not** a capture-blocking one
(`CAPTURE_BLOCKING_REASONS`). `disabled`, `sleeping`, `unreachable` and `waking`
short-circuit the ladder because dialling cannot produce a better answer;
`online: false` is a *verdict* — three consecutive control-plane misses in
`reachability-poll.ts` — and gating the ladder on a verdict is how a wrong flag
becomes self-sealing. So the ladder still runs, and a capture that LANDS is
served exactly as captured, with no treatment and no `stateReason`: recovery
needs no separate path.

## Consequences

- A frame identity now changes when the camera's STATE changes, not only when
  the pixels do (`variantKey` → ETag). That is what makes an already-painted
  tile repaint the moment a camera drops, and repaint again when it returns.
- The one state a client may still own is a **long timeout** — the hub not
  answering at all. Everything else it renders comes from served metadata.
- The offline treatment degrades to the raw cached frame if the SVG rasterizer
  fails, because `stateReason` has already been stamped: the tile stays honest
  through its metadata even when the pixels cannot carry the sentence.
- The link poll no longer refreshes an offline camera (`getSnapshotLinks` skips
  any device with a `stateReason`), so a fleet with dead cameras stops paying a
  dial per tile per poll. The image request still runs the ladder.
- `sleeping` continues to outrank `offline` for a battery camera — a sleeping
  camera is usually unreachable too, and reporting a working camera as a fault
  is the mirror image of D62's rule.

## Enforcement

`packages/system/src/builtins/snapshot/__tests__/snapshot-offline-tile.spec.ts`
pins all of it, including the two invariants that are easy to break while
"improving" this: the ladder still dials an offline camera, and a recovered one
serves fresh frames with no treatment left stuck to them. On the client,
`camstack/src/components/camera/__tests__/tile-state-is-server-owned.spec.ts`
fails the moment a surface re-derives a state from registry flags or draws a
state icon of its own.
