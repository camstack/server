---
id: D570
title: The clips surface is NOT a mode of the playback machine — a clip plays in its own sheet until it can enter the broker's recorded path, and a mode GO_LIVE cannot leave is a loop
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - camstack/src/clips/clip-stage.ts
  - camstack/src/clips/clips-surface.ts
  - camstack/src/clips/clip-download.ts
  - camstack/src/clips/clip-list-identity.ts
  - camstack/src/clips/use-clip-stage.ts
  - camstack/src/clips/use-clip-save.ts
  - camstack/src/recording/playback-machine.ts
  - camstack/src/data/use-camera-clips.ts
  - camstack/src/components/camera/clips/ClipStageView.tsx
---

## Context

[D569](adr-0569-one-camera-one-clip-source-picked-in-that-cameras-own-settings-and-the-two-derivations-are-exclusive-not-merged.md)
shipped a native clip in `NativeClipModal` — a sheet over the camera. The
operator asked for the same frame and a loop:

> *"Non riusciamo sul viewer a mostrare le clip sullo stesso riquadro stream e
> farle andare in loop? Si distacca dallo scrub e dal playback."*
>
> [Can't we show the clips on the viewer in the same stream frame and make them loop? It detaches from the scrub and the playback.]

**The first attempt (1.0.512) did that by adding a `clip` mode to
`usePlaybackMachine` whose reducer returned the same state object by reference
for every action outside an allow-list, and it was a hard regression.** On
device **3629 ("Camera porta retro")** attaching a clip left the app
vibrating continuously and unresponsive:

> *"Una volta agganciata una clip sento la vibrazione continua e non posso più
> muovere."*
>
> [Once a clip is attached I feel continuous vibration and I can no longer move.]

### Cycle 1 — the vibration, and it was caused by the mode itself

`use-timeline-scrub.ts` fires a go-live when the scroller sits at the live edge.
Its **only** brake is:

```ts
case 'goLive':
  if (!isLiveRef.current) onGoLive()
```

`isLive` is `mode === 'live' && activeEpoch === null`. The echo terminates
because `onGoLive()` puts the machine into `live`, which raises the flag. **The
brake is the machine reaching `live`.** A `clip` mode that `GO_LIVE` could not
leave — and whose bridge withheld the call — removed it. Every pass ran
`goLiveFelt`, whose first statement is `hapticTap()`, with the scroller
re-anchored each time, so the timeline looked frozen at one instant while the
phone buzzed.

It needed the scroller to BE at the live edge. **3629 is a sleeping battery
camera with 10 clips** — the compressed axis is a few hundred px, so the list
sits pinned at the top, and the battery hold means the machine was on `live`
with no player mounted. **592 was never affected**: mains-wired, 357 clips, a
tapped card thousands of px down, so the go-live command never issued.

### Cycle 2 — a render storm, independent of the player

`useCameraClips` built its empty list as a fresh `[]` inside a `useMemo` whose
deps include the react-query RESULT objects, whose identity changes every
render. `derivedClips` lists `clips.clips` as a dep, so on a camera whose clip
query had not answered the published list changed identity on every render — and
1.0.512 put that list in screen state. Unbounded `setState`. Proving it did
**not** raise `Maximum update depth exceeded`; it spun until the runner was
killed.

### Then the operator reframed it, twice, and was right both times

> *"Si deve staccare completamente la parte Clips dal playback… Non fa niente
> perdere lo scrub, niente playback delle recordings, solamente superficie
> Clips."*
>
> [The Clips part must be completely detached from the playback… It does nothing to lose the scrub, no playback of the recordings, only the Clips surface.]

> *"Anche il player non è lo stesso ma un video al di sopra. Non riusciamo ad
> utilizzare la stessa macchina di playback tramite WebRTC?"*
>
> [Also the player is not the same but a video on top. Can't we use the same playback machinery over WebRTC?]

Both observations are correct and the second is the important one. **Recorded
playback is ONE WebRTC track with a moving source pointer** owned by the
broker's per-viewer `TimelineSession`; every intent — play-from-epoch, seek,
rate, frame-step, drag, go-live — is one pointer-move on the `camstack-control`
data channel. If a clip could be another position of that pointer there is no
overlay, no second player and nothing to detach.

**It cannot today, and the reason is specific.** Measured by reading:

- The broker has **no file source kind at all**: `pull-rtsp | pull-rtmp |
  pull-http | pull-flv | pull-rfc4571 | push-annexb | derived`.
- `RecordedFeeder`'s only byte source is `recording.locateSegment` /
  `readSegmentBytes` / `readGopBytes` — **all keyed `(deviceId, profile,
  startMs|epochMs)`**. No path, no handle.
- `playRecorded` on the control channel carries `{deviceId, epoch, profile}`; a
  clip needs a file-relative timeline.
- A broker stream is keyed `(deviceId:number, camStreamId:string)` and the
  reconcile sweep retracts anything the device catalog does not claim;
  `brokerOwned`, the only exemption, is deliberately not on the cap wire.
- `docs/design/2026-09-20-clip-streaming.md` §5 recommended an ephemeral
  cam-stream and §9 withdrew it — but **on camera-transport economics** (a
  second Baichuan socket, wake budget, a 4.7 s cold start). None of that applies
  to a file already minted to the hub's own scratch. The withdrawal does not
  settle this question; §5's inventory of what is missing server-side does, and
  it is accurate.

An **analytics clip is not on that path either**: it resolves to
`recording.getPlaybackManifest` — HLS VOD from disk. So the hub already has two
independent readers of its own recordings, and "one clips layer common to every
provider" is not true today even for our own clips.

## Decision

**The clips surface is not a mode of the playback machine, and it will not
become one. A clip that is a FILE plays in its own sheet until it can enter the
broker's recorded path as another position of the existing source pointer.**

1. **`PlaybackMode` has exactly five members and every one is leavable by
   `GO_LIVE` in one dispatch.** The `clip` mode, `CLIP_ATTACH`/`CLIP_DETACH`,
   `resumeFrom`, the bridge's `isClipHoldingFrame` withholding and
   `shouldMountLiveView`'s clip branch are **all removed**. A mode `GO_LIVE`
   cannot leave is a loop waiting for a short clip list, and the rule is now a
   guard rather than a memory.

2. **The machine is untouched while a clip plays — so there is nothing to
   restore when it closes.** No capture, no resume target, no re-armed anchor.
   A sleeping battery camera is still on its poster afterwards because the
   battery gate decides, and it never changed. This is strictly better than
   1.0.512's `resumeFrom`, which existed only to undo damage the mode itself
   did.

3. **The clip plays in a `Modal`, and that is honest rather than ideal.** It IS
   a second player — the operator saw that — and a sheet says so. What it does
   not do is hold an opinion about the machine, which is the only thing that
   can starve the app.

4. **A derived array only enters state through `adoptClipList`.** The list must
   travel from the timeline's body to the player (the player steps through it),
   and `useCameraClips` now returns a module-level constant for its empty list
   so the churn is gone at the SOURCE. Both halves are load-bearing: fixing only
   the source leaves the hazard one careless memo away (`eventClusters` and
   `activity.recording` are also deps of `derivedClips`, and neither was
   audited); fixing only the adopt leaves every other consumer recomputing.

5. **Everything from 1.0.512 that was not the bug survives**: the loop read off
   the row (`repeat={stage.loop}`), the in-progress clip that plays **once** and
   says why, stepping that **skips** rows the provider refused and does not
   wrap, the save control in the cluster magnifier's corner, and the axis-free
   surface for a body of files (`clips-surface.ts` — a body of FILES draws no
   transport, no heatmap, no playhead, because they are meaningless there, not
   empty).

6. **The target shape, recorded so the next slice does not re-derive it.** Do
   **not** publish clips into the broker as synthetic cam-streams — that needs a
   new ingest kind, a sweep exemption on the cap wire and a non-device key, and
   still yields no seek, because the control protocol never reaches a live
   source. Instead add a **file-backed source behind the existing
   `RecordedFeeder`**: a `LocateResult`/`ReadGopFn` over a local MP4 (mp4box
   sample index — a progressive `+faststart` file has no `mfra`), a control
   message carrying a clip handle and a file-relative timeline, a
   `TimelineSession` branch, and a third `ClipPlayback` variant. That reuses the
   feeder, the demux, the push sink, seek/rate/scrub and the existing WebRTC
   session, and touches none of the broker's registry or reconcile invariants.
   Order of a week of server work, and it deletes this ADR's sheet.

## Consequences

- **1.0.512 is superseded by its own follow-up.** The in-frame clip player
  shipped and regressed within hours; the surface is back to a sheet with the
  loop and the stepping kept.
- **Analytics clips do not join the layer, and cannot yet.** They are an HLS VOD
  manifest, not a file; making them join means the same file-backed feeder work
  from the other end. A layer that is "common" in name and branches internally
  is what this repo keeps paying for, so it is named as not-yet rather than
  claimed.
- **The operator's grant is banked, not spent.** He said losing scrub and
  recorded playback inside the clips surface is acceptable. That permission is
  what makes a standalone layer legitimate if the feeder work never happens —
  but it was not used as a reason to build one now, because the feeder shape is
  strictly better and the operator removed the deadline.
- **`clips-surface.ts` and `clip-stage.ts` survive the reshape unchanged**,
  which is some evidence they were at the right altitude: they describe the
  SURFACE, not who owns the frame.

## Enforcement

- `camstack/src/recording/__tests__/go-live-terminator.spec.ts` — **the guard
  that would have caught the regression.** It reads the `PlaybackMode` union off
  the SOURCE and requires every member to be proven leavable by `GO_LIVE` in one
  dispatch, plus a bounded-dispatch test: ten go-live echoes must produce
  exactly one transition. Proven red against the shipped 1.0.512 code, where
  `'clip'` was declared and had no way out.
- `camstack/src/clips/__tests__/clip-publish-loop.spec.ts` — **a COUNT, not a
  value.** Renders the real parent/child publish shape and fails if it exceeds a
  render budget. Proven red with a pass-through `adoptClipList`: *"render loop:
  22 renders and still going"*, in 17 ms. The budget is enforced by the harness
  and not by React, because the loop does **not** raise `Maximum update depth
  exceeded` — it spins, which is the failure mode that reports nothing.
- `camstack/src/components/camera/clips/__tests__/clip-stage-wiring.spec.ts` —
  the player is mounted at the screen ROOT and not in `streamBox`, it renders a
  `Modal`, `repeat` is never a literal, and **the machine contains neither
  `CLIP_` nor `'clip'` nor `attachClip`** — the strongest form of "the clips
  surface is not part of the playback machine" is that the word does not appear
  in it.
- `clip-stage.spec.ts`, `clips-surface.spec.ts`, `clip-download.spec.ts`,
  `clip-mapping.spec.ts`, `live-wire.spec.ts` — the eleven red-on-revert proofs
  from the first pass, all still green. **None of them could see either loop**,
  and that is the lesson worth keeping: a loop is not a wrong value, it is the
  same right value for ever, so it can only be caught by bounding a count.
- **Nothing guards the file-backed feeder's absence**, because it does not
  exist. Whoever lands it deletes the sheet and this section with it.
