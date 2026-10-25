---
id: D622
title: CI spawns the pinned ffmpeg, never the runner's — a suite that grades a binary no node runs is not a verdict
status: proposed
date: 2026-09-23
supersedes:
applies-to:
  - scripts/ci-provision-ffmpeg.ts
  - packages/addon-pipeline/src/stream-broker/recorded/__tests__/segment-audio-js.spec.ts
---

## Context

Every node runs one pinned ffmpeg build, downloaded and verified by
`ensureFfmpeg`; the host's PATH is deliberately not on the resolution list
([D540](adr-0540-every-node-downloads-the-same-pinned-ffmpeg.md)). The test
runner was the one machine exempt from that rule: the `tests` job ran
`apt-get install ffmpeg` and the suites that spawn a real binary — the
recorded-segment demuxers, the recorder's fixture builders, the fMP4 splitter —
took whatever the runner template's Ubuntu carried. On `ci-runner` that was
**ffmpeg 4.2.7** (`ffmpeg -version` in run 35895968547).

What that cost, measured 2026-09-23:

- `segment-audio-js.spec` › *transcodes a legacy AAC fragment to Opus via the
  ffmpeg fallback* failed on every push from 2026-09-22 with `expected 0 to be
  greater than 50`. In 4.2 `libavformat/movenc.c` refuses Opus in MP4 without
  `-strict -2` ("support is experimental"); the fallback exits non-zero,
  `tolerateNonZeroExit` returns 0 bytes, the demux returns `[]`.
- Two more tests in the same file were **inert**: their Opus fixture is built by
  the same command, the builder returned `null` on failure, and each test
  `return`ed on null. Green, on every run, testing nothing.
- `fmp4-box-splitter.spec` is gated with `describe.runIf(ffmpegAvailable())` —
  it ran against 4.2.7 and passed, which says nothing about the 8.1.2 the
  product ships.

The rejected alternative was to make the tests tolerant of the runner's binary
(`-strict -2` in the fixture, or a skip when Opus-in-MP4 is refused). That
keeps the suite grading a binary no node will ever run, and it is the same shape
as the `null`-and-return that hid two tests for months.

## Decision

The `tests` job provisions the pinned build through the code path every node
boots through (`ensureFfmpeg`, into a directory beside the checkout that
`git clean` never touches), puts a shim directory whose `ffmpeg` is that binary
on `PATH`, and exports `CAMSTACK_FFMPEG_PATH`. A spec that spawns ffmpeg reads
`CAMSTACK_FFMPEG_PATH` first and falls back to PATH only for a developer
machine. A fixture that cannot be built with that binary **throws**, naming the
binary and ffmpeg's stderr; it never returns a value a test can quietly skip on.

## Consequences

- One 60 MB download per runner container, once; afterwards a cache hit.
- The runner needs a glibc the jellyfin portable build accepts. The linux-x64
  build is verified on the hub, not on the runner; the first push after this
  record is the verification, and a failure is a loud red in one step with the
  probe's output, not a green suite on the wrong binary.
- Bumping `FFMPEG_RELEASE` now changes what CI tests, on the same push. That is
  the point.
- `ffprobe` is not provisioned (the downloader extracts only `ffmpeg`); the
  specs that mention it mock it. A spec that needs the real one has to say so.

## Enforcement

Review only, plus the throw: a fixture builder that returns `null` on an ffmpeg
failure would be caught by nothing but a reader. The workflow step is named
after what it does and replaces the apt install outright, so a return to the
host binary is a visible diff in `ci.yml`.
