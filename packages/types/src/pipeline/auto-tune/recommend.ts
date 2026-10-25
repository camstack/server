/**
 * The Auto tune recommender (D745, D755): one detector per node, from ONE
 * family (YOLOv9) for the whole cluster, chosen from static hardware facts ×
 * the measured latency table × a capacity floor. Pure; no benchmark, and no
 * load: nothing here depends on how many sessions ran yesterday.
 *
 * Per node:
 *  1. Classify the hardware (`classifyInferenceHardware`). An unknown class,
 *     an offline node or a node with nothing to recommend is left untouched —
 *     unless the node has its own measurements (below) or a device reported
 *     compute that can be scaled from a measured column (D930).
 *  1b. MEASURED ON THE NODE BEATS THE TABLE (D791), and the table beats an
 *     estimate: a fresh node benchmark result for (device, model) replaces
 *     whatever cell the class or the compute scale produced. A node of
 *     unknown hardware with measurements is recommended from them alone.
 *  2. The node's ACCELERATORS (NPU, iGPU, Neural Engine) that are enabled and
 *     available share ONE model — so a camera's floors never flip with the
 *     device the balancer rotated it onto. A candidate must have a build for
 *     every accelerator's format and a latency cell for each.
 *  3. A candidate FITS a device when the device sustains at least
 *     `minSessionsPerDevice` parallel sessions with it:
 *     ⌊fps × factor × (1 − headroom) / camera fps⌋ ≥ minSessionsPerDevice.
 *     factor is 1 at 10 fps; below that an Intel iGPU uses the measured
 *     overlap (D930).
 *  4. Among candidates that fit everywhere, the most accurate wins (person
 *     recall at the shipped floor); within `RECALL_TIE` of the best, the
 *     fastest wins. That IS the step-down order the data gives: the first
 *     variant down from m-640 is s-640-int8, not m-320. When nothing fits,
 *     the candidate with the most capacity is used and the plan says so.
 *  5. An enabled CPU device (the fallback pool) gets its own pick the same
 *     way. An ENABLED Coral is sized at its one default build
 *     (`CORAL_DEFAULT_MODEL_ID`) from the `coral` column, outside the
 *     accelerator group — it shares no model with it. A DISABLED Coral stays
 *     out like any disabled device; a Coral is enabled by default (D912).
 *  6. A device whose root detector is pinned to a CUSTOM-registry model (a
 *     fine-tune, a canary) is KEPT (D786): no model is chosen for it, so Apply
 *     writes nothing there. One kept accelerator keeps the whole accelerator
 *     group, because the group shares one model.
 */
import type { HardwareInfo } from '../../interfaces/platform.js'
import type { ModelFormat } from '../../types/models.js'
import {
  DETECTOR_ACCURACY,
  DETECTOR_PERF,
  type DetectorLatencyCell,
  type DetectorPerfTable,
} from './detector-performance.js'
import { reportIsScalable, resolveLatencyColumn } from './accelerator-compute.js'
import type { AcceleratorCompute } from './accelerator-compute.js'
import { acceleratorKindOf, classifyInferenceHardware } from './hardware-class.js'
import {
  type AcceleratorKind,
  DEFAULT_MIN_SESSIONS_PER_DEVICE,
  type DeviceModelChoice,
  type HardwareClassId,
  type NodeRecommendation,
  type RecommendationReason,
} from './plan-schemas.js'

/** The family the cluster runs. */
export const AUTO_TUNE_FAMILY = 'yolov9'

/**
 * The model a Coral runs by default (D908) and the only one Auto tune sizes it
 * at (D912). Auto tune never enables a device; it sizes the enabled ones.
 */
export const CORAL_DEFAULT_MODEL_ID = 'yolov9s-320-edgetpu'

/** Recall within this of the best counts as a tie — the faster one wins. */
export const RECALL_TIE = 0.02

/** Default share of an accelerator's throughput kept free. */
export const DEFAULT_HEADROOM = 0.4

/** Detection rate a session is counted at when no camera says otherwise. */
export const DEFAULT_CAMERA_FPS = 10

/**
 * Camera rate at which serial `1000/p50` matched the cameras that held
 * (N100 iGPU, 2026-10-24). Below this the second InferRequest's overlap
 * becomes extra sessions; at and above it the serial ceiling is the count.
 */
export const SERIAL_CAPACITY_CAMERA_FPS = 10

/**
 * Aggregate throughput ÷ serial throughput when the frame interval is wide
 * enough to hide the second request. intel-igpu is the N100 measurement
 * (~1.4× under LATENCY with 2 InferRequests). Every other kind stays 1
 * until it is measured the same way.
 */
export const AGGREGATE_THROUGHPUT_BY_KIND: Readonly<Partial<Record<AcceleratorKind, number>>> = {
  'intel-igpu': 1.4,
}

/** The overlap factor for this kind at this camera rate. 1 at {@link SERIAL_CAPACITY_CAMERA_FPS} and above. */
export function aggregateThroughputFactor(kind: AcceleratorKind, cameraFps: number): number {
  if (!(cameraFps > 0) || cameraFps >= SERIAL_CAPACITY_CAMERA_FPS) return 1
  return AGGREGATE_THROUGHPUT_BY_KIND[kind] ?? 1
}

/**
 * Parallel sessions one device sustains at `fps` with `headroom` kept free.
 * `aggregateFactor` is the kind's overlap (1 unless the caller measured
 * extra throughput at this camera rate).
 */
export function capacitySessionsOf(
  fps: number,
  headroom: number,
  cameraFps: number,
  aggregateFactor = 1,
): number {
  if (!(fps > 0) || !(cameraFps > 0) || !(aggregateFactor > 0)) return 0
  // The epsilon keeps an exact fit (e.g. 50 fps × 0.6 / 10 = 3) from flooring to 2.
  return Math.max(0, Math.floor((fps * aggregateFactor * (1 - headroom)) / cameraFps + 1e-9))
}

/** A latency measured on the node itself (a fresh node benchmark result, D791). */
export interface MeasuredLatencyCell {
  readonly p50Ms: number
  readonly fps: number
  readonly resultId: string
  readonly measuredAtMs: number
}

/** deviceKey → modelId → measured cell. */
export type MeasuredLatency = Readonly<
  Record<string, Readonly<Record<string, MeasuredLatencyCell>>>
>

/** A table cell, or a measured one carrying where it came from. */
type SourcedCell = DetectorLatencyCell & { readonly source?: DeviceModelChoice['source'] }

/** One device of a node, as the recommender reads it. */
export interface AutoTuneDeviceInput {
  readonly key: string
  readonly format: ModelFormat
  readonly enabled: boolean
  readonly available: boolean
  /**
   * The custom-registry model the device's root detector is pinned to, when
   * it is one (the caller decides what is custom). The device is then kept.
   */
  readonly customPinModelId?: string
}

/** One node, as the recommender reads it. */
export interface AutoTuneNodeInput {
  readonly nodeId: string
  readonly reachable: boolean
  readonly hardware: HardwareInfo | null
  readonly devices: readonly AutoTuneDeviceInput[]
  /** Object-detection model id → the formats it has a build for, from the node's catalog. */
  readonly formatsByModel: Readonly<Record<string, readonly ModelFormat[]>>
}

interface Candidate {
  readonly modelId: string
  readonly personRecall: number
}

interface DeviceContext {
  readonly device: AutoTuneDeviceInput
  readonly accelerator: AcceleratorKind
  readonly column: Readonly<Record<string, SourcedCell>>
}

function reportFor(hardware: HardwareInfo, deviceKey: string): AcceleratorCompute | null {
  return hardware.accelerators?.find((report) => report.deviceKey === deviceKey) ?? null
}

/** The table column with the node's own measurements laid over it. */
function overlayMeasured(
  table: Readonly<Record<string, DetectorLatencyCell>> | undefined,
  measured: Readonly<Record<string, MeasuredLatencyCell>> | undefined,
): Readonly<Record<string, SourcedCell>> | undefined {
  if (measured === undefined || Object.keys(measured).length === 0) return table
  const out: Record<string, SourcedCell> = { ...table }
  for (const [modelId, m] of Object.entries(measured)) {
    out[modelId] = {
      p50Ms: m.p50Ms,
      fps: m.fps,
      measured: true,
      source: { kind: 'node-benchmark', resultId: m.resultId, measuredAtMs: m.measuredAtMs },
    }
  }
  return out
}

/** The capacity rule every pick is measured by. */
interface Sizing {
  readonly headroom: number
  readonly cameraFps: number
  readonly minSessions: number
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function sessionsOn(
  cell: DetectorLatencyCell | undefined,
  sizing: Sizing,
  kind: AcceleratorKind,
): number {
  if (cell === undefined) return 0
  return capacitySessionsOf(
    cell.fps,
    sizing.headroom,
    sizing.cameraFps,
    aggregateThroughputFactor(kind, sizing.cameraFps),
  )
}

function fitsOn(ctx: DeviceContext, modelId: string, sizing: Sizing): boolean {
  return sessionsOn(ctx.column[modelId], sizing, ctx.accelerator) >= sizing.minSessions
}

function candidatesFor(
  contexts: readonly DeviceContext[],
  formatsByModel: Readonly<Record<string, readonly ModelFormat[]>>,
): readonly Candidate[] {
  const ids = Object.keys(DETECTOR_ACCURACY).filter((id) => id.startsWith(AUTO_TUNE_FAMILY))
  return ids
    .filter((id) =>
      contexts.every(
        (c) => c.column[id] !== undefined && (formatsByModel[id] ?? []).includes(c.device.format),
      ),
    )
    .map((id) => ({ modelId: id, personRecall: DETECTOR_ACCURACY[id]?.personRecall ?? 0 }))
    .toSorted((a, b) => b.personRecall - a.personRecall || a.modelId.localeCompare(b.modelId))
}

function totalLatency(contexts: readonly DeviceContext[], modelId: string): number {
  return contexts.reduce(
    (sum, c) => sum + (c.column[modelId]?.p50Ms ?? Number.POSITIVE_INFINITY),
    0,
  )
}

/** The fewest sessions any device of the group sustains with this model. */
function worstSessions(
  contexts: readonly DeviceContext[],
  modelId: string,
  sizing: Sizing,
): number {
  return contexts.reduce(
    (worst, c) => Math.min(worst, sessionsOn(c.column[modelId], sizing, c.accelerator)),
    Number.POSITIVE_INFINITY,
  )
}

interface GroupPick {
  readonly modelId: string
  readonly reasons: readonly RecommendationReason[]
}

/** One model for a group of devices that must agree (step 2–4 of the header). */
function pickForGroup(
  contexts: readonly DeviceContext[],
  formatsByModel: Readonly<Record<string, readonly ModelFormat[]>>,
  sizing: Sizing,
): GroupPick | null {
  const candidates = candidatesFor(contexts, formatsByModel)
  if (candidates.length === 0) return null
  const fitting = candidates.filter((c) => contexts.every((ctx) => fitsOn(ctx, c.modelId, sizing)))
  if (fitting.length === 0) {
    const lightest = candidates.toSorted(
      (a, b) =>
        worstSessions(contexts, b.modelId, sizing) - worstSessions(contexts, a.modelId, sizing) ||
        totalLatency(contexts, a.modelId) - totalLatency(contexts, b.modelId),
    )[0]
    if (lightest === undefined) return null
    return {
      modelId: lightest.modelId,
      reasons: [
        {
          kind: 'no-fit-lightest',
          sessions: worstSessions(contexts, lightest.modelId, sizing),
          minSessions: sizing.minSessions,
        },
      ],
    }
  }
  const best = fitting[0]
  if (best === undefined) return null
  const tied = fitting.filter((c) => best.personRecall - c.personRecall <= RECALL_TIE)
  const chosen =
    tied.toSorted(
      (a, b) =>
        totalLatency(contexts, a.modelId) - totalLatency(contexts, b.modelId) ||
        b.personRecall - a.personRecall,
    )[0] ?? best
  const reasons: RecommendationReason[] = []
  const mostAccurate = candidates[0]
  if (mostAccurate !== undefined && mostAccurate.modelId !== best.modelId) {
    const limitedBy =
      contexts.find((ctx) => !fitsOn(ctx, mostAccurate.modelId, sizing))?.device.key ?? ''
    reasons.push({ kind: 'stepped-down', from: mostAccurate.modelId, to: best.modelId, limitedBy })
  }
  if (chosen.modelId !== best.modelId) {
    reasons.push({
      kind: 'tie-faster',
      over: best.modelId,
      recallDelta: round(best.personRecall - chosen.personRecall),
    })
  }
  return { modelId: chosen.modelId, reasons }
}

function choiceOn(ctx: DeviceContext, modelId: string, sizing: Sizing): DeviceModelChoice | null {
  const cell = ctx.column[modelId]
  if (cell === undefined) return null
  const estimatedFrom = cell.source?.kind === 'node-benchmark' ? undefined : cell.estimatedFrom
  const source =
    cell.source ??
    (estimatedFrom !== undefined
      ? { kind: 'estimated' as const, estimatedFrom }
      : { kind: 'table' as const })
  return {
    modelId,
    p50Ms: cell.p50Ms,
    fps: cell.fps,
    measured: cell.measured,
    source,
    ...(estimatedFrom !== undefined ? { estimatedFrom } : {}),
    capacitySessions: sessionsOn(cell, sizing, ctx.accelerator),
    personRecall: DETECTOR_ACCURACY[modelId]?.personRecall ?? 0,
  }
}

function deviceReasonsFor(
  choice: DeviceModelChoice,
  sizing: Sizing,
): readonly RecommendationReason[] {
  const out: RecommendationReason[] = [
    { kind: 'capacity', sessions: choice.capacitySessions, minSessions: sizing.minSessions },
  ]
  if (!choice.measured) out.push({ kind: 'derived-latency', modelId: choice.modelId })
  return out
}

function skippedNode(
  node: AutoTuneNodeInput,
  reason: RecommendationReason,
  hardwareClass: HardwareClassId | null,
): NodeRecommendation {
  return {
    nodeId: node.nodeId,
    reachable: node.reachable,
    hardwareClass,
    cpuModel: node.hardware?.cpuModel ?? null,
    skipped: true,
    acceleratorModelId: null,
    devices: node.devices.map((d) => ({
      deviceKey: d.key,
      accelerator: node.hardware ? acceleratorKindOf(d.key, node.hardware) : null,
      enabled: d.enabled,
      available: d.available,
      chosen: null,
      reasons: [],
    })),
    reasons: [reason],
  }
}

/** Recommend one node. See the module header. */
export function recommendNode(input: {
  readonly node: AutoTuneNodeInput
  readonly headroom?: number
  /** Least parallel sessions per device (default {@link DEFAULT_MIN_SESSIONS_PER_DEVICE}). */
  readonly minSessionsPerDevice?: number
  /** The rate a session is counted at (default {@link DEFAULT_CAMERA_FPS}). */
  readonly cameraFps?: number
  readonly perf?: DetectorPerfTable
  /** This node's fresh node-benchmark measurements (D791); they beat the table. */
  readonly measured?: MeasuredLatency
}): NodeRecommendation {
  const { node } = input
  const sizing: Sizing = {
    headroom: input.headroom ?? DEFAULT_HEADROOM,
    cameraFps: input.cameraFps ?? DEFAULT_CAMERA_FPS,
    minSessions: input.minSessionsPerDevice ?? DEFAULT_MIN_SESSIONS_PER_DEVICE,
  }
  const perf = input.perf ?? DETECTOR_PERF
  if (!node.reachable) return skippedNode(node, { kind: 'node-offline' }, null)
  if (node.hardware === null) return skippedNode(node, { kind: 'no-hardware-facts' }, null)
  const hardware = node.hardware
  const { hardwareClass, cpuModel } = classifyInferenceHardware(hardware)
  const measured = input.measured ?? {}
  const hasMeasured = Object.values(measured).some((m) => Object.keys(m).length > 0)
  const knownTable = hardwareClass === 'unknown' ? undefined : perf[hardwareClass]
  const canEstimate = (hardware.accelerators ?? []).some((report) => {
    const kind = acceleratorKindOf(report.deviceKey, hardware)
    return kind !== null && reportIsScalable(report, kind)
  })
  if (knownTable === undefined && !hasMeasured && !canEstimate) {
    return skippedNode(node, { kind: 'no-measured-data', hardwareClass }, hardwareClass)
  }
  const classTable = knownTable ?? {}

  const devices = node.devices.toSorted((a, b) => a.key.localeCompare(b.key))
  const contexts = new Map<string, DeviceContext>()
  const early = new Map<string, readonly RecommendationReason[]>()
  const corals: DeviceContext[] = []
  for (const device of devices) {
    const accelerator = acceleratorKindOf(device.key, hardware)
    if (!device.enabled) {
      early.set(device.key, [{ kind: 'device-disabled' }])
      continue
    }
    if (!device.available) {
      early.set(device.key, [{ kind: 'device-unavailable' }])
      continue
    }
    if (accelerator === 'coral') {
      const column = overlayMeasured(classTable.coral, measured[device.key])
      const builds = node.formatsByModel[CORAL_DEFAULT_MODEL_ID] ?? []
      if (column?.[CORAL_DEFAULT_MODEL_ID] === undefined || !builds.includes(device.format)) {
        early.set(device.key, [{ kind: 'no-family-build', format: device.format }])
        continue
      }
      corals.push({ device, accelerator, column })
      continue
    }
    const column =
      accelerator === null
        ? undefined
        : overlayMeasured(
            resolveLatencyColumn({
              hardwareClass,
              accelerator,
              report: reportFor(hardware, device.key),
              perf,
            })?.column,
            measured[device.key],
          )
    if (accelerator === null || column === undefined) {
      early.set(device.key, [{ kind: 'no-family-build', format: device.format }])
      continue
    }
    contexts.set(device.key, { device, accelerator, column })
  }

  const isCpu = (a: AcceleratorKind): boolean => a === 'x86-cpu' || a === 'arm-cpu'
  // Step 6: custom pins. An accelerator's pin keeps the whole group.
  const keptByKey = new Map<string, readonly RecommendationReason[]>()
  const keptReasonOf = (group: readonly DeviceContext[]): RecommendationReason | null => {
    const pinned = group.find((c) => c.device.customPinModelId !== undefined)
    if (pinned?.device.customPinModelId === undefined) return null
    const reason: RecommendationReason = {
      kind: 'kept-custom-pin',
      modelId: pinned.device.customPinModelId,
      deviceKey: pinned.device.key,
    }
    for (const c of group) keptByKey.set(c.device.key, [reason])
    return reason
  }
  const acceleratorGroup = [...contexts.values()].filter((c) => !isCpu(c.accelerator))
  const acceleratorKept = keptReasonOf(acceleratorGroup)
  const accelerators = acceleratorKept === null ? acceleratorGroup : []
  const cpus = [...contexts.values()]
    .filter((c) => isCpu(c.accelerator))
    .filter((c) => keptReasonOf([c]) === null)

  const chosenByKey = new Map<string, DeviceModelChoice>()
  const reasonsByKey = new Map<string, readonly RecommendationReason[]>()
  const nodeReasons: RecommendationReason[] = []
  let acceleratorModelId: string | null = null

  const groupPick =
    accelerators.length > 0 ? pickForGroup(accelerators, node.formatsByModel, sizing) : null
  if (acceleratorKept !== null) nodeReasons.push(acceleratorKept)
  if (groupPick !== null) {
    acceleratorModelId = groupPick.modelId
    nodeReasons.push(...groupPick.reasons)
    for (const ctx of accelerators) {
      const choice = choiceOn(ctx, groupPick.modelId, sizing)
      if (choice === null) continue
      chosenByKey.set(ctx.device.key, choice)
      reasonsByKey.set(ctx.device.key, deviceReasonsFor(choice, sizing))
    }
  } else {
    for (const ctx of accelerators) {
      reasonsByKey.set(ctx.device.key, [{ kind: 'no-family-build', format: ctx.device.format }])
    }
  }
  // A Coral the operator enabled is sized at its default model (D912): it has
  // one build, so there is nothing to choose — only a capacity to report.
  for (const ctx of corals) {
    const choice = choiceOn(ctx, CORAL_DEFAULT_MODEL_ID, sizing)
    if (choice === null) continue
    chosenByKey.set(ctx.device.key, choice)
    reasonsByKey.set(ctx.device.key, deviceReasonsFor(choice, sizing))
  }
  for (const ctx of cpus) {
    const pick = pickForGroup([ctx], node.formatsByModel, sizing)
    const choice = pick === null ? null : choiceOn(ctx, pick.modelId, sizing)
    if (pick === null || choice === null) {
      reasonsByKey.set(ctx.device.key, [{ kind: 'no-family-build', format: ctx.device.format }])
      continue
    }
    chosenByKey.set(ctx.device.key, choice)
    reasonsByKey.set(ctx.device.key, [
      { kind: 'cpu-device' },
      ...pick.reasons,
      ...deviceReasonsFor(choice, sizing),
    ])
  }

  return {
    nodeId: node.nodeId,
    reachable: true,
    hardwareClass,
    cpuModel,
    skipped: chosenByKey.size === 0,
    acceleratorModelId,
    devices: devices.map((device) => ({
      deviceKey: device.key,
      accelerator: acceleratorKindOf(device.key, hardware),
      enabled: device.enabled,
      available: device.available,
      chosen: chosenByKey.get(device.key) ?? null,
      ...(keptByKey.has(device.key) ? { kept: 'custom-pin' as const } : {}),
      reasons:
        early.get(device.key) ?? keptByKey.get(device.key) ?? reasonsByKey.get(device.key) ?? [],
    })),
    reasons: nodeReasons,
  }
}
