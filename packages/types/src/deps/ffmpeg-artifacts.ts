/**
 * The ffmpeg build every CamStack node downloads, per platform and arch.
 *
 * ## Why a download, on every node, including the container
 *
 * The version of ffmpeg used to be CODE: baked into the image, changeable only
 * by rebuilding and rolling it. Now it is DATA — this file states the release,
 * and a node that boots with a different one downloads it. Changing ffmpeg is a
 * framework bump, not an image rebuild.
 *
 * It also settles the licence question by removing it. FFmpeg's licence is
 * chosen at compile time: the core is LGPL 2.1+, `--enable-gpl` makes it GPL
 * (for x264/x265), `--enable-version3` makes that v3, and `--enable-nonfree`
 * makes the result undistributable. These are GPL v3 builds, and we do not
 * distribute them: the user's own node fetches the archive from the project
 * that publishes it, so we convey no GPL work and inherit none of the
 * obligations that come with conveying one. That is the whole reason the image
 * no longer installs ffmpeg at all — not a technical preference.
 *
 * ## Why jellyfin-ffmpeg
 *
 * One vendor covering linux-amd64, linux-arm64, darwin-arm64 and darwin-x64
 * from one release, with the widest hardware surface of anything maintained:
 * VAAPI, QSV, NVENC/NVDEC, AMF, Vulkan, OpenCL and DRM on amd64, plus Rockchip
 * MPP on arm64. It reaches the vendor libraries through dlopen trampolines,
 * so the binary is not linked against a driver stack it may not find.
 *
 * **What it still needs from the host, measured 2026-09-19.** On the Unraid
 * HOST, which has no libva, `-vaapi_device` aborts the process outright —
 * `implib-gen: libva-drm.so.2: failed to load library ... Assertion '0 &&
 * "Assertion in generated code"' failed`. Inside our container, which installs
 * libva plus the iHD driver, the same command encodes: verified end to end with
 * `testsrc → format=nv12,hwupload → h264_vaapi`. So the image drops ffmpeg and
 * KEEPS the Intel media stack; the drivers are the part a binary cannot bring.
 *
 * ## Why each artifact carries a checksum and a claim
 *
 * The download is now the only source, so `sha256` is verified before anything
 * is extracted — jellyfin publishes no checksums on its release assets, so
 * these are ours, taken at the version bump. And `expectedHwaccels` is what the
 * build is supposed to be able to do: a binary that probes short of its own
 * claim is a source that changed under us, which is precisely what went
 * unnoticed for months when a static build turned out to carry no VAAPI at all
 * (D536).
 */

/** The pinned jellyfin-ffmpeg release. Changing this is the version change. */
export const FFMPEG_RELEASE = '8.1.2-5' as const

/** ffmpeg 8.1.2 is what this release builds — for the log line, not resolution. */
export const FFMPEG_VERSION = '8.1.2' as const

export interface FfmpegArtifact {
  readonly url: string
  readonly archiveFormat: 'zip' | 'tar.gz' | 'tar.xz'
  /** SHA-256 of the ARCHIVE, verified before extraction. */
  readonly sha256: string
  /** Bytes, as published — for the "downloading 60 MB" line. */
  readonly sizeBytes: number
  /**
   * `-hwaccels` names this build must report. Asserted after download: short of
   * this is a changed source, not a quiet degradation.
   */
  readonly expectedHwaccels: readonly string[]
}

const BASE = `https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${FFMPEG_RELEASE}`

function portable(target: string): string {
  return `${BASE}/jellyfin-ffmpeg_${FFMPEG_RELEASE}_portable_${target}-gpl.tar.xz`
}

/**
 * Every artifact below was fetched and hashed on 2026-09-19, and each one's
 * capability claim was verified by RUNNING it: the linux64 build on the hub
 * itself, the two macOS builds on an M-series Mac (the x86_64 one under
 * Rosetta, which translates x86 to arm — never the reverse, which is why the
 * darwin split matters at all).
 *
 * linux-arm64 is hashed but NOT executed — there is no arm64 Linux node in
 * this cluster yet. Its claim is taken from the project's build script, so the
 * first ARM node to boot will either confirm it or trip the assertion, which is
 * the outcome the assertion exists for.
 */
const FFMPEG_ARTIFACTS: Readonly<Record<string, FfmpegArtifact>> = {
  'linux-x64': {
    url: portable('linux64'),
    archiveFormat: 'tar.xz',
    sha256: '1fd859927053c44a4f2dbf67ae8b9ba8d29fb3b8930df0dd57d91aa60589363d',
    sizeBytes: 60_255_400,
    // Measured on the hub: cuda vaapi qsv drm opencl vulkan amf.
    expectedHwaccels: ['vaapi', 'qsv', 'drm', 'vulkan', 'opencl'],
  },
  'linux-arm64': {
    url: portable('linuxarm64'),
    archiveFormat: 'tar.xz',
    sha256: '1bd4fafaf4c309cad896d3479152c31d6b7604d4be8b8526882ea16cc6d5f589',
    sizeBytes: 53_958_064,
    // No QSV on arm64 — libvpl is an amd64-only leg of that build.
    expectedHwaccels: ['vaapi', 'drm'],
  },
  'darwin-arm64': {
    url: portable('macarm64'),
    archiveFormat: 'tar.xz',
    sha256: 'b2ac80bb184e9a2f3f7c236876b2f56a5639596a95b42f41ced34fab66ad720d',
    sizeBytes: 32_896_684,
    // VideoToolbox is an OS framework, so it needs nothing from the host.
    expectedHwaccels: ['videotoolbox'],
  },
  'darwin-x64': {
    url: portable('mac64'),
    archiveFormat: 'tar.xz',
    sha256: '021cd321ea169722cd2e4aca35884305449666a0d231d3378af7f87d6a5626e5',
    sizeBytes: 37_852_180,
    expectedHwaccels: ['videotoolbox'],
  },
  /**
   * Windows x64 — the same jellyfin-ffmpeg release, GPL, from the project's
   * own `win64-clang-gpl` leg (a flat zip: `ffmpeg.exe` + `ffprobe.exe`,
   * statically linked, so nothing to install beside it). Hashed 2026-10-13.
   *
   * NOT executed: it was verified by reading the build's own configuration
   * string out of the binary (`--enable-gpl --enable-version3 --enable-dxva2
   * --enable-d3d11va --enable-d3d12va --enable-amf --enable-libvpl
   * --enable-nvenc --enable-vulkan --enable-opencl`), which is the same
   * codec/feature set as the linux build plus the Windows hwaccel API family.
   * `expectedHwaccels` claims only what that string guarantees; the first real
   * Windows node confirms it or trips the assertion, which is what it is for.
   * AMF/NVENC/QSV are encoders and vendor runtimes (they need the GPU driver),
   * so they are not claimed here.
   */
  'win32-x64': {
    url: `${BASE}/jellyfin-ffmpeg_${FFMPEG_RELEASE}_portable_win64-clang-gpl.zip`,
    archiveFormat: 'zip',
    sha256: '4bb79f3d1e4092404eafe3fb3b0101e196f8eb00355201f60314e5ba21447b82',
    sizeBytes: 67_819_203,
    expectedHwaccels: ['d3d11va', 'dxva2'],
  },
}

/** The artifact for this node, or a refusal naming what was asked for. */
export function getFfmpegArtifact(platform: string, arch: string): FfmpegArtifact {
  const artifact = FFMPEG_ARTIFACTS[`${platform}-${arch}`]
  if (!artifact) {
    throw new Error(
      `Unsupported platform/architecture for ffmpeg: ${platform}-${arch}. ` +
        `Point ${'CAMSTACK_FFMPEG_PATH'} at a binary this node can run.`,
    )
  }
  return artifact
}

/** The URL alone, for a caller that wants nothing else. */
export function getFfmpegDownloadUrl(platform: string, arch: string): string {
  return getFfmpegArtifact(platform, arch).url
}
