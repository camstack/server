---
id: D762
title: The stream broker has no frame plane — it decodes nothing, and reports no decode rate, decoder node or per-device queue depth
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/capabilities/stream-broker.cap.ts
  - packages/types/src/capabilities/schemas/streaming-shared.ts
  - packages/types/src/capabilities/webrtc-session.cap.ts
  - packages/types/src/capabilities/pipeline-runner.cap.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts
  - packages/addon-pipeline/src/stream-broker/widgets/StreamBrokerPanel.tsx
  - packages/addon-pipeline-orchestrator/src/camera-status-service.ts
  - packages/addon-admin-ui/src/components/pipeline/node-load-model.ts
---

## Context

The stream broker carried a shared-memory frame plane from Phase 5 / D9:
`streamBroker.subscribeFrames` / `pullFrameHandles` / `unsubscribeFrames`, a
`FrameHandlePlane` that opened one `frameSink: 'shm'` decoder session per pixel
format through the `decoder` cap, a 6 s decoder-seed ring, and the bookkeeping
that rotated those sessions on an hwaccel change or a decoder going down.

Decoding moved to the pipeline runner's session-decode workers (2026-07-16), and
nothing called `subscribeFrames` again. The plane stayed, gated rather than
deleted, "because the cap method is a public wire surface". What it left behind
was read as measurement:

- `BrokerStats.decodeFps` (0), `decodedSubscribers` (0) and `decoderNodeId`
  (null) on every live camera. The broker panel showed "Dec: 0.0 fps" and
  "Decoder: deferred"; D758 had already found the camera card showing "26→0fps"
  from the same field.
- `webrtcSession.listStreams` carried `decodeFps`, copied from the same stat.
- The camera status read `decoderNodeId` to "upgrade" `assignment.decoderNodeId`
  to the broker's live decode node — a node that never existed.
- `RunnerLocalLoad.devices[].queueDepthTotal` was hard-coded 0 ("until the pool
  backlog gets a public accessor") and the load prospectus would have shown it
  as a queue the moment it was non-zero.

Proof the plane was dead, taken on 2026-10-08: no caller of `subscribeFrames`,
`pullFrameHandles` or `unsubscribeFrames` in `packages/**`, `server/**`,
`scripts/**` or the viewer (`camstack/` src, app and embed — the only hits are
the generated proxy/schema bundled into its embed build); the only consumers
were test mocks and two manual RTSP-relay diagnostics. On the live hub, all 46
streaming brokers returned `decodeFps: 0`, `decodedSubscribers: 0`,
`decoderNodeId: null`, every `listClients().decoded` was empty, and
`decoder.listActiveSessions` was `[]`.

## Decision

The stream broker decodes nothing and has no frame plane. The three cap methods,
their schemas, the `decoded` client channel (`listClients` / `killClient`), the
`decodeFps` / `decodedSubscribers` / `decoderNodeId` stats, the broker's
`FrameHandlePlane`, `DecoderSessionProxy`, decoder-seed ring, decoder rotation
and in-process static-decoder fallback are removed, with `decodeFps` from the
WebRTC stream choice. `assignment.decoderNodeId` is the detection node,
co-located by construction, and never read from the broker. A runner's
per-device load carries no queue depth until a real per-pool counter exists; the
pool's `inFlight` / `inFlightCap` is the device tier's pressure signal.

A field that nothing feeds is removed, not kept at 0 — the same rule as D758.

## Alternatives rejected

- **Keep the plane for an out-of-repo caller.** None exists on the fleet (the
  live hub held no decoded subscriber and no decoder session), and the fields it
  fed were actively wrong in three UIs.
- **Make the fields nullable.** "Unknown" would be permanent: the broker has
  nothing to measure, so the honest shape is no field.
- **Feed `queueDepthTotal` per device from the pool.** The inference pool has no
  per-device backlog accessor; `inFlight` already carries the signal the
  balancer uses (`isDeviceSaturated`).

## Consequences

- A client built against the old cap calling `subscribeFrames` gets a not-found
  procedure. The hub-served viewer embed bundle still contains the generated
  proxy entries until its next build; the viewer never calls them.
- An older hub validating a newer broker's `getBrokerStats` would refuse the
  missing fields; a broker and its hub ship in one `@camstack/server` release.
- The `decoder` cap's session surface (`createSession`, `pushPacket`,
  `pullFrames`, `pullHandles`, `getFrame`, …) now has no in-repo caller. Its
  removal is the "decoder `frameSink: 'shm'` mode" slice of the shm-ring roadmap
  item; `getInfo` and `reprobeHwaccel` stay in use.
- `EventCategory.PipelineAgentHwaccelChanged` lost its only subscriber (the
  rotation); it had no emitter either.

## Enforcement

`packages/types/src/capabilities/__tests__/no-broker-frame-plane.spec.ts` fails
if a frame-plane method, schema, stat, the `decoded` channel, the stream-choice
`decodeFps` or a per-device `queueDepthTotal` comes back.
`StreamBrokerPanelStats.spec.tsx` fails if the panel renders a decode rate or
decoder node, `camera-status-cap.spec.ts` if a broker-reported `decoderNodeId`
is taken as the decode placement. The method-tier guard fails on any new method
until it is recorded.
