---
id: D525
title: The mute belongs to the PLACEHOLDER, not to the path
status: accepted
date: 2026-09-17
applies-to:
  - packages/addon-pipeline/src/stream-broker/rtsp/restream-intent.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/audio/g711-silence.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/audio/sentry-audio-silence.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/join-burst-admission.ts
covers:
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-listen-server.ts
last-verified: 2026-09-23
---

## Context

The `/sentry` restream suffix is documented as "fed the last picture while the
camera sleeps, **and the real media the moment something wakes it**". Its parser
did this:

```ts
if (rest.endsWith(SENTRY_PATH_SUFFIX)) {
  return {
    lookupPath: …,
    // Video only. An `m=audio` nobody fills stalls a consumer's ffmpeg, and
    // for the hours a camera may sit in sentry nobody fills it.
    muted: true,
    declaration: declare('sentry'),
  }
}
```

The operator found it: *"il sentry è muto? Non dovrebbe! O almeno la parte di
camera deve ovviamente avere audio della camera, è muto ovviamente il prestream
in sleeping."* [is the sentry muted? It should not be! Or at least the camera part must of course have the camera's audio; the prestream in sleeping is of course muted.]

The comment was right about the HAZARD and wrong about the REMEDY. An `m=audio`
nobody fills does stall a consumer's ffmpeg. The answer is to FILL it.

What makes this more than a one-line fix is **when** the decision was taken.
`muted` is derived from a string, once, at DESCRIBE — and **RTSP cannot
renegotiate mid-session**. A sentry is defined as a dial that attaches while the
camera is asleep and STAYS attached across the wake, so the SDP it is handed at
DESCRIBE is the only one it will ever see. `muted: true` there did not mean "no
audio while asleep"; it meant "no audio, ever, on this session". The downstream
code makes that concrete: `rtsp-restreamer` builds `mutedSdp =
stripAudioFromSdp(sdp)` and the listen server serves it, so the consumer never
negotiates an audio track and can never be sent one.

Two things were tried in the trace and rejected:

- **Simply flipping `muted` to `false`.** It is not sufficient and it is not
  safe. Not sufficient, because while the camera sleeps the restreamer's full
  SDP is composed from the PLACEHOLDER frame (`rebuildSdp` in Annex-B mode) and
  has no `m=audio` either — un-muting a dial changes which empty SDP it gets.
  Not safe, because `isMuted()` was answering a second, unrelated question:
  `servePendingSessionsRtp` used it as "this consumer RE-CLOCKS on a real-time
  clock and never drains a 2-3 s catch-up burst" (`LIVE_EDGE_MAX_SPAN_MS`, the
  measured HomeKit failure at 2 996 ms). A sentry IS that shape. Flipping the
  flag alone would have silently handed every sentry a backlog it cannot drain.
- **Grafting the audio track onto the full SDP.** That announces an `m=audio`
  to every consumer, including ones this system does not fill — recreating the
  stall the original comment feared, for a wider population.

## Decision

**A SENTRY session is announced the camera's audio track and that track is
FILLED at all times** — generated silence while the camera sleeps and the
courtesy picture is being served, the camera's own RTP the instant media flows,
and never both at once. Concretely, and each clause is a rule that can be
violated:

1. **The path decides nothing about audio.** `parseRestreamPath` returns
   `muted: false` for `/sentry`. Mute is a property of what is being served, not
   of the URL that asked for it.
2. **`isMuted()` means audio and only audio.** The re-clocking join rule is a
   second predicate, `isLiveEdgeOnlyDial` / `RtspSession.isLiveEdgeOnly()`, and
   `admitJoinBurst` takes `liveEdgeOnly` instead of `muted && !detectionIntent`.
   Every population's verdict is unchanged: `/muted` yes, `/sentry` yes,
   detection no (D193), recording and plain no.
3. **A sentry gets its own SDP variant.** `RestreamSdpVariant` is
   `full | muted | sentry`; `getSentrySdp()` serves the camera's own SDP when it
   describes audio, and otherwise grafts the RETAINED audio shape onto the
   video-only one. Nobody else's SDP moves, so the stall hazard reaches only the
   population this system fills.
4. **The audio shape is retained across a suspend.** `sentryAudioTrack` is not
   cleared by `resetStreamState`, for the same reason `deviceAudioMuted` is not:
   that method resets one CONNECTION, this describes the CAMERA — and a sleeping
   camera has no SDP to read, which is the whole premise of the sentry.
5. **Silence is EXACT or it is refused.** Only G.711 (PCMU `0xFF`, PCMA `0xD5`,
   static payload types 0 and 8, 8 kHz mono) is filled. Every other codec is
   refused BY NAME, logged with `tags: { deviceId }`, and the sentry gets no
   audio track at all rather than one the camera would contradict on wake.
6. **Real media always wins, synchronously.** `pushAudioRtpPassthrough` calls
   `noteRealAudio` FIRST, before the packet reaches any session, so no generated
   frame can be behind it. The filler takes the track back only after a rolling
   quiet gap (1 s) — which is also how it resumes when the camera sleeps again,
   with no second signal anybody has to remember to send.
7. **The operator's broker-side mute (D83) outranks all of it.** While it is on
   this camera distributes no audio of any kind, generated included.

## Consequences

**What it costs.** One 172-byte RTP packet per 20 ms per BROKER — not per
consumer: the packet is built once and handed to every sentry session by
reference, exactly as the live path does. 8.6 KB/s of loopback traffic on a
camera someone is watching and nobody has woken, zero on every camera with no
sentry attached, because the timer exists only while a sentry session does. The
bound is structural: it cannot scale with consumers and it cannot outlive the
sessions.

**What it forbids.** Deciding anything at URL-parse time that the thing it
describes can change mid-session. That is the generalisable finding here: a
`/sentry` dial's SUBJECT — a camera — changes state under it by design, so every
fact the URL fixes is a fact that is wrong for half the session's life. The
amount of history a dial asks for (D382) is legitimately a URL-time decision
because the ask does not change; whether the camera has audio is not.

**What has to be true elsewhere.**

- The retained shape is captured in `StreamBroker.onAudioTrack`, the only place
  the camera's own SDP is parsed. A future audio path that does not go through
  it must retain the shape itself or sentries on those cameras get no audio.
- A sentry attached on a hub that has never seen this camera awake gets no audio
  track, and says so once per camera. Persisting the shape across a restart is
  possible and deliberately not done: it would be a second authority on a fact
  the camera reports for itself, and being wrong about it is a stall.
- The transition carries an RTP discontinuity. Generated silence has its own
  SSRC, sequence and wall-clock-anchored timestamp; the camera's audio has its
  own. This is the same discontinuity the placeholder VIDEO plane already hands
  every sentry consumer at the same instant, and consumers cope with it there.

## Enforcement

`packages/addon-pipeline/src/stream-broker/rtsp/__tests__/sentry-audio.spec.ts`
— 26 specs covering the parse, the two split predicates, the exact silence
bytes, the four SDP cases, the transition in both directions with a
zero-overlap assertion, and a wire-level DESCRIBE through `RtspListenServer`
(the variant choice is invisible to any assertion that calls the restreamer
directly).

`sentry-never-wakes.spec.ts` is the property that must not break and still
holds: nothing here gives a sentry demand, so it still never dials.

Eleven deliberate sabotages were run against the gates. Ten went red at once.
The eleventh — deleting the reconcile from `removeSession` — stayed GREEN,
because a filler whose last consumer has left writes to nobody and a quiet
socket looks exactly like a released timer. `isSentryAudioFilling()` exists
solely so that leak is assertable, and the sabotage now fails.

Review only for the rule that a URL-time decision must not describe something
that changes mid-session; there is no guard for it.
