/**
 * Pure, side-effect-free ffmpeg argument construction for the
 * `decoder-ffmpeg` addon.
 *
 * The addon decodes video in an **ffmpeg subprocess** (unlike `decoder-nodeav`
 * which decodes in-process via node-av's native bindings). On the Intel hub,
 * node-av's VA-API decode path SIGBUSes (uncatchable) on 8MP h264 and takes the
 * whole decoder runner down; ffmpeg-as-subprocess decodes the same hardware
 * cleanly because a crash is isolated to the child process.
 *
 * These helpers are extracted from the session so the argument shape is
 * unit-testable without spawning a real ffmpeg binary.
 *
 * Validated working command on the Intel hub (renderD128, 8MP h264, ~50fps,
 * exit 0):
 *
 *   ffmpeg -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 \
 *     -hwaccel_output_format vaapi -f h264 -i <in> \
 *     -vf hwdownload,format=nv12,scale=640:360,format=gray \
 *     -f rawvideo -y /dev/null
 */
import { logBannerArgs } from '../stream-broker/stream-broker/ffmpeg-args-common.js'

/** Default DRM render node used for the VA-API / QSV hardware decode path. */
export const DEFAULT_VAAPI_RENDER_DEVICE = '/dev/dri/renderD128'

/**
 * The concrete decode hwaccel the ffmpeg session runs with: the literal
 * `-hwaccel` method name the configured ffmpeg build supports (e.g. `'vaapi'`,
 * `'qsv'`, `'videotoolbox'`, `'cuda'`), or `null` / `'none'` for pure software.
 * The addon resolves this from its `hwaccel` setting intersected with the
 * node's `platform-probe` decode-accel list — it is never hardcoded here.
 *
 * The Intel `vaapi` / `qsv` paths keep frames on the GPU
 * (`-hwaccel_output_format`) and pull them with `hwdownload,format=nv12`; any
 * other hw method emits a bare `-hwaccel <m>` and lets ffmpeg auto-download to
 * a software pixel format before the scale.
 */
export type FfmpegHwAccel = string | null

/** Whether a resolved hwaccel value means "decode in software" (no `-hwaccel`). */
export function isSoftwareHwAccel(hwaccel: FfmpegHwAccel): boolean {
  return hwaccel === null || hwaccel === '' || hwaccel === 'none'
}

/** Backends whose decoded frames stay on the GPU and need an explicit
 *  `-hwaccel_output_format <m>` + `hwdownload,format=nv12` chain. */
function needsHwDownload(hwaccel: FfmpegHwAccel): boolean {
  return hwaccel === 'vaapi' || hwaccel === 'qsv'
}

/**
 * The GPU-side scale filter names, one per keep-on-GPU decode backend. Emitting
 * `<filter>=w=W:h=H` BEFORE `hwdownload` runs the (expensive) downscale on the
 * GPU render engine and pulls only the small frame into system memory — instead
 * of `hwdownload`-ing the full-resolution frame and scaling it on the CPU. On
 * the Intel hub this cut the decode child's CPU ~12× (verified live).
 */
export type GpuScaleFilter = 'scale_vaapi' | 'scale_qsv' | 'scale_vt'

/** Decode backend → its GPU scaler filter. */
const GPU_SCALE_FILTER_BY_BACKEND: Readonly<Record<string, GpuScaleFilter>> = {
  vaapi: 'scale_vaapi',
  qsv: 'scale_qsv',
  videotoolbox: 'scale_vt',
}

/** Every GPU scaler this addon knows how to drive — used to scan `-filters`. */
export const KNOWN_GPU_SCALE_FILTERS: readonly GpuScaleFilter[] = [
  'scale_vaapi',
  'scale_qsv',
  'scale_vt',
]

/**
 * The GPU scaler that pairs with a decode backend, ignoring build support — a
 * static hwaccel → filter map. Returns null for software / a backend with no
 * GPU scaler (e.g. `cuda`, `drm`). Case-insensitive.
 */
export function gpuScaleFilterForBackend(hwaccel: FfmpegHwAccel): GpuScaleFilter | null {
  if (hwaccel === null) return null
  return GPU_SCALE_FILTER_BY_BACKEND[hwaccel.toLowerCase()] ?? null
}

/**
 * Resolve the GPU scaler to use for a decode backend GIVEN the filters the
 * configured ffmpeg build actually offers ({@link parseAvailableGpuScaleFilters}).
 * Returns the filter when the backend maps to one AND the build has it; null
 * otherwise — the caller then emits the CPU-scale chain (graceful fallback).
 */
export function resolveGpuScaleFilter(
  hwaccel: FfmpegHwAccel,
  availableFilters: ReadonlySet<string>,
): GpuScaleFilter | null {
  const filter = gpuScaleFilterForBackend(hwaccel)
  if (filter === null) return null
  return availableFilters.has(filter) ? filter : null
}

/**
 * Parse `ffmpeg -filters` stdout into the set of {@link KNOWN_GPU_SCALE_FILTERS}
 * the build offers. Matches whole filter tokens (word-boundary) so the plain
 * `scale` filter is never mistaken for a GPU scaler. PURE — the spawn lives in
 * the addon; only the parse is here so it is unit-tested.
 */
export function parseAvailableGpuScaleFilters(filtersStdout: string): Set<GpuScaleFilter> {
  const present = new Set<GpuScaleFilter>()
  for (const filter of KNOWN_GPU_SCALE_FILTERS) {
    if (new RegExp(`\\b${filter}\\b`).test(filtersStdout)) present.add(filter)
  }
  return present
}

/**
 * Whether the decode keeps frames on the GPU — needs `-hwaccel_output_format`
 * and an `hwdownload` in the filtergraph. VA-API / QSV always do (their decoded
 * surfaces live on the GPU); another backend only when a GPU scaler will run on
 * those surfaces (e.g. `videotoolbox` + `scale_vt`).
 */
function keepFramesOnGpu(hwaccel: FfmpegHwAccel, gpuScaleFilter: GpuScaleFilter | null): boolean {
  return needsHwDownload(hwaccel) || gpuScaleFilter !== null
}

/** Raw output pixel formats the ffmpeg session produces. */
export type FfmpegRawPixel = 'rgb24' | 'gray'

/** The decode-session parameters the arg-builder reads. */
export interface FfmpegDecodeConfig {
  readonly codec: string
  /** Downscale divisor — output width is capped at `floor(640 / max(scale, 1))`. */
  readonly scale: number
  /** Cap-level output format. `'gray'` → 1ch gray; everything else → 3ch rgb24. */
  readonly outputFormat: string
}

/** Options driving the ffmpeg argument shape. */
export interface FfmpegDecodeArgOptions {
  readonly hwaccel: FfmpegHwAccel
  /** DRM render node for vaapi. Defaults to {@link DEFAULT_VAAPI_RENDER_DEVICE}. */
  readonly renderDevice?: string
  /**
   * Exact output geometry when the source dimensions are already known. When
   * BOTH are provided (> 0) the scale filter substitutes them verbatim
   * (`scale=<outW>:<outH>`). Otherwise ffmpeg picks the height and caps the
   * width at {@link maxDecodeWidth} via `scale=min(iw\,<maxW>):-2` — the live
   * path, since the broker does not pass width/height for the shm frame plane.
   */
  readonly outWidth?: number
  readonly outHeight?: number
  /**
   * The GPU scaler to run BEFORE `hwdownload` (`scale_vaapi` / `scale_qsv` /
   * `scale_vt`) so the downscale happens on the GPU and only the small frame is
   * pulled to system memory. Resolved by the session from the backend ∩ the
   * build's `-filters` ({@link resolveGpuScaleFilter}). `null` / omitted → the
   * CPU-scale chain (`hwdownload,…,scale=…`) — the graceful fallback.
   */
  readonly gpuScaleFilter?: GpuScaleFilter | null
  /**
   * PULL-MODE input (P2b, cross-node Phase 2): when set, ffmpeg dials this
   * URL itself (`-rtsp_transport tcp -i <url>` for rtsp) instead of reading
   * Annex-B packets from stdin (`-f <codec> -i pipe:0`). Used by the
   * remote-source leg: a detect-node decoder pulls the source-owner's
   * compressed restream and decodes it locally. The whole output tail
   * (filtergraph, rawvideo pipe) is identical to push mode. Omitted → the
   * push-mode stdin input (unchanged default).
   */
  readonly inputUrl?: string
}

/** Map a cap codec string to the ffmpeg `-f` input demuxer/format. */
export function codecToInputFormat(codec: string): string {
  switch (codec.toLowerCase()) {
    case 'h265':
    case 'hevc':
      return 'hevc'
    case 'h264':
    default:
      return 'h264'
  }
}

/** Map the cap-level output format to a raw ffmpeg pixel format. */
export function rawPixelForFormat(outputFormat: string): FfmpegRawPixel {
  return outputFormat === 'gray' ? 'gray' : 'rgb24'
}

/** Packed bytes-per-pixel for a raw output format (rgb24 = 3, gray = 1). */
export function channelsForPixel(pixel: FfmpegRawPixel): number {
  return pixel === 'gray' ? 1 : 3
}

/**
 * The maximum output width for a given `scale` divisor — matches the node-av
 * scaler's `maxW = floor(640 / scale)` rule so both decoders produce
 * comparably-sized frames for the motion / detection pipeline.
 */
export function maxDecodeWidth(scale: number): number {
  const s = scale > 1 ? scale : 1
  return Math.max(2, Math.floor(640 / s))
}

/**
 * Compute exact output geometry from a known source resolution — the node-av
 * rule (`outWidth = min(srcW, floor(640/scale))`, `outHeight =
 * round(outWidth*srcH/srcW)`). Provided for callers that DO know the source
 * dimensions; the live broker path leaves them to ffmpeg (`-2` height).
 */
export function computeOutputGeometry(
  srcWidth: number,
  srcHeight: number,
  scale: number,
): { width: number; height: number } {
  const width = Math.min(srcWidth, maxDecodeWidth(scale))
  const height = Math.round((width * srcHeight) / srcWidth)
  return { width, height }
}

/** Build the `-vf` filtergraph string for the requested hwaccel + pixel format. */
function buildVideoFilter(
  hwaccel: FfmpegHwAccel,
  pixel: FfmpegRawPixel,
  outWidth: number | undefined,
  outHeight: number | undefined,
  maxW: number,
  gpuScaleFilter: GpuScaleFilter | null,
): string {
  const exact = outWidth !== undefined && outWidth > 0 && outHeight !== undefined && outHeight > 0

  if (gpuScaleFilter !== null) {
    // GPU-side scale: `scale_<be>` runs the downscale on the GPU render engine,
    // then `hwdownload` pulls only the SMALL frame to nv12 (the surface's
    // software format) and the cheap pixel-convert finishes on the CPU. The GPU
    // scaler takes separate `w=`/`h=` params; `-2` keeps aspect with an even
    // height. The comma inside `min(iw,N)` MUST be escaped (`\,`).
    const wh = exact ? `w=${outWidth}:h=${outHeight}` : `w=min(iw\\,${maxW}):h=-2`
    return `${gpuScaleFilter}=${wh},hwdownload,format=nv12,format=${pixel}`
  }

  // CPU-scale fallback. Exact geometry when known; otherwise let ffmpeg pick an
  // even height and cap the width.
  const scaleExpr = exact ? `${outWidth}:${outHeight}` : `min(iw\\,${maxW}):-2`
  const scaleAndFormat = `scale=${scaleExpr},format=${pixel}`
  // VA-API / QSV frames stay on the GPU (`-hwaccel_output_format <m>`); pull
  // them into system memory as nv12 before the software scale + pixel convert.
  // Other hw methods auto-download, so a plain scale suffices.
  return needsHwDownload(hwaccel) ? `hwdownload,format=nv12,${scaleAndFormat}` : scaleAndFormat
}

/**
 * Build the full ffmpeg argv for a decode session. PURE — no spawn, no env
 * access — so the argument shape is asserted in unit tests.
 *
 * Notes:
 * - `-loglevel info -nostats`: the session parses the muxer's `Output #0`
 *   stream line from stderr to learn the exact output W×H (the broker does not
 *   pass source geometry for the shm path). `-nostats` suppresses the periodic
 *   `frame= …` counter while keeping the one-shot Output block.
 * - The input is `pipe:0` (Annex-B packets written to stdin) in push mode, or
 *   `options.inputUrl` (the owner's restream, dialed by ffmpeg itself —
 *   `-rtsp_transport tcp` for rtsp URLs) in pull mode; the output is raw video
 *   on `pipe:1` either way.
 */
export function buildFfmpegDecodeArgs(
  config: FfmpegDecodeConfig,
  options: FfmpegDecodeArgOptions,
): string[] {
  const inputFormat = codecToInputFormat(config.codec)
  const pixel = rawPixelForFormat(config.outputFormat)
  const maxW = maxDecodeWidth(config.scale)
  const { hwaccel } = options
  const gpuScaleFilter = options.gpuScaleFilter ?? null
  const vf = buildVideoFilter(
    hwaccel,
    pixel,
    options.outWidth,
    options.outHeight,
    maxW,
    gpuScaleFilter,
  )

  let hwaccelArgs: string[]
  if (isSoftwareHwAccel(hwaccel) || hwaccel === null) {
    hwaccelArgs = []
  } else {
    // VA-API / QSV pin the render node; a GPU scaler (or VA-API/QSV) keeps the
    // frames on the GPU via `-hwaccel_output_format`. Any other method with no
    // GPU scaler auto-downloads (bare `-hwaccel`).
    hwaccelArgs = ['-hwaccel', hwaccel]
    if (needsHwDownload(hwaccel)) {
      hwaccelArgs.push('-hwaccel_device', options.renderDevice ?? DEFAULT_VAAPI_RENDER_DEVICE)
    }
    if (keepFramesOnGpu(hwaccel, gpuScaleFilter)) {
      hwaccelArgs.push('-hwaccel_output_format', hwaccel)
    }
  }

  // Push mode forces the raw Annex-B demuxer for the stdin stream; pull mode
  // lets the container/RTSP session self-describe (forcing `-f h264` on an
  // RTSP input would be wrong). `-rtsp_transport tcp` only applies to the
  // rtsp demuxer, so it is emitted only for rtsp URLs.
  const inputArgs =
    options.inputUrl !== undefined
      ? [
          ...(options.inputUrl.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []),
          '-i',
          options.inputUrl,
        ]
      : ['-f', inputFormat, '-i', 'pipe:0']

  // Aggressive probe-skip (`-probesize 1M -analyzeduration 0`) is a PUSH-mode
  // optimisation: a raw `pipe:0` h264 stream self-describes from the bitstream,
  // so minimal probing cuts startup latency. In PULL mode the RTSP demuxer must
  // read the SDP + a few RTP packets to lock onto the stream; the same flags
  // starve it and it produces garbage / no frames (Reolink 592 rfc4571 restream
  // decoded to unusable output on the pull path with these set). Let ffmpeg
  // probe normally for a pull-mode RTSP input.
  const probeArgs =
    options.inputUrl !== undefined ? [] : ['-probesize', '1M', '-analyzeduration', '0']

  return [
    ...logBannerArgs('info'),
    '-nostats',
    // Low-latency flags: disable input buffering, flush packets eagerly.
    '-fflags',
    '+nobuffer+flush_packets',
    '-flags',
    'low_delay',
    ...probeArgs,
    ...hwaccelArgs,
    ...inputArgs,
    '-vf',
    vf,
    '-f',
    'rawvideo',
    '-pix_fmt',
    pixel,
    'pipe:1',
  ]
}

/**
 * Parse the exact output geometry from ffmpeg's stderr. The muxer prints an
 * `Output #0, rawvideo …` block whose `Stream #0:0: Video: rawvideo …, <fmt>,
 * WIDTHxHEIGHT …` line carries the scaled dimensions. Gating on the `Output #`
 * marker avoids picking up the INPUT stream's (source) resolution, which is
 * printed earlier.
 *
 * Returns `null` until the Output block with a `WxH` token has been seen.
 */
export function parseFfmpegOutputDims(stderr: string): { width: number; height: number } | null {
  const outputIdx = stderr.indexOf('Output #')
  if (outputIdx < 0) return null
  const after = stderr.slice(outputIdx)
  // 2–5 digit dims only: avoids matching a codec fourcc hex like `0x30303859`
  // (whose `0x…` the naive `\d+x\d+` would grab as `0` × `30303859`).
  const match = after.match(/(\d{2,5})x(\d{2,5})/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}

/**
 * Pick the first kernel-preferred `-hwaccel` method the configured ffmpeg build
 * actually supports, or `null` (software) when it supports none. Mirrors the
 * broker's `pickDecodeHwAccel` (`ffmpeg-invocation.ts`) so the decoder gates
 * decode-hwaccel against the same probed evidence:
 * - empty `preferred` → `null` (software);
 * - empty `supportedMethods` (probe miss) → keep the top preference and let the
 *   session's per-child software fallback cover a genuine failure;
 * - otherwise the first preference the build supports, or `null`.
 */
export function pickDecodeHwAccel(
  preferred: readonly string[],
  supportedMethods: readonly string[],
): string | null {
  if (preferred.length === 0) return null
  if (supportedMethods.length === 0) return preferred[0] ?? null
  const supported = new Set(supportedMethods.map((m) => m.toLowerCase()))
  return preferred.find((name) => supported.has(name.toLowerCase())) ?? null
}

/**
 * Canonical decode-hwaccel preference order for the ffmpeg-subprocess decoder.
 *
 * `vaapi` is ranked ABOVE `qsv` deliberately: on the Intel hub the `qsv` decode
 * child exits early (`code=171`, no frames) while the `vaapi` path decodes 8MP
 * h264 cleanly at ~50fps. The kernel probe (`resolveHwAccel`) tends to surface
 * `qsv` first on Intel, so we re-rank its result through this table before
 * building the attempt chain. `videotoolbox` leads for macOS; `cuda` / `nvdec`
 * trail for NVIDIA. A method not listed here keeps its incoming relative order,
 * placed AFTER every ranked one.
 */
export const DECODE_HWACCEL_RANK: readonly string[] = [
  'videotoolbox',
  'vaapi',
  'qsv',
  'cuda',
  'nvdec',
  'd3d11va',
  'dxva2',
  'amf',
  'vdpau',
  'drm',
]

/** Rank index for {@link DECODE_HWACCEL_RANK} — unranked methods sort last. */
function decodeHwAccelRankIndex(method: string): number {
  const idx = DECODE_HWACCEL_RANK.indexOf(method.toLowerCase())
  return idx < 0 ? DECODE_HWACCEL_RANK.length : idx
}

/**
 * Build the ORDERED list of hardware `-hwaccel` methods to attempt for an
 * `'auto'` decode session, best-first. The session walks this chain on an
 * early-exit-with-no-frames and only falls to software once it is exhausted.
 *
 * Strategy:
 * - Seed candidates from the kernel-preferred order UNION the canonical rank
 *   UNION the build's supported list, so a method the kernel omitted but the
 *   build supports (the Intel `vaapi` case — kernel surfaces only `qsv`) is
 *   still attempted.
 * - When the build's supported-method list is known (non-empty), keep only
 *   methods it actually offers; on a probe miss (empty) keep just the kernel
 *   preferences (avoid blindly spawning every backend).
 * - Re-rank the survivors by {@link DECODE_HWACCEL_RANK} so `vaapi` precedes
 *   `qsv`. A supported method not in the rank table keeps its position AFTER
 *   every ranked one (stable sort). Returns lowercased method names; empty ⇒
 *   pure software.
 */
export function rankDecodeHwAccels(
  preferred: readonly string[],
  supportedMethods: readonly string[],
): string[] {
  const supported = new Set(supportedMethods.map((m) => m.toLowerCase()))
  const hasSupportList = supported.size > 0
  const pool = hasSupportList
    ? [...preferred, ...DECODE_HWACCEL_RANK, ...supportedMethods]
    : [...preferred]
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const raw of pool) {
    const method = raw.toLowerCase()
    if (seen.has(method)) continue
    seen.add(method)
    if (hasSupportList && !supported.has(method)) continue
    candidates.push(method)
  }
  return candidates.sort((a, b) => decodeHwAccelRankIndex(a) - decodeHwAccelRankIndex(b))
}
