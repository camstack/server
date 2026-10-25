---
id: D691
title: A departure is committed when its sustain ends, and pictured on the subject that left
status: accepted
date: 2026-10-01
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/occupancy-recheck-controller.ts
  - packages/addon-post-analysis/src/notification-center/occupancy-watcher.ts
  - packages/addon-post-analysis/src/notification-center/ring-still.ts
  - packages/addon-post-analysis/src/notification-center/clip-retention-ask.ts
covers:
  - packages/types/src/capabilities/pipeline-orchestrator.cap.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/addon-pipeline-orchestrator/src/index.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/still-shelf.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
---

Amends [D682](adr-0682-a-pick-ups-footage-is-cut-around-the-pick-up.md) (its
"the recorded gif is a pick-up's only" rule) and
[D178](adr-0178-an-absent-subject-is-photographed-once-by-one-shelf.md) (its
picture of the emptied scope).

## Context

Camera 102, rule "Pat è andato via" (`became-free`, zone "Parking pat'",
`vehicle`, sustain 29 s, `gif: true`), 2026-10-01. The car left at
07:50:17.3. The notification arrived at 07:55:09 — 4 min 52 s later — with a
still of the empty space and no gif. The same rule had shipped one attachment
(no gif) on 30/09, 26/09 and 24/09. Tracker v2 was not the cause.

Three links, all older than the trial:

1. **The edge could only commit on a sample after the sustain.** The watcher
   is pure and has no timer. The session closed on motion clear at 07:50:45,
   1.3 s before the sustain ended, and the next sample of 102 was the 300 s
   parked-object recheck (07:55:02). The census sampler cannot help: it may
   never testify to an absence (D393).
2. **A dated occupancy edge the ring had lost got no gif.** The ring held 60 s;
   the recorded fallback refused everything but a package pick-up
   (`not-a-pick-up`, D682).
3. **The still was the empty space.** On a became-free edge nobody is left in
   the scope, so D178's shelf photographed the camera live — at the commit.

## Decision

Operator-approved, 2026-10-01.

- **A pending flip asks for ONE look at its sustain's end.** The watcher
  reports each flip as it ARMS (`takeArmedFlips`); the notification centre
  asks the orchestrator `requestOccupancyLook({ deviceId, afterMs: sustain })`.
  The orchestrator owns the dial, because only it can attach a camera between
  sessions: at `afterMs + 2 s` it runs the recheck's own attach → burst →
  detach (`reason: occupancy-sustain-look`). The commit is scene evidence; the
  census rule (D393) is untouched.
  - Bounded: one pending look per camera. A second ask moves it to the LATER
    end (one sample after both windows commits both) and never adds a dial.
    A shorter-sustain key on the same camera therefore waits for the longer
    one — rare (102's two rules share one key).
  - **One look per SESSION** (fix round 1, review H2): once a look has
    dialled, every ask is refused `already-looked` until the next session is
    dispatched. A look's own burst can re-arm a flickering flip, and a look
    per arm chained a burst every ~30 s forever.
  - The cadence never cancels a pending look (fix round 1, review H1): a
    close that arms the cadence, a skipped tick and a settle all re-arm the
    cadence timer only. A look is dropped only when the camera is forgotten,
    at shutdown, or when it lands on a burst already in flight — each said
    per camera (`occupancy early look: dropped`).
  - A session open at the due time is the look; no burst.
  - The look does not fold into the cadence's empty streak and does not re-arm
    on failure. A refusal (`unknown-camera`, `out-of-range`,
    `no-burst-producer`, `already-looked`) or a failed ask leaves the edge to
    the cadence, said per camera (a failing ask warns once per camera until
    one succeeds).
  - It is NOT gated on `occupancyRecheckEnabled`: it commits a notification,
    not a parked-object census. The runner still refuses a sleeping battery
    camera.
- **A DATED occupancy edge the ring lost gets its recorded gif** (D682
  amended). The recorded gif belongs to the self-dating kinds, a pick-up and
  now an occupancy edge, under D686's 30 s bound in the ONE message. An edge
  that could not date itself gets none (`moment-unknown`). Every other kind
  still gets none, renamed `not-self-dating` (was `not-a-pick-up`). The path
  runs only when `footageSourceFor` says `recordings`, so a ring-held edge
  never pays for a recorder export.
- **A departure is pictured on what left** (D178 amended).
  - A became-free edge names a media-ownable baseline member the committing
    read no longer lists: the departed track, whose best shot was taken on its
    way out (`chooseDepartedMediaOwner`).
  - When nobody who left owns track media (a parked entry), the shelf cuts a
    frame from the clip ring 1 s before `observedAt` (`ring-still.ts`: a ±1 s
    ring mp4, the frame 1 s before its end, on the pinned ffmpeg).
  - When the departed track resolves NO media (fused away, or too short to
    persist a best shot), the same ring still stands in, lazily: cut only on
    that miss (fix round 1, review M3). On `feat/tracker-v2` a fused-away id
    should first resolve through `TrackAliasStore`; that store is not on main.
  - When the ring has lost the moment (a sustain ≳ 50 s, or a cheap profile
    past `CLIP_RING_MAX_BYTES` ≈ 2.2 Mbps for a minute), the frame is cut from
    ONE recorded export of the same ±1 s window under D686's 30 s bound (fix
    round 1, review M2). A camera that does not record names both misses.
  - Never a live frame of the empty space. An undated departure, or a node
    with no ring still, ships no picture and says
    `occupancy departure still: none` (`moment-unknown` / `no-ring-still`).
  - An ARRIVAL that owns nobody is still photographed live: its subject is
    there now.
- **A camera an occupancy rule follows holds a full minute of ring**, whatever
  the rule attaches (operator: "incrementare il buffer … a 1 minuto"). The
  ring still is cut from it.

## Consequences

- **Release order** (corrected in fix round 1, review M1). The ask is an
  addon-to-addon call: a UDS cap call routed by cap name to the
  orchestrator's provider (`child-cap-dispatch.ts`), never the hub's tRPC
  router. So (a) needs the new ORCHESTRATOR addon, not a server release:
  `@camstack/types` (bundled with each addon) → `addon-pipeline-orchestrator`
  (hub) → `addon-post-analysis` (hub, then agents) → `@camstack/server` on the
  next ordinary train, which only exposes the method on the hub's tRPC/admin
  surface. An older orchestrator answers `method 'requestOccupancyLook' not
  found`: one warn per camera, and the cadence still commits. Verify after the
  deploy with `occupancy early look: scheduled`.
- An extra burst (4 frames) per pending flip whose session closed first. Not
  one per session: an arrival's session is normally still open at the due
  time, and then no burst is dialled.
- Memory: the ring is the cheapest profile's encoded AnnexB, about bitrate ×
  60 s, capped at 16 MiB (`CLIP_RING_MAX_BYTES`). At D500's measured 4.3 Mbps
  over 22 cheap streams (~195 kbps each) that is ≈1.5 MB per camera, or about
  +1 MB over a 20 s ask. 102 already held 60 s (its rules ask for a gif), so it
  costs nothing there today. Only a still-only or `attach: none` occupancy
  rule now adds a ring.
- The ring still costs one ring mp4 render and one ffmpeg frame decode per
  departure that has no departed track with media. When the ring has lost
  the moment it costs one recorded export as well — a second export if the
  rule also orders a recorded gif for the same moment (not shared with the
  dispatcher's cut memo). A past capture is bounded at 32 s (the 30 s recorded
  bound plus the decode), a live snapshot still at 8 s; a still-only rule's
  dispatcher wait (3 s) can ship text-only before a recorded frame lands.
- The ring still is cut from the cheapest profile, so it is lower-resolution
  than a live snapshot, and it travels as base64 through the existing
  `renderPreBufferClip` (D613's `peerBytes` is the long-term form).
- A refusal name changed: log searches for `not-a-pick-up` must now search for
  `not-self-dating`.

## Enforcement

- `occupancy-recheck-controller.spec.ts`:
  - the look fires at sustain + margin, not at 300 s;
  - one burst per camera, at the LATER end;
  - an open session means no dial;
  - the cadence's streak is untouched;
  - named refusals;
  - a refused burst is not retried;
  - end to end through `SessionDispatchController`: a burst before 300 s.

  Each is red with its gate removed: the margin, the session skip, the
  `clearTimeout` of a moved look, the later-end bound, the range check, and
  the settle fold. Fix round 1, in PRODUCTION order (the ask while the
  session is open, then the close; a cadence tick between the ask and the
  due): the look survives (red with the cadence re-arm cancelling it); one
  look per session, re-armed by the next one (red without the budget, or
  without its reset); a look on a burst in flight is dropped out loud; the
  look's completion is logged with `found`.
- `pipeline-orchestrator-request-occupancy-look.router.spec.ts`: admin-only,
  and a malformed ask never reaches the provider.
- `occupancy-media.spec.ts`:
  - the departed member is named, and preferred over one that stayed;
  - a parked departure names nobody, and becomes a ring still at
    `observedAt − 1 s`;
  - no ring still means no picture and the named line, and an undated
    departure means `moment-unknown`;
  - an arrival is still photographed live;
  - a flip asks for one look when it arms, and a refusal is logged.

  Each is red with its gate removed.
- `ring-still.spec.ts`: the cut, the frame choice, and the staged file's
  removal. Every miss throws by name. The recordings fallback on a ring that
  threw or answered empty, both misses named — red with the fallback removed.
- `still-shelf-past.spec.ts`: a past capture waits out a 10 s recorded answer
  and still gives up at its own bound.
- `occupancy-departure-deps.spec.ts`: the addon's real wiring of both deps
  (the ring cut's arguments, the decode, the recorded fallback's deadline).
- `occupancy-media.spec.ts` (fix round 1): a departed track with no media
  gets the ring still, one with media never cuts the ring; a failing ask
  warns once per camera until one succeeds.
- `recorded-footage-one-shot.spec.ts`:
  - a dated occupancy gif is cut from the recordings into one message;
  - an undated one gets `moment-unknown`;
  - a queued detection gets `not-self-dating`;
  - red with the old pick-up-only gate.
- `clip-retention-ask.spec.ts`: a still-only or `attach: none` occupancy rule
  asks for 60 s.
