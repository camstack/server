---
id: D904
title: A Reolink camera that cannot be reached for two minutes is offline
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/reachability-offline.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
---

## Context

A standalone Reolink camera went offline ONLY on the firmware's own `offline`
push. The comment in `handleSimpleEvent` called that deliberate: socket close,
reconnect and RFC 4571 idle teardown must leave online state alone, because a
socket blip is not an outage and a battery camera that drops its socket is
asleep, not gone (D173).

On 2026-10-22 camera 108 (mains-powered) lost power from 11:13 to 13:28 UTC. A
camera without power sends no push. The keepalive declared the socket dead at
11:13:22, every login after it answered `connect EHOSTUNREACH`, and the
camera stayed `online` for 2 h 15 m. Only the stream-level `stream-offline`
and the recorder's stall alarm said anything. The operator's decision: if the
socket is not reachable, offline must happen.

## Decision

On a mains camera that dials its own socket (not a battery camera, not a hub
child), a lost control socket or a login that fails at the NETWORK level
(`EHOSTUNREACH`, `ECONNREFUSED`, a timeout, and the like) opens a 2-minute
window (`REACHABILITY_OFFLINE_WINDOW_MS`). Any success inside it closes the
window and nothing is said. When it ends with no success, one fresh login
probe runs; only its failure marks the camera offline, through the normal
`DeviceOffline` (`reason: 'unreachable'`), once. While offline, the camera is
probed every 30 s, and the first successful login (that probe, or any demand's)
marks it online again through `DeviceOnline` (`reason: 'reachable-again'`),
once. A firmware push still wins at once and resets this verdict. An answer
from the camera (bad credentials, a rejected command) proves it is there and
never counts toward offline.

Two minutes: longer than a camera reboot after a firmware update or a settings
write (60 to 90 s on this fleet), a Wi-Fi roam or a switch port renegotiating,
and several turns of the reconnect back-off (capped at 30 s); shorter than the
recorder's stall alarm, which must not be the first thing to speak.

## Consequences

- One failed probe still never flips the camera (D49): two observations a
  window apart must agree before the destructive verdict.
- A mains camera that is offline costs one login attempt every 30 s.
- Battery cameras are untouched: probing one would be the wake D173 forbids.
- Hub children are untouched: the Hub owns their socket and their online flag.

## Enforcement

`packages/addon-provider-reolink/src/__tests__/reachability-offline.spec.ts`
(the window, the confirmation probe, offline once, recovery once, the push
reset) and `reachability-offline-camera.spec.ts` (the camera's wiring and the
push path) — fake timers, no network.
