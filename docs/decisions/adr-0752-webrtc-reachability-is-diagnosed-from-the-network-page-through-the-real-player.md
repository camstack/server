---
id: D752
title: WebRTC reachability is diagnosed from the Network page, through the real player
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/ui-library/src/composites/webrtc-diagnostics/**
  - packages/ui-library/src/composites/peer-connection-config.ts
  - packages/addon-admin-ui/src/pages/system/NetworkDiagnostics.tsx
---

## Context

The only WebRTC/TURN diagnostic lived in the Benchmark addon (a WebRTC / TURN
tab) and ran entirely in the browser: it gathered candidates per ICE server
and connected two peer connections in the same page. With policy `all` that
loopback connects host↔host every time, so it proved nothing about the path a
viewer takes to the hub. Remote "black screen" reports needed the opposite:
what the HUB offered, whether ICE, then DTLS, then RTP, then decode held, and
what the hub believed it sent — and the Benchmark addon (accelerator capacity)
was the wrong home for a network question.

## Decision

WebRTC reachability is diagnosed under **Administration → Network →
Diagnostics**, from the browser the operator is holding (desktop or phone).
"Test each endpoint" stays a browser probe per ICE URL (srflx mapping, relay
allocation, relay protocol, relay-only loopback); the same-page loopback with
policy `all` is gone. The **hub session test** opens a real session through
`CameraStreamPlayer` + `useDeviceWebrtc` on a pinned (low/sub) target, twice —
browser ICE policy `all`, then `relay` — and only LISTENS: wrapped signaling
callbacks for the hub's answer SDP and trickled candidates, `onPeerConnection`
listeners for the ICE/DTLS timeline, the player's 1 Hz `StreamDebugSample` for
the client stats and `getSessionDebug`. The verdict names the first layer that
did not hold (transport → hub DTLS → media black-hole / hub not sending →
loss or keyframe size), and a layer whose deciding number was not measured is
`unknown` (D393). The player gains `iceTransportPolicy` and `onPeerConnection`
for this and nothing else: production never sets a policy.

## Consequences

- The probes and the report live in `@camstack/ui-library`
  (`composites/webrtc-diagnostics/`), so the viewer embed can host the same
  test on a native phone without a second implementation; that needs a
  published ui-library first.
- No new server capability: the hub's own ICE self-check and a hub-side
  relay-only session are phase 2 (roadmap).
- The test opens two real sessions on the chosen camera for ~30 s.

## Enforcement

`webrtc-diagnostics-*.spec.ts` and `peer-connection-config.spec.ts` (the
config helper keeps the key absent without a policy); each was checked to fail
with its rule removed. Nothing stops a new page from forcing a policy — review
only.
