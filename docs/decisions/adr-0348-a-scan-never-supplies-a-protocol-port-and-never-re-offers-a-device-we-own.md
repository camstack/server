---
id: D348
title: A scan never supplies a protocol port, and never re-offers a device we already own
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/reolink-discovery-map.ts
  - packages/addon-provider-reolink/src/reolink-discovery-map.ts
  - packages/addon-provider-reolink/src/hub-channel-reconcile.ts
  - packages/types/src/capabilities/device-provider.cap.ts
---

## Context

An operator ran a network scan from the Reolink plugin and re-added a Home Hub
that was already onboarded. Four hours later the hub, its two working cameras and
a third camera were all offline.

Three separate defects stacked, and each of them was individually invisible.

**The scan wrote the wrong port.** `mapReolinkDiscoveryToCandidates` carried the
discovered `httpPort` into `prefilledConfig.port`. `port` in
`reolinkCameraSchema` is the BAICHUAN port (`z.number().default(9000)`, and the
`.describe()` says so); `httpPort` is the HTTP/ONVIF listener. On a Reolink Home
Hub those are 9000 and 8000. Every Baichuan login then dialled the ONVIF
listener, which accepts the TCP connection and closes it: `Baichuan socket
closed`, 316 times in 12 hours. The unit test asserted `port: 8000` — the suite
was green on the bug for as long as it existed.

Nothing in the diagnosis was ambiguous once measured, and each cheap measurement
killed a plausible theory: the HTTP API accepted the stored credentials and
issued a token (not a password problem, not a lockout); the live `GetDevInfo`
firmware matched the stored one byte for byte (not a firmware update); ports
8000, 80 and 554 were all open from the container (not the network). The
device's own `GetNetPort` reported `onvifPort: 8000, mediaPort: 9000`, and the
two child cameras — which copy the hub's credentials at adoption and had not been
re-added — still carried `port: 9000`. They were a photograph of the correct
config.

**The scan offered a device we already owned.** Reolink candidates are keyed
`host-<slug>`, while an adopted device is keyed `mac-<mac>` (learned at adopt
time). No stableId comparison could ever match, so an owned device always looked
addable, and nothing anywhere in the stack expressed "already added" — the wizard
only ever looked candidates up by stableId. The docblock had recorded the gap as
a known limitation for as long as the file existed.

**A child that lost its config could never come back.** The third camera's
persisted blob was empty. `adoptDiscoveredChild` copies
`host`/`port`/`username`/`password`/`transport` down from the hub at adoption and
nothing ever re-applies them, so `reolinkCameraSchema` rejected the blob on
`host` and `password` — fields a hub-adopted child never dials, because
`ReolinkCamera` with a parent uses `parent.api`. It burned all four bounded
restore attempts (D347) on fields it would not have used. And with no `channel`,
`loadAdoptedChildrenByChannel` could not see it: it rendered as available for
adoption — one click from being adopted a second time — while `routeSimpleEvent`
dropped every push for its slot.

## Decision

**A scan reports what it found; it never supplies a protocol port.** A discovered
HTTP/ONVIF port is not evidence about any other protocol's port. A non-default
Baichuan port is an operator edit, never a scan result — the schema default is
the only value a scan may leave in place.

**A provider that can recognise its own devices says so, and a recognised
candidate is never selectable.** `DiscoveryCandidate` carries
`alreadyOnboarded` / `onboardedDeviceId` / `onboardedName`, matched by UID first
(it survives a DHCP move) and host second. Absent means "not recognised", NOT
"known to be new" — a provider that cannot tell simply never sets it. The
candidate is still SHOWN, named and disabled: hiding it answers "where is my
camera?" with silence.

**A child inherits from its parent at every restore, not only at adoption.**
`BaseDeviceProvider.healSavedConfig` runs against the persisted blob immediately
before `create()`, because a restored device self-hydrates from the DB and a blob
the schema rejects fails forever with nothing revisiting it. Only ABSENT fields
are filled, so a child that deliberately differs keeps what it has.

**The hub is the authority on which slot a UID occupies.** After a successful
discovery refresh, adopted children are matched to the hub's channel list by
IDENTITY (`stableId` carries the UID) and a drifted or missing `channel` is
repaired. Identity survives a channel move; the channel does not.

## Consequences

Any field a provider sets on a `DiscoveryCandidate` must be listed in
`discoverDevices`' projection in `device-queries.ts`, which rebuilds the object
field by field. `alreadyOnboarded` was invisible to the operator for exactly as
long as that projection dropped it.

The reconciliation repairs, it never adopts: a discovered channel with no adopted
child is skipped, and a child that is not live is left to its next successful
restore.

The channel this incident turned on was **3**, not the "next free" 2 — channel 2
was empty. Deriving a channel from sibling numbering would have bound a camera to
an empty slot under the right name, which is worse than the outage it replaced.
