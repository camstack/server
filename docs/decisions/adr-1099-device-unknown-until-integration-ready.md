---
id: D1099
title: A device is unknown until its integration is ready; offline is concluded only after
status: proposed
date: 2026-11-24
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/state-refresh-scheduler.ts
  - packages/system/src/builtins/device-manager/state-refresh-wiring.ts
  - packages/system/src/builtins/device-manager/device-state-mirror.ts
  - packages/types/src/capabilities/device-status.cap.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
---

## Context

When an integration (a device provider addon) restarts, its devices were
reported offline in a storm — status flips, `device-offline` notifications —
although they never went offline: the provider had not re-read them yet.

The traced path:

- A driver decides a device's liveness: `BaseDevice.markOnline(false)`
  (`packages/types/src/device/base-device.ts`) writes the `device-status` slice
  (`online`, `lastChangedAt`). A device is seeded `online: true` at construction
  and a provider flips a whole integration's devices offline when its link is
  not up (for example `setIntegrationDevicesOnline` in the UniFi provider).
- The slice reaches the hub through `setCapSlice` into
  `DeviceStateMirror.applySingleCapUpdate`, which emits `device.state-changed`.
- The notification centre turns that slice into `device-offline` / `device-online`
  (`incomingFromSystemEvent` -> `deviceLiveness`, `event-intake.ts`), the ledger
  records the flip and `DeviceLivenessHoldoff` (15 s, `liveness-holdoff.ts`)
  swallows a bounce shorter than the window.
- WHEN a migrated provider re-reads a device is the core's (D1062): the
  `StateRefreshScheduler` in the hub's device-manager, per integration group.

The 15 s hold-off swallows a flap only when the provider comes back inside it.
A restart where the first read takes longer than 15 s still announces offline.
Nothing in the pipeline could say "not yet known".

## Decision

1. `DeviceStatus` carries an explicit `unknown: true` marker: the provider has
   not answered since the (re)start and `online` is a placeholder, not a fact.
   Absent means answered.
2. Offline is concluded only once the integration is READY. The scheduler owns
   readiness: an integration group is ready once its first read after
   registration SETTLED (succeeded, or failed — a failed first read is an
   answer: the integration is unreachable). No timer waits for it (D3).
3. The mirror gates `device-status` writes of a device whose integration is not
   ready: an `online: false` write is held back (the slice keeps its last
   `online`, marked `unknown`), remembered, and LOGGED with its reason and
   `tags: { deviceId }` (D391). When the group becomes ready the held offline is
   applied through the normal path, so the notification centre's 15 s hold-off
   still applies on top. An `online: true` write before ready is an answer and
   clears the hold.
4. Readiness is in-memory hub state read by the mirror on every write
   (`isAwaitingFirstRead`) and pushed by the scheduler in-process; it is never
   an event, so a lost event cannot strand a device (D8, D11, D49). A
   `reconcileReadiness()` pass releases anything the push missed.
5. The notification centre ignores a `device-status` slice marked `unknown`: it
   is not a liveness claim.

## Consequences

- The gate is per INTEGRATION as well as per device. Homematic, Home Assistant
  and UniFi register their policy once, on the gateway/broker cap
  (`integrationId` = the integration id); their child devices carry none. The
  device-manager reads each device's `integrationId` from its row (or its
  parent's) when its first `device-status` write arrives, and the mirror treats
  the device as awaiting while the scheduler group `addonId::integrationId` has
  a device that has not had its first read settle. No new registry or lookup.
- A device of an integration with no `device-state-refresh` policy at all has no
  scheduler group and is not gated (unchanged behaviour).
- A device whose integration is down for real stays `unknown` until the first
  read settles — at most one declared refresh interval after registration —
  and is then offline plus the 15 s hold-off.
- A later adoption under a running integration gates only ITSELF: an
  integration is gated once, when it (re)appears (hub boot, or its runner came
  back with no settled entries), and never again for a device added to it.
- The `unknown` slice is persisted like any `device-status` slice (restored at
  boot as the last known `online` plus the marker); the next answer replaces it.
- A legacy row with no `meta.integrationId` on itself or its parent stays
  ungated (it has no integration to wait for).
- With no prior reading, a held offline writes NO slice (no invented
  `online: true`); the device reads as unreported until the first read settles.
- `unknown` is a new optional field of a capability schema: a framework change
  (server closure), and consumers that render reachability (UI, exports) must
  learn to show it; the admin UI is not changed by this record.

- **Full-push integrations are gated too** (planning#690, the 07:18Z restart of
  ~45 Home Assistant devices). A `push: 'full'` device is never read, so it
  awaits from registration until its FIRST state report (a cap the
  provider's own state path writes: never the named `FRAMEWORK_STATE_CAPS`,
  i.e. `device-status`, the `feature-probe` seed / `onProbe` stamp and
  `device-admin-link`, which the framework writes at activation) — that device alone settles — or until
  `FULL_PUSH_FIRST_REPORT_BOUND_MS` (120 s), after which a dead integration is
  concluded offline as before. The integration stays awaiting while any of its
  devices has not settled, so a sibling's held offline is not released ahead of
  its own cache replay. The integration key is ONE source, the device's
  `meta.integrationId` (`int_0019`), for the policy (`haRefreshPolicy`) and for
  the mirror (`noteIntegration`); the broker id was a different key and the
  group never matched. A Home Assistant container reports `unknown` until its
  first child state; unknown to online is not a transition. An `unknown: true`
  slice is never held as an offline, and it is no claim of absence for any
  reader: Alexa answers connectivity `OK` (as for a failed read), the device
  hero shows no offline badge, the composer reads no value. The container's
  first `markOnline`, either way, ends `unknown`.

**Amendment (planning#710, 2026-11-25): every integration, not only full-push.**
The 09:03Z restart flipped five Gree climates (polled) offline then online 20 s
later, each notified. A polled device's FIRST READ THAT FAILED used to count as
an answer ("the integration is unreachable"); it no longer does. A device that
a scheduler schedules stays awaiting until a read ANSWERED, its first state
report (any integration mode), or the same bound (120 s, armed for every
device, not only full-push). A failed read settles nothing; a real first
offline (an answered read, or a report) is applied and notifies. A composed
(Composer) device starts `unknown` (never `offline`); the FIRST runtime of a
block after a process start holds it unknown while its sources start up (a
field not yet reported, a first read not answered, a cap not seeded), for at
most the same 120 s bound, measured from the runtime's start and decided by the
runtime's one deadline timer. A block failure or a refused write applies at
once; a rebuilt runtime (block edit) and the withdrawn-block placeholder are
offline as before. A scheduled device whose every read failed and that wrote
nothing is concluded offline once when the bound passes.
A device no scheduler schedules (no refresh policy) is not covered.

**Amendment (planning#713, 2026-11-25): one key, a stopping runner, a presumed seed.**
Three holes survived the first two amendments.
(A) The scheduler grouped a device by its policy's `integrationId` while the
mirror keyed it by the row's `meta.integrationId`; they never matched for Gree
(`gree:<mac>` against `int_0011`). The mirror now tells the scheduler the row key
(`noteIntegration` -> `noteRowIntegration`) and the device is grouped under it,
so there is ONE key; a policy that named the integration differently is logged
as a warning with `tags: { deviceId }`. Every other provider policy
(esphome, dreame, mqtt-ha: `brokerId`; wyze: account id or `wyze-<mac>`; vesync,
ecowitt: their integration id; reachability: `stableId`) is covered by the same
rule, whatever it named.
(B) A hub-initiated stop of a runner on this node (`process.stop`, `restart`,
`restartAll`, which uninstall and applyServerUpdate use) goes through one helper
that re-gates the runner's devices before the SIGTERM
(`StateRefreshPolicyRegistry.regateSource` -> scheduler `regate`): they stop
counting reports as answers and await again. When the disconnect then empties
the runner's source (`replaceSource(..., [])`) the scheduler leaves a TOMBSTONE
for the integration: the group stays awaiting and the mirror holds the late
teardown offline (a closed link -> `markOnline(false)`). The tombstone ends when
the integration registers again (normal boot gating takes over) or at the 120 s
bound (a bounded hold, the same bound as above), when the held offlines are
released through the normal path (so an uninstall resolves too). A new
registration also ends `stopping` when the old connection's close was ignored as
superseded, and a second stop of the same key re-arms a full bound. In-memory,
no event gates (D3, D49). A crash respawn is NOT gated, on purpose: a crashed
runner writes no teardown offline, and a real offline must show. Gaps: runners
hosted on an agent (their policies register in the agent process, which the hub
scheduler does not read), hub-main in-process addons, and the broker shutdown
`stopped()`. Chosen over dropping device-status writes of a runner already told
to shut down: the hub cannot tell a teardown write from a real late one, and the
held-offline path already logs and bounds it.
(C) The `BaseDevice` construction seed is a PRESUMPTION: `{ online: true,
unknown: true }`. While the integration awaits, the mirror never lets it
overwrite a prior reading (the prior `online` stays, marked `unknown`) and it
clears no held offline; `markOnline` ends `unknown` even when the value is
unchanged; once the integration is ready a slice still presumed becomes a plain
`online: true` (a driver that never calls `markOnline`, accessory children). A
device whose integration is not awaited keeps the old behaviour (plain online).

Specs: `device-unknown-restart-holes.spec.ts`, `base-device-presumed-status.spec.ts`.

## Enforcement

Specs in `packages/system/src/builtins/device-manager/__tests__/device-unknown-until-ready.spec.ts`
(restart -> unknown -> ready -> offline/online, a missed readiness push is
reconciled) and in the notification-center intake spec (an `unknown` slice is
not a liveness claim), and `device-unknown-full-push.spec.ts` (the 07:18Z
shape: offline writes then a replay 40 s later reach no consumer; a silent
integration is offline after the bound). Review only for the rest.

Specs for the amendment: `device-unknown-polled.spec.ts`, `composed-device-boot-status.spec.ts`, and the `planning#710` block of `composition-runtime.spec.ts`.
