---
id: D228
title: Recording write stays in recorder; scrub stays on the live WebRTC session — never a third addon
status: accepted
date: 2026-08-24
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/**
  - packages/addon-pipeline/src/stream-broker/recorded/**
  - packages/addon-pipeline/src/stream-broker/webrtc/**
---

## Context

The operator's scrub was still slow after the viewer badge-poll storm had
already been replaced by a 5 min reconcile. Hub evidence (~15:13 Europe/Rome,
2026-08-24) put stream-broker at ~76 % CPU with live restream and scrub demux
on the same event loop, hub-main at ~94 %, and `restream dropped packets` on
the cameras being scrubbed. The tempting split was "move recording/scrub into
a new addon" so live ingest would not compete with archive reads.

That split already exists for the **write** path. `recorder` is its own runner
([D128](adr-0128.md)): segment files, `mfra`, `locateSegment` / `readGopBytes`.
`stream-broker` already talks to it over compressed RPC. Merging those two
runners is forbidden by [D29](adr-0029.md).

What does **not** exist — and must not — is a third process that owns recorded
playback. [D42](adr-0042.md) is one WebRTC session per viewer per camera:
live, recorded and scrub are the same track, the server moves a pointer. A
`recorded-playback` addon would either open a second session (the D41 mute /
two-truths class, tried and rejected in a single day) or push Annex-B/RTP
through hub-main at tick rate ([D9](adr-0009.md)).

The load that *was* still "all devices, too often" was the viewer's standing
`getSnapshotLinks` demand from tab-mounted grid thumbs, plus `listTracks` on
a today-window whose `until` was tomorrow midnight (never immutable, poll
every 30 s of the whole lookback). Those are client gates, not process
topology.

## Decision

**Do not add an addon for recording or scrub.** Write stays in `recorder`.
Scrub/playback stays in `stream-broker` on the same WebRTC session as live.
If the broker event loop is still saturated **after** the viewer demand and
`listTracks` split have landed (OTA + measured Loki `scrub:drawn` vs
`restream dropped packets`), the next lever is a `worker_threads` (or child)
**inside** the stream-broker runner for `demuxSegmentPreferJs` — same addon,
same track, live loop freed. That spike is gated on the measurement, not
shipped in anticipation.

## Consequences

- A future "isolate scrub" PR that introduces `execution.group` between
  recorder and broker, or a new `recorded-playback` manifest, is a violation
  of this record and of D42 / D29.
- Viewer snapshot demand and theater `listTracks` must not enrol or poll
  while the operator is in recorded/scrub; that is the load that was
  mistaken for a missing process.

## Enforcement

Review only for the process topology. Viewer gates are pinned by
`camstack/src/screens/__tests__/grid-list-snapshot-gate.spec.ts`,
`camstack/src/screens/camera-detail/__tests__/live-poll-gate.spec.ts`,
and `camstack/src/components/camera/theater/__tests__/timeline-deferral.spec.ts`
(`pollLive: props.mode === 'live'`).
