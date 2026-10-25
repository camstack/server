---
id: D289
title: Talking through a camera is OPERATE, not CONFIGURE — and a scope preset that NAMES a capability must be able to reach it
status: accepted
date: 2026-08-29
supersedes:
applies-to:
  - packages/types/src/capabilities/intercom.cap.ts
  - scripts/scope-preset-specs.ts
  - scripts/check-scope-preset-promises.ts
  - server/backend/src/api/trpc/trpc-error-device-tags.ts
---

## Context

On 2026-08-29 a non-admin viewer user tapped talk-back on a Hikvision doorbell
four times in twenty-four seconds. The app showed a generic "talk failed"
alert. The hub logged the reason, four times:

```
FORBIDDEN  intercom.startSession  principal="bob (session)"  "Admin required"
```

The call never left the hub. It did not reach `provider-hikvision`, the ISAPI
`TwoWayAudio` channel, or the camera — Loki's whole retention (~42 h) contains
zero `intercom talk session opened` lines, on any camera, for any principal.

The obvious suspect was wrong. The same day's PCM/transcode work (D281) had
replaced the intercom drop branch with a resample session, and nothing about it
was running: the hub had `provider-hikvision` 1.2.46, `provider-reolink` 1.2.61
and both decoders at 1.2.38 — the versions immediately *before* the release that
carried D281. Nor was the failure Hikvision-specific, or specific to anything:
`intercom.startSession` is refused for every camera of every provider, for every
non-admin principal, and always has been.

Every one of the six `intercom` methods carried `auth: 'admin'` from the initial
commit. That is not one gate among several — `adminProcedure` throws
`FORBIDDEN: Admin required` *before* `protectedProcedure`'s scope check runs, so
a method resolving to `'admin'` can never consult a scope grant at all. The
scope machinery generated for the cap was meanwhile complete and correct:
`METHOD_ACCESS_MAP` recorded all six as `capScope: 'device', access: 'create'`,
`METHOD_DEVICE_SELECTORS` recorded the `deviceId` field of each, `intercom` was
in `DEVICE_CAP_NAMES`. All of it dead, none of it reachable.

And the `camera-operator` scope preset had promised the opposite, in the text an
operator reads before clicking it, since that same initial commit: *"Everything
`camera-viewer` does plus PTZ control, intercom, snapshots and recording
start/stop."* The user held `device:{all}[view,create]` — that grant, or wider.
The prose was checked by nothing.

Two smaller things fell out of the investigation. The refusal lines carried
`code`, `path`, `principal` and `message` but no `deviceId`, so the first
question asked of a 30-camera fleet — "one camera or all of them?" — could not
be answered from the log. And the same guard, once written, found that
`event-listener`'s `capability:motion-detection[view]` row grants nothing:
`motion-detection` has no `view`-access method (`analyze` is `create`, `reset`
and `removeCamera` are `delete`).

## Decision

A `scope: 'device'` capability method that OPERATES a device — commands it,
reads from it, drives a live session against it — is `auth: 'protected'`, and is
gated by the scope matcher on `(device, access)`. `auth: 'admin'` is for methods
that change what the device IS: presets, credentials, cache invalidation,
adoption, removal. `intercom` has no method of the second kind, so all six are
`protected`; this is the split `ptz` already draws between `move`/`goToPreset`
and `savePreset`/`deletePreset`, and `snapshot` between `getSnapshot` and
`invalidateCache`.

A scope preset that NAMES a capability in its description declares it in
`promisedCaps`, and the build fails if no row of that preset can reach the cap.
The rows stay derived — a new device cap is still inherited by `category:device`
with no edit — only the prose claim is written down, so that the prose cannot
quietly become false.

A tRPC error line for a path that names a device carries `tags: { deviceId }`,
derived from the same codegen'd selector table the scope matcher reads.

## Consequences

A `camera-operator` (`category:device[view,create]`, or a `device` selector
grant at `create`) can now open, feed and close a talk session on the cameras
that grant covers — and only those. A `camera-viewer` (`view` only) still
cannot: talking is `create`. A grant on camera 5 cannot talk through camera 7.
A `category:system` grant, however broad, reaches nothing here.

This widens who can push audio out of a camera speaker from "admins" to "anyone
holding an operator grant on that camera". That is the intended authority and
the one the preset has always advertised, and it is the same tier that already
lets the same principal physically rotate the camera (`ptz.move`). An operator
who does not want it grants `view` only.

`camera-operator`'s description no longer claims "recording start/stop": that is
a `scope: 'system'` cap, so no `category:device` row ever reached it. The claim
was false in the same way, and correcting the text is the only honest option —
adding a `category:system` row to make it true would silently widen a preset
operators already hold.

`event-listener` keeps its inert `capability:motion-detection[view]` row and
does not promise that cap. Widening or removing a row an operator may already
hold is an operator-visible change, not a drive-by; it is recorded here so the
next person finds it deliberate rather than missed.

Nothing in this record says the Hikvision leg WORKS. It says the call now
reaches it. Whether ISAPI `TwoWayAudio` then carries audio to a given firmware
is unverified by these changes and unverifiable from logs, because no talk
session has reached a camera inside Loki's retention.

## Enforcement

`scripts/check-scope-preset-promises.ts`, wired into `.github/workflows/ci.yml`:
for each preset with `promisedCaps`, each named cap must have at least one
method whose `resolveMethodAuth` is not `'admin'` AND whose `METHOD_ACCESS_MAP`
access flavour is inside a matching row's tier. It reads the same two
authorities the runtime does, so it cannot drift from them.

`server/backend/src/api/trpc/__tests__/intercom-operator-reach.spec.ts` asserts
the per-method half the guard deliberately does not: all six methods resolve
non-admin, a `camera-operator` reaches all six, and a viewer / a wrong-camera
grant / a system-only grant / no grant reach none. Restoring `auth: 'admin'` on
any one method turns it red.

`server/backend/src/api/trpc/__tests__/trpc-error-device-tags.spec.ts` covers
the log tag, including the cases where tagging nothing is correct.
