---
id: D632
title: A sensor notification shows every LINKED camera, mosaic by default, one option — the mode is a media field, not a top-level clearable key
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/types/src/capabilities/notification-rules.cap.ts
---

## Context

A sensor rule today ships either N separate notifications (one per linked
camera, whichever media ladder the rule's `attach` picks) or a single picture
picked from an arbitrary camera — neither answer is "here is what every
camera watching this sensor just saw", which is what an operator actually
wants for a door contact or a motion sensor with three overlapping cameras.
Two things stood in the way of composing that picture honestly:

1. **The opt-in filter hides linked cameras.** `LinkedCamerasCache`'s existing
   index answers "which cameras opted this device into TRACKED EVENTS"
   (`producesTrackedEvents`), not "which cameras link this device" — a camera
   can link a sensor for live-view convenience without opting into its
   timeline rows, and today's per-camera notification fan-out never sees it.
   Timeline rows must keep the opt-in gate; a notification about "what did the
   cameras see" is a different question and must not inherit it.
2. **State cards and stale frames are indistinguishable from photographs.** A
   camera that is offline, sleeping, disabled, or mid-wake still answers
   `getSnapshot` with SOMETHING (a state placeholder, or its last cached
   frame from minutes ago) unless the caller checks first. A mosaic built
   from unchecked captures would silently include tiles that are not what
   the camera saw at the trigger.

The rule ships in two steps. The schema field below travels in
`@camstack/types` on the `@camstack/server` train; the code that captures,
excludes, and composes lives in `addon-post-analysis` and reaches the hub by
an addon deploy (`camstack deploy packages/addon-post-analysis`). The addon
inlines `@camstack/types`, so it knows the field on its own deploy; the hub's
cap-router input validation uses the copy `@camstack/system` inlines, so until
the server release is installed a rule saved through `notificationRules.*`
has `linkedCameras` stripped and reads as absent — the default, `mosaic` —
and the addon deploy is safe on either side of that train.

The field considered and rejected: widening `media.attach`'s enum with a
`mosaic` value. Rejected because `attach` answers a different question
(selection strategy against ONE subject's ladder, consumed by non-sensor
rules too) and because an older peer that has not received this schema
version rejects an UNKNOWN enum value outright (`z.enum` on the receiving
side) — a ladder value it does not recognise would break parsing of the
whole `media` object on that peer, whereas an unknown OPTIONAL field is
silently absent there instead (see the `.optional()` note below).

## Decision

`NcMediaPolicy` gains one optional field, `linkedCameras: NcLinkedCameraMode`,
`NcLinkedCameraModeSchema = z.enum(['mosaic', 'each'])`:

- `mosaic` (the default when absent) — one image composed of every linked
  camera's photograph, taken at the trigger.
- `each` — one image per camera where the notification target itself takes
  several attachments (the degrade engine keeps them in camera order); a
  target that takes only one keeps the first camera WITH a picture — the
  primary's, unless its tile was excluded, stale or failed (the engine keeps
  images by position, and a missing primary still is simply not there).
- Either mode ships exactly ONE notification per sensor event — never N.
- A sensor linked to exactly one camera ships that camera's plain snapshot
  today's way, in both modes; the field is meaningless on a rule whose
  subject is not a sensor.
- "Cameras that link the sensor" ignores the tracked-events opt-in — ALL
  linked cameras, not just the ones that opted the sensor into their
  timeline. Offline, sleeping, and disabled cameras are excluded from the
  capture set and logged per camera with a reason; timeline rows and markers
  are untouched and keep honouring the opt-in.

**The default is applied in the addon's code
(`linkedCameraMode(media) = media.linkedCameras ?? 'mosaic'`), deliberately
NOT a Zod `.default()`.** `NcMediaPolicySchema` is used both directly and
through `NcRuleInputSchema.partial()` (`NcRulePatchSchema`, documented on that
schema): a `.default()` on a field inside a schema that is itself
`.partial()`-wrapped still runs on every parse of that inner object, so a
PARTIAL patch that sends `media: { attach: 'best' }` to change one unrelated
field would materialise `linkedCameras: 'mosaic'` onto the stored rule even
though the operator never touched that setting — indistinguishable from
having chosen it explicitly, and impossible to tell apart from a rule an
older client saved before this field existed. Absence must stay absence.

**How the addon honours it** (each is part of the rule, not an
implementation detail):

- **Camera set.** `LinkedCamerasCache.allCamerasFor` (beside the opt-in
  respecting `camerasFor`) returns every camera whose linked devices contain
  the sensor; `resolveLinkedMediaCameras` orders it self first, then link
  order. The first camera in that order is the PRIMARY camera.
- **Exclusion source.** First the Notification Center's own
  `NcDeviceDirectory`: `online === false` excludes with no call at all. Then
  the snapshot wrapper's capture-free `getDebugState`: `state.reason` in
  `disabled | offline | sleeping | unreachable | waking` excludes. A debug read
  that FAILS does not exclude (D49) — the camera is dialled and its line says
  the state was unknown. Every exclusion is logged with
  `tags: { deviceId: cameraId }` and its reason.
- **Stale frames.** After the captures settle, ONE cache-only
  `getSnapshotOverview({ deviceIds })` read gives each landed camera's
  `lastCapturedAt`; a tile captured more than
  `SENSOR_LINKED_MAX_FRAME_AGE_MS` (10 s, the mains snapshot cache's max age)
  before the event is dropped with reason `stale`. The overview can race a
  cache entry replaced in the milliseconds between the two calls, which only
  ever makes a frame look NEWER than it was — accepted. An overview read that
  fails keeps every tile (D49) and logs `freshness unverified` once, tagged
  with the sensor.
- **Tile count.** Zero surviving tiles ⇒ a text-only notification; one ⇒ that
  camera's plain still; two or more ⇒ the mosaic (or the per-camera stills in
  `each`). `getSnapshot` is never called with `force` — it would wake battery
  cameras.
- **No second capture.** The shelf (`NcLinkedStillShelf`) and the sensor
  marker materializer both call `getSnapshot` within the same second; the
  wrapper answers the second from its ≤10 s cache, so the camera is
  photographed once. Marker bytes are NOT plumbed into the Notification
  Center to save that cache hit.
- **AI.** The narration pass reads the RAW tiles (as D154 does for digests).
  The confirm gate keeps its single-image contract and judges the image that
  ships — the mosaic in `mosaic` mode.
- **One evaluation, one cooldown.** A sensor event is evaluated ONCE, at the
  sensor level, carrying every linked camera id — not once per camera row.
  The subject's `deviceId` is the primary camera, so a `rule-device` cooldown
  is keyed by the primary camera.
- **Matching = the sensor + the row cameras.** The linked cameras widen the
  MEDIA only. A device-scoped rule matches the sensor or a camera that took a
  timeline row for the change (`rowCameraIds`, not muted) — exactly the rules
  the per-camera rows matched (D630 §6). The primary matches only when it is
  one of them.
- **Mutes reach as far as they did per row (D62).** A muted sensor drops the
  event; a change that took rows where EVERY row camera is muted is dropped
  too; otherwise a muted camera loses only its tile (and is never dialled).
- **Capture only for a rule that could fire on this kind.** The capture gate
  reads the rule mirror: media wanted, scope as above, `sensorKinds` including
  the event's kind, no `occupancy` condition. Coarse only toward over-capture.
- **Only an evaluated change is a set.** The media cameras are resolved only
  when the ingest evaluates the change (`dropReason` null or `no-camera`); a
  camera's own `motion` no camera opted in stays a drop. A camera LINKING
  another camera forms a set like any sensor: a camera's own `motion` opted
  in by one of two or more linking cameras notifies once, with their tiles.

## Consequences

- **`rule-device` evaluation changes shape.** Because the addon
  moves from one `onSensorEventPersisted` per linked camera to ONE
  sensor-level evaluation carrying every linked camera id, a sensor rule that used to
  produce N notifications produces one. This is the intended behaviour change
  this rule exists for, not a regression to guard against — but it means a
  rule authored under today's fan-out semantics (e.g. relying on N separate
  cooldown windows, one per camera) collapses to a single window keyed by the
  primary camera once the addon deploy is live.
- **A camera linked but not opted in is now PHOTOGRAPHED — and nothing
  more.** Because `allCamerasFor` ignores `producesTrackedEvents`, a camera
  that links a sensor purely for live-view convenience is included in the
  sensor's notification mosaic/set. It does not make its own rules fire (it
  took no row), and it does not lift a mute: with every row camera muted the
  event stays dropped. This is the reason `allCamerasFor` is a sibling of the
  opt-in-respecting `camerasFor`/`resolveSensorEventCameras` rather than a
  flag on it.
- **`invalidate()` on link edits stays unwired.** Nothing in `system/src`
  emits an event when a device's `_linkedDeviceIds` changes
  (`DeviceSettingsUpdated` has no emitter; `DeviceMetaChanged` covers only
  name/location/disabled), so `LinkedCamerasCache`'s TTL is the only thing
  that notices a link edit, same as today's `camerasFor`. Adding an emitter is
  a framework change out of scope here; recorded in
  (planning repo: sessions/sessions.md) when the viewer editor gains the field. <!-- drift-ok: moved to the private planning repo -->
- **The editor carry risk is CLOSED** (see Enforcement): both editors author
  the field for sensor rules and no longer drop it on save.
- **Record identity.** When the primary camera took no row, the evaluation's
  record is another camera's row with `deviceId` rewritten to the primary, or a
  fresh `pa-sensor-<uuid>` that names no stored row. A deep link built from
  `(deviceId, recordId)` of such a notification may not resolve.

## Enforcement

Nothing generated. `npx tsc -p packages/types --noEmit` catches a caller that
constructs an `NcMediaPolicy` with an invalid `linkedCameras` value at compile
time; `NcMediaPolicySchema.parse` catches it at runtime on both sides of the
wire. The editor carry-through risk (now closed) had no guard — review only, until
`buildRuleInput` (admin) and `pruneMediaPolicy` (viewer) carry the field
through each editor's form state and rebuild logic.

**Closed 2026-09-25 (plan tasks 9–10).** Both editors now author the field,
sensor rules only: the admin form's `mediaLinkedCameras` written by
`buildRuleInput` under `kind === 'sensor'` (pinned in
`notification-rules.helpers.spec.ts`, "media.linkedCameras in the admin
editor"), and the viewer's `pruneMediaPolicy` gated by
`NcMediaKindGate.carriesLinkedCameras` (`rule-editor.spec.ts`, "media.linkedCameras
is a SENSOR rule's knob"). Each gate was removed once and its spec went red.
