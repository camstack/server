/**
 * Broker-side ADAPTER onto the ONE ffmpeg argv builder.
 *
 * This file used to CONTAIN a builder (`buildFfmpegArgs`) — one of two in the
 * repo for the same job. The other, `buildTranscodeFfmpegArgs` in
 * `webrtc/session.ts`, knew nothing about hardware encoders or `-threads` and
 * served the derived feeder and the WebRTC transcode leg; the two disagreed in
 * the direction that costs CPU. Both are gone. The single builder now lives in
 * `@camstack/types` (`ffmpeg/invocation.ts`), because three separate ADDONS
 * need it and addons may never import each other.
 *
 * What remains here is broker-specific TRANSLATION: the `system-config`
 * `ffmpeg` section, the `hwAccel` setting vocabulary, and the mapping from a
 * probed hardware-encoder set onto an encoder id. None of it emits an argument.
 */
import type { HardwareEncoders, AudioCodecTarget, IScopedLogger } from '@camstack/types'
export type { FfmpegSpawnFn } from '@camstack/types/node'
export { defaultFfmpegSpawn } from '@camstack/types/node'
import {
  buildFfmpegArgs as buildSharedFfmpegArgs,
  AUDIO_PRESETS,
  type FfmpegInvocation,
  type FfmpegSink,
  type FfmpegAudioSidecar,
  type FfmpegVideoEncoderId,
  type FfmpegHwEncodeDevice,
} from '@camstack/types'

/**
 * The `system-config` `ffmpeg.hwAccel` (or per-source-stream) decode preference.
 *
 * - `'copy'` / `'none'` — software decode (no `-hwaccel`).
 * - `'auto'` — emit the LITERAL `-hwaccel auto`: ffmpeg picks a backend itself
 *   and falls back to software in-process when a frame can't be hw-decoded.
 * - a specific backend — force it, gated against what the build supports.
 */
export type FfmpegHwAccelSetting =
  | 'auto'
  | 'copy'
  | 'none'
  | 'videotoolbox'
  | 'vaapi'
  | 'qsv'
  | 'cuda'

/** The decode preference settings that pin (or skip) a specific backend. */
export type FfmpegHwAccelPrefer = Exclude<FfmpegHwAccelSetting, 'auto' | 'copy'>

/** The full set of hwaccel settings (for validation + option surfaces). */
export const FFMPEG_HW_ACCEL_SETTINGS: readonly FfmpegHwAccelSetting[] = [
  'auto',
  'copy',
  'none',
  'videotoolbox',
  'vaapi',
  'qsv',
  'cuda',
]

/**
 * Classify a decode `hwAccel` setting into one resolution strategy:
 * - `'auto'` → the LITERAL `-hwaccel auto` (never collapsed to a backend);
 * - `'copy'` / `'none'` → software (no `-hwaccel`);
 * - a specific backend → gated through {@link pickDecodeHwAccel}.
 */
export type DecodeHwAccelStrategy =
  | { readonly kind: 'auto' }
  | { readonly kind: 'software' }
  | { readonly kind: 'specific'; readonly prefer: FfmpegHwAccelPrefer }

export function classifyDecodeHwAccel(setting: FfmpegHwAccelSetting): DecodeHwAccelStrategy {
  if (setting === 'auto') return { kind: 'auto' }
  if (setting === 'copy' || setting === 'none') return { kind: 'software' }
  return { kind: 'specific', prefer: setting }
}

/** Resolved `system-config` `ffmpeg` section the broker spawns against. */
export interface FfmpegSystemConfig {
  /**
   * The node's pinned ffmpeg (D540) — passed to `spawn`, never into the arg
   * list. `null` until the addon resolved it, and after a resolution that
   * FAILED: every child then refuses through {@link requireBrokerFfmpeg}. It
   * used to default to `'ffmpeg'`, so a failed resolution quietly ran the
   * HOST's binary for every transcode on the node.
   */
  readonly binaryPath: string | null
  /** `ffmpeg.hwAccel` — drives decode `prefer` + encoder forcing. */
  readonly hwAccel: FfmpegHwAccelSetting
  /** `ffmpeg.threadCount` — `0` = auto (let ffmpeg decide). */
  readonly threadCount: number
}

/** Who is asking for the broker's ffmpeg, for the refusal line. */
export interface BrokerFfmpegAsk {
  readonly logger: IScopedLogger
  /** The camera the child would serve; `null` only when none can be named. */
  readonly deviceId: number | null
  /** What would have been spawned, e.g. `'egress transcode'`. */
  readonly purpose: string
  /** Told about the refusal, so the host can ask for the binary again. */
  readonly onMissing?: () => void
}

/**
 * The binary to spawn, or a THROW after an ERROR naming the camera and the
 * child that was refused. Never a PATH name (D540).
 */
export function requireBrokerFfmpeg(binaryPath: string | null, ask: BrokerFfmpegAsk): string {
  if (binaryPath !== null) return binaryPath
  ask.logger.error(`${ask.purpose} refused — no pinned ffmpeg on this node (D540)`, {
    ...(ask.deviceId !== null ? { tags: { deviceId: ask.deviceId } } : {}),
  })
  ask.onMissing?.()
  throw new Error(`${ask.purpose}: no pinned ffmpeg resolved on this node`)
}

/** Audio codecs that can be muxed into an RTP sidecar output. */
export type AudioSidecarCodec = Extract<AudioCodecTarget, 'aac' | 'opus' | 'pcmu'>

/** Narrow an audio target to a sidecar-capable codec, or `null` (copy/none). */
export function toAudioSidecarCodec(audio: AudioCodecTarget): AudioSidecarCodec | null {
  return audio === 'aac' || audio === 'opus' || audio === 'pcmu' ? audio : null
}

/** The broker's transcode request, in the cap's vocabulary. */
export interface FfmpegTranscodeInvocation {
  readonly sourceUrl: string
  readonly targetCodec: 'H264' | 'H265'
  readonly encoder: FfmpegVideoEncoderId
  /**
   * The device the hardware ENCODER runs on, from {@link chooseVideoEncoder}.
   * Absent/null ⇒ argv unchanged: no device option, no upload filter.
   */
  readonly hwEncodeDevice?: FfmpegHwEncodeDevice | null
  /** A backend, the literal `'auto'`, or a software sentinel. */
  readonly decodeHwAccel: string | null
  readonly scale: { readonly width: number; readonly height: number } | null
  readonly audio: AudioCodecTarget
  /** `0` = auto (omit `-threads`). */
  readonly threadCount: number
  readonly outputArgs: readonly string[]
}

/**
 * Map a `hwAccel` setting to the `prefer` argument of the platform probe for
 * the SPECIFIC-backend case only.
 *
 * @deprecated Prefer {@link classifyDecodeHwAccel} for the full branching.
 */
export function hwAccelSettingToPrefer(setting: FfmpegHwAccelSetting): FfmpegHwAccelPrefer | null {
  if (setting === 'auto' || setting === 'copy') return null
  return setting
}

/**
 * Pick the decode `-hwaccel` backend, gated by what the configured ffmpeg
 * binary actually supports. Conservative by design:
 * - empty `preferred` → `null` (software);
 * - empty `supportedMethods` (probe miss) → keep the top preference and let the
 *   per-stream software fallback cover failures;
 * - otherwise the first preference the build supports, else `null`.
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

const KNOWN_ENCODERS: ReadonlySet<string> = new Set<FfmpegVideoEncoderId>([
  'libx264',
  'libx265',
  'h264_videotoolbox',
  'hevc_videotoolbox',
  'h264_vaapi',
  'hevc_vaapi',
  'h264_qsv',
  'hevc_qsv',
  'h264_nvenc',
  'hevc_nvenc',
  'h264_amf',
  'hevc_amf',
])

/** Type guard — an encoder id the shared builder knows how to emit. */
function isKnownEncoder(value: string): value is FfmpegVideoEncoderId {
  return KNOWN_ENCODERS.has(value)
}

/**
 * Pick the video encoder, honouring the `hwAccel` preference. `'none'`/`'copy'`
 * force the software ENCODER too, so a software-decode preference yields a
 * fully software — and therefore maximally compatible — transcode. An encoder
 * the shared builder does not know falls back to software rather than being
 * passed through unchecked.
 */
export function pickVideoEncoder(
  target: 'H264' | 'H265',
  encoders: HardwareEncoders | null,
  hwAccel: FfmpegHwAccelSetting,
): FfmpegVideoEncoderId {
  const software: FfmpegVideoEncoderId = target === 'H264' ? 'libx264' : 'libx265'
  if (hwAccel === 'none' || hwAccel === 'copy' || !encoders) return software
  const picked = target === 'H264' ? encoders.defaultH264 : encoders.defaultH265
  return isKnownEncoder(picked) ? picked : software
}

/** Why a transcode is running on the CPU, when it is. */
export type SoftwareEncodeReason =
  | 'operator-forced-software'
  | 'no-hardware-on-node'
  | 'binary-lacks-encoder'

/** The encoder, the device it needs, and — when it is software — why. */
export interface VideoEncoderChoice {
  readonly encoder: FfmpegVideoEncoderId
  /** Non-null only for a backend that must be handed an explicit device. */
  readonly hwEncodeDevice: FfmpegHwEncodeDevice | null
  /** `null` when the encode runs on hardware. */
  readonly softwareReason: SoftwareEncodeReason | null
}

/**
 * Choose the video encoder — separately from the DECODE preference, which is
 * the whole point.
 *
 * {@link pickVideoEncoder} folded the two together: `hwAccel: 'copy'` meant
 * "software everything". But `copy` is this fleet's decode DEFAULT for a real
 * reason — hardware decode hard-fails on a fragile HEVC source — and it was
 * quietly deciding the encoder as well. On a hub with a working Intel iGPU
 * that put every egress and derived transcode on `libx264`, spending cores
 * this box does not have, while the GPU idled. A software decode can feed a
 * hardware encoder (`hwupload` is exactly that), and the encode is where the
 * CPU goes.
 *
 * Three things can send it back to the CPU, and each is NAMED so the caller
 * can say which — a silent software transcode is the thing this exists to end:
 *
 * - `operator-forced-software` — someone asked for `none`. Honoured.
 * - `no-hardware-on-node` — the hwaccel resolver offers nothing.
 * - `binary-lacks-encoder` — the node has the hardware and THIS ffmpeg cannot
 *   use it. That is a build property, not a resource condition (D536).
 *
 * An UNKNOWN encoder list (`null`, a probe that failed) is not a "no": we
 * could not ask, so the hardware encoder is still attempted and ffmpeg's own
 * failure is the answer. Reading "unknown" as "unsupported" would keep a
 * capable node in software forever on one bad probe.
 */
export function chooseVideoEncoder(input: {
  readonly target: 'H264' | 'H265'
  /** The node's hardware backend from `ctx.kernel.hwaccel`, or `null`. */
  readonly backend: string | null
  /** What `ffmpeg -encoders` said, or `null` when it could not be asked. */
  readonly binaryEncoders: ReadonlySet<string> | null
  readonly hwAccelSetting: FfmpegHwAccelSetting
  /** DRM render node for the backends that need one named. */
  readonly renderNode: string
}): VideoEncoderChoice {
  const software: FfmpegVideoEncoderId = input.target === 'H264' ? 'libx264' : 'libx265'
  const fallback = (reason: SoftwareEncodeReason): VideoEncoderChoice => ({
    encoder: software,
    hwEncodeDevice: null,
    softwareReason: reason,
  })

  if (input.hwAccelSetting === 'none') return fallback('operator-forced-software')
  const backend = input.backend === null ? null : input.backend.toLowerCase()
  if (backend === null) return fallback('no-hardware-on-node')
  const ids = ENCODER_IDS_BY_BACKEND[backend]
  if (!ids) return fallback('no-hardware-on-node')
  const encoder = input.target === 'H264' ? ids.h264 : ids.h265
  if (input.binaryEncoders !== null && !input.binaryEncoders.has(encoder)) {
    return fallback('binary-lacks-encoder')
  }
  return {
    encoder,
    // Only VAAPI has to be handed a device and fed uploaded frames; the others
    // take software frames as they are, and a device flag for a backend that
    // does not want one is a flag the child rejects.
    hwEncodeDevice: backend === 'vaapi' ? { kind: 'vaapi', renderNode: input.renderNode } : null,
    softwareReason: null,
  }
}

/**
 * The h264/hevc hardware ENCODER ids for a decode-hwaccel backend name — a
 * static, deterministic map (platform → encoder, no probe).
 */
const ENCODER_IDS_BY_BACKEND: Readonly<
  Record<string, { readonly h264: FfmpegVideoEncoderId; readonly h265: FfmpegVideoEncoderId }>
> = {
  videotoolbox: { h264: 'h264_videotoolbox', h265: 'hevc_videotoolbox' },
  vaapi: { h264: 'h264_vaapi', h265: 'hevc_vaapi' },
  cuda: { h264: 'h264_nvenc', h265: 'hevc_nvenc' },
  nvdec: { h264: 'h264_nvenc', h265: 'hevc_nvenc' },
  qsv: { h264: 'h264_qsv', h265: 'hevc_qsv' },
  amf: { h264: 'h264_amf', h265: 'hevc_amf' },
}

/**
 * Build the {@link HardwareEncoders} default pair for THIS node's decode
 * backend, resolved LOCALLY from `ctx.kernel.hwaccel` — WITHOUT probing
 * `ffmpeg -encoders` through the `platform-probe` singleton, whose per-node
 * `nodePin` does not survive a forked agent child's link chain (it answers with
 * the HUB's encoders). Returns `null` for software / an unmapped backend.
 */
export function localHardwareEncoders(backend: string | null): HardwareEncoders | null {
  if (backend === null) return null
  const ids = ENCODER_IDS_BY_BACKEND[backend.toLowerCase()]
  if (!ids) return null
  return { encoders: [], defaultH264: ids.h264, defaultH265: ids.h265, probedAt: Date.now() }
}

/**
 * Translate the broker's transcode request into the shared
 * {@link FfmpegInvocation}. Emits no arguments itself — `buildFfmpegArgs` from
 * `@camstack/types` does that, and it is the only thing that may.
 *
 * One broker-specific decision lives here: the broker scales with an EXACT
 * filter (`scale=W:H`), because its callers have already picked a source
 * stream whose aspect matches the target. The `EncodeProfile` path uses
 * fit-inside instead, where the target geometry is a downstream BUDGET.
 */
export function brokerTranscodeInvocation(
  inv: FfmpegTranscodeInvocation,
): Omit<FfmpegInvocation, 'sink' | 'audioSidecar'> {
  return {
    logLevel: 'warning',
    decodeHwAccel: inv.decodeHwAccel,
    ...(inv.hwEncodeDevice ? { hwEncodeDevice: inv.hwEncodeDevice } : {}),
    input: { url: inv.sourceUrl, rtspTransport: 'tcp' },
    video: {
      kind: 'encode',
      encoder: inv.encoder,
      scale: inv.scale ? { mode: 'exact', width: inv.scale.width, height: inv.scale.height } : null,
    },
    audio: audioPlanFromTarget(inv.audio),
    threadCount: inv.threadCount,
    outputArgs: inv.outputArgs,
  }
}

/** Map the cap's `AudioCodecTarget` vocabulary onto the shared audio plan. */
function audioPlanFromTarget(audio: AudioCodecTarget): FfmpegInvocation['audio'] {
  if (audio === 'none') return { kind: 'none' }
  if (audio === 'copy') return { kind: 'copy' }
  if (audio === 'aac' || audio === 'opus' || audio === 'pcmu') return AUDIO_PRESETS[audio]
  return AUDIO_PRESETS.aac
}

/**
 * Assemble the egress argv. A one-line DELEGATION on purpose: the egress owns
 * the SINK (it allocates the restreamer and the sidecar port), the shared
 * builder owns every ARGUMENT. This must never grow argument logic of its own
 * — `scripts/check-ffmpeg-primitive.ts` refuses a second builder.
 */
export function buildBrokerEgressArgs(
  invocation: Omit<FfmpegInvocation, 'sink' | 'audioSidecar'>,
  sink: FfmpegSink,
  audioSidecar: FfmpegAudioSidecar | null,
): string[] {
  return buildSharedFfmpegArgs({ ...invocation, sink, audioSidecar })
}
