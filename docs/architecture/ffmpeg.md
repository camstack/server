---
title: The ffmpeg binary — where it comes from, which one, and how to change it
applies-to:
  - packages/types/src/deps/ffmpeg-artifacts.ts
  - packages/types/src/deps/ffmpeg-binary-source.ts
  - packages/types/src/deps/ffmpeg-downloader.ts
  - packages/types/src/ffmpeg/binary-capabilities.ts
  - packages/types/src/ffmpeg/pinned-binary.ts
  - packages/types/src/ffmpeg/pinned-spawn.ts
last-verified: 2026-10-13
---

# The ffmpeg binary

CamStack spawns ffmpeg for the broker's egress and derived transcodes, the
WebRTC transcode leg, the recorder, snapshots, HomeKit fragments and the camera
grid. What that binary is compiled with decides whether any of them can use the
machine's hardware, so it is not left to the machine.

## The rule

**Every node runs the same pinned build, and it is never the host's**
([D540](../decisions/adr-0540-every-node-downloads-the-same-pinned-ffmpeg.md),
which supersedes half of
[D536](../decisions/adr-0536-the-ffmpeg-a-node-spawns-is-always-one-we-provided.md)).
Resolution, in order:

1. **`CAMSTACK_FFMPEG_PATH`** — the operator's own binary. Wins over everything.
   A value that names a file which does not exist is reported as an error and
   ignored, because a typo must not stop a node serving video.
2. **The pinned build**, at `<dataDir>/deps/ffmpeg-<release>`.
3. **A download** of that build, verified against a pinned SHA-256 before a byte
   is extracted.

The system PATH is not on that list. A host binary is an unknown version with
unknown vendor libraries and it changes under us on any host update; a
self-hosted NVR cannot assume the host has ffmpeg at all. There is no
image-provided copy either — see "What the image owes" below.

## How a site gets it — and what it does without it

Resolution is only half the rule; the other half is that every SPAWN uses the
answer. A runtime site asks `ctx.deps.ensureFfmpeg()` through
`memoizePinnedFfmpeg` (`@camstack/types`) or is handed a REQUIRED path by its
addon — never an optional path with a `'ffmpeg'` default. When the binary
cannot be had, the site refuses with a logged reason (`tags: { deviceId }` when
a camera is involved); it never falls back to PATH. One-shot clip passes use
`resolvePinnedFfmpegSpawner` (`@camstack/types/node`).

**A refusal is never kept for good.** A site holds the RESOLVER and asks it
at the point of use; the memo remembers only a success, so a node whose
download was down at boot (every runner starting at once for an
`FFMPEG_RELEASE` bump, or a new node's first start) recovers on the next
spawn, with no restart and no timer. The broker resolves once at init and
recovers through `wireBrokerFfmpeg` / `FfmpegReresolver`: a refused child
starts one shared re-resolve (at most one per 30 s), and a success lands in the
manager's config, which every `StreamBroker` READS per dial — never a copy
taken at creation, so a broker born during the re-resolve cannot miss it. The
HKSV prebuffer never gives up either: a failing respawn retries at the 30 s
ceiling forever, logging one ERROR per ten failures.

There is no pinned `ffprobe` — the provisioning extracts `ffmpeg` only — so
runtime code does not run one: durations come from the file's own `mvhd`, and
the hub's stream probe reads `ffmpeg -i`'s input report.

`scripts/check-no-bare-ffmpeg.ts` refuses the bare shapes at commit. About a
dozen sites had them when it was written (see the private session log, 2026-09-29).

## Which version, today

| | |
| --- | --- |
| Release | **jellyfin-ffmpeg 8.1.2-5** (ffmpeg 8.1.2) |
| Stated in | `FFMPEG_RELEASE`, `packages/types/src/deps/ffmpeg-artifacts.ts` |
| Artifacts | `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` — portable GPL tarballs · `win32-x64` — the `win64-clang-gpl` zip |
| Licence | GPL v3 (`--enable-gpl --enable-version3`), with x264, x265 and AAC |
| Hardware | amd64: VAAPI, QSV, NVENC/NVDEC, AMF, Vulkan, OpenCL, DRM · arm64: VAAPI, Rockchip MPP, DRM · macOS: VideoToolbox · Windows x64: D3D11VA, D3D12VA, DXVA2, AMF, QSV, NVENC/NVDEC, Vulkan, OpenCL |

Verified by running them on 2026-09-19: the linux64 build on the hub, and both
macOS builds on an M-series Mac (the x86_64 one under Rosetta). `linux-arm64` is
hashed but unexecuted — no ARM node exists in this cluster yet.

**The Windows x64 pick (2026-10-13).** The same vendor and release as every
other target, so the feature set and the major version match
(`--enable-gpl --enable-version3`, x264/x265/fdk-aac, the same filters). It is
the project's `win64-clang-gpl` leg: one flat zip with a statically linked
`ffmpeg.exe` and `ffprobe.exe`, nothing to install beside it. The configure
string compiled into the binary lists `--enable-dxva2 --enable-d3d11va
--enable-d3d12va --enable-amf --enable-libvpl --enable-nvenc --enable-vulkan
--enable-opencl`, which is what `hwaccel-resolver` assumes on win32 (D3D11VA and
DXVA2, plus the vendor encoder). It has **not been executed** — it was read, not
run, from a Mac — so `expectedHwaccels` claims only `d3d11va` and `dxva2`; the
first real Windows node confirms it or trips the post-download assertion. AMF,
QSV and NVENC need the vendor's GPU driver, exactly like VAAPI needs libva, and
are not claimed. Windows ARM64 (`winarm64-clang-gpl`) exists upstream but has no
node to be verified on, so it is not pinned. The zip is unpacked in-process
(`deps/zip-extract.ts`), not by `unzip`, which Windows lacks.

## Changing the version — no image rebuild

The version is DATA, not code. To move it:

1. Download the five portable artifacts for the new release and take their
   SHA-256 (`shasum -a 256`). The publisher ships no checksums, so ours are the
   only integrity check there is.
2. Update `FFMPEG_RELEASE`, the five `sha256` values, the sizes and — if the
   build's flags changed — `expectedHwaccels`.
3. Publish `@camstack/types` and apply the framework update. Each node
   downloads the new build on its next runner start.

Nothing else moves: not the image, not the containers. The binary is stored
under its release, so the old one stays on disk and a rollback is a version
number, not a download that has to succeed.

## The override

`CAMSTACK_FFMPEG_PATH=/path/to/ffmpeg` on a node uses that binary and skips both
the pin and the download. It is for an operator who has a build they want — a
distro package with a codec we do not ship, a local build with a patch. Two
consequences worth knowing:

- the post-download capability assertion is **skipped** for an override: your
  build is yours to characterise;
- nothing else changes — the same argv, the same hardware selection, the same
  logging.

There is also a per-node `binaryPath` in the stream-broker's settings, which
predates the env var and does the same thing for the broker's children only.

## What the image owes: drivers, not ffmpeg

A binary cannot bring a GPU driver. Our container image therefore installs
**libva plus the Intel iHD media driver** (and the NPU stack) and **no ffmpeg at
all**.

This is not theoretical. Measured 2026-09-19 with the portable build:

```
bare Unraid host  →  implib-gen: libva-drm.so.2: failed to load library …
                     Assertion `0 && "Assertion in generated code"' failed  →  SIGABRT
inside CamStack   →  testsrc → format=nv12,hwupload → h264_vaapi  →  encodes
```

The dlopen design those builds use buys **portability, not graceful absence**:
without the driver the process aborts. A node that must do hardware video needs
the driver stack present, and in the container that is our job.

### The driver and its libva are one pinned decision (D926)

A VA driver exports one init symbol, `__vaDriverInit_1_N`, and libva 2.N looks
for exactly that VA-API 1.N name (or older). The pair must match. It did not in
`intel-1.2.509`: Intel's repo gave iHD 25.2.4 (`__vaDriverInit_1_22` only),
the driver package does not depend on `libva2`, so apt kept Ubuntu noble's
libva 2.20. `vaInitialize` failed on every Intel node, every decode ran in
software (an N100 at load 13.9) and the image had built green.

So the `intel` stage installs `libva2`, `libva-drm2`, `libva-x11-2`,
`libva-wayland2`, `vainfo` and `intel-media-va-driver-non-free` **all from
Intel's repo, all pinned** (`LIBVA_VERSION`, `VAINFO_VERSION`, `IHD_VERSION`):
bump them together. The `amd` stage is consistent as it stands — Ubuntu's Mesa
`radeonsi` (25.2.8) exports `__vaDriverInit_1_20` against Ubuntu's libva 2.20.

Two checks keep it that way:

- **Build time** — `scripts/docker/check-libva-abi.sh <driver.so>` (baked as
  `/usr/local/bin/camstack-check-libva-abi.sh`) compares the newest
  `__vaDriverInit_1_N` the driver exports with the installed `libva2` and fails
  the build on a gap: `iHD_drv_video.so needs VA-API >= 1.22, libva2 2.20.0-…
  provides 1.20`. Both final stages run it. In a running container with
  `/dev/dri` it also runs `vainfo --display drm` against `renderD128`.
- **Boot time** — the kernel hwaccel resolver
  (`packages/system/src/kernel/hwaccel/vaapi-init-probe.ts`) runs `vainfo`
  once per process on a Linux node with a render node. When libva cannot
  initialise the driver it logs ONE `ERROR` —
  `hwaccel: vaapi: init-failed (driver iHD needs VA-API >= 1.22, libva has
  1.20)` — and withholds `vaapi` and `qsv` from `ctx.kernel.hwaccel`, so the
  egress transcode, HomeKit and `decoder.reprobeHwaccel` stop offering a
  backend that cannot open. No `vainfo` on the host (a bare install) changes
  nothing. The session decode worker follows the same answer: the runner
  refreshes the resolver's offer on each spawn's acquire leg and sends it on
  `start` (`hwaccel`, `session-decode/session-hwaccel.ts`), and the worker
  tries only the offered backends in its platform order — so a node whose VA
  init failed never tries vaapi/qsv per session. An unresolved offer (`null`)
  keeps the platform order.

## What the binary is asked about itself

`probeFfmpegBinary` (`packages/types/src/ffmpeg/binary-capabilities.ts`) runs
`-version`, `-hwaccels` and `-encoders` and parses them. It answers a different
question from the kernel's hardware resolver, and CamStack needs both:

- **what does this NODE have** — `/dev/dri` presence, the resolver's job;
- **what can this BINARY use** — the probe's job.

A backend that only one of the two knows about is not usable. Asking only the
first is what produced months of `Device creation failed: -12` — the name
parses, the device cannot exist, and it reads like a resource shortage while
being a property of the build.

Every resolution logs the path, the origin (`override` / `downloaded`), the
release, the version string and the hwaccel list. A downloaded build that probes
short of its artifact's `expectedHwaccels` logs an ERROR naming both lists: that
is a source which changed under us, and it is the guard that was missing when a
static build turned out to carry no VAAPI.

## Hardware encoding

The encoder is chosen independently of the decode preference
([D538](../decisions/adr-0538-the-encoder-is-not-the-decode-preference.md)): a
software decode can feed a hardware encoder, and the encode is where the CPU
goes. Only an explicit `none` forces software, and **every software transcode
logs an ERROR naming which of three reasons it is** —
`operator-forced-software`, `no-hardware-on-node`, `binary-lacks-encoder`. On
this fleet a software transcode is a defect, not a fallback.

VAAPI encoding needs three things together — `-vaapi_device`, the upload LAST in
the filter chain, and the encoder — and `FfmpegInvocation.hwEncodeDevice` emits
all three or none. A hardware encode fed by a filter graph is refused rather
than mis-built: the upload has to be the graph's last node.

## Where things are

| | |
| --- | --- |
| Artifacts, release, checksums | `packages/types/src/deps/ffmpeg-artifacts.ts` |
| Resolution order + the env var | `packages/types/src/deps/ffmpeg-binary-source.ts` |
| Provisioning, probe, assertion | `packages/types/src/deps/ffmpeg-downloader.ts` |
| What a binary can do | `packages/types/src/ffmpeg/binary-capabilities.ts` |
| Argument construction (the only place) | `packages/types/src/ffmpeg/invocation.ts` |
| Encoder choice + software reasons | `packages/addon-pipeline/src/stream-broker/stream-broker/ffmpeg-invocation.ts` |
