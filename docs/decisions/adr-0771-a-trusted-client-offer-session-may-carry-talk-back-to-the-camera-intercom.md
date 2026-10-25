---
id: D771
title: A trusted client-offer WebRTC session may carry talk-back to the camera through the intercom push-talk triple, and the hub strips the flag from every browser call
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/webrtc/talkback-bridge.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/session.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/broker-webrtc-server.ts
  - packages/types/src/capabilities/webrtc-session.cap.ts
  - server/backend/src/api/trpc/trpc.router.ts
  - packages/addon-export-alexa/src/handlers/rtc-session.ts
---

## Context

The Alexa export declared `isFullDuplexAudioSupported: true` on every camera
with the `intercom` cap, and nothing carried the Echo's microphone anywhere.
The broker's client-offer path (`AdaptiveSession.handleOffer`, the one
`webrtcSession.handleOffer` uses) forced audio to `sendonly`, so the answer
quietly downgraded the Echo's `sendrecv` offer. A half-built hook existed
(`AdaptiveSession` option `intercom.onAudioReceived`) but only the server-offer
path read it, it labelled every packet Opus whatever was negotiated, and
nothing in the repo ever passed it. Declaring a capability that does nothing
is the D50 anti-pattern.

HomeKit already relays its return audio through the `intercom` cap's push-talk
triple (`startTalkSession` / `pushTalkAudio` / `endTalkSession`); the Reolink
and Hikvision providers decode Opus at 48 kHz and resample for the camera there.

Two alternatives were rejected. Inferring talk-back from the offer alone (a
`sendrecv` audio m-line on an intercom camera) would let any browser — including
a share-token viewer without the share's `talk` flag — reach the speaker through
`webrtcSession`. Keying on `consumerAttribution.kind === 'alexa'` trusts a field
the browser sends itself.

## Decision

- `webrtcSession.handleOffer` takes `talkback?: boolean`. When true and the
  offer lets the peer send audio, the broker answers audio `sendrecv` and relays
  every inbound frame to the device's intercom through the push-talk triple
  (`TalkbackBridge`): opened lazily on the first frame with sound (Opus DTX
  frames never open it), pushed in order, retried on failure, ended once when
  the session closes. The codec of each packet is read from the negotiated
  payload type, never assumed.
- The hub strips `talkback` from every request-bound `handleOffer`, as it
  overwrites `relayOnly`. Only a mesh-originated caller can set it.
- The Alexa export sets it only for a camera with `intercom` and a linked user
  who may CONTROL that camera (D767); a view-only user's camera is discovered
  with `isFullDuplexAudioSupported: false`.

## Consequences

- Every other viewer's session is unchanged: `sendonly` audio, no bridge.
- A browser intercom session (`intercom.startSession`) and an Echo talk-back on
  the same camera contend for the camera's talk channel; the provider decides.
- Frames travel as base64 over the existing `pushTalkAudio` (about 50/s), the
  same load HomeKit already puts on it.

## Enforcement

`talkback-bridge.spec.ts` (bridge behaviour, offer parsing, the werift answer
direction through the same helpers the session calls, codec mapping),
`device-scoped-providers.spec.ts` (the flag reaches the server),
`webrtc-session-ua-enrich.spec.ts` (stripped on a request-bound call, kept on a
mesh call) and `rtc-talkback.spec.ts` (the Alexa decision).
