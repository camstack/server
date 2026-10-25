---
name: getenc-wake-burst-asymmetry
description: Why Baichuan GetEnc (cmd56) times out on camstack but is answered for plugin catalog on the same Reolink battery doorbell — root cause = how each consumer DRIVES the socket, not the lib.
metadata:
  type: project
---

# GetEnc (cmd56) timeout asymmetry: camstack vs plugin catalog

Same lib `@apocaliss92/nodelink-js` v0.4.33 (byte-identical dist) in both. The asymmetry is in the CONSUMER, not the lib.

## Lib facts (identical for both)
- `BaichuanClient.sendFrame` (src/client/BaichuanClient.ts:2932) does NOT serialize writes — `writeWire(wire)` (2596/2601) fires immediately after registering the `cmdId:msgNum` pending entry. No global send queue (only CoverPreview + snapshot have special serialization). A burst of concurrent `sendFrame` calls = N concurrent writes.
- Transport BCUDP (`src/bcudp/BcUdpStream.ts`) is a single reliable byte-stream: one monotonic `sendPacketId` (write, 1567) shared across ALL commands; receive reassembles ONLY contiguous packets (`flushReceived`, 1376). getEnc reply spans multiple data packets (full Compression XML for main/sub/third). ACK bitmap window capped at 200 bytes (buildAckPayload, 1245) to avoid camera disconnects.
- `getEnc`/`getStreamMetadata` = cmd56 (chunk-OZL6C2YJ.js:14830, getEncXml). `getStreamInfoList` = cmd146 (21180). Standalone GetEnc in `buildVideoStreamOptions` is NOT wrapped in try/catch.

## camstack (FAILS)
- `onWakeTransition` (reolink-camera.ts:4434) → `Promise.allSettled([alignAuxDevicesState('wake'), refreshParentSettingsSnapshot()])`.
- `alignAuxDevicesState` (4251) fires ALL accessory refreshes CONCURRENTLY (`Promise.allSettled` over promises[], 4275-4298): PIR getPirInfo + floodlight (getWhiteLedState + getFloodlightOnMotion, 2 concurrent, floodlight.ts:124) + siren getSirenOnMotion + parent-settings(N).
- PLUS stream-params cap re-fires `getEnc` (cmd56) on a 10s-stale bridge (registerStreamParamsCap, 2578-2583, staleMs 10_000).
- PLUS `buildStreamCatalog` (3630) calls `wakeUp(waitAfterWakeMs:2500)` then `buildVideoStreamOptions` (→ getNetPort cmd37 + getEnc cmd56) on broker reconcile — cold, right after a bare wake.
- Net: a BURST of ~6+ concurrent commands (incl. heavy multi-packet getEnc) on one BCUDP byte-stream at each ~14s wake window, racing the firmware encoder cold-start and the 30s idle_disconnect. The heavy getEnc reply gets starved/delayed past its 10s timeout → `Baichuan timeout cmdId=56`.

## plugin catalog (WORKS)
- On `awake` (`updateSleepingState`, camera.ts:3946-3969) does NOTHING proactive — only flips `this.sleeping=false` (explicit comment 3947-3958: a wake fan-out wakes the cam MORE than the original flicker).
- `alignAuxDevicesState` (3102) is FULLY SEQUENTIAL — each `await api.getX()` completes before the next.
- `getVideoStreamOptions` (3333) CACHES (`cachedVideoStreamOptions`, 3336) + single-flights (`fetchingStreamsPromise`, 3341). GetEnc runs ONCE at init (3905, sequential after ensureClient/updateDeviceInfo/alignAux) and on real stream requests — NEVER on a periodic poll.
- `batteryUpdateTimer` default 10 min (NOT 30s), awake-path = battery→alignAux→snapshot, all sequential, NO getEnc.

## Ranked root cause
1. **Concurrency.** camstack fans out a concurrent command burst on one un-serialized BCUDP socket at each wake; plugin catalog is sequential everywhere. Heavy multi-packet getEnc reply is starved.
2. **Eager + repeated getEnc.** camstack re-runs getEnc on broker reconcile + 10s-stale stream-params bridge; plugin catalog caches getVideoStreamOptions and never re-fires getEnc on a timer.
3. **Cold getEnc right after bare wake.** buildStreamCatalog does wakeUp(2500ms)+immediate getEnc, racing encoder cold-start; plugin catalog reads encoder config only at init/real-stream when warm.

## Fix options for camstack
- Serialize the wake fan-out: chain aux refreshes + getEnc sequentially (port plugin catalog's sequential alignAuxDevicesState) instead of Promise.allSettled.
- Cache the stream catalog / stream-params getEnc result (encoder config is profile-stable) — fetch once, don't re-fire on every reconcile/10s-stale query. Mirror plugin catalog's cachedVideoStreamOptions + single-flight.
- Defer getEnc to a real stream DESCRIBE (lib's BaichuanRtspServer lazyMetadata path, chunk:6053, wraps getEnc in try/catch) instead of eagerly in buildVideoStreamOptions on a poll.
- Optionally add a global per-socket send-serialization queue in the lib's BaichuanClient.sendFrame so bursts don't collide on UDP.
