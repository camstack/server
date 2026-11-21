---
id: D1078
title: The node benchmark measures decode too, through the real decode worker, and a node's capacity is the smaller of its decode and detection capacity
status: accepted
date: 2026-11-21
supersedes: D791 (only "Not measured: session decode, motion")
applies-to:
  - packages/types/src/pipeline/node-benchmark/**
  - packages/addon-pipeline/src/pipeline-runner/node-bench/**
  - packages/addon-pipeline-orchestrator/src/node-benchmark/**
---

## Context

The node benchmark (D791) measures the inference plane on frames decoded
ONCE into RAM. It said so itself: "Not measured: session decode, motion".
So the capacity a node reported after an install was its detector's, and a
node whose decoder gives out first — a CPU-only box offered 4K H.265
cameras, a hardware decoder with a handful of sessions — was promised
cameras it could not open. The feasibility verdict could not see the limit
most small nodes actually hit.

Two shortcuts were considered and refused. Decoding a file with one ffmpeg
per stream measures ffmpeg, not the decode worker a session runs (its
demux, its hardware offer, its frame delivery). Decoding a REAL camera
needs a camera, moves no faster than it does, and cannot be ramped past
the cameras the node has.

## Decision

The node benchmark has a third phase, `decode`, inside the same run: same
orchestrator-owned benchmark mode, same restore, same deadline, same CPU
(≤ 85 %) and free-RAM (≥ 15 %) limits. Per stream profile (3840×2160 H.265
and 1920×1080 H.264, both at 15 fps) it ramps concurrent streams 1 … 32
through the node's REAL decode path:

- the source is an encoded clip built ON the node by its own ffmpeg (the
  bench clip scaled to the profile, else a moving test pattern), cut into
  pictures and paced in real time into a loopback-only RTSP endpoint — the
  same restreamer the broker serves a session from;
- each stream is one real forked decode worker, opened with the hardware
  offer and the lease settings a session gets on that node, hardware where
  the node has it and software otherwise;
- every delivered frame is a handle inside the runner; the motion kernel
  runs on its gray view at the plan's detection rate. No decoded frame
  crosses a process boundary beyond the one a session already crosses.

A step holds when EVERY stream delivered at least 90 % of the profile frame
rate over the window, frames arrived at most 1000 ms (p95) after the
instant they were paced, no stream errored or failed to start, the event
loop did not stall, and CPU and RAM stayed inside the limits. Free RAM is
also checked before each worker is forked. The cell stores `maxStreams`
(the last step that held), the profile, what stopped the ramp, whether
every stream ran on a hardware decoder, the decoder names the workers
reported, and whether motion ran. A profile the node cannot be offered (no
ffmpeg, no encoder) stores NO cell and is named on the run — unmeasured is
never zero (D393).

A node's decode capacity is its fresh decode cell with the FEWEST streams:
a node is sized for its heaviest cameras. The capacity verdict
(`pipelineOrchestrator.getNodeCapacityVerdict`) is
`min(decode, detection)` and names which plane limits; with one plane
measured it gives that plane's number and says the verdict is incomplete.

## Consequences

- Decode cells live next to the detector cells (`phase: 'decode'`), keyed
  by node × profile, stale by age only — they name no inference pool. Every
  reader of the detector cells (Auto tune, the automatic shares) skips
  them; the shares are NOT yet bounded by decode capacity — only the
  verdict is.
- A default run now also measures decode (up to about six more minutes per
  profile at worst). The automatic first measurement of a new device
  (D913) stays `device` only, so a node has a decode cell only after an
  operator-started run.
- What the number does not include: the broker's source reader, recording
  and egress; network jitter of a real camera; detection running at the
  same time (the planes are measured apart, hence the `min`); the live
  admission ceiling of the node's decode workers, which the measurement
  bypasses. Delivery is unthrottled, slightly heavier than a session's.
  The picture may be synthetic, so entropy differs from a real scene; the
  bitrates are camera-like (≈ 6 Mbit/s 4K H.265, ≈ 4 Mbit/s 1080p H.264).
- The RAM limit reads the OS free-memory figure, which under-reports on
  hosts that count reclaimable cache as used; a ramp stopped by `ram` on
  such a host is a floor, not the decoder's limit. The cell says `ram`.
- An orchestrator that asks for `decode` needs a runner that knows the
  phase: both packages ship together.

## Enforcement

`decode-bench-driver.spec.ts` (the hold rule, each limit, no cell on a
skipped or cut ramp), `decode-bench-rig.spec.ts`,
`decode-bench-source.spec.ts`, `results.spec.ts` (decode cells are skipped
by the detector reductions; the verdict carries both planes), and
`node-benchmark-service.spec.ts` (a decode cell is stored, a skipped
profile is named). `check-ffmpeg-primitive` lists the one-shot encode.
The end-to-end path (real worker, hardware decode) is review only.
