---
id: D540
title: Every node downloads the same pinned ffmpeg, and the image ships none
status: accepted
date: 2026-09-19
supersedes: D536 (in part)
applies-to:
  - packages/types/src/deps/ffmpeg-artifacts.ts
  - packages/types/src/deps/ffmpeg-binary-source.ts
---

## Context

D536 stopped CamStack from ever running the host's ffmpeg, and the way it did
that was to prefer the binary our container image installed. It worked, and it
left three things wrong:

- **The answer depended on where a node ran.** An image node got a build with
  VAAPI and QSV; a native node (the macOS agent today, a bare-metal Linux agent
  tomorrow) got a portable build with no hardware support at all. One product,
  two capability sets, and every bug that depends on which one answered.
- **The ffmpeg version was CODE.** It lived in the image, so changing it meant
  rebuilding the image and swapping the container on every machine — a 40-minute
  CI train and a restart per node, for a dependency bump.
- **We were distributing it.** FFmpeg's licence is chosen at compile time: the
  core is LGPL 2.1+, `--enable-gpl` makes it GPL (that is what x264/x265 cost),
  `--enable-version3` makes it v3, and `--enable-nonfree` makes the result
  undistributable. Shipping a GPL build inside our image means conveying a GPL
  work, with the source-availability obligations that follow.

## Decision

Every node downloads the same pinned ffmpeg build, and the image ships none.
The release is stated once in the framework (`FFMPEG_RELEASE`), so changing
ffmpeg is a framework bump rather than an image rebuild; the binary is stored
under its release (`ffmpeg-<release>`), so two versions coexist during a change
and a rollback is a file already on disk. Resolution is: the operator's
`CAMSTACK_FFMPEG_PATH` → the pinned build → download it. The system PATH is
never a candidate, and neither is anything the image happens to contain.

The build is jellyfin-ffmpeg's portable artifact — one vendor covering
linux-amd64/arm64 and darwin-arm64/x64, with VAAPI, QSV, NVENC, AMF, Vulkan,
OpenCL, DRM and (on arm64) Rockchip MPP, plus x264/x265 and AAC. Each artifact
carries a pinned SHA-256, verified before extraction, and the hardware it is
supposed to report; a build that probes short of its own claim is a source that
changed under us and says so.

## Consequences

- **We convey no GPL work.** The node fetches the archive from the project that
  publishes it, so the distribution obligations sit with them. This is the
  reason the image installs nothing, not a technical preference.
- **The image still owes the DRIVERS**, which no binary can bring: libva and the
  iHD media driver stay. Measured 2026-09-19 — the portable build encodes VAAPI
  inside our container and ABORTS outright on the bare Unraid host
  (`implib-gen: libva-drm.so.2: failed to load library`, then an assertion), so
  a missing driver is not the graceful degradation the dlopen design suggests.
- **A node with no network and no previous download has no ffmpeg.** That is the
  cost of the uniformity, accepted deliberately: there is no image copy to fall
  back to. The failure is loud and names the artifact.
- The first boot after this change downloads ~60 MB on linux-amd64, ~33 MB on
  darwin-arm64, once per release.
- `linux-arm64` is hashed but has never been executed — no ARM node exists in
  this cluster. Its capability claim comes from the project's build script, so
  the first ARM node to boot either confirms it or trips the assertion.

## Enforcement

`ffmpeg-binary-source.spec.ts` pins the resolution order, that no host path is
ever an answer, and that every artifact has a checksum and a claim;
`binary-downloader.spec.ts` pins that a mismatched artifact is refused and
deleted. The Dockerfile carries the reasoning where the install used to be.
