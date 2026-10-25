---
id: D519
title: A composite camera is ONE ffmpeg child, started by a consumer and stopped by the last one, over NORMALIZED geometry
status: accepted
date: 2026-09-17
supersedes:
applies-to:
  - packages/system/src/builtins/camera-grid/**
covers:
  - packages/types/src/capabilities/camera-grid-layout.cap.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/restream-intent.ts
  - packages/ui-library/src/composites/cap-settings/CameraGridLayoutEditor.tsx
---

## Context

An operator wanted several cameras composed into one picture — "a 16:9 taken
from the middle of two streams, side by side" — and then wanted that picture to
behave like an ordinary camera: recorded, in the timeline, scrubbable, bound
like any other.

Four questions had a real second answer, and each of the wrong answers is
something this repo has already paid for in a different shape.

**1. How is the picture composed?** `hstack`/`vstack` is the obvious ffmpeg
answer and it was tried on paper first. It expresses a regular grid of EQUAL
tiles and nothing else — the operator's actual request, arbitrary rectangles
with per-source crops, cannot be written in it at all. It also has no notion of
a gap: a missing source does not leave a hole, it reshuffles every surviving
tile.

**2. Pixels or fractions?** Storing "crop 960x540 at 480,270" reads naturally
and is what a first draft wrote. A source camera changes resolution — a profile
switch, a firmware update, a substream that comes back different — and from that
moment the stored rectangle cuts the wrong part of the picture, with nothing
anywhere saying so. The operator sees a slightly wrong crop, which is the class
of bug nobody files.

**3. Does the crop go through `deriveDetailCropRect`?** [D52](adr-0052.md) says
"one vector index = one crop derivation", and this is a crop, so the question is
fair. But D52 protects the COMPARABILITY of a vector index: every crop that feeds
it must be cut the same way, which is why that function is the only cutter.
A grid cell feeds no index. Routing it through D52's function would have added a
second caller — with its own padding rules and its own aspect handling — to the
one function D52 exists to keep single-purpose.

**4. Prebuffer or on demand?** Every other camera in the fleet has a live dial
the broker keeps warm. A grid that did the same would decode N cameras and
encode one composition, permanently, per grid — and a grid is the one camera in
the system whose idle cost is a multiple of everybody else's. The operator was
explicit: off when nobody is watching. The complication is that "nobody" has to
include the recorder, or a grid with recording enabled would record nothing.

## Decision

A composite camera is **one ffmpeg child** performing N decodes, one composition
and ONE encode, assembled by the shared builder in `@camstack/types`
(`extraInputs` + `filterGraph`, `-map` derived from the graph's declared pad) and
emitting only compressed packets — frames never cross a process boundary at
frame-rate ([D9](adr-0009.md)/[D18](adr-0018.md)).

Its geometry is **normalized [0,1] on both sides** — the crop taken out of a
source, and the cell it lands in — and the crop resolves against the source's own
size at runtime (`crop=iw*w:ih*h:iw*x:ih*y`). It is composed onto an explicit
`color=` canvas with `overlay`, never with `hstack`/`vstack`, and it does **not**
go through `deriveDetailCropRect`.

The child runs **while, and only while, somebody is reading its bytes**. A
consumer is an open read of the grid's loopback HTTP endpoint; the broker is the
only thing that dials it, and it dials for whatever is consuming the grid's
profile slot — a viewer, a snapshot, or the recorder. The first consumer acquires
one broker handle per source (`streamBroker.getStreamWithCodec`, which rides the
source camera's ONE dial) and starts the child; the last one to leave stops it
and releases every handle.

## Consequences

- **A grid costs nothing when nobody watches, and a multiple of one camera when
  somebody does.** The operator pays for the composition at exactly the moments
  it is looked at. The recorder needs no special case: with recording enabled the
  broker holds a dial, so the grid stays up like any other recorded camera.
- **A geometry change restarts the composition.** ffmpeg cannot be told a new
  graph, so the child is stopped and the consumer's next read builds the new
  picture. A grid is not seamlessly re-editable while live.
- **A cold start is slower than an ordinary camera's**, because the composite
  emits nothing until the SLOWEST of its N inputs has probed. That is why every
  input carries a shrunk `-analyzeduration`/`-probesize` (safe on RTSP: the SDP
  already declares the codec).
- **A camera used by two cells is decoded once.** The source→ordinal mapping in
  `gridPlanFor` is what makes "a wide shot and a crop of the same street" cost
  one decode, and it is the reason the layout's `inputIndex` is derived rather
  than authored.
- **The stream must be named in `getCatalog` on every pull, idle included.**
  The broker sweeps anything its registry holds that a provider's catalog does
  not name. `brokerOwned: true` is the opt-out from that sweep and it is
  deliberately NOT on the cap wire — a cap caller cannot make its own
  publication un-sweepable. A grid does not need it and cannot have it: it is a
  provider-declared stream, and being present is what keeps it. A catalog that
  went empty while the composition was idle would retract the stream of every
  grid, which is all of them by design.
- **`profileHint: 'high'` is mandatory, not decoration.** A single-stream device
  with no hint is ranked by pixel count into `mid` — the slot no storage class
  selects on its own and the one scrub never reads. That is the Dreame robot bug,
  and a composite is single-stream by construction.
- **Object detection is off at creation and never re-asserted.** A grid is a
  picture composed from cameras that are already analysed; running detection on
  it pays twice and attributes a subject to a viewpoint that does not exist. It
  is written to the authorities (`setWrapperActive`) ONCE, on creation — an
  operator who deliberately turns it back on must win, and a reconcile that
  re-asserted it every minute would silently overrule them.
- **The geometry gets a widget, not a derived form.** A generated form renders
  "cell 1 crop x = 0.25" and cannot be used. The non-spatial knobs stay ordinary
  fields beside it.

## Enforcement

- `scripts/check-ffmpeg-primitive.ts` — refuses a second argv builder; this
  addon composes the shared one and names nothing `build*Ffmpeg*Args`.
- `scripts/check-addon-entries.ts` — the manifest entry must exist in the vite
  `entries` map.
- `packages/system/src/builtins/camera-grid/__tests__/grid-stream-invocation.spec.ts` pins
  the ARGV of a 2x2 grid, including "exactly one `-c:v`, one `-filter_complex`,
  four `-i`" and "`-hwaccel` before every `-i`".
- `packages/system/src/builtins/camera-grid/__tests__/grid-stream-session.spec.ts` and
  `…/grid-stream-relay.spec.ts` pin the on-demand lifecycle, the second over a
  real loopback socket.
- `packages/system/src/builtins/camera-grid/__tests__/grid-stream-descriptor.spec.ts` pins
  `profileHint`.
- The "never re-assert detection" rule is **review only**. Nothing stops a future
  pass moving `silenceAnalysisFor` out of the `outcome.created` branch.

---

## Addendum, 2026-09-17 — the editor, the snapshot, and the profiles

Three things the first pass got wrong or left out. Each is recorded here rather
than as its own record because each is a consequence of the same decision: a
composite is an ORDINARY camera, and an ordinary camera has a settings page, a
snapshot and profiles.

### The geometry widget is declared on a CAPABILITY, not in a settings schema

The first pass put the editor in the addon's own `deviceSettingsSchema()` as a
`type: 'widget'` field. The hub returned that section correctly and
`ConfigFormField` renders `type:'widget'` perfectly well. It rendered nowhere,
because **nothing ever asked camera-grid for it**: the only page that fetches a
per-device addon settings schema is Cluster → Pipeline → Device Overrides, and
it interrogates a HAND-WRITTEN list — `PIPELINE_CLUSTER_DEVICE_ADDONS`, four
names — whose own comment says an addon not on it "falls off silently".

Adding a fifth name would have been wrong twice: that page is per-camera
DETECTION tuning, and a grid's geometry belongs beside PTZ and motion zones on
the camera itself. Which is exactly where the framework already puts a widget
declared through `deviceConfig.ui` on a capability.

So `camera-grid-layout` is a capability: `scope: 'device'`, `deviceNative`,
carrying `deviceConfig.ui = { kind: 'widget', widgetId: 'host/camera-grid-layout' }`
and the two methods the editor was already calling through `addons.custom`
(`getLayout` / `saveLayout`). The grid camera device registers it natively, the
custom actions and the `deviceSettingsSchema()` override are **deleted**, and
the widget asks THE CAMERA through the ordinary device proxy.

The tab is `streaming`, not a top-tab of its own: a `grid` top-tab needs an entry
in `WELL_KNOWN_TAB_MAP` or the device page renders the raw id as the label (the
robot camera showed a tab called "navigation", 2026-09-06), and that file was
outside this slice's reach.

**The cost, stated:** a new capability is a framework change. It reaches a node
only inside a published `@camstack/server` (D16) — `camstack deploy
packages/addon-camera-grid` alone will NOT make this editor appear.

### The snapshot is a frame of the composition, and never a dial

A grid had no snapshot at all, so it showed nothing in lists and grids. The
operator's decision, verbatim: *"Lo snapshot possiamo sempre farlo dallo stream
sempre, non c'e' bisogno di comporre gli snapshots"* [we can always take the snapshot from the stream, there is no need to compose the snapshots].

Composing N source snapshots was the alternative, and it is a SECOND compositor
with its own geometry and its own aspect handling, producing a picture that
differs from the real one in ways nobody notices until they matter.

So the grid camera registers a NATIVE `snapshot` provider — deliberately absent
before, on the reasoning that the broker's ordinary grab takes one from the
profile slot and taking one IS a consumer. That is true, and it is the defect:
it means a thumbnail in a list starts N decodes. The native runs FIRST in the
wrapper's ladder, and it answers one of three things:

| state | answer |
| --- | --- |
| a composition is running | one JPEG sampled out of the bytes it is already emitting |
| nothing running, a frame was kept | that frame — stale, and honest about it |
| nothing running, nothing ever kept | `null`, logged with the reason |

`GridStreamSession.openIfRunning` is the whole guarantee: it REFUSES a cold
session, so a thumbnail can never be the reason sources get acquired. The kept
frame is `GridLastFrameFileStore`, one file per grid under the addon's own
`dataDir` — the same shape and the same reasoning as
`@camstack/system`'s `SnapshotDurableStore`, restated rather than imported
because that class is a builtin's internals and an addon reaching into one would
be importing another addon.

**The residual, stated plainly.** For a grid that has never once been composed,
the native answers `null` and the wrapper falls through to its broker frame-grab,
which WILL dial the grid's profile slot and start a composition. Closing that
door needs a guard in `packages/system/src/builtins/snapshot` ("this device's
stream is composed on demand; do not dial it for a thumbnail"), which was outside
this slice's allowed paths. It cannot wake a battery camera — a grid never dials
one live at all, see below — and it is self-limiting, because the frame it
produces is then kept.

### A grid has its own profiles, and each maps onto the sources'

The first pass published ONE stream, `profileHint: 'high'`, and every source was
asked for `profile: 'high'` — including when the only thing consuming the grid
was a thumbnail.

A grid now publishes one composition per profile it can serve: `grid` (high,
keeping the bare id so an existing operator assignment is not orphaned),
`grid-mid` and `grid-low`. A grid's `high` composes its sources' `high`, its
`low` their `low`. `mid` and `low` compose onto a SCALED copy of the operator's
canvas (×0.5, ×0.25, even, floored at 160×90) — the geometry needs no second
version of itself because every rectangle is normalized on both sides.

**A profile is offered only when EVERY source can serve it**, asked of
`streamBroker.listAllProfileSlots` (`sourceCamStreamId === null` is the broker
saying no). Not "at least one": a cell whose source has no `low` cannot be
filled, and a composition with a hole in it reads as a broken camera, not as an
unassigned profile three cameras away. The refusal NAMES the sources, in the log
and in the editor, because "this grid has no low" is not something an operator
can act on and "101 has no low" is. A read that FAILS keeps the previous answer;
a grid that has never had one refuses to describe itself (the device throws)
rather than publishing an empty catalog, which would retract every stream.

### "sentryMuted" — what it turned out to be

The operator asked for *"lo stream sentryMuted (lo dobbiamo creare, non esiste
ancora)"* for battery sources. It half existed. `SENTRY_PATH_SUFFIX` has been
there since the sentry shipped, and `parseRestreamPath` already answers
`muted: true` for it — **the sentry path IS the muted one, by construction**,
because an `m=audio` nobody fills stalls a consumer for the hours a camera may
sleep. So sentryMuted is not a new intent and not a flag on an existing one.

What did not exist is two things:

1. **The writer.** `withDetectionIntent` and `withRecordingIntent` had no sentry
   counterpart, so a caller had to hand-concatenate — and `<token>/muted/sentry`
   parses back to the token `<token>/muted`, a lookup that finds nothing and says
   nothing. `withSentryIntent` REPLACES whatever the url declared, and drops any
   pre-roll request (there is no history in a still picture).
2. **The offer.** Eligibility (`sentryEligible`: a BATTERY camera that DECLARES
   the signals cap) is asked of facts only the broker holds. A grid re-deriving
   it from cap bindings would be a second authority, and two authorities on this
   question is how a composite ends up dialling a sleeping camera because its own
   copy of the rule was a release behind. So the broker ANSWERS it, on the
   acquisition: `getStreamWithCodec` now returns `sentryUrl` — the sentry dial
   when this camera offers one, `null` when it does not.

The grid's rule is then one line: **an offered sentry is TAKEN**
(`gridSourceDial`). There is no sleep check and no fallback, deliberately: "use
the sentry if the camera is asleep, otherwise the live stream" reads reasonable
and IS the wake, because whether a battery camera is asleep changes between the
read and the dial, and the dial is what wakes it.

**Why it cannot wake a camera.** `rtsp-listen-server` acquires the broker warm-up
— which is demand, and demand dials — for every declaration EXCEPT `sentry`, and
`sentry-never-wakes.spec.ts` pins that with the control cases (`/muted` still
warms; a plain dial still warms). The safety of the writer therefore reduces to
one claim: everything it emits declares sentry. `sentry-intent-writer.spec.ts`
asserts exactly that, over every url shape the broker hands out.

A cell whose source is asleep composes that camera's last picture, held, for as
long as it sleeps — visible, legible and obviously not moving. The two
alternatives are the ones this record and the sentry both exist to refuse:
dropping the cell (a hole an operator files as a broken grid) and dialling the
camera (eleven seconds of battery for five seconds of video, measured on device
640 on 2026-09-15).

### Enforcement added

- `packages/addon-pipeline/src/stream-broker/rtsp/__tests__/sentry-intent-writer.spec.ts`
  — everything `withSentryIntent` emits declares sentry and is muted.
- `packages/addon-pipeline/src/stream-broker/stream-broker/__tests__/sentry-url-on-acquire.spec.ts`
  — `sentryUrl` is offered only when the broker's own gate says so, and a
  transcode offers none.
- `packages/system/src/builtins/camera-grid/__tests__/grid-profiles.spec.ts` — a profile a
  source cannot serve is not on offer, and the refusal names the source.
- `packages/system/src/builtins/camera-grid/__tests__/grid-snapshot.spec.ts` — the three
  snapshot states, including "nothing is composing ⇒ sample NOTHING".
- `packages/system/src/builtins/camera-grid/__tests__/grid-sentry-sources.spec.ts` — an
  offered sentry is taken, with no sleep check and no fallback.
- `packages/system/src/builtins/camera-grid/__tests__/grid-frame-sample.spec.ts` — the
  grab closes its hold and kills its child.

The single-JPEG grab (`grid-frame-sample.ts`) is deliberately NOT the ffmpeg
primitive: it is the run-to-completion class
`scripts/check-ffmpeg-primitive.ts` already carves out by name for
`recorder/still/still-frame-service.ts` and `builtins/snapshot/snapshot.addon.ts`.
It spawns a variable binary, so the guard's textual Rule 2 does not see it; an
explicit `SPAWN_ALLOWLIST` entry belongs there and `scripts/` was outside this
slice's allowed paths.
