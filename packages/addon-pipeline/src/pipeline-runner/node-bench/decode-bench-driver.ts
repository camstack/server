/**
 * The `decode` measurement of the node benchmark (D1078), run by the runner
 * ON the node under test. Pure orchestration over an injected rig — the addon
 * supplies the real one (an encoded camera-like stream served on the loopback
 * and decoded by the session decode workers, `decode-bench-rig.ts`), tests
 * supply a simulated node.
 *
 * Per profile (a resolution, a frame rate, a codec): N concurrent streams
 * 1, 2, 3, 4, 6, …; a step HOLDS while
 *
 *  - every stream delivered at least {@link DECODE_MIN_FPS_RATIO} of the
 *    profile frame rate over the accounted window,
 *  - the frames of every stream arrived no later than
 *    {@link DECODE_MAX_FRAME_AGE_MS} after they were shot (p95),
 *  - no stream failed or never started, the event loop did not stall,
 *  - the node's CPU (≤ 85 %) and free RAM (≥ 15 %) stayed inside the limits
 *    the `pipeline` measurement uses.
 *
 * `maxStreams` is the last load that held. A ramp cut short measured nothing
 * reliable and yields no cell; a profile the node cannot be offered (no
 * encoder for the synthetic source, no decode worker) is SKIPPED with its
 * reason and yields no cell either — never a zero.
 */
import {
  DECODE_MAX_FRAME_AGE_MS,
  DECODE_MIN_FPS_RATIO,
  DECODE_RAMP,
  decodeProfileId,
  type NodeBenchDecodeCell,
  type NodeBenchDecodeRampStep,
  type NodeBenchLimit,
  type NodeBenchProgress,
  type NodeBenchRunnerInput,
  type NodeDecodeProfile,
} from '@camstack/types'
import type { CapacityStallWindow } from '../capacity/capacity-runner.js'
import { PIPELINE_CPU_MAX_PCT, PIPELINE_RAM_FREE_MIN_PCT } from './node-bench-driver.js'

/** One stream over the accounted window. */
export interface DecodeStreamWindow {
  /** Frames delivered inside the window. */
  readonly frames: number
  /** p95 of (arrival − the frame's own media-clock instant); null with no frame. */
  readonly ageP95Ms: number | null
  /** Worker errors and exits inside the window. */
  readonly errors: number
  /** The backend the stream's worker decodes on; null when it did not say. */
  readonly decoder: string | null
}

export interface DecodeScaleOutcome {
  /** Every stream delivered a first frame. */
  readonly ready: boolean
  readonly reason: string | null
}

/** The streams of ONE profile: grown step by step, torn down once. */
export interface DecodeRig {
  /** Grow to `count` streams; resolves when each decoded a first frame, or one could not. */
  readonly scaleTo: (count: number) => Promise<DecodeScaleOutcome>
  readonly beginWindow: () => void
  readonly endWindow: () => readonly DecodeStreamWindow[]
  /** A motion pass ran on decoded frames since the rig opened. */
  readonly motionRan: () => boolean
  readonly close: () => Promise<void>
}

export type DecodeRigOutcome =
  | { readonly kind: 'ready'; readonly rig: DecodeRig }
  | { readonly kind: 'skipped'; readonly reason: string }

export type DecodeBenchProgress = Omit<NodeBenchProgress, 'cellsDone' | 'cellsTotal'>

export interface DecodeSystemSample {
  readonly cpuPct: number
  readonly ramFreePct: number
}

export interface DecodeBenchDriverDeps {
  readonly input: NodeBenchRunnerInput
  readonly openRig: (profile: NodeDecodeProfile) => Promise<DecodeRigOutcome>
  readonly now: () => number
  readonly sleepUntil: (t: number) => Promise<void>
  readonly shouldStop: () => boolean
  readonly stallSnapshot: () => CapacityStallWindow
  /** Node CPU % since the previous call, and free RAM %. */
  readonly sampleSystem: () => DecodeSystemSample
  readonly onProgress: (progress: DecodeBenchProgress) => void
  readonly onCell: (cell: NodeBenchDecodeCell) => void
  /** A profile was asked for and not measured — `decode <profile>: <reason>`. */
  readonly onSkipped: (reason: string) => void
  /** One profile is finished (measured, skipped or cut short). */
  readonly onProfileDone?: () => void
}

interface StepInput {
  readonly load: number
  readonly profile: NodeDecodeProfile
  readonly windows: readonly DecodeStreamWindow[]
  readonly windowSec: number
  readonly stalls: number
  readonly system: DecodeSystemSample
}

/** How long one wait runs before it looks at an abort again. */
const DECODE_WAIT_SLICE_MS = 250

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Judge one accounted window. Pure. */
export function evaluateDecodeStep(step: StepInput): NodeBenchDecodeRampStep {
  const { windows, profile, system } = step
  const failReasons: string[] = []
  const errors = windows.reduce((n, w) => n + w.errors, 0)
  if (errors > 0) failReasons.push(`errors ${errors}`)
  const minFps =
    windows.length === 0
      ? null
      : round1(Math.min(...windows.map((w) => w.frames)) / Math.max(step.windowSec, 1e-9))
  const minHeld = round1(profile.fps * DECODE_MIN_FPS_RATIO)
  if (minFps === null || minFps < minHeld) {
    failReasons.push(`fps ${minFps ?? 'none'} < ${minHeld} (${profile.fps} fps profile)`)
  }
  const ages = windows.flatMap((w) => (w.ageP95Ms === null ? [] : [w.ageP95Ms]))
  const ageP95Ms = ages.length === 0 ? null : Math.round(Math.max(...ages))
  if (ageP95Ms !== null && ageP95Ms > DECODE_MAX_FRAME_AGE_MS) {
    failReasons.push(`frame age p95 ${ageP95Ms} ms > ${DECODE_MAX_FRAME_AGE_MS} ms`)
  }
  if (step.stalls > 0) failReasons.push(`event-loop stalls ${step.stalls}`)
  if (system.cpuPct > PIPELINE_CPU_MAX_PCT) {
    failReasons.push(`cpu ${Math.round(system.cpuPct)}% > ${PIPELINE_CPU_MAX_PCT}%`)
  }
  if (system.ramFreePct < PIPELINE_RAM_FREE_MIN_PCT) {
    failReasons.push(`ram free ${Math.round(system.ramFreePct)}% < ${PIPELINE_RAM_FREE_MIN_PCT}%`)
  }
  return {
    load: step.load,
    pass: failReasons.length === 0,
    minFps,
    ageP95Ms,
    cpuPct: system.cpuPct,
    ramFreePct: system.ramFreePct,
    failReasons,
  }
}

/** Which limit a failing decode step hit first, from its reasons. */
export function decodeLimitOf(reasons: readonly string[]): NodeBenchLimit {
  const has = (prefix: string): boolean => reasons.some((r) => r.startsWith(prefix))
  if (has('errors') || has('unresolved')) return 'errors'
  if (has('cpu')) return 'cpu'
  if (has('ram')) return 'ram'
  if (has('event-loop')) return 'stall'
  if (has('fps')) return 'fps'
  if (has('frame age')) return 'p95'
  return 'none'
}

/** `vaapi`, or `software+vaapi` when the streams did not all get the same one. */
function decoderLabel(windows: readonly DecodeStreamWindow[]): string {
  const names = new Set(windows.map((w) => w.decoder ?? 'unknown'))
  return [...names].toSorted().join('+')
}

function allHardware(windows: readonly DecodeStreamWindow[]): boolean {
  return windows.length > 0 && windows.every((w) => w.decoder !== null && w.decoder !== 'software')
}

export class DecodeBenchDriver {
  constructor(private readonly deps: DecodeBenchDriverDeps) {}

  private progress(profile: NodeDecodeProfile, load: number | null, what: string): void {
    this.deps.onProgress({
      phase: 'decode',
      deviceKey: null,
      modelId: null,
      load,
      message:
        load === null
          ? `${decodeProfileId(profile)} · ${what}`
          : `${decodeProfileId(profile)} · streams ${load} · ${what}`,
    })
  }

  /** Sleep to `t` in short slices, so an abort does not wait out the window. */
  private async wait(t: number): Promise<void> {
    while (!this.deps.shouldStop()) {
      const left = t - this.deps.now()
      if (left <= 0) return
      await this.deps.sleepUntil(this.deps.now() + Math.min(left, DECODE_WAIT_SLICE_MS))
    }
  }

  /**
   * The cell of one profile; null when the ramp was cut short; a `skipped`
   * reason when the FIRST step failed for a cause that is not a measurement.
   * Only a rate or frame-age failure at load 1 is a measured zero (the node
   * really cannot decode one stream at camera rate); RAM, errors, an
   * unstarted stream, a stall or CPU contention say nothing about the decoder
   * (D393: a failed measurement is null, never 0).
   */
  private async ramp(
    profile: NodeDecodeProfile,
    rig: DecodeRig,
  ): Promise<NodeBenchDecodeCell | { readonly skipped: string } | null> {
    const { input } = this.deps
    const ramp: NodeBenchDecodeRampStep[] = []
    let held: readonly DecodeStreamWindow[] = []
    let seen: readonly DecodeStreamWindow[] = []
    let warmupMs = 0
    for (const load of DECODE_RAMP) {
      if (this.deps.shouldStop()) return null
      this.progress(profile, load, 'starting')
      const startedAt = this.deps.now()
      const scaled = await rig.scaleTo(load)
      if (ramp.length === 0) warmupMs = this.deps.now() - startedAt
      if (this.deps.shouldStop()) return null
      if (!scaled.ready) {
        ramp.push({
          load,
          pass: false,
          minFps: null,
          ageP95Ms: null,
          cpuPct: null,
          ramFreePct: null,
          failReasons: [scaled.reason ?? 'unresolved: a stream did not start'],
        })
        break
      }
      this.progress(profile, load, 'settle')
      await this.wait(this.deps.now() + input.settleSec * 1000)
      if (this.deps.shouldStop()) return null
      this.progress(profile, load, 'measure')
      const stallStart = this.deps.stallSnapshot()
      this.deps.sampleSystem()
      rig.beginWindow()
      const windowStart = this.deps.now()
      await this.wait(windowStart + input.measureSec * 1000)
      if (this.deps.shouldStop()) return null
      const windows = rig.endWindow()
      const step = evaluateDecodeStep({
        load,
        profile,
        windows,
        windowSec: (this.deps.now() - windowStart) / 1000,
        stalls: this.deps.stallSnapshot().count - stallStart.count,
        system: this.deps.sampleSystem(),
      })
      ramp.push(step)
      seen = windows
      if (!step.pass) break
      held = windows
    }
    const failed = ramp.find((s) => !s.pass)
    if (failed !== undefined && failed.load === DECODE_RAMP[0]) {
      const limit = decodeLimitOf(failed.failReasons)
      if (limit !== 'fps' && limit !== 'p95') {
        return { skipped: failed.failReasons.join('; ') }
      }
    }
    // The decoder of the streams that HELD; with none, of the ones that ran.
    const named = held.length > 0 ? held : seen
    return {
      phase: 'decode',
      profile,
      maxStreams: ramp.filter((s) => s.pass).at(-1)?.load ?? 0,
      limitedBy: failed === undefined ? 'none' : decodeLimitOf(failed.failReasons),
      hardware: allHardware(named),
      decoder: decoderLabel(named),
      motion: rig.motionRan(),
      warmupMs: Math.round(warmupMs),
      ramp,
    }
  }

  /** Measure every profile the input names; stops between steps when told to. */
  async run(): Promise<void> {
    for (const profile of this.deps.input.decodeProfiles) {
      if (this.deps.shouldStop()) return
      this.progress(profile, null, 'preparing the stream')
      const opened = await this.deps.openRig(profile)
      if (opened.kind === 'skipped') {
        this.deps.onSkipped(`decode ${decodeProfileId(profile)}: ${opened.reason}`)
        this.deps.onProfileDone?.()
        continue
      }
      try {
        const cell = await this.ramp(profile, opened.rig)
        if (cell === null) {
          // cut short by an abort: nothing to store
        } else if ('skipped' in cell) {
          this.deps.onSkipped(`decode ${decodeProfileId(profile)}: ${cell.skipped}`)
        } else {
          this.deps.onCell(cell)
        }
      } finally {
        await opened.rig.close()
        this.deps.onProfileDone?.()
      }
    }
  }
}
