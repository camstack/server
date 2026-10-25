/**
 * The wire shapes of the Auto tune plan and apply (D745), used by the
 * `pipeline-orchestrator` cap. The recommender's own types
 * (`recommend.ts`) are the TS face of the same data; these
 * schemas are what crosses the cap boundary.
 */
import { z } from 'zod'
import { MODEL_FORMATS } from '../../types/models.js'

const ModelFormatSchema = z.enum(MODEL_FORMATS)

/** Default least number of parallel sessions per device Auto tune keeps (D755). */
export const DEFAULT_MIN_SESSIONS_PER_DEVICE = 2
/** The operator's range for it. */
export const MIN_SESSIONS_PER_DEVICE_RANGE = { min: 1, max: 8 } as const

export const HardwareClassIdSchema = z.enum([
  'intel-core-ultra',
  'intel-n-series',
  'apple-m-base',
  'apple-m-pro',
  'amd-phoenix',
  'unknown',
])

export const AcceleratorKindSchema = z.enum([
  'intel-npu',
  'intel-igpu',
  'amd-igpu',
  'amd-npu',
  'x86-cpu',
  'arm-cpu',
  'apple-ane',
  'coral',
])

export const RecommendationReasonSchema = z.discriminatedUnion('kind', [
  /** The chosen model sustains `sessions` parallel sessions on this device, at least `minSessions`. */
  z.object({
    kind: z.literal('capacity'),
    sessions: z.number(),
    minSessions: z.number(),
  }),
  z.object({
    kind: z.literal('tie-faster'),
    over: z.string(),
    recallDelta: z.number(),
  }),
  z.object({
    kind: z.literal('stepped-down'),
    from: z.string(),
    to: z.string(),
    limitedBy: z.string(),
  }),
  /** No candidate reaches `minSessions`: the one with the most capacity (`sessions`) is used. */
  z.object({
    kind: z.literal('no-fit-lightest'),
    sessions: z.number(),
    minSessions: z.number(),
  }),
  z.object({ kind: z.literal('derived-latency'), modelId: z.string() }),
  z.object({ kind: z.literal('cpu-device') }),
  z.object({ kind: z.literal('device-disabled') }),
  z.object({ kind: z.literal('device-unavailable') }),
  z.object({ kind: z.literal('node-offline') }),
  z.object({ kind: z.literal('no-hardware-facts') }),
  z.object({
    kind: z.literal('no-measured-data'),
    hardwareClass: HardwareClassIdSchema,
  }),
  z.object({ kind: z.literal('no-family-build'), format: ModelFormatSchema }),
  /**
   * Kept as is (D786): `deviceKey` runs the custom-registry model `modelId` —
   * this device, or an accelerator of the same group (they share one model).
   */
  z.object({
    kind: z.literal('kept-custom-pin'),
    modelId: z.string(),
    deviceKey: z.string(),
  }),
])

/** Why a device is left exactly as it is, whatever the plan would pick (D786). */
export const KeptReasonSchema = z.enum(['custom-pin'])

/**
 * Where a choice's latency came from (D791): this node's own benchmark
 * result, or the hardware-class table. Measured on the node beats the table.
 */
export const LatencySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table') }),
  z.object({
    kind: z.literal('node-benchmark'),
    resultId: z.string(),
    measuredAtMs: z.number(),
  }),
  /**
   * Scaled from a measured column of the same accelerator kind (D930).
   * A node benchmark still beats this; the table beats nothing.
   */
  z.object({
    kind: z.literal('estimated'),
    estimatedFrom: HardwareClassIdSchema,
  }),
])
export type LatencySource = z.infer<typeof LatencySourceSchema>

export const DeviceModelChoiceSchema = z.object({
  modelId: z.string(),
  p50Ms: z.number(),
  fps: z.number(),
  measured: z.boolean(),
  /** Absent on a plan from before D791 — read as the table. */
  source: LatencySourceSchema.optional(),
  /**
   * The measured class this latency was scaled from (D930). Absent when the
   * cell is the table or a node benchmark.
   */
  estimatedFrom: HardwareClassIdSchema.optional(),
  /** Parallel sessions at the camera rate with the headroom kept free: ⌊fps × (1 − headroom) / camera fps⌋. */
  capacitySessions: z.number(),
  personRecall: z.number(),
})

export const DeviceRecommendationSchema = z.object({
  deviceKey: z.string(),
  accelerator: AcceleratorKindSchema.nullable(),
  enabled: z.boolean(),
  available: z.boolean(),
  chosen: DeviceModelChoiceSchema.nullable(),
  /** Present when the device is kept as is: Apply writes nothing on it. */
  kept: KeptReasonSchema.optional(),
  reasons: z.array(RecommendationReasonSchema).readonly(),
})

export const NodeRecommendationSchema = z.object({
  nodeId: z.string(),
  reachable: z.boolean(),
  hardwareClass: HardwareClassIdSchema.nullable(),
  cpuModel: z.string().nullable(),
  skipped: z.boolean(),
  acceleratorModelId: z.string().nullable(),
  devices: z.array(DeviceRecommendationSchema).readonly(),
  reasons: z.array(RecommendationReasonSchema).readonly(),
})

export const ModelPinChangeSchema = z.object({
  stepId: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
})

export const NodeDeviceChangeSchema = z.object({
  nodeId: z.string(),
  deviceKey: z.string(),
  madeExplicit: z.boolean(),
  modelPins: z.array(ModelPinChangeSchema).readonly(),
  thresholds: z
    .array(z.object({ stepId: z.string(), keys: z.array(z.string()).readonly() }))
    .readonly(),
})

/**
 * Every model and model-bound threshold lives on the accelerator that runs it
 * (D927), so the plan writes node / device entries only — there is no camera
 * layer for it to clear.
 */
export const AutoTuneWarningSchema = z.discriminatedUnion('kind', [
  /** A custom-registry model is pinned on this (node, device), so Auto tune skips it (D786). */
  z.object({
    kind: z.literal('custom-pin-kept'),
    nodeId: z.string(),
    deviceKey: z.string(),
    modelId: z.string(),
  }),
  /** The custom-model registry did not answer: every pin outside the measured catalog was kept. */
  z.object({
    kind: z.literal('custom-registry-unreadable'),
    error: z.string(),
  }),
])

export const AutoTuneOptionsSchema = z.object({
  /** Share of each accelerator's throughput kept free (0.3–0.5). */
  headroom: z.number().min(0.3).max(0.5).default(0.4),
  /**
   * The least number of parallel sessions every device must sustain at the
   * camera rate with the headroom kept free (D755). The most accurate model
   * that reaches it wins.
   */
  minSessionsPerDevice: z
    .number()
    .int()
    .min(MIN_SESSIONS_PER_DEVICE_RANGE.min)
    .max(MIN_SESSIONS_PER_DEVICE_RANGE.max)
    .default(DEFAULT_MIN_SESSIONS_PER_DEVICE),
})

export const AutoTunePlanSchema = z.object({
  /** Hash of everything the apply will write — the apply refuses a different one. */
  planHash: z.string(),
  family: z.literal('yolov9'),
  headroom: z.number(),
  minSessionsPerDevice: z.number(),
  /** The detection rate a session is counted at (the fastest camera running the pipeline root). */
  cameraFps: z.number(),
  generatedAt: z.number(),
  nodes: z.array(NodeRecommendationSchema).readonly(),
  nodeChanges: z.array(NodeDeviceChangeSchema).readonly(),
  warnings: z.array(AutoTuneWarningSchema).readonly(),
})

export const AutoTuneApplyInputSchema = z.object({
  planHash: z.string(),
  headroom: z.number().min(0.3).max(0.5).default(0.4),
  minSessionsPerDevice: z
    .number()
    .int()
    .min(MIN_SESSIONS_PER_DEVICE_RANGE.min)
    .max(MIN_SESSIONS_PER_DEVICE_RANGE.max)
    .default(DEFAULT_MIN_SESSIONS_PER_DEVICE),
})

export const AutoTunePhaseResultSchema = z.object({
  phase: z.enum(['download', 'node-models', 'redispatch']),
  ok: z.boolean(),
  detail: z.string(),
})

export const AutoTuneApplyResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('applied'),
    planHash: z.string(),
    phases: z.array(AutoTunePhaseResultSchema).readonly(),
  }),
  /** A model could not be downloaded onto its node: nothing was written. */
  z.object({
    kind: z.literal('aborted'),
    phases: z.array(AutoTunePhaseResultSchema).readonly(),
  }),
  /** The configuration changed since the plan was shown: here is the new one, confirm again. */
  z.object({ kind: z.literal('stale'), plan: AutoTunePlanSchema }),
  z.object({
    kind: z.literal('refused'),
    reason: z.enum(['apply-in-progress']),
  }),
])

export type AutoTunePlan = z.infer<typeof AutoTunePlanSchema>
export type AutoTuneOptions = z.infer<typeof AutoTuneOptionsSchema>
export type AutoTuneApplyInput = z.infer<typeof AutoTuneApplyInputSchema>
export type AutoTuneApplyResult = z.infer<typeof AutoTuneApplyResultSchema>
export type AutoTunePhaseResult = z.infer<typeof AutoTunePhaseResultSchema>
export type AutoTuneWarning = z.infer<typeof AutoTuneWarningSchema>
export type AutoTuneNodeDeviceChange = z.infer<typeof NodeDeviceChangeSchema>
export type HardwareClassId = z.infer<typeof HardwareClassIdSchema>
export type AcceleratorKind = z.infer<typeof AcceleratorKindSchema>
export type RecommendationReason = z.infer<typeof RecommendationReasonSchema>
export type DeviceModelChoice = z.infer<typeof DeviceModelChoiceSchema>
export type DeviceRecommendation = z.infer<typeof DeviceRecommendationSchema>
export type NodeRecommendation = z.infer<typeof NodeRecommendationSchema>
export type KeptReason = z.infer<typeof KeptReasonSchema>
