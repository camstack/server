---
id: D483
title: An on-demand player is a second VIEWER session, and the instant it opens at is REQUIRED
status: proposed
date: 2026-09-12
covers:
  - camstack/src/recording/viewed-instant.ts
  - camstack/src/store/reel-highlight.ts
  - camstack/src/store/reel-highlight-store.ts
  - camstack/src/data/use-reel-highlight.ts
  - camstack/src/components/camera/ReelHighlightSheet.tsx
  - camstack/src/live/ondemand-player.ts
  - camstack/src/live/ondemand-geometry.ts
  - camstack/src/live/use-seek-to-moment.ts
  - camstack/src/store/ondemand-player-store.ts
  - camstack/src/components/camera/OnDemandPlayer.tsx
  - camstack/src/components/camera/OnDemandPlayerHost.tsx
---

## Context

The operator asked for a second player: opened on demand on a tablet or a wide
web window, showing a camera's RECORDED playback from a given instant, with a
compact timeline that can scrub and return to live, movable and resizable, and —
added while the work was starting — *«un overlay mobile ovunque sulla pagina
corrente qualunque essa sia e non cambia con la navigazione»*.

The defect it removes is concrete. "Go to this moment" in a track detail did
`router.push('/camera/<id>?at=<epoch>')` from two screens (`EventsScreen`,
`CamerasScreen`), which REPLACES the screen — so the operator lost the track
detail they were reading in order to see the moment it described.

Three things were assumed at the start of the work and turned out to be wrong.
They are the reason this record exists rather than a commit message.

**The attach does not declare a history window.** The brief required this player
to state its preroll under D382, on the grounds that an unstated ask had once
meant "everything". D382 governs an **RTSP restream dial path**
(`stream-broker/rtsp/restream-intent.ts`, `/preroll-<ms>`) and its consumers are
the `events` recorder's ffmpeg, the detection decode worker and muted re-clocked
legs. The viewer is not one of them: under D42 a viewer has ONE media session
whose source POINTER moves, so live, recorded and scrub are the same WebRTC
track and there is no window to over-ask for. `preroll` appears nowhere in the
viewer or `embed/` source.

**A second concurrent session is not the new cost it was framed as.** The
theater already replaces its single picture with a WALL of N sessions in the
picture's own box (`workspace-grid.ts`, 2026-09-02), after the operator
overruled the session-protection argument — *«Non fa niente se riconnette»*. Two
sessions is this app's normal case. The genuinely new cost is a second audio
source and a second decoder, addressed below.

**The mechanism already existed end to end.** `LiveViewProps.initialSeekMs` →
`EmbedConfig` → `embed/src/playback/initial-seek.ts`, which fires
`warm(epochMs)` + `playRecorded(…)` the moment the control channel opens.
`usePlaybackMachine` is hook-local *because* there can be more than one of it.
So no new transport and no new state layer were written.

A fourth correction came from the audio question. The instruction was to reuse
an existing audio-ownership seam, "one audio at a time, ownership moving", on
the strength of `EmbedGridPage`'s docblock: *«Audio is EXCLUSIVE: at most one
tile is unmuted at a time (`activeAudioId`)»*. **`activeAudioId` does not
exist** — neither does `setActiveAudio`. Audio in the grid is COMBINABLE, a
host-owned SET (`audioOnIds` / `setAudioOn`), which the two lines directly above
that paragraph in the same docblock say. The paragraph is a leftover describing
a design that was replaced, and it nearly bought a fourth audio policy on a
screen that already has two.

## Decision

An on-demand player is a second viewer session with the same machinery as the
first, and:

1. **The instant is REQUIRED.** `OnDemandRequest` has no optional `atMs`. This is
   D382's *discipline* without its mechanism: an unstated ask must not be
   decided by its own absence, and an optional `atMs` would read as "open live"
   at every call site that forgot it. Both entry points supply one — the track
   detail the event's, the reel the primary machine's `activeEpoch`, with the
   live edge (`null`) resolving to wall-clock now.
2. **One contract, two entry points.** `openOnDemand({ deviceId, atMs })` means
   "this camera, at this moment". The reel's action is deliberately NOT "camera
   B live": `addToView` already puts B's live picture on screen, and a second
   road to the same place is not a use case.
3. **The surface gate is `shouldUseWideDetail`, borrowed whole.** Below it the
   `?at=` navigation is preserved byte-for-byte, so the button never stops
   working — it stops replacing the screen where there is room not to. No
   private breakpoint: that predicate's docblock forbids widening without the
   operator, and the reel is already gated behind it.
4. **The primary KEEPS PLAYING** (operator's call, overruling the
   recommendation). The secondary mounts `muted`, the same default the primary
   has, and there is NO exclusivity rule between them — the app's audio model is
   a combinable host-owned set and the only exclusive resource is the mic
   (`useExclusiveIntercom`).
5. **The host is a sibling of the `<Stack>` navigator**, in `app/(app)/_layout.tsx`,
   never a child of a screen: a screen unmount would END the media session.
6. **Both gestures commit on RELEASE.** The picture is a WKWebView / iframe, so a
   gesture-driven layout prop relayouts WebKit per frame. A drag moves an empty
   ghost; the box changes once, to one of three snap sizes or a clamped position.
7. **The compact timeline COMPOSES the theater's leaves** — `HeatmapBar` and
   `TimelinePlaybackBar` verbatim, neither gaining a prop. It is not
   `TheaterTimeline` and not a mode of it.

## Consequences

**What it costs.** One additional availability query per open player, a second
decoder, and a second broker feeder while the player is on a recorded pointer.
None of this is measured, and it should not be claimed as free: what can be said
is that the wall already creates the same condition with N cameras, so D483
introduces no condition that was not already reachable.

**A consequence of keep-playing the operator should hear.** The primary's
playhead keeps advancing while the secondary is open, so closing the secondary
does not return the operator to the instant they left. That is what "keeps
playing" means, and it is stated here rather than left emergent.

**What it forbids.** A player opened with no instant. A second breakpoint for
"medium/large". A gesture that drives a layout prop on the panel. A copy of
`TheaterTimeline`. An audio exclusivity rule that disagrees with the wall.

**What now has to be true elsewhere.** `viewOptions` left the reel's action bar
(operator: *«il pulsante delle settings che non è necessario lì»* [the settings button, which is not needed there]) — it
configures overlays drawn on a LIVE picture and a reel card is a snapshot
thumbnail. Nothing is stranded: the same panel is reachable from `GridTile` and
from `CameraDetailScreen`. The shelf passes its own `SHELF_CONTROLS` so the WALL
is untouched; removing the control from `cell-controls.ts` would have changed
the grid silently, which is worth more than the invariant it breaks.

**The reel's highlight is a DIFFERENT control from the one that left it, and
the two happened to look alike.** In the same change the operator asked for the
reel's cards to light up on motion and audio, with a settings button opening the
highlight editor. `viewOptions` left the CARD because it configures overlays for
a snapshot where no overlay is visible; the new button is SHELF-scoped and
configures how the cards themselves light up. One control per camera removed,
one control per reel added — not a removal reversed.

Its scope follows from the surface, not from taste: the picture's highlight is
per-camera (`useCameraViewOptions(deviceId)`) and the reel draws many cameras,
so there is no "the" camera whose object it could share — it owns one, for the
whole reel («settings comuni su quella griglia» [common settings on that grid]). It lives in a dedicated store
because `grid-store`'s `setGridHighlightEntry` is "a no-op for an unknown id"
(a reel entry would vanish silently) and `settings-store` — the right neighbour
— is imported BY `grid-store`, so taking `GridHighlightSettings` into it closes
an import cycle. The audio default is **rung `mid` (-39 dBFS)**, chosen against
`audio-level.ts`'s shipped calibration rather than the fleet's own `audio-dbfs`
baseline, which this session could not query; `low` (-53) sits inside the quiet
band and would light a reel of N cards on room tone. It is one constant and the
operator's to move.

**The camera SWAP carries the instant too, and three gestures now share one
computation.** The operator added *«se sono in playback deve rimanere allo
stesso istante sulla nuova camera»* [if I am in playback it must stay at the same instant on the new camera], so tapping a reel card means "camera B at
the moment I am looking at" — the same verb as the reel's on-demand entry point.
`recording/viewed-instant.ts` answers "what moment is the primary showing" once,
and the two consumers apply OPPOSITE rules to the degenerate case, correctly:
the swap carries NOTHING when the primary is live (an `?at=<now>` would open the
new camera in recorded playback just behind the live edge — a feeder, a seek and
a picture that never catches up), while the overlay resolves live to `now`
because its contract has no optional `atMs`. That is why the answer is a union
and not a `number | null` each call site `?? nowMs`es for itself — which is the
shape `resolveReelInstant` had shipped with an hour earlier, and it gave the swap
the wrong rule.

No new vocabulary: `?at=` is already how the app says "open this camera at this
instant". `replace` stays `replace`, so backing out still returns to the list.
And the route still changes, so the screen still remounts — the operator's
separate *«senza ricaricare tutto»* [without reloading everything] request is NOT answered, and its finding is
recorded in (planning repo: sessions/sessions.md): the embed can already swap in place <!-- drift-ok: moved to the private planning repo -->
(`embed/src/embed/set-device-command.ts`, whose docblock is verbatim the request)
and the host has no `setDevice` in its command union. Carrying the instant is
correct either way, so this is not work the in-place swap discards.

A camera with no footage at that instant is deliberately NOT pre-checked: the
coverage read is per-day and cached, and a stale "no coverage" would refuse a
valid seek. It opens at the instant and says so — the embed reports `gap`, the
playback bar draws it, the coverage tape shows no band under the cursor, and a
log line carries `tags.deviceId` plus what was carried.

**The camera swap happens IN PLACE, and the trade that gated it did not exist.**
The operator chose in-place over the alternatives. The remount was caused by
`key={deviceId}` in `app/(app)/camera/[id].tsx`, NOT by the route change —
`router.replace` re-renders the same route — so dropping the key keeps the URL
truthful on web and keeps `replace`'s back-to-the-list behaviour. None of the
three legs was given up.

The instant rides the swap (`setDeviceCommandSchema` gains `atMs`) so it is
flash-free; a swap-then-seek would be the "host round-trip, live-first flash"
that config-carried seeking exists to remove. The page's contract comment was
REWRITTEN, not deleted: its invariant — the boot instant never applies to a
different camera — still holds exactly, and what changed is that the host may
pass one as an ARGUMENT. A leaked instant is still the defect; an argued one is
the feature. The same distinction governs the playback machine, which is reset
AND seeded by one atomic `SWAP_CAMERA` action.

Capability is DETECTED, not assumed: the page advertises `caps` on a message the
host already receives, and absence reads as "an older page". That is the only
form that stays correct when the app ships OTA and the embed ships with the
orchestrator addon. Without the needed capability the host rebuilds the surface —
the old behaviour — and logs it at `warn`, because a branch that degrades
silently is one nobody notices has stopped degrading.

**Two existing guards had to change, and both were narrowed rather than
deleted.** `camera-action-bar.spec.ts` asserted the wall and the shelf are
identical control-for-control; it now asserts the difference is exactly
`{viewOptions}` and that the shelf may never gain a control the wall lacks — a
stronger claim than the equality was. `docked-timeline-chrome.spec.ts` asserted
`TimelinePlaybackBar` is imported by `TimelineView` and nothing else; its stated
reason is this timeline's PANEL system ("the 'panel is open' state would have to
be told to it"), which does not reach a surface with no panels, so it is now
scoped to the `theater/` directory and the footer band — which genuinely cannot
travel — is pinned absolutely.

## Enforcement

Guards, in the viewer:

- `src/live/__tests__/ondemand-player.spec.ts` — both gate clauses (including
  the non-obvious one: on web a landscape window whose SHORTER side is ≥ 768 is
  tablet-proportioned and qualifies BELOW `DETAIL_WIDE_MIN_WIDTH`), the
  navigate fallback, the reel instant, and `resolveOnDemandOpen`'s
  unknown-is-not-gone rule (D315).
- `src/live/__tests__/ondemand-geometry.spec.ts` — snap commit, the
  container-beats-minimum clamp, the re-clamp that pulls a position stored in a
  bigger window back on screen, and the z-order relation.
- `src/store/__tests__/ondemand-player-store.spec.ts` — per-field parsing (one
  bad member must not discard a good one), absent ⇒ default, and that `open`
  RETARGETS rather than refusing.
- `src/grid/__tests__/camera-action-bar.spec.ts` and
  `src/screens/camera-detail/__tests__/camera-shelf-mount.spec.ts` — the
  viewOptions divergence, by value and in the rendered tree.
- `src/components/camera/theater/__tests__/heatmap-day-window.spec.ts` — the
  extracted `localDayWindow`, including the flat-24 h span that is deliberately
  not calendar-correct.

`src/live/__tests__/set-device-contract.spec.ts` is the one that matters most
structurally: it feeds the host's REAL encoder output, on both transports, into
the embed's REAL schema. A writer and a reader declared in two bundles have no
test that catches them diverging unless something feeds one into the other.

Each of the three load-bearing gates was disarmed and confirmed to fail:
reverting `resolveOnDemandOpen` to `(ids ?? [])` fails only the unknown case;
putting `viewOptions` back on the reel fails four value assertions and the mount
assertion; removing the navigate fallback fails the two routing assertions.

**Review only**, and worth writing down: that the overlay really survives
navigation on BOTH web (router swaps DOM) and native (the Stack unmounts
screens) rests on expo-router layout-route semantics plus the sibling placement.
It was not verified at runtime in the session that wrote it — no device or
browser was driven — and it is the requirement most likely to hold on one
platform and fail on the other.
