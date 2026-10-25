/**
 * Capacity of an accelerator we have not measured (D930).
 *
 * The latency table stays the measured columns. A device that reports compute
 * (OpenVINO GOPS, or execution units × clock, or compute units, or TOPS) is
 * estimated from the nearest measured column of the same accelerator kind,
 * scaled by the compute ratio and clamped. A node benchmark still replaces
 * the estimate. A device that reports neither compute nor a known class stays
 * `unknown`.
 *
 * A failed probe field is `null`, never `0` (D393): zero would be a compute
 * ratio of zero and would size the device as if it could not run.
 */
import { z } from 'zod'
import type { AcceleratorKind, HardwareClassId } from './plan-schemas.js'
import {
  DETECTOR_PERF,
  type DetectorLatencyCell,
  type DetectorLatencyColumn,
  type DetectorPerfTable,
} from './detector-performance.js'

/**
 * An unmeasured device is never estimated outside this band of its reference.
 *
 * Peak GOPS and detector latency do not move together: a 640 model is memory
 * bound, a 320 model less so, and the N100→N305 public EU×clock ratio is
 * about 2.2×. 2× is the widest that spread justifies without a measurement
 * on the device; 0.5× is the symmetric floor so a tiny iGPU is not told it
 * is many times slower than the weakest column we measured. A node benchmark
 * replaces the estimate and is not clamped.
 */
export const ESTIMATE_COMPUTE_RATIO_MIN = 0.5
export const ESTIMATE_COMPUTE_RATIO_MAX = 2

/**
 * Within this of 1.0, a device whose class IS the reference is that measured
 * machine (a probe clock a few percent off the spec), not a different chip.
 * An unknown class is still estimated, so the plan says so.
 */
export const REFERENCE_MATCH_FRACTION = 0.05

/** N100 iGPU: 24 execution units, 750 MHz graphics max (Intel specification). */
export const N100_IGPU_EU = 24
export const N100_IGPU_CLOCK_MHZ = 750

/**
 * Core Ultra 7 265K iGPU: 4 Xe-cores. OpenVINO's execution-unit count for
 * Xe-LP is 16 per Xe-core, and the graphics max dynamic frequency is 2000 MHz.
 * Used only to choose the nearest column for a chip that is not itself a
 * Core Ultra — that class is the measurement and is never scaled.
 */
export const CORE_ULTRA_265K_IGPU_EU = 64
export const CORE_ULTRA_265K_IGPU_CLOCK_MHZ = 2000

/** Phoenix / Hawk Point Radeon 780M: 12 compute units. */
export const PHOENIX_780M_CU = 12

const positiveOrNull = z
  .number()
  .nullable()
  .transform((value) => (value !== null && Number.isFinite(value) && value > 0 ? value : null))

const textOrNull = z
  .string()
  .nullable()
  .transform((value) => (value !== null && value.trim() !== '' ? value : null))

export const PrecisionGopsSchema = z.object({
  int8: positiveOrNull,
  fp16: positiveOrNull,
})
export type PrecisionGops = z.infer<typeof PrecisionGopsSchema>

/** What one accelerator device reported. Every failed query is null. */
export const AcceleratorComputeSchema = z.object({
  deviceKey: z.string(),
  fullDeviceName: textOrNull,
  executionUnits: positiveOrNull,
  clockMHz: positiveOrNull,
  gops: PrecisionGopsSchema.nullable(),
  architecture: textOrNull,
  npuName: textOrNull,
  tops: positiveOrNull,
  vendor: textOrNull,
  webgpuArchitecture: textOrNull,
  webgpuDevice: textOrNull,
  computeUnits: positiveOrNull,
})
export type AcceleratorCompute = z.infer<typeof AcceleratorComputeSchema>

const AcceleratorFactsPayloadSchema = z.object({
  accelerators: z.array(AcceleratorComputeSchema).nullable(),
})

/** The unit a compute ratio is taken in. Two scores of different units are not compared. */
export type ComputeMetric = 'gops-int8' | 'gops-fp16' | 'eu-mhz' | 'cu' | 'tops'

export interface ComputeScore {
  readonly metric: ComputeMetric
  readonly value: number
}

/** The compute of one measured column, in the unit the probe reports. */
export interface ReferenceCompute {
  readonly hardwareClass: HardwareClassId
  readonly accelerator: AcceleratorKind
  readonly score: ComputeScore
}

/**
 * Compute of the machines the latency columns were measured on.
 * GOPS is preferred when a column carries it; none of these do yet — the
 * boxes were measured before the probe reported `DEVICE_GOPS` — so the scale
 * uses execution units × clock (Intel) or compute units (AMD) until a
 * re-measure locks a GOPS figure on the column.
 */
export const REFERENCE_COMPUTE: readonly ReferenceCompute[] = [
  {
    hardwareClass: 'intel-n-series',
    accelerator: 'intel-igpu',
    score: { metric: 'eu-mhz', value: N100_IGPU_EU * N100_IGPU_CLOCK_MHZ },
  },
  {
    hardwareClass: 'intel-core-ultra',
    accelerator: 'intel-igpu',
    score: { metric: 'eu-mhz', value: CORE_ULTRA_265K_IGPU_EU * CORE_ULTRA_265K_IGPU_CLOCK_MHZ },
  },
  {
    hardwareClass: 'amd-phoenix',
    accelerator: 'amd-igpu',
    score: { metric: 'cu', value: PHOENIX_780M_CU },
  },
]

export interface ResolveLatencyInput {
  readonly hardwareClass: HardwareClassId
  readonly accelerator: AcceleratorKind
  readonly report: AcceleratorCompute | null
  readonly perf?: DetectorPerfTable
  readonly references?: readonly ReferenceCompute[]
}

export interface ResolvedLatencyColumn {
  readonly column: DetectorLatencyColumn
  /** Null when the column is the measurement itself. */
  readonly estimatedFrom: HardwareClassId | null
}

/** Parse a probe payload. `null` means the probe failed — not "no accelerators". */
export function parseAcceleratorFactsJson(raw: unknown): readonly AcceleratorCompute[] | null {
  const parsed = AcceleratorFactsPayloadSchema.safeParse(raw)
  if (!parsed.success || parsed.data.accelerators === null) return null
  return parsed.data.accelerators
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null
}

/** Scores in the order the estimate prefers. A non-positive field is absent. */
export function computeScores(report: AcceleratorCompute): readonly ComputeScore[] {
  const scores: ComputeScore[] = []
  const int8 = positive(report.gops?.int8 ?? null)
  if (int8 !== null) scores.push({ metric: 'gops-int8', value: int8 })
  const fp16 = positive(report.gops?.fp16 ?? null)
  if (fp16 !== null) scores.push({ metric: 'gops-fp16', value: fp16 })
  const units = positive(report.executionUnits)
  const clock = positive(report.clockMHz)
  if (units !== null && clock !== null) scores.push({ metric: 'eu-mhz', value: units * clock })
  const computeUnits = positive(report.computeUnits)
  if (computeUnits !== null) scores.push({ metric: 'cu', value: computeUnits })
  const tops = positive(report.tops)
  if (tops !== null) scores.push({ metric: 'tops', value: tops })
  return scores
}

function nearestReference(
  kind: AcceleratorKind,
  score: ComputeScore,
  references: readonly ReferenceCompute[],
): ReferenceCompute | null {
  const same = references.filter(
    (ref) => ref.accelerator === kind && ref.score.metric === score.metric && ref.score.value > 0,
  )
  const first = same[0]
  if (first === undefined) return null
  return same.reduce((best, ref) => {
    const distance = Math.abs(Math.log(score.value / ref.score.value))
    const bestDistance = Math.abs(Math.log(score.value / best.score.value))
    return distance < bestDistance ? ref : best
  }, first)
}

function scoreAgainstReferences(
  report: AcceleratorCompute,
  kind: AcceleratorKind,
  references: readonly ReferenceCompute[],
): ComputeScore | null {
  for (const score of computeScores(report)) {
    if (nearestReference(kind, score, references) !== null) return score
  }
  return null
}

/** True when this report can scale a measured column of `kind`. */
export function reportIsScalable(
  report: AcceleratorCompute,
  kind: AcceleratorKind,
  references: readonly ReferenceCompute[] = REFERENCE_COMPUTE,
): boolean {
  return scoreAgainstReferences(report, kind, references) !== null
}

function classColumn(
  perf: DetectorPerfTable,
  hardwareClass: HardwareClassId,
  accelerator: AcceleratorKind,
): DetectorLatencyColumn | undefined {
  if (hardwareClass === 'unknown') return undefined
  return perf[hardwareClass]?.[accelerator]
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function clampRatio(ratio: number): number {
  return Math.min(ESTIMATE_COMPUTE_RATIO_MAX, Math.max(ESTIMATE_COMPUTE_RATIO_MIN, ratio))
}

function scaleColumn(
  column: DetectorLatencyColumn,
  ratio: number,
  estimatedFrom: HardwareClassId,
): DetectorLatencyColumn {
  const out: Record<string, DetectorLatencyCell> = {}
  for (const [modelId, cell] of Object.entries(column)) {
    out[modelId] = {
      p50Ms: round1(cell.p50Ms / ratio),
      fps: Math.max(1, Math.round(cell.fps * ratio)),
      measured: false,
      estimatedFrom,
    }
  }
  return out
}

/**
 * The latency column for one device. A measured class other than the N-series
 * spread is returned unchanged — one class there is one measured machine.
 * `intel-n-series` is the N100 column; a different reported compute scales it.
 * An unknown class scales from the nearest reference of the same kind.
 */
export function resolveLatencyColumn(input: ResolveLatencyInput): ResolvedLatencyColumn | null {
  const perf = input.perf ?? DETECTOR_PERF
  const references = input.references ?? REFERENCE_COMPUTE
  const measured = classColumn(perf, input.hardwareClass, input.accelerator)
  // Core Ultra, Apple, Phoenix: the column is the measurement, not a scale.
  if (measured !== undefined && input.hardwareClass !== 'intel-n-series') {
    return { column: measured, estimatedFrom: null }
  }
  const score =
    input.report === null
      ? null
      : scoreAgainstReferences(input.report, input.accelerator, references)
  if (score === null) {
    return measured === undefined ? null : { column: measured, estimatedFrom: null }
  }
  const nearest = nearestReference(input.accelerator, score, references)
  const base =
    nearest === null ? undefined : classColumn(perf, nearest.hardwareClass, input.accelerator)
  if (nearest === null || base === undefined) {
    return measured === undefined ? null : { column: measured, estimatedFrom: null }
  }
  const rawRatio = score.value / nearest.score.value
  const sameMachine =
    input.hardwareClass === nearest.hardwareClass &&
    Math.abs(rawRatio - 1) <= REFERENCE_MATCH_FRACTION
  if (sameMachine) return { column: base, estimatedFrom: null }
  return {
    column: scaleColumn(base, clampRatio(rawRatio), nearest.hardwareClass),
    estimatedFrom: nearest.hardwareClass,
  }
}
