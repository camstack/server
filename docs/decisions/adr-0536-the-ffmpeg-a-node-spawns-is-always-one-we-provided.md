---
id: D536
title: The ffmpeg a node spawns is always one WE provided, never the host's
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/types/src/deps/ffmpeg-binary-source.ts
  - packages/types/src/deps/ffmpeg-downloader.ts
---

## Context

`ensureFfmpeg` resolved `deps dir → system PATH → download`. On a node with no
downloaded copy, every transcode in the product — the broker's egress and
derived legs, the WebRTC transcode leg, the recorder, snapshots, the camera grid
— ran through whatever binary the host happened to have: an unknown version with
unknown vendor libraries, changing under us on any host update.

It also got the hardware wrong, silently. A portable static build is compiled
without vendor libraries, so it has no VAAPI and no QSV. Measured on the hub,
which has a working Intel iGPU:

```
/data/deps/ffmpeg   7.0.2 johnvansickle static   hwaccels: vdpau
/usr/bin/ffmpeg     6.1.1 Ubuntu, in the image   hwaccels: vdpau cuda vaapi qsv drm opencl vulkan
```

Children asked for `-hwaccel vaapi`, got `Device creation failed: -12` — what
fftools prints when `av_hwdevice_ctx_alloc` returns NULL because the type is not
in the build, so the name parses and the device simply cannot exist — and
transcoded in software with nothing naming the cause.

The first fix was to PROBE the candidates and prefer the capable one, which
would have preferred `/usr/bin/ffmpeg`. That is the host's binary on any node
that is not our container, and it was rejected for that reason. A second draft
put the choice in an environment variable, which makes the correct default
something an operator has to know about and set on every node.

## Superseded in part by D540 (2026-09-19)

The rule below — the binary is always one WE provide, never the host's — still
stands and is the reason the rest exists. What changed one day later is HOW:
the container image no longer installs ffmpeg, and every node, image or not,
downloads the same pinned build. `/opt/camstack/bin/ffmpeg` and the `bundled`
origin are gone. See
[D540](adr-0540-every-node-downloads-the-same-pinned-ffmpeg.md).

## Decision

The ffmpeg CamStack spawns is always a binary we provided. Which one is a
property of where the node runs, not of configuration: our container image
installs one and links it at `/opt/camstack/bin/ffmpeg` — a path only the image
ever writes, which is what makes "is this ours?" answerable at all, since
`/usr/bin/ffmpeg` is ours inside the image and the host's outside it — and every
other node gets the static build we download into `<dataDir>/deps`. The system
PATH is not a candidate, and no code path falls back to a bare `ffmpeg`.
`CAMSTACK_FFMPEG_PATH` and the broker's per-node `binaryPath` are voluntary
operator overrides and nothing in the product sets either.

## Consequences

- A node that can neither find our binary nor download one now FAILS loudly
  instead of degrading onto the host's. The three resolvers
  (`decoder-ffmpeg`, `stream-broker`, `camera-grid`) no longer swallow it.
- The image's ffmpeg is preferred over the downloaded static build, so the
  container gets VAAPI and QSV. A linux node running outside our image gets the
  static build and therefore no VAAPI — `ensureFfmpeg` logs the version and the
  hwaccel list of whatever it resolved, every time, so that is visible rather
  than inferred from a `-12`.
- The `/opt/camstack/bin/ffmpeg` link must exist in every image we ship. An
  image without it silently downgrades that node to the static download.

## Enforcement

Unit tests pin the ordering and that no candidate is ever a bare name
(`packages/types/src/deps/__tests__/ffmpeg-binary-source.spec.ts`). The absence
of a PATH fallback in the three resolvers is review-only.
