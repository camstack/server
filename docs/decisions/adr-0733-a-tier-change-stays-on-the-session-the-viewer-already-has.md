---
id: D733
title: A live tier change stays on the session the viewer already has — the probe goes to that session, and the track moves to the new rendition on its keyframe
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/webrtc/in-place-tier-switch.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/broker-webrtc-server.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/session.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/adaptive-controller.ts
  - packages/addon-pipeline/src/stream-broker/recorded/timeline-session.ts
  - packages/types/src/capabilities/webrtc-session.cap.ts
  - packages/ui-library/src/composites/adaptive-downlink.ts
  - packages/ui-library/src/composites/camera-stream-player.tsx
  - packages/ui-library/src/hooks/use-device-webrtc.ts
---

## Context

Every adaptive live open built TWO WebRTC sessions. The cold start lands on the
smallest rung on purpose (first picture fast), and the downlink probe can only
run after that session's first decoded frame (D635). The player then answered
its own probe with a second, make-before-break session carrying
`downlinkMbps`. Every move of the server ladder was the same shape again: a
close-and-recreate re-offer (D42's "tier change = close + recreate"), a new
PeerConnection under the same id, a new TimelineSession.

Measured on the hub before this record (Loki, 48 h to 2026-10-07 00:30):

- 31 of 38 adaptive cold starts (`reason: default-low`) were followed by a
  probe-climb session (`reason: downlink`), 0.33–8.3 s later (p50 0.86 s).
- From the viewer's own `webrtc-timing` lines: 37 of 57 app opens were two
  sessions. Open → first frame p50 561 ms (p10 319, p90 5 365); open → the HIGH
  picture p50 1 524 ms (p10 959, p90 4 071); the climb session's own
  first-frame p50 393 ms — ICE + DTLS + a fresh pipeline paid a second time for
  a camera the viewer was already watching.

The track was never the obstacle. D42 already moves it between live, recorded
and scrub with an RTP rebase, and `onSourceRestarted` already recovers a
re-dial — a new SSRC, new sequence/timestamp base and new parameter sets — in
place, by replaying the broker's GOP from its keyframe. Moving the track from
one RTP rendition of a camera to another is the same operation with a
different broker behind it.

Options weighed:

- **A. In-place source switch** on the same session: rebind the broker
  subscriptions, rebase RTP, replay the new rendition's GOP from its keyframe;
  fall back to the re-offer only when the negotiated codec cannot carry it.
- **B. Server-side re-offer on the same session id** (renegotiation of the
  same PeerConnection). Rejected: werift renegotiation of an established PC is
  not proven anywhere in this repo, and it still costs a signaling round trip,
  a poll interval and a decoder reconfiguration — for nothing A does not do,
  since the codec does not change in the cases A accepts.
- **C. Simulcast-style selection** (every rendition on its own SSRC, the
  server picks). Rejected: the browser receives one track per m-line; carrying
  several renditions means several transceivers and an SDP the native viewer
  and Alexa/HomeKit callers do not make, to buy what A already buys.
- **Server ladder only** (stop the client climb, let telemetry carry the
  probe). Rejected: telemetry is device-scoped and absent on the admin-ui
  panel, is ignored when two adaptive sessions share a camera (D635 I2), and
  climbs one rung per healthy streak (4 s, then 12 s) — high would arrive tens
  of seconds later than the probe said it could.

## Decision

**A tier change stays on the session the viewer already has whenever the
negotiated session carries the new rendition as it is; only a change it
cannot carry is a re-offer, and that re-offer is logged with its reason.**

- **The probe goes to its session.** The player hands the reading to
  `webrtcSession.applyDownlinkProbe({ sessionId, downlinkMbps })`. The client
  sends a measurement, never a tier; the broker picks with the same
  `pickAdaptiveTier` an offer's hints get, against the viewport the offer
  carried (a tile still ceilings to `low`). A probe only raises the rung. Any
  answer — `switching` or `held` (`not-adaptive`, `pinned`, `already-there`,
  `recorded`, `no-session`) — ends the client's part; only a hub that does not
  know the method leaves the player its legacy second session.
- **In place** (`in-place-tier-switch.ts`): allowed for a passthrough
  source-RTP session whose target rendition has the same codec, decodes under
  the client's offered H.264 profiles without a Baseline transcode, has the
  same audio codec, and can host the session's Opus egress. The target broker
  is subscribed make-before-break while the old one keeps feeding, and the
  switch COMMITS on the first packet whose broker pre-buffer holds a GOP from a
  keyframe: all subscriptions move in one synchronous step,
  `switchLiveSource` rebases RTP and replays that GOP, the MTU returns to the
  default, the TimelineSession is kept and told the new `liveProfile`.
- **Fallback, by name** (`adaptive: tier switch needs a re-offer — cannot stay
  on the session`, `reason`): `recorded`, `transcode-down`,
  `not-rtp-passthrough`, `transcode`, `tier-unavailable`, `target-not-rtp`,
  `codec-differs` (camera 106: main H.265, sub H.264),
  `target-needs-transcode`, `audio-codec-differs`, `opus-egress-unsupported`,
  and `target-no-keyframe` after 8 s without a switchable keyframe — during
  which the old rendition kept the picture moving.
- **A rung that is not served** (`mid` on a two-stream camera) lands where the
  re-offer always landed it, on the rung the broker resolves to; the ladder
  `settleOn`s that rung instead of being rebuilt.

This amends D42's "a tier switch is a close-and-recreate re-offer" and D635's
"a failed try costs one re-offer up and one down" for every switch that stays
in place; D635's delivery judgement is unchanged.

## Consequences

- One session per adaptive live open on an H.264→H.264 or H.265→H.265 ladder,
  and no new PeerConnection for any ladder move it accepts. A recorded pointer
  is never disposed by a tier change that stayed in place (the TimelineSession
  survives).
- Time to the high picture loses the second session's setup (p50 393 ms of
  its own first frame, plus signaling). A warm target commits on its next
  packet; a cold one waits for its dial and first IDR while the old rendition
  stays on screen.
- The probe climb now jumps straight to the probed rung inside the session;
  the ladder after it is unchanged. `settleOn` keeps the measured-failure
  memory and counts no promotion, exactly as the controller a re-offer used to
  build.
- The negotiated H.264 fmtp is always `42e01f` (`session.ts`), so a Main/High
  rung was already passing through under it; the in-place switch adds no new
  profile exposure. The client-offer profile check still refuses a rung a
  Baseline-only client cannot decode.
- The mid-session GOP replay is the same one `goLive` (D42) and a source
  re-dial already perform on a live track.
- Deploy order: the stream-broker addon (`addon-pipeline`) with the framework
  that routes `applyDownlinkProbe` (a published `@camstack/server`), THEN the
  player (ui-library in that same server for the admin UI; the viewer's embed
  build for the app). A new player on an old hub keeps the legacy climb; an old
  player on a new hub keeps opening its second session, now the last one
  (ladder moves stay in place).
- Measured AFTER on the hub: to be appended once deployed — the session count
  per open and open → high, from the same two queries.

## Enforcement

Tests, each disarmed once and seen red:
- `one-session-per-live-open.spec.ts` (server, real brokers' RTP + pre-buffer,
  mocked werift session): a fat probe keeps one session and no re-offer; the
  old rendition feeds until the new keyframe and the switch replays from it;
  a ladder demotion on a two-stream camera lands on `low` in place; codec
  differs → re-offer with `codec-differs`; no keyframe → old picture, then
  re-offer with `target-no-keyframe`; pinned, profile-target (remote) and
  tile sessions hold. Replacing the in-place call with the re-offer turns 5
  red; removing the pre-buffer gate turns the no-frozen-frame case red.
- `in-place-tier-switch.spec.ts`: every refusal by name; commit only on a
  keyframe; one subscription; warm-up released after commit; timeout.
- `session-source-restart.spec.ts`: `switchLiveSource` rebases, replays the
  new bootstrap, re-seeds, resets the MTU.
- ui-library `adaptive-downlink.spec.ts`: a `held` answer is an answer; only
  no wiring / no session / a failed call falls back.
- Logs: `adaptive: tier switched in place — same session, same connection`
  and the fallback line above; a fallback rate that grows reopens this record.
