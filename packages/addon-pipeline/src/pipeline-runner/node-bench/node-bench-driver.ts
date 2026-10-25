/**
 * The node benchmark measurement (D791), run by the runner ON the node under
 * test. Pure orchestration over injected effects — the addon supplies the
 * in-process `runPipeline`, the clock and the samplers; tests supply fakes.
 *
 * `device` — per device × candidate detector: root only (`plane: 'frame'`,
 * the live per-frame shape), the open-loop pacer of the capacity ramp
 * (`executeCapacityRamp`) at the camera rate, K streams 1, 2, 4, …; a step
 * passes while the p95 latency stays inside the FRAME INTERVAL, drops ≤ 1 %,
 * no event-loop stall and no error. `kMax` is the last passing K.
 *
 * `pipeline` — per device, its first candidate with the operator's detail
 * steps (`plane: 'full'`: root + crop children, faces, plates, classifiers,
 * CLIP…) on the same varied frames; K parallel sessions 1, 2, 3, …; the same
 * gate plus the node's CPU (≤ 85 %) and free RAM (≥ 15 %). `maxSessions` is
 * the last passing K; `stepsFired` names the detail steps that ran at least
 * once (a step that never ran measured nothing — the orchestrator drops the
 * cell).
 *
 * Every dispatch reads the NEXT frame of the ring, so the content — and the
 * detail-plane work it triggers — varies like a real scene. Nothing here
 * writes: the executor is called directly, no result is emitted on the bus.
 */
import {
  DEVICE_RAMP,
  type NodeBenchCell,
  type NodeBenchDeviceCell,
  type NodeBenchLimit,
  type NodeBenchPipelineCell,
  type NodeBenchProgress,
  type NodeBenchRampStep,
  type NodeBenchRunnerInput,
  PIPELINE_RAMP,
  type PipelineStepInputOutput,
} from '@camstack/types'
import {
  type CapacityDispatchOutcome,
  type CapacityRampStep,
  type CapacityStallWindow,
  executeCapacityRamp,
  percentile,
} from '../capacity/capacity-runner.js'

/** One decoded frame, raw RGB at the detection size. */
export interface BenchFrame {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

/** What one dispatch returned, reduced to what the measurement needs. */
export interface BenchDispatchResult {
  readonly shed: boolean
  readonly detections: number
  readonly inferMs: number
  readonly predictMs: number
  /** Step ids that ran on this frame (from the executor's step timings). */
  readonly stepsRan: readonly string[]
}

export interface NodeBenchDriverDeps {
  readonly input: NodeBenchRunnerInput
  readonly frames: readonly BenchFrame[]
  readonly dispatch: (args: {
    readonly steps: readonly PipelineStepInputOutput[]
    readonly deviceKey: string
    readonly plane: 'frame' | 'full'
    readonly frame: BenchFrame
  }) => Promise<BenchDispatchResult>
  /** The `pipeline` measurement's tree for a root model (built from the node's catalog). */
  readonly pipelineSteps: (rootModelId: string) => Promise<readonly PipelineStepInputOutput[]>
  readonly now: () => number
  readonly sleepUntil: (t: number) => Promise<void>
  readonly shouldStop: () => boolean
  readonly stallSnapshot: () => CapacityStallWindow
  readonly rssMb: () => number
  /** Node CPU % since the previous call, and free RAM %. */
  readonly sampleSystem: () => { readonly cpuPct: number; readonly ramFreePct: number }
  readonly onProgress: (progress: NodeBenchProgress) => void
  readonly onCell: (cell: NodeBenchCell) => void
}

/** Node-wide limits the `pipeline` measurement must stay inside. */
export const PIPELINE_CPU_MAX_PCT = 85
export const PIPELINE_RAM_FREE_MIN_PCT = 15
const WARMUP_CALLS = 3

const DETECTOR_STEP = 'object-detection'

function rootOnly(modelId: string): PipelineStepInputOutput[] {
  return [{ addonId: DETECTOR_STEP, modelId, enabled: true, children: [] }]
}

/** Which limit a failing step hit first, from its reasons. */
export function limitOf(reasons: readonly string[]): NodeBenchLimit {
  const has = (prefix: string): boolean => reasons.some((r) => r.startsWith(prefix))
  if (has('errors') || has('unresolved')) return 'errors'
  if (has('cpu')) return 'cpu'
  if (has('ram')) return 'ram'
  if (has('event-loop')) return 'stall'
  if (has('e2e p95')) return 'p95'
  if (has('dropRatio')) return 'drops'
  return 'none'
}

function rampStepOf(
  step: CapacityRampStep,
  measureSec: number,
  system: { cpuPct: number; ramFreePct: number } | null,
): NodeBenchRampStep {
  return {
    load: step.cameras,
    pass: step.verdict.pass,
    p95Ms: Math.round(step.verdict.e2eMs.p95 * 10) / 10,
    dropRatio: Math.round(step.verdict.dropRatio * 10000) / 10000,
    fps: Math.round((step.raw.completed / Math.max(measureSec, 1e-9)) * 10) / 10,
    cpuPct: system?.cpuPct ?? null,
    ramFreePct: system?.ramFreePct ?? null,
    failReasons: step.verdict.failReasons,
  }
}

export class NodeBenchDriver {
  private frameIndex = 0
  private cellsDone = 0
  private readonly cellsTotal: number

  constructor(private readonly deps: NodeBenchDriverDeps) {
    const { input } = deps
    const deviceCells = input.phases.includes('device')
      ? input.devices.reduce((n, d) => n + d.modelIds.length, 0)
      : 0
    const pipelineCells = input.phases.includes('pipeline') ? input.devices.length : 0
    this.cellsTotal = deviceCells + pipelineCells
  }

  private nextFrame(): BenchFrame {
    const frames = this.deps.frames
    const frame = frames[this.frameIndex % frames.length]
    this.frameIndex += 1
    if (frame === undefined) throw new Error('node bench: no frames')
    return frame
  }

  private progress(p: Omit<NodeBenchProgress, 'cellsDone' | 'cellsTotal'>): void {
    this.deps.onProgress({ ...p, cellsDone: this.cellsDone, cellsTotal: this.cellsTotal })
  }

  private async warmup(
    steps: readonly PipelineStepInputOutput[],
    deviceKey: string,
    plane: 'frame' | 'full',
  ): Promise<number> {
    const t0 = this.deps.now()
    let firstMs = 0
    for (let i = 0; i < WARMUP_CALLS; i++) {
      const started = this.deps.now()
      await this.deps.dispatch({ steps, deviceKey, plane, frame: this.nextFrame() })
      if (i === 0) firstMs = this.deps.now() - started
    }
    return Math.max(firstMs, 0) || this.deps.now() - t0
  }

  private ramp(opts: {
    readonly loads: readonly number[]
    readonly steps: readonly PipelineStepInputOutput[]
    readonly deviceKey: string
    readonly plane: 'frame' | 'full'
    readonly withSystemGate: boolean
    readonly onStepsRan?: (ran: readonly string[]) => void
    readonly label: Omit<NodeBenchProgress, 'cellsDone' | 'cellsTotal' | 'load' | 'message'>
  }): Promise<{
    steps: CapacityRampStep[]
    system: Map<number, { cpuPct: number; ramFreePct: number }>
    aborted: boolean
  }> {
    const { input } = this.deps
    const frameIntervalMs = 1000 / input.fpsPerStream
    const system = new Map<number, { cpuPct: number; ramFreePct: number }>()
    const dispatch = async (): Promise<CapacityDispatchOutcome> => {
      const r = await this.deps.dispatch({
        steps: opts.steps,
        deviceKey: opts.deviceKey,
        plane: opts.plane,
        frame: this.nextFrame(),
      })
      opts.onStepsRan?.(r.stepsRan)
      if (r.shed) return { kind: 'shed', shedSignal: 'first-class' }
      return { kind: 'ok', inferMs: r.inferMs, predictMs: r.predictMs, detections: r.detections }
    }
    return executeCapacityRamp({
      ramp: opts.loads,
      fpsPerCamera: input.fpsPerStream,
      settleMs: input.settleSec * 1000,
      measureMs: input.measureSec * 1000,
      drainTimeoutMs: Math.max(5000, frameIntervalMs * 20),
      slo: { dropRatioMax: 0.01, e2eP95MsMax: frameIntervalMs, stallsMax: 0 },
      stopOnFirstFail: true,
      dispatch,
      now: this.deps.now,
      sleepUntil: this.deps.sleepUntil,
      shouldStop: this.deps.shouldStop,
      stallSnapshot: this.deps.stallSnapshot,
      rssMb: this.deps.rssMb,
      ...(opts.withSystemGate
        ? {
            extraFailReasons: (step: CapacityRampStep): readonly string[] => {
              const s = this.deps.sampleSystem()
              system.set(step.cameras, s)
              const out: string[] = []
              if (s.cpuPct > PIPELINE_CPU_MAX_PCT) {
                out.push(`cpu ${Math.round(s.cpuPct)}% > ${PIPELINE_CPU_MAX_PCT}%`)
              }
              if (s.ramFreePct < PIPELINE_RAM_FREE_MIN_PCT) {
                out.push(`ram free ${Math.round(s.ramFreePct)}% < ${PIPELINE_RAM_FREE_MIN_PCT}%`)
              }
              return out
            },
            onMeasureStartHook: () => {
              this.deps.sampleSystem()
            },
          }
        : {}),
      onStep: (info) => {
        if (info.phase === 'done') return
        this.progress({
          ...opts.label,
          load: info.cameras,
          message: `${opts.label.phase === 'device' ? 'streams' : 'sessions'} ${info.cameras} · ${info.phase}`,
        })
      },
    }).then((outcome) => ({ steps: [...outcome.steps], system, aborted: outcome.aborted }))
  }

  /** A cell whose ramp was cut short measured nothing reliable — null. */
  private async measureDevice(
    deviceKey: string,
    modelId: string,
  ): Promise<NodeBenchDeviceCell | null> {
    const steps = rootOnly(modelId)
    const label = { phase: 'device' as const, deviceKey, modelId }
    this.progress({ ...label, load: null, message: 'loading the model' })
    const warmupMs = await this.warmup(steps, deviceKey, 'frame')
    const { steps: ramp, aborted } = await this.ramp({
      loads: DEVICE_RAMP,
      steps,
      deviceKey,
      plane: 'frame',
      withSystemGate: false,
      label,
    })
    if (aborted) return null
    const passing = ramp.filter((s) => s.verdict.pass)
    const last = passing.at(-1)
    const first = ramp[0]
    const failed = ramp.find((s) => !s.verdict.pass)
    const single = first?.raw.e2eMsList ?? []
    return {
      phase: 'device',
      deviceKey,
      modelId,
      p50Ms: Math.round(percentile(single, 0.5) * 10) / 10,
      p95Ms: Math.round(percentile(single, 0.95) * 10) / 10,
      p99Ms: Math.round(percentile(single, 0.99) * 10) / 10,
      fps:
        last === undefined
          ? 0
          : Math.round((last.raw.completed / this.deps.input.measureSec) * 10) / 10,
      kMax: last?.cameras ?? 0,
      limitedBy: failed === undefined ? 'none' : limitOf(failed.verdict.failReasons),
      warmupMs: Math.round(warmupMs),
      ramp: ramp.map((s) => rampStepOf(s, this.deps.input.measureSec, null)),
    }
  }

  private async measurePipeline(
    deviceKey: string,
    modelId: string,
  ): Promise<NodeBenchPipelineCell | null> {
    const steps = await this.deps.pipelineSteps(modelId)
    const label = { phase: 'pipeline' as const, deviceKey, modelId }
    this.progress({ ...label, load: null, message: 'loading the pipeline' })
    const fired = new Set<string>()
    const warmupMs = await this.warmup(steps, deviceKey, 'full')
    const {
      steps: ramp,
      system,
      aborted,
    } = await this.ramp({
      loads: PIPELINE_RAMP,
      steps,
      deviceKey,
      plane: 'full',
      withSystemGate: true,
      onStepsRan: (ran) => {
        for (const s of ran) fired.add(s)
      },
      label,
    })
    if (aborted) return null
    const last = ramp.filter((s) => s.verdict.pass).at(-1)
    const failed = ramp.find((s) => !s.verdict.pass)
    return {
      phase: 'pipeline',
      deviceKey,
      modelId,
      steps: this.deps.input.steps,
      maxSessions: last?.cameras ?? 0,
      limitedBy: failed === undefined ? 'none' : limitOf(failed.verdict.failReasons),
      stepsFired: this.deps.input.steps.filter((s) => fired.has(s)),
      warmupMs: Math.round(warmupMs),
      ramp: ramp.map((s) =>
        rampStepOf(s, this.deps.input.measureSec, system.get(s.cameras) ?? null),
      ),
    }
  }

  /** Run every cell the input asks for; stops between steps when told to. */
  async run(): Promise<void> {
    const { input } = this.deps
    if (input.phases.includes('device')) {
      for (const device of input.devices) {
        for (const modelId of device.modelIds) {
          if (this.deps.shouldStop()) return
          const cell = await this.measureDevice(device.deviceKey, modelId)
          this.cellsDone += 1
          if (cell !== null) this.deps.onCell(cell)
        }
      }
    }
    if (input.phases.includes('pipeline')) {
      for (const device of input.devices) {
        const modelId = device.modelIds[0]
        if (modelId === undefined || this.deps.shouldStop()) return
        const cell = await this.measurePipeline(device.deviceKey, modelId)
        this.cellsDone += 1
        if (cell !== null) this.deps.onCell(cell)
      }
    }
  }
}
