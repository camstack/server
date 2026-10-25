/**
 * Hardware-accelerated DECODE for the HomeKit transcode path.
 *
 * ## Why decode, and why only decode
 *
 * `stream-bitrate.ts` transcodes only when the source cannot be passed through
 * — in practice an H.265 camera, because iOS Home renders only H.264 over the
 * classic HAP SRTP path. That branch was pure software on both halves, and the
 * decode half is the expensive one: a 4K→1080p session measured **77 % of one
 * core, dominated by decode**, on a hub already running 70-95 % main-thread
 * with 42 s of synchronous blocks per 120 s.
 *
 * **Encode stays on `libx264`, deliberately.** Two of the four causes of the
 * year-long HomeKit failure were an absent `-g` and absent in-band SPS/PPS, and
 * both are load-bearing on the encoder: `h264_vaapi` / `h264_qsv` carry their
 * own rate-control model, do not accept `-profile:v baseline`, and emit
 * parameter sets on their own schedule rather than x264's. Swapping the encoder
 * would put those two back in play, and there is no hardware in this repo's
 * test environment to prove they still hold. Decode alone is where the measured
 * cost is, and it changes nothing about the bitstream that reaches iOS.
 *
 * ## Probe, never assume
 *
 * The backend is NOT chosen here. It is read from the decoder addon's own
 * per-node probe (`decoder.getInfo` → `hwaccel` / `probedBestHwaccel`, stored
 * as `probedBestHwaccel@<node>`), which is the single opinion the rest of the
 * fleet already runs on — `AgentLoadService` reads exactly the same value.
 * A `-hwaccel qsv` on a node without that device does not degrade the stream,
 * it kills ffmpeg at spawn.
 *
 * That is also why the local `ctx.kernel.hwaccel.resolve()` is deliberately NOT
 * used as a second guess. Its `preferred[0]` on an Intel host is `qsv`, while
 * the decoder addon's ranking puts `vaapi` first *on this exact hardware*
 * because qsv children exit `code=171` producing no frames. Falling back to the
 * raw resolver would reintroduce the failure the ranking exists to avoid, so
 * the fallback is software.
 *
 * Everything here is pure; the cap read lives in `stream-hwaccel-probe.ts`.
 */
import type { HwAccelBackend } from '@camstack/types'
import { HWACCEL_OPTIONS } from '@camstack/types'

/**
 * The DRM render node a VAAPI/QSV decode binds to.
 *
 * Same default the decoder addons use. Named rather than inlined because a
 * multi-GPU host needs the second node and an operator has to be able to see
 * which one was dialled in the log.
 */
export const DEFAULT_RENDER_DEVICE = '/dev/dri/renderD128'

/**
 * How long after spawn an exit still counts as "hardware init failed".
 *
 * Same window the ffmpeg decoder addon uses for its own cascade. A hardware
 * context that cannot be created fails within milliseconds; anything that ran
 * longer produced no frames for a different reason, and re-spawning it in
 * software would just hide that reason.
 */
export const HW_DECODE_FALLBACK_WINDOW_MS = 4_000

/** Backends whose decode binds to a DRM render node. */
const RENDER_NODE_BACKENDS: readonly HwAccelBackend[] = ['vaapi', 'qsv']

/**
 * Values of the decoder cap's `hwaccel` field that are operator CHOICES rather
 * than devices.
 */
const HWACCEL_NON_BACKEND_CHOICES: readonly string[] = ['auto', 'none']

/**
 * Every backend the decoder cap can publish, taken from the cap's own UI option
 * list so this module cannot drift from it. A hand-written copy of the union is
 * exactly the "hand-written cap interface that rots silently" this repo has
 * been bitten by.
 */
const HWACCEL_BACKENDS: ReadonlySet<string> = new Set(
  HWACCEL_OPTIONS.map((option) => option.value).filter(
    (value) => !HWACCEL_NON_BACKEND_CHOICES.includes(value),
  ),
)

/** Is this string a hardware backend, as opposed to `auto`, `none` or junk? */
export function isHwAccelBackend(value: string): value is HwAccelBackend {
  return HWACCEL_BACKENDS.has(value)
}

/** What `decoder.getInfo` told us about this node. */
export interface DecoderHwaccelReading {
  /** The operator's explicit choice: a backend, `auto`, or `none`. */
  readonly hwaccel: string | null
  /** What the node's own probe found. Empty when it has never run. */
  readonly probedBestHwaccel: string | null
}

/** Which of the two decoder fields supplied the backend. */
export type HwDecodeSource = 'operator' | 'probed'

/** Why a session is decoding in software. Every one of these is logged. */
export type HwDecodeSkipReason =
  | 'pass-through'
  | 'operator-disabled'
  | 'not-probed'
  | 'unrecognised-backend'
  | 'no-decoder-reading'
  | 'hardware-attempt-failed'

export interface HwDecodeHardware {
  readonly kind: 'hardware'
  readonly backend: HwAccelBackend
  readonly source: HwDecodeSource
  /**
   * The VALUE `-hwaccel` takes — `'auto'` on macOS (see {@link decodeArgs}),
   * otherwise the backend. Handed to the shared builder's `decodeHwAccel`,
   * which is the ONLY thing allowed to emit the flag, and only before `-i`.
   */
  readonly hwaccel: string
  /**
   * Input options that travel WITH `-hwaccel` (`-hwaccel_device …`). Passed as
   * the shared input plan's `extraArgs`, which the builder emits after
   * `-hwaccel` and still strictly before `-i`.
   */
  readonly extraInputArgs: readonly string[]
  /** `['-hwaccel', hwaccel, ...extraInputArgs]` — for the log line. */
  readonly args: readonly string[]
}

export interface HwDecodeSoftware {
  readonly kind: 'software'
  readonly reason: HwDecodeSkipReason
  /** `null` ⇒ the shared builder emits no `-hwaccel` at all. */
  readonly hwaccel: null
  readonly extraInputArgs: readonly string[]
  readonly args: readonly string[]
}

export type HwDecodeDecision = HwDecodeHardware | HwDecodeSoftware

export interface SelectHwDecodeInput {
  /** Only the transcode branch decodes; `-c:v copy` never does. */
  readonly transcode: boolean
  /** `decoder.getInfo` for THIS node, or `null` when it could not be read. */
  readonly reading: DecoderHwaccelReading | null
  /** `process.platform`, injected so the macOS rule is testable. */
  readonly platform: NodeJS.Platform
  readonly renderDevice?: string
  /** A hardware attempt in THIS session already died at init. */
  readonly hardwareAlreadyFailed?: boolean
  /**
   * A backend that died at init in THIS PROCESS inside the memo window
   * (`stream-hwaccel-memo.ts`), or `null`.
   *
   * Per-backend rather than a blanket "hardware failed": a host whose vaapi is
   * out of memory may still have a working qsv, and writing hardware off
   * wholesale would be a downgrade nobody asked for. It overrides the
   * operator's explicit pin too — a device that cannot be created is not made
   * creatable by being named.
   */
  readonly recentlyFailedBackend?: string | null
}

/**
 * Decide how this session decodes, and produce the ffmpeg input-side flags.
 *
 * Every path that ends in software carries a named reason, because a session
 * that quietly stopped using the GPU and a session that never had one look
 * identical in a CPU graph.
 */
export function selectHwDecode(input: SelectHwDecodeInput): HwDecodeDecision {
  if (!input.transcode) return software('pass-through')
  if (input.hardwareAlreadyFailed === true) return software('hardware-attempt-failed')
  if (input.reading === null) return software('no-decoder-reading')

  const chosen = (input.reading.hwaccel ?? '').trim()
  if (chosen === 'none') return software('operator-disabled')
  if (chosen !== '' && chosen !== 'auto') {
    return isHwAccelBackend(chosen)
      ? hardware(chosen, 'operator', input)
      : software('unrecognised-backend')
  }

  const probed = (input.reading.probedBestHwaccel ?? '').trim()
  // The decoder writes the literal string `none` when its probe found nothing,
  // and `''` when it has never run. Both mean the same thing here.
  if (probed === '' || probed === 'none') return software('not-probed')
  return isHwAccelBackend(probed)
    ? hardware(probed, 'probed', input)
    : software('unrecognised-backend')
}

export interface HwDecodeFailureInput {
  readonly usedHardware: boolean
  readonly hardwareAlreadyFailed: boolean
  readonly stopRequestedByController: boolean
  readonly videoPacketsForwarded: number
  /** Wall time between spawn and exit. */
  readonly runtimeMs: number
}

/**
 * Did this ffmpeg exit look like a failed hardware init, rather than a
 * teardown or a fault software would hit too?
 *
 * All five conditions are necessary. Dropping the controller-stop check in
 * particular would respawn on every normal teardown, because iOS restarts a
 * session it is not enjoying and that is indistinguishable at the exit code.
 */
export function shouldRetryInSoftware(input: HwDecodeFailureInput): boolean {
  if (!input.usedHardware) return false
  if (input.hardwareAlreadyFailed) return false
  if (input.stopRequestedByController) return false
  if (input.videoPacketsForwarded > 0) return false
  return input.runtimeMs <= HW_DECODE_FALLBACK_WINDOW_MS
}

export function software(reason: HwDecodeSkipReason): HwDecodeSoftware {
  return { kind: 'software', reason, hwaccel: null, extraInputArgs: [], args: [] }
}

function hardware(
  backend: HwAccelBackend,
  source: HwDecodeSource,
  input: SelectHwDecodeInput,
): HwDecodeDecision {
  // A backend that produced nothing minutes ago is not tried again until the
  // memo expires. Checked HERE rather than at the top because the check is
  // per-backend: the failure of one device says nothing about another.
  if (input.recentlyFailedBackend === backend) return software('hardware-attempt-failed')
  const { hwaccel, extraInputArgs } = decodePlan(backend, input)
  return {
    kind: 'hardware',
    backend,
    source,
    hwaccel,
    extraInputArgs,
    args: ['-hwaccel', hwaccel, ...extraInputArgs],
  }
}

/** The `-hwaccel` value and the input options that must accompany it. */
interface HwDecodePlan {
  readonly hwaccel: string
  readonly extraInputArgs: readonly string[]
}

/**
 * The input-side decode configuration, and nothing else.
 *
 * No `-hwaccel_output_format`: the decoded frames have to land in system
 * memory for libx264 to scale and encode them. Setting it would keep them on
 * the GPU, which only pays off with a GPU scale filter — and that is the
 * decoder addon's job, not a two-output SRTP session's.
 *
 * The two halves are returned SEPARATELY because the shared argv builder emits
 * `-hwaccel` itself (it is the only function allowed to, so the flag cannot
 * drift past `-i`) and takes everything else as the input plan's `extraArgs`.
 */
function decodePlan(backend: HwAccelBackend, input: SelectHwDecodeInput): HwDecodePlan {
  // macOS: `-hwaccel auto` rather than the explicit backend. Carried over from
  // the ffmpeg decoder addon, which found that an explicit
  // `-hwaccel videotoolbox` tears down under several concurrent decode
  // children while `auto` selects VideoToolbox anyway.
  if (backend === 'videotoolbox' && input.platform === 'darwin') {
    return { hwaccel: 'auto', extraInputArgs: [] }
  }
  return {
    hwaccel: backend,
    extraInputArgs: RENDER_NODE_BACKENDS.includes(backend)
      ? ['-hwaccel_device', input.renderDevice ?? DEFAULT_RENDER_DEVICE]
      : [],
  }
}
