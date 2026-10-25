---
id: D635
title: The adaptive ladder judges DELIVERY over a GOP, not an absolute rate, and says why it holds
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/webrtc/stall-tracker.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/delivery-meter.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/adaptive-controller.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/adaptive-config.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/climb-hold.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/rung-bitrate.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/climb-capacity.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/try-climb.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/rtt-stability.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/probe-evidence.ts
  - packages/ui-library/src/composites/client-network-sample.ts
  - packages/ui-library/src/composites/adaptive-downlink.ts
  - server/backend/src/api/health/adaptive-probe.routes.ts
---

## Context

Device 104 ("Camera hall") sat on `low` for every live session, and the
viewer's "Quality ladder" line said "never moved". Its `low` rung is a static
indoor sub stream: ~41 kbps between IDRs, one IDR every ~4 s. The broker's climb
gate (`StallTracker.isClimbSafe`) asked whether the client's LAST 2 s receive
rate reached an absolute 128 kbps. The client's 2 s windows alternated
~250 kbps (IDR inside) and ~40 kbps (P-frames only), so every other tick reset
the healthy clock and the 4 s streak a first promotion needs never formed. The
stall side was stuck the same way: every IDR window cleared the 64 kbps stall
before its 6 s confirm, and a rung steadily under 64 kbps with a longer GOP
would have confirmed a "stall" on a perfect picture. The floors measured the
rung's own bitrate (demand), not whether the link carried it. The browser's
REMB (430–520 kbps, 10× the rung) was in the logs and nothing read it.

The client's climb could not rescue it. `/adaptive-probe` timed a 128 KiB blob
from the REQUEST, in parallel with `createSession`, on a hub at ~80 % CPU, and
read the LAN at 1.2–1.46 Mbps. Worse, found while fixing it: the hub's global
`@fastify/compress` treats `octet-stream` as compressible, and the blob was one
repeated byte — it crossed the wire as ~1 KB of brotli. The probe had never
measured a transfer at all.

## Decision

**Delivery.** Climb and stall safety are judged on the delivery ratio — bytes
the client reported receiving ÷ bytes this session sent — each client report
aligned to the broker's send history to the nearest 100 ms. Two windows:

- the GOP window (`max(2 s, measured IDR interval)`, ≤ 16 s) judges PARTIAL
  delivery and climbs: a stall starts below 25 %, a climb needs 90 %;
- the newest single report judges a TOTAL freeze: received < 10 % of ≥ 16 kbps
  sent starts a stall at once, and a report back at ≥ 50 % clears it (the GOP
  window still holds the zeros for a few ticks and must not keep it alive).

A delivery not yet measured refuses a climb while the client IS reporting; no
telemetry at all behaves as before. A session created by a tier change counts
no client report until the change blackout (8 s) has passed — until the player
swaps onto the new PC (after its first decode, 2–5 s) its reporter reads the
old, closed PC. With more than one adaptive session of the camera on the
broker, the device-scoped client record may be another viewer's: delivery is
then unknown (no stall from it) and a try-climb is refused.

**Capacity.** Evidence for the next rung is the receiver's REMB (aged out after
30 s unchanged) and the viewer's downlink probe — carried in its telemetry
whatever it read, with its age, and on offers (dated as old as the client's
30 s cache allows). The newest probe wins. The bar is the next rung's measured
bitrate × 1.2, or the client ladder threshold (mid 2.5 Mbps, high 8 Mbps) for a
rung that has measured nothing. Either witness clearing the bar CONFIRMS a
climb — a probe only while fresh (120 s). REMB is capped by what is sent, so it
is evidence for room and never against; a probe BELOW the bar holds
(`capacity`) until a newer probe replaces it, however old it is. With no
evidence either way the ladder TRIES the rung after the healthy streak, only on
a clean path (delivery ≥ 0.95 over the full window, loss < 1 %, RTT stable,
own telemetry), and watches it for its first window (20 s; 40 s hard end):
two consecutive evaluations under 0.9 delivered, a confirmed stall or failing
loss revert it; the next try waits 30 s × 2^(n−1), capped at 10 min, and that
backoff is kept per DEVICE on the broker (10 min TTL) so a new viewer session
inherits it. A trial that lands back on its own rung is not a trial; recorded
playback restarts a running trial.

**Visibility.** Every tick that does not promote leaves a named `ClimbHold`
(`code` is an open string on the wire; known codes in
`WEBRTC_CLIMB_HOLD_CODES`), carried on `webrtcSession.getSessionDebug`, and
`adaptive: climb held` is logged on a code change, a code at most once per
60 s, tagged `{ deviceId }`. A reverted try is carried on the wire as
`stall`/`loss` with `causeDetail: 'trial-revert'`.

**Probe.** 1 MiB of random bytes, `compress: false`, timed from its first body
byte, run after the session's first decoded frame, single-flight app-wide, never
on a renegotiation (the cached value only). It requires a session (Bearer or
the session cookie, the stream data plane's check) and is rate-limited to 12
per client IP per minute.

## Consequences

- Freeze → first downgrade, measured by `sparse-rung-climb.spec.ts` on `high`
  over 4 client phases:

  | GOP | round 2 (GOP-window start) | now (newest-report start) |
  | --- | --- | --- |
  | 2 s | 7.7–9.7 s | 8–10 s |
  | 4 s | 11.7–13.7 s | 8–10 s |
  | 8 s | 11.7–13.7 s | 8–10 s |
  | 10 s | 13.7–17.7 s | 8–10 s |

  The old absolute 64 kbps floor was 8–10 s: one fully frozen report, then the
  6 s confirm. The round-2 column is the review's own simulation.
- A first version held any climb whose REMB was below the next rung × 1.2.
  REMB follows what is SENT — 430–520 kbps on a 41 kbps rung — so device 104
  would have held forever. REMB counts only FOR room.
- A failed try costs one re-offer up and one down, ≈ 18 s on the tried rung:
  the new session counts no report for the 8 s change blackout, then needs a
  covered window and two evaluations under 0.9 (review N2). The same blackout
  means a freeze that begins within 8 s of ANY tier change is demoted only at
  about T0 + 16 s. The per-device backoff reaches its 10 min cap after 5
  consecutive failures (30 → 60 → 120 → 240 → 480 → 600 s), across viewer
  sessions, within the 10 min TTL — so one cellular viewer's failed tries also
  delay a LAN viewer of the same camera that cannot probe.
- The broker keeps a device's probe for at most 10 min, and forgets it when the
  device's last adaptive session ends (review N1): a SHORT probe holds until
  replaced, and a viewer that cannot probe would otherwise inherit another
  viewer's slow reading indefinitely.
- An adaptive tick that throws is caught and logged (`adaptive: tick failed`,
  once a minute per session, `{ deviceId }`); the next tick runs normally.
- Two viewers of one camera on one broker: neither's delivery is judged, so a
  freeze on either is caught only by loss/RTCP. The proper fix is a
  session-scoped client record (`sessionId` on `reportClientStats`).
- The probe needs a SESSION credential:
  - the hub-served web viewer sends the `camstack_session` cookie only if one
    exists — an admin-ui login on that browser (`exchangeSession` reuses it);
  - the native app's `file://` embed must pass `probeAuthToken` (ui-library
    prop), a follow-up of this release;
  - a SHARE-LINK embed can never probe: share tokens are not session-grade.
  Without a credential the probe reads unknown (401) and the broker's try
  decides. The first refusal per origin is reported on `onAdaptiveHints`
  (`phase: 'probe-refused'`, `probeStatus`), which hosts forward to their log. Cost: one probe per camera open per 30 s, ≤ 1 MiB (≈ 0.8 MB at
  2.5 Mbps), about three minutes of a 41 kbps sub stream.
- Clocks: a report's age is `broker now − lastUpdated`, and `lastUpdated` is
  stamped by the HUB. On an agent the clocks must agree within seconds (NTP);
  an agent more than 10 s ahead would read every report stale and fall back to
  "no telemetry".
- The wire enums stay open or unwidened (`climbHold.code`/`tryBlockedBy`
  strings, `cause` + optional `causeDetail`): the router validates output, and a
  server built before a new value must not reject the whole debug answer.

## Enforcement

Tests, each disarmed once and seen red:
- `stall-tracker.spec.ts`: freeze on the newest report; an IDR missed at an edge
  is not a freeze; a recovered report clears it; shared telemetry is never a stall.
- `stall-through-meter.spec.ts`: a quiet 40 kbps rung is not a stall, and
  IDR-only delivery on a 1.8 Mbps rung is one — through the real meter.
- `adaptive-controller.spec.ts`: [250, 40] kbps promotes; a probe clears a
  climb despite REMB 480; a short probe holds at any age; tries, clean path,
  shared telemetry, revert, backoff, kept trial, same-rung trial, recorded
  playback restarting a trial.
- `sparse-rung-climb.spec.ts`: device 104 end to end with a real client around
  tier changes (old-PC zeros, the post-swap zero, 2.5/3.5/5 s swaps), freeze
  latency per GOP, and two sessions sharing one record.
- `adaptive-ladder-vs-recorded-pointer.spec.ts`: the broker counts sessions per
  device.
- `delivery-meter.spec.ts`, `climb-capacity.spec.ts`, `rtt-stability.spec.ts`,
  `probe-evidence.spec.ts`, `device-memory.spec.ts`.
- ui-library: `adaptive-downlink.spec.ts` (first-byte timing, first-frame
  gating, single-flight, cached-only) and `client-network-sample.spec.ts`
  (re-baseline on a PC swap, silence while renegotiating, probe in the telemetry).
- Backend: `adaptive-probe.spec.ts` (no compression, incompressible, session
  required, rate limit) and `network-quality.service.spec.ts`.
- Viewer: `status-detail-lines.spec.ts`, `stream-debug-sample.spec.ts`.

Amended by [D733](adr-0733-a-tier-change-stays-on-the-session-the-viewer-already-has.md)
(2026-10-07): the probe climb is handed to the session it was measured on
(`applyDownlinkProbe`) instead of opening a second session, and a ladder move the
session can carry stays in place — "one re-offer up and one down" applies only to
a move that falls back.
