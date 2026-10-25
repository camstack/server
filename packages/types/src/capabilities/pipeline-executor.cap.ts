import { z } from 'zod'
import type { ConfigField, ConfigUISchema } from '../interfaces/config-ui.js'
import type {
  InferenceCapabilities,
  ModelAvailability,
} from '../interfaces/inference-capabilities.js'
import type { AudioResult, FrameResult } from '../types/detection.js'
import {
  ModelProviderIdSchema,
  RootStepSupplySchema,
  ModelVariantGroupSchema,
  PipelineModelFormatStatusSchema,
} from '../types/models.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { FrameInputSchema } from './schemas/detection-shared.js'
import { FrameHandleSchema } from './schemas/streaming-shared.js'

/**
 * A root model's boxes standing in for one crop-kind step's own inference
 * (D730) — see `runPipeline.suppliedRoot`.
 */
export const SuppliedRootOutputSchema = z.object({
  stepId: z.string(),
  /** The root model that drew the boxes — stamped on the result. */
  modelId: z.string(),
  detections: z
    .array(
      z.object({
        /** `[x1, y1, x2, y2]` in the pixels of the call's image. */
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        score: z.number(),
        /**
         * Five facial landmarks in the same pixels — a face the step's own
         * detector already re-found inside a root face box (D730), so its
         * embedder child aligns it exactly as it aligns any detected face.
         */
        landmarks: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
      }),
    )
    .min(1),
})
export type SuppliedRootOutput = z.infer<typeof SuppliedRootOutputSchema>

/**
 * Reference to the frame's retained NATIVE surface + the parent crop's placement
 * within the frame, so the executor can re-cut a leaf child ROI at native
 * resolution on the detail plane. See the `runPipeline` `nativeCropRef` field.
 */
export const NativeCropRefSchema = z.object({
  /** Handle keying the retained native surface (node-pinned to its owner). */
  handle: FrameHandleSchema,
  /** The parent crop's padded/clamped rectangle in FRAME-space pixels. */
  cropFrameSpace: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
})
export type NativeCropRef = z.infer<typeof NativeCropRefSchema>

export const FrameViewSpecSchema = z.object({
  crop: z
    .object({
      left: z.number(),
      top: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
  content: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  fit: z.enum(['stretch', 'contain']),
  format: z.enum(['rgb', 'gray', 'jpeg']),
})
export type FrameViewSpec = z.infer<typeof FrameViewSpecSchema>

/**
 * Process-local frame identity. It is serializable so it can ride an in-process
 * capability call, but `registryId` deliberately prevents resolution in any
 * other process or execution group.
 */
export const FrameRefSchema = z.object({
  registryId: z.string().min(1),
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.enum(['rgb', 'gray']),
  timestamp: z.number(),
  capturedAt: z.number().optional(),
})
export type FrameRef = z.infer<typeof FrameRefSchema>

// ── Engine & device ──────────────────────────────────────────────
// Kept in sync with the shared `MODEL_FORMATS` (types/models.ts) so
// `PipelineEngineChoice.format: ModelFormat` stays assignable. `gguf` is a
// valid ModelFormat (llm managed models) though no pipeline engine uses it.
const ModelFormatSchema = z.enum(['onnx', 'coreml', 'openvino', 'tflite', 'pt', 'gguf'])
const PipelineSlotSchema = z.enum([
  'detector',
  'cropper',
  'classifier',
  'refiner',
  'audio-classifier',
])

const PipelineEngineChoiceSchema = z.object({
  runtime: z.literal('python'),
  backend: z.string(),
  format: ModelFormatSchema,
  device: z.string().optional(),
})

/**
 * One pool's resolved provisioning (`getEffectiveTuning`). `numWorkers` is the
 * knob that lifts a saturated pool (`inference-devices.md`); `concurrency` is
 * per-worker in-flight requests. `deviceKey` echoes the pool asked about —
 * `null` for the node-default pool.
 */
export const EffectiveTuningSchema = z.object({
  deviceKey: z.string().nullable(),
  runtime: z.string(),
  batchMode: z.string(),
  windowMs: z.number(),
  maxBatchSize: z.number(),
  concurrency: z.number(),
  numWorkers: z.number(),
})
export type EffectiveTuning = z.infer<typeof EffectiveTuningSchema>
/** Input of `getEffectiveTuning` — absent `deviceKey` ⇒ the node-default pool. */
export interface EffectiveTuningInput {
  readonly deviceKey?: string
}

const EngineDeviceInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
})

const AvailableEngineSchema = z.object({
  engine: PipelineEngineChoiceSchema,
  devices: z.array(EngineDeviceInfoSchema).readonly(),
  defaultDevice: z.string(),
})

// ── Pipeline step (recursive) ──
// Zod v4's `ZodType` is invariant over its `Input`/`Output` generics, so the
// canonical `z.lazy()` recursive pattern does not type-check cleanly against
// the full `PipelineDefaultStep` TS interface. Use a zod-inferred type
// instead — the resulting shape is structurally identical and still fully
// typed for callers via `z.infer<typeof PipelineDefaultStepSchema>`.
// Phase 7 (settings redesign): removed generic `confidence: number` field.
// Each step declares its own thresholds via `configSchema` and persists
// them inside `settings`. The runtime executor reads
// `StepDefinition.defaultConfidence` from the step registry as the
// hard-coded fallback threshold.
export type PipelineDefaultStepOutput = {
  readonly addonId: string
  readonly addonName: string
  readonly slot: 'detector' | 'cropper' | 'classifier' | 'refiner' | 'audio-classifier'
  readonly inputClasses: readonly string[]
  readonly outputClasses: readonly string[]
  readonly enabled: boolean
  readonly modelId: string
  readonly children: readonly PipelineDefaultStepOutput[]
  readonly group?: string
  readonly settings?: Readonly<Record<string, unknown>>
}

const PipelineDefaultStepSchema: z.ZodType<PipelineDefaultStepOutput> = z.lazy(() =>
  z.object({
    addonId: z.string(),
    addonName: z.string(),
    slot: PipelineSlotSchema,
    inputClasses: z.array(z.string()).readonly(),
    outputClasses: z.array(z.string()).readonly(),
    enabled: z.boolean(),
    modelId: z.string(),
    children: z.array(PipelineDefaultStepSchema).readonly(),
    group: z.string().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }),
)

// ── PipelineSchema (returned by getSchema) ──
const PipelineModelOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Per format: `downloaded` (a current copy), and since D746 what is on disk
  // (`onDisk`: current / stale / missing) and the build's `precision`.
  formats: z.record(z.string(), PipelineModelFormatStatusSchema),
  // Variant-selector grouping — mirrors `ModelCatalogEntry.group`/`.legacy` so
  // the pipeline/device steppers can render the same grouped Family→Tier→Variant
  // picker as the config UI. Absent `group` ⇒ ungrouped (flat list); `legacy`
  // entries stay resolvable but hidden from the grouped selector.
  group: ModelVariantGroupSchema.optional(),
  legacy: z.boolean().optional(),
  // Catalog source for the provider-first stepper picker. Absent ⇒ CamStack
  // (built-in). Stamped on plus catalog / plugin catalog / BYO registry merges.
  provider: ModelProviderIdSchema.optional(),
  // The default confidence IN FORCE for this model — its own floor, else the
  // step's (D662, resolved by `effective-confidence.ts` on the node). Optional
  // only for version skew: a runner that predates it omits it, and a reader
  // then falls back to the step's `defaultConfidence`.
  defaultConfidence: z.number().optional(),
  // The steps this root model can supply (D730) — `rootSuppliesOf` the model,
  // declared or derived on read, so the step editors and matrices can offer
  // "Use the root model" and show the root chip. Absent ⇒ supplies nothing.
  suppliesSteps: z.array(RootStepSupplySchema).readonly().optional(),
})

const ConfigFieldBridge = z.custom<ConfigField>()

const PipelineAddonSchemaSchema = z.object({
  id: z.string(),
  name: z.string(),
  slot: PipelineSlotSchema,
  inputClasses: z.array(z.string()).readonly(),
  outputClasses: z.array(z.string()).readonly(),
  childSlots: z.array(PipelineSlotSchema).readonly(),
  models: z.array(PipelineModelOptionSchema).readonly(),
  defaultModelId: z.string(),
  // Per-format model override. Lets an addon declare "on `coreml` prefer
  // apple-soundanalysis, on `onnx` prefer yamnet-onnx". The orchestrator's
  // agent-seed routine uses this to pick a modelId that matches the
  // agent's active engine format.
  defaultModelIdByFormat: z.record(z.string(), z.string()).optional(),
  // Whether a freshly-seeded agent starts with this addon `enabled: true`.
  // Absent = true. Operator-controlled after first seed.
  enabledByDefault: z.boolean().optional(),
  defaultConfidence: z.number(),
  group: z.string().optional(),
  configSchema: z.array(ConfigFieldBridge).readonly().optional(),
})

const PipelineSlotSchemaSchema = z.object({
  id: PipelineSlotSchema,
  label: z.string(),
  priority: z.number(),
  parentSlot: PipelineSlotSchema.nullable(),
  addons: z.array(PipelineAddonSchemaSchema).readonly(),
})

const PipelineSchemaSchema = z.object({
  availableEngines: z.array(AvailableEngineSchema).readonly(),
  selectedEngine: PipelineEngineChoiceSchema,
  slots: z.array(PipelineSlotSchemaSchema).readonly(),
})

// ── Detection / inference ──
// NOTE: `DetectorOutputSchema` was removed with the legacy single-addon
// `detect` cap method (no real consumers). The `DetectorOutput` TS interface
// in `types/detection.ts` remains — engine internals still speak it.

// ── Engine runtime provisioning (Phase 2) ───────────────────────────
// Per-node snapshot of the detection engine's lazy-provisioning state
// machine (idle → installing → verifying → ready, failing back to
// `failed` with a `nextRetryAt`). Surfaced read-only over the cap so the
// Pipeline page can show a live "installing OpenVINO… / ready" indicator
// per node, and live-updated via the `pipeline.engine-provisioning`
// event emitted on every transition.
const EngineProvisioningSchema = z.object({
  runtimeId: z.enum(['onnx', 'openvino', 'coreml', 'edgetpu']).nullable(),
  device: z.string().nullable(),
  state: z.enum(['idle', 'installing', 'verifying', 'ready', 'failed']),
  progress: z.number().optional(),
  error: z.string().optional(),
  nextRetryAt: z.number().optional(),
  /**
   * Gate A (config-correctness gate at engine change): human-readable
   * config issues surfaced EAGERLY when the node's engine changes — model
   * substitutions ("chose X, running Y") and zero-build steps ("no model
   * has a <format> build"). Additive/optional: informational only, never
   * enforced here — `assertEngineReady` (readiness) still gates inference.
   * Absent/empty when the node-default tree resolves cleanly.
   */
  configIssues: z.array(z.string()).optional(),
})
export type EngineProvisioning = z.infer<typeof EngineProvisioningSchema>

// ── Pipeline run input (UI-facing) ──
// Phase 7: dropped generic `confidence`. Per-step thresholds live in
// `settings` (each step declares its own field in `configSchema`); the
// runtime executor falls back to `StepDefinition.defaultConfidence`
// when settings don't override.
export type PipelineStepInputOutput = {
  readonly addonId: string
  readonly modelId?: string
  readonly enabled: boolean
  readonly children?: readonly PipelineStepInputOutput[]
  readonly settings?: Readonly<Record<string, unknown>>
  /**
   * Step-tree device jump (same-node, phase 1). Operator manual override
   * carried from the per-(node,device) BASE
   * (`inferenceDevices[node][deviceKey].steps[step].jumpDeviceKey`): run THIS
   * enrichment step (and its inherited children) on a DIFFERENT enabled device
   * of the SAME node — `<backend>:<device>` (e.g. `openvino:npu`). Absent ⇒ the
   * runner AUTO-jumps only when the effective device's format cannot run the
   * step's model, else the step inherits the effective device. Same-node only.
   */
  readonly jumpDeviceKey?: string
}

export const PipelineStepInputSchema: z.ZodType<PipelineStepInputOutput> = z.lazy(() =>
  z.object({
    addonId: z.string(),
    modelId: z.string().optional(),
    enabled: z.boolean().default(true),
    children: z.array(PipelineStepInputSchema).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    jumpDeviceKey: z.string().optional(),
  }),
)

// ── Pre-init validation (Gate B) ──────────────────────────────────
// `validatePipeline` is PURE COMPUTE against the calling node's
// `currentEngine.format` — it never writes the node-global
// `modelSubstitutions` map (that stays owned exclusively by
// `resolveStepModels`, the node-default tree resolver, to avoid a
// two-writer race). Per-camera substitutions are returned in the RESULT
// instead; the orchestrator logs them at attach time.
const ModelSubstitutionSchema = z.object({
  addonId: z.string(),
  chosen: z.string(),
  running: z.string(),
  format: z.string(),
})

const PipelineValidationIssueSchema = z.object({
  addonId: z.string(),
  // Every kind is a HARD issue — `ok` is false whenever `issues` is
  // non-empty. Model substitutions (degraded-but-loadable) are reported
  // separately in `substitutions` and never make `ok` false.
  // `unknown-device`: the `deviceKey` the call asked about names no pool this
  // node can build (D646) — `addonId` is `*`, the whole tree is affected.
  kind: z.enum(['unknown-addon', 'no-format-build', 'unknown-device']),
  detail: z.string(),
})

const PipelineValidationResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(PipelineValidationIssueSchema).readonly(),
  substitutions: z.array(ModelSubstitutionSchema).readonly(),
  /** The node's `currentEngine.format` this validation ran against. */
  format: z.string(),
})
export type PipelineValidationResult = z.infer<typeof PipelineValidationResultSchema>
export type PipelineValidationIssue = z.infer<typeof PipelineValidationIssueSchema>

// ── Reference media ──
const ReferenceImageEntrySchema = z.object({
  filename: z.string(),
  stepIds: z.array(z.string()).readonly().optional(),
})

const ReferenceImageBodySchema = z.object({
  base64: z.string(),
  filename: z.string(),
})

const ReferenceAudioEntrySchema = z.object({
  filename: z.string(),
  sizeKb: z.number(),
})

const ReferenceAudioBodySchema = z.object({
  base64: z.string(),
})

// Benchmark schemas (BenchmarkInputSchema, BenchmarkResultSchema,
// BenchmarkHistoryEntrySchema, BenchmarkHistoryEntryInputSchema,
// BenchmarkLatencyStatsSchema, PipelineRunInputSchema) moved to
// `@camstack/addon-benchmark/src/benchmark-schemas.ts` (2026-04-14).
// They describe a surface that belongs to the benchmark addon, not the
// core pipeline-executor cap. `PipelineEngineChoiceSchema` below remains
// exported because it's still referenced by other cap methods (runPipeline
// output, getSelectedEngine).

const AudioBackendSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  available: z.boolean(),
  /**
   * Raw classifier labels this backend can emit (e.g. YAMNet's
   * 521-class set or Apple SoundAnalysis's 303-class set). Used by
   * the benchmark UI to populate the `enabledMicroClasses` filter
   * specific to the selected backend without a separate fetch.
   */
  rawLabels: z.array(z.string()).readonly().optional(),
})

const AudioCapabilitiesSchema = z.object({
  activeBackend: z.string(),
  availableBackends: z.array(AudioBackendSchema).readonly(),
  sampleRate: z.number(),
  chunkDurationMs: z.number(),
})

// ── Download model result ────────────────────────────────────────────
const DownloadModelResultSchema = z.object({
  filePath: z.string(),
  sizeMB: z.number(),
  durationMs: z.number(),
})

/**
 * Wrapper carrying a single test run's result. Replaces the legacy
 * ad-hoc `{labels: [{className, originalClass, score}]}` shape with the
 * canonical `AudioResult` from the Phase 6 output rework: one
 * `AudioDetection` per class above `minScore`, top-N candidates in
 * `debug.alternateLabels['audio-classifier']`, per-source timings in
 * `debug.stepTimings`. The outer `success`/`error` fields stay so the
 * benchmark UI can still report a clean failure when the classifier
 * cap isn't available.
 */
const AudioTestResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  frame: z.custom<AudioResult>().optional(),
})

// ── Typed bridges to complex TS interfaces defined in `@camstack/types` ──
// Use `z.custom<T>()` when the target interface is a deeply-nested discriminated
// union (ConfigUISchema) or a recursive graph (PipelineConfig, PipelineRunResult,
// InferenceCapabilities). `z.custom<T>()` provides full TS inference on the
// client without forcing a duplicate Zod definition that would drift from the
// canonical TS interface. Validation is structural at the tRPC transport layer
// and the server-side provider guarantees the shape at emission time.
const ConfigUISchemaBridge = z.custom<ConfigUISchema>()
const ConfigUISchemaNullableBridge = z.custom<ConfigUISchema | null>()
const InferenceCapabilitiesBridge = z.custom<InferenceCapabilities>()
const ModelAvailabilityListBridge = z.custom<readonly ModelAvailability[]>()
export const PipelineRunResultBridge = z.custom<FrameResult>()

/**
 * Pipeline executor — detection engine + configuration + inference API.
 *
 * Merged from: pipeline-executor, pipeline-config, inference, detection-config.
 * Implemented by the detection-pipeline addon.
 *
 * Per-device surface (DeviceSettingsContribution + the "is detection
 * enabled for this camera?" toggle) lives on the paired
 * `detection-pipeline` cap (device-scoped, singleton, wrapper
 * defaultActive) — same split pattern used by stream-broker /
 * camera-streams and audio-analyzer / audio-analysis.
 */
export const pipelineExecutorCapability = {
  name: 'pipeline-executor',
  scope: 'system',
  mode: 'singleton',
  methods: {
    // ── Engine selection ─────────────────────────────────────────────
    // `setEngine` removed in Phase 6c — the stateless-pipeline model
    // picks engine per-camera, not per-node. `getSelectedEngine` is
    // kept read-only so the benchmark + models-page can still show the
    // executor's bootstrap engine; its semantics degrade to "what the
    // executor would pick by default" in the stateless world.
    getAvailableEngines: method(z.void(), z.array(PipelineEngineChoiceSchema)),
    getSelectedEngine: method(z.void(), PipelineEngineChoiceSchema),
    /**
     * Per-node detection-engine provisioning snapshot. Returns the live
     * state of the lazy runtime-provisioning machine on `nodeId`
     * (idle / installing / verifying / ready / failed). The UI pairs this
     * one-shot query with the `pipeline.engine-provisioning` live event
     * (emitted on every transition) to drive a per-node "engine ready?"
     * indicator without polling. Phase 2.
     */
    getEngineProvisioning: method(z.object({ nodeId: z.string() }), EngineProvisioningSchema),

    // ── Video pipeline step configuration (phase 2c) ─────────────────
    // Per-addonId config the operator tunes on the Pipeline → agent
    // page. Replaces the orchestrator's per-agent
    // `setAgentAddonDefaults` mutation. No `enabled` flag — the cap
    // binding system (wrapper caps + setWrapperActive) decides whether
    // a step runs.
    getVideoPipelineSteps: method(
      z.void(),
      z.record(
        z.string(),
        z.object({
          modelId: z.string(),
          settings: z.record(z.string(), z.unknown()).readonly(),
        }),
      ),
    ),
    setVideoPipelineSteps: method(
      z.object({
        steps: z.record(
          z.string(),
          z.object({
            modelId: z.string(),
            settings: z.record(z.string(), z.unknown()).readonly(),
          }),
        ),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Inference-device liveness (the routing channel, 2026-08-26) ───
    /**
     * Which of THIS node's inference devices the executor currently refuses,
     * and why. `nodeId` is the ROUTING key (stripped by the generated router).
     *
     * The channel that did not exist. Pool health was known only inside the
     * detection addon and was an input to no routing decision anywhere: the
     * per-dispatch capability gate is keyed on model FORMAT and so can never
     * separate `openvino:gpu` from `openvino:npu`, and the orchestrator's live
     * eligibility probe (`platformProbe.getCapabilities`) answers about
     * HARDWARE — which was present throughout. So when the hub's `openvino:gpu`
     * Python worker was SIGABRT'd by the Intel GPU plugin on 2026-08-25, the
     * balancer went on handing that dead pool cameras by rotation for 31 hours:
     * ~370 000 `PoolWorker[w0]: not initialized` lines, every frame lost.
     *
     * Read semantics the caller depends on, and which the provider guarantees:
     * this is a synchronous read of in-memory state. It never probes hardware,
     * never spawns a pool and never throws — an EMPTY `unhealthy` means "asked,
     * nothing is refused", which is what re-admits a device. A read that FAILS
     * (node offline, version skew) must therefore be distinguishable from an
     * empty answer, and it is: it rejects.
     */
    getInferenceDeviceHealth: method(
      z.object({ nodeId: z.string() }),
      z.object({
        unhealthy: z
          .array(
            z.object({
              /** `<backend>:<device>`, e.g. `openvino:gpu`. */
              deviceKey: z.string(),
              /**
               * `failed` — the per-device restart budget is exhausted; no pool
               * will be spawned until an operator re-arms it or the runner
               * respawns. `backoff` — under budget, waiting out the backoff (or
               * a cached pool observed dead and not yet condemned).
               */
              state: z.enum(['failed', 'backoff']),
              /** Epoch ms of the death that produced this state. */
              since: z.number(),
              /** Pool deaths inside the current window. */
              deaths: z.number(),
              /** The last death's message. */
              lastError: z.string(),
            }),
          )
          .readonly(),
      }),
    ),
    /**
     * Re-arm a terminally `failed` inference device on `nodeId`: forget its
     * restart budget so the next dispatch builds a fresh pool.
     *
     * The terminal state is deliberate (the abort it bounds is deterministic —
     * an automatic probation would just respawn Python forever, more slowly),
     * and a terminal state an operator cannot leave is a silent fault. This is
     * the way out. `rearmed:false` means there was nothing to forget.
     */
    rearmInferenceDevice: method(
      z.object({ nodeId: z.string(), deviceKey: z.string() }),
      z.object({ rearmed: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Global pipeline configuration ────────────────────────────────
    // `setGlobalSteps` removed in Phase 6c — there is no "global
    // pipeline" in the stateless model (each camera carries its own
    // steps via the orchestrator's `pipelines/<deviceId>`).
    // The node's computed default tree (`getGlobalSteps`,
    // `getGlobalPipelineConfig`, `getDefaultSteps`) is not a cap surface
    // (D927): a model is chosen by the accelerator that runs it, and a frame
    // carries the `{modelId, deviceKey}` it ran with. The executor keeps a
    // private node-default tree for its own config-issue gate.
    getSchema: method(z.void(), PipelineSchemaSchema),
    getOrchestratorConfigSchema: method(z.void(), ConfigUISchemaBridge),

    /**
     * Gate B (pre-init config-correctness gate). PURE COMPUTE against this
     * node's `currentEngine.format` — resolves `steps` the same way the
     * runtime dispatch path would, and reports what WOULD happen without
     * touching any node-global state. Called by the orchestrator at attach
     * time (`attachOn`), node-pinned to the TARGET node, so config problems
     * surface BEFORE `pipelineRunner.attachCamera` rather than at the first
     * per-frame resolve. `ok` is false iff `issues` is non-empty (both
     * `unknown-addon` and `no-format-build` are HARD issues); `substitutions`
     * is informational (a degraded-but-loadable model swap) and never
     * affects `ok`. Never throws.
     *
     * `deviceKey` validates against THAT device pool's format instead of the
     * node default (D646) — the cheap question a pinned replay asks before it
     * reads any media: can this (node, deviceKey) run exactly this model?
     */
    validatePipeline: method(
      z.object({ steps: z.array(PipelineStepInputSchema), deviceKey: z.string().optional() }),
      PipelineValidationResultSchema,
    ),

    // ── Inference / detection ────────────────────────────────────────
    getCapabilities: method(z.void(), InferenceCapabilitiesBridge),
    getAddonModels: method(z.object({ addonId: z.string() }), ModelAvailabilityListBridge),
    downloadModel: method(
      z.object({ addonId: z.string(), modelId: z.string(), format: ModelFormatSchema }),
      DownloadModelResultSchema,
      { kind: 'mutation' },
    ),
    deleteModel: method(
      z.object({ addonId: z.string(), modelId: z.string(), format: ModelFormatSchema }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation' },
    ),
    // NOTE: onDownloadProgress / onPipelineProgress removed in Fase H.4.
    // Consumers subscribe via the generic `live.onEvent` core router with
    // `{category: 'model.download.progress'}` or `{category: 'pipeline.progress'}`
    // — the event bus already handles category filtering, no dedicated
    // pipeline-executor method needed.
    // NOTE: the legacy single-addon `detect` method was removed — it had no
    // real consumers (runtime dispatch is the stateless `runPipeline`).
    // `runFrame` removed in Phase 4 — runtime dispatch now goes through
    // the stateless `runPipeline({steps, frame, deviceId})` path.
    // The runner hydrates `steps` from the orchestrator's attach payload
    // (`pipelines[deviceId]`), so there is no longer an executor-side
    // global "current pipeline" for a legacy `runFrame` call to target.
    /**
     * Stateless single-frame execution. Callers (runner, benchmark) pass
     * the complete `steps` tree; the executor holds no state about cameras
     * or saved pipelines. WHICH pool answers is the node's own engine, or the
     * `deviceKey` pool when one is named.
     *
     * There is no `engine` field (D646). It existed for the benchmark and was
     * honoured by swapping the SHARED provider's engine, factory and executor
     * for the duration of the call, on a node serving live cameras. A caller
     * that still sends the key has it stripped here and changes nothing.
     *
     * Exactly one of `frame`, `frameRef`, `frameHandle`, `imageBase64`,
     * `referenceImage` must be provided:
     *  - `frame`: runtime dispatch path (runner → decoded broker frame).
     *    Carries the raw buffer, dimensions, and format; the executor
     *    uses it directly without base64 round-tripping.
     *  - `frameHandle` (CB5): a zero-pixel shm `FrameHandle` for the SAME
     *    decoded frame. Both runner and executor are hub-local processes
     *    sharing `/dev/shm`, so the executor maps the named segment and
     *    reads the pixels back zero-copy — eliminating the ~1.2MB
     *    re-serialisation over UDS/MsgPack the `frame` path pays per call.
     *    High-risk: the FrameRing is a latest-wins seqlock with no
     *    refcount, so a recycled slot yields a null read; the executor
     *    then degrades to an empty result and the runner ships pixels via
     *    `frame` as the fallback (queue-depth gated on the runner side).
     *  - `imageBase64`: one-shot test path (benchmark ImageTab).
     *  - `referenceImage`: named file from the reference-image store.
     */
    runPipeline: method(
      z.object({
        steps: z.array(PipelineStepInputSchema).min(1),
        frame: FrameInputSchema.optional(),
        /**
         * Process-local lazy frame. Valid only when caller and provider resolve
         * in the same execution-group process; split/cross-node callers use
         * `frame`/`image` inline compatibility instead.
         */
        frameRef: FrameRefSchema.optional(),
        /**
         * CB5 shm passthrough — a `FrameHandle` naming the same ring slot
         * the decoded pixels live in. One more member of the one-of
         * frame/frameHandle/image/imageBase64/referenceImage group.
         */
        frameHandle: FrameHandleSchema.optional(),
        imageBase64: z.string().optional(),
        /**
         * Binary JPEG bytes — preferred over `imageBase64` on internal
         * hops (hub → forked worker via Moleculer MsgPack) because it
         * skips the 33% base64 overhead + the per-call base64 decode on
         * the detection-pipeline worker. Callers can pass either; exactly
         * one of `frame`/`image`/`imageBase64`/`referenceImage` is required.
         */
        image: z.instanceof(Uint8Array).optional(),
        referenceImage: z.string().optional(),
        deviceId: z.number().optional(),
        sessionId: z.string().optional(),
        /**
         * Execution plane. 'full' (default) runs the whole tree — benchmark,
         * reference-image, and detail-subtree calls. 'frame' is the live
         * per-frame dispatch: ONLY root-plane steps run; crop children
         * (inputClasses ≠ null) are skipped and served per-track via
         * pipelineRunner.runDetailSubtree (two-plane design).
         */
        plane: z.enum(['full', 'frame']).optional(),
        /**
         * Inference-device selector (Phase 2 multi-device). Format
         * `<backend>:<device>` (e.g. `openvino:gpu`, `edgetpu:usb`, `cpu`).
         * Omitted ⇒ the runner's default device (current single-engine
         * behaviour). Selects WHICH device pool of the node runs the call.
         */
        deviceKey: z.string().optional(),
        /**
         * Two-plane NATIVE child-crop reference. Set by `runDetailSubtree` ONLY
         * when the parent crop was resolved from the frame's retained NATIVE
         * surface (a frameHandle HIT). Lets the executor re-cut a LEAF crop
         * child's ROI (plate-ocr, face-embedding, leaf classifiers) at native
         * resolution from that surface — the SAME quality path faces already
         * had — instead of the downscaled parent tile. `handle` keys the native
         * surface (node-pinned to its owner); `cropFrameSpace` is the parent
         * crop's padded/clamped rectangle in FRAME-space pixels, used to compose
         * the executor's crop-normalized child ROI back into frame-normalized
         * coordinates. Auxiliary to the image source (`image`/`frame`/…), NOT one
         * of the mutually-exclusive image inputs. Absent ⇒ tile-crop children
         * (today's behaviour on the fallback path).
         */
        nativeCropRef: NativeCropRefSchema.optional(),
        /**
         * Offline REPLAY of stored media for `deviceId` (D56, D646): the
         * camera's zone gate and overrides apply as live, every executing
         * step runs EXACTLY the model it names on the `deviceKey` pool it
         * names or the call refuses (`model-not-servable` /
         * `device-not-servable`), and nothing reaches the camera's live
         * trace stream. Absent ⇒ unchanged behaviour.
         */
        replay: z.literal(true).optional(),
        /**
         * Root-supplied detections for the tree's ROOT step (D730). Set by
         * `runDetailSubtree` when the camera's root model supplies a crop-kind
         * step (a plus catalog `license_plate` for `plate-detection`): the step is
         * NOT inferred, these boxes are its output, and its children (the plate
         * reader) run on them through their own crop policy. Boxes are in the
         * PIXELS of the image this call carries. Absent ⇒ the root step runs.
         */
        suppliedRoot: SuppliedRootOutputSchema.optional(),
      }),
      PipelineRunResultBridge,
      { kind: 'mutation' },
    ),

    /**
     * Batched run — N raw frames packed into one cap call. The provider
     * routes the batch through `SharedInferencePool.inferBatch`
     * (`MSG_INFER_BATCH = 0x03`) so the IPC framing and JSON response
     * envelope cost is amortised N:1 vs N concurrent `runPipeline`
     * calls. Single root step + uniform model assumed; trees with crop
     * children fall back to sequential execution.
     *
     * Used by `scripts/bench-batch-style.mts` for batch benchmarking —
     * N frames in one call to amortise per-call IPC overhead.
     */
    runPipelineBatch: method(
      z.object({
        steps: z.array(PipelineStepInputSchema).min(1),
        frames: z.array(FrameInputSchema).min(1).max(255),
        deviceId: z.number().optional(),
        sessionId: z.string().optional(),
        /**
         * Pure-inference benchmark hint. A NONZERO uint32 pins every frame in
         * the batch to the Python pool's bench preprocess cache
         * (`_bench_frame_id`) so a REPEATED benchmark frame is decoded +
         * preprocessed ONCE and every later inference is a pure-inference cache
         * hit — the sustained-throughput run measures inference, not
         * decode+preprocess+infer. Omitted/0 for live frames (all different →
         * full preprocess every call, correct). Fresh per sustained run;
         * released via `uncacheFrame`.
         */
        frameId: z.number().int().nonnegative().optional(),
        /** Inference-device selector (Phase 2 multi-device); see runPipeline. */
        deviceKey: z.string().optional(),
      }),
      z.object({
        results: z.array(PipelineRunResultBridge).readonly(),
      }),
      { kind: 'mutation' },
    ),

    // ── Bench frame cache (Python pool-side) ──────────────────────────

    /**
     * Cache a raw frame inside the Python inference pool's memory.
     * Returns a numeric `frameId` that `inferCached` references —
     * subsequent calls send only 5 bytes through the pipe instead of
     * 1.2MB raw data, eliminating the pipe transfer bottleneck.
     */
    cacheFrameInPool: method(
      z.object({
        data: z.instanceof(Uint8Array),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        format: z.enum(['rgb', 'bgr', 'gray']),
      }),
      z.object({
        frameId: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      { kind: 'mutation' },
    ),

    /**
     * Run inference on a previously cached frame. Sends only 5 bytes
     * (model_idx + frameId) through the IPC pipe — eliminates the
     * ~35ms per-call overhead of transferring 1.2MB raw data.
     */
    inferCached: method(
      z.object({
        stepId: z.string(),
        frameId: z.number().int(),
        /**
         * The model to time — REQUIRED (D658). Without it the pool answered the
         * step's ACTIVE variant (the first loaded after boot), so a benchmark
         * of model B silently timed model A. Callers pass the `rootModelId`
         * their warmup `runPipeline` reported: the model that actually ran.
         */
        modelId: z.string().min(1),
      }),
      z.record(z.string(), z.unknown()),
      { kind: 'mutation' },
    ),

    /**
     * Release a cached frame from the Python pool's memory.
     */
    uncacheFrame: method(z.object({ frameId: z.number().int() }), z.void(), { kind: 'mutation' }),

    /**
     * The effective provisioning of ONE pool of this node (operator override →
     * the pool's own runtime row). `deviceKey` names the device pool; absent is
     * the node-default pool. It answered only for the node default until
     * D646, so a benchmark on `openvino:npu` recorded the onnx pool's tuning
     * beside an NPU measurement.
     */
    getEffectiveTuning: method(
      z.object({ deviceKey: z.string().optional() }),
      EffectiveTuningSchema,
    ),
    // ── Engine registry / management (stateless-pipeline spec) ────────
    /**
     * List every EngineFactory currently loaded in this executor's RAM,
     * with the models resident and a coarse "in use" marker derived from
     * ongoing inference activity. Used by the Pipeline page Engines tab.
     */
    listLoadedEngines: method(
      z.void(),
      z
        .array(
          z.object({
            engineKey: z.string(),
            engine: PipelineEngineChoiceSchema,
            modelsLoaded: z.array(z.string()).readonly(),
            inUseByCameras: z.array(z.number()).readonly(),
            /**
             * Origin of this resident factory.
             *  - `runtime`       — main camera-serving engine (no idle TTL).
             *  - `device-pool`   — a concurrent per-device pool (Phase 2
             *                      multi-device, keyed by `deviceKey`) resolved
             *                      via `resolveDeviceFactory`. Runs alongside the
             *                      `runtime` engine on a DIFFERENT accelerator
             *                      (NPU / iGPU / Coral) — this is how the
             *                      Engines tab shows all pools running at once.
             */
            kind: z.enum(['runtime', 'device-pool']),
            /** Native pid of the underlying Python pool (null when no pool). */
            poolPid: z.number().nullable(),
            /** ms since this factory was last used (null when not warm-tracked). */
            idleMs: z.number().nullable(),
            /** Idle TTL after which the factory self-evicts (null when not applicable). */
            idleTtlMs: z.number().nullable(),
          }),
        )
        .readonly(),
    ),
    /** Warm up an engine without running a frame. No-op if already loaded. */
    spinEngine: method(
      z.object({ engine: PipelineEngineChoiceSchema }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Unload an engine from RAM. `force:true` unloads even when cameras
     * are actively using it (they re-spin on next frame). Default is
     * gated — returns `{success:false, reason}` when in use.
     */
    killEngine: method(
      z.object({
        engine: PipelineEngineChoiceSchema,
        force: z.boolean().optional(),
      }),
      z.object({ success: z.boolean(), reason: z.string().optional() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Benchmarks & testing ─────────────────────────────────────────
    // Moved to `@camstack/addon-benchmark` as customActions (2026-04-14).
    // The addon exposes runBenchmark / runPipelineTest / listBenchmarkHistory /
    // saveBenchmarkResult / deleteBenchmarkResult / clearBenchmarkHistory via
    // `api.addons.custom.mutate({addonId: 'benchmark', action, input})` and
    // delegates the actual pipeline execution back to this cap's runPipeline.

    // ── Reference media ──────────────────────────────────────────────
    listReferenceImages: method(z.void(), z.array(ReferenceImageEntrySchema).readonly()),
    getReferenceImage: method(
      z.object({ filename: z.string() }),
      ReferenceImageBodySchema.nullable(),
    ),
    getReferenceAudioFiles: method(z.void(), z.array(ReferenceAudioEntrySchema).readonly()),
    getReferenceAudio: method(
      z.object({ filename: z.string() }),
      ReferenceAudioBodySchema.nullable(),
    ),
    getAudioCapabilities: method(z.void(), AudioCapabilitiesSchema),
    runAudioTest: method(
      z.object({
        addonId: z.string(),
        modelId: z.string(),
        filename: z.string().optional(),
        // Per-step settings (e.g. `enabledClasses`) sourced from the
        // audio-classifier step's `getConfigSchema()`. The provider
        // applies them to the classification result before returning.
        settings: z.record(z.string(), z.unknown()).optional(),
      }),
      AudioTestResultSchema,
      { kind: 'mutation' },
    ),

    // ── Detection wiring / metrics (from detection-config) ───────────
    getDetectionConfigSchema: method(z.void(), ConfigUISchemaNullableBridge),
    // NOTE: orchestratorStatus / cameraDetectionStatus removed in the
    // pipeline page redesign — UI reads runner metrics directly via
    // perNodePipeline.getLocalMetrics / getCameraMetrics, which forward
    // to the pipeline-runner cap on the target node.
    //
    // NOTE: listBrokers / brokerStatus used to live here too — removed in
    // Fase H.3. Frontends now call `streamBroker.listAllProfileSlots`
    // directly and filter by deviceId client-side (`brokerId` is
    // `${deviceId}/${profile}` — a prefix match). The broker collection
    // lives in the stream-broker capability and there is no reason for
    // pipeline-executor to mirror it.
    //
    // NOTE: subscribeLive / subscribeAudioLive removed in Fase H.4.
    // Consumers use the generic `live.onEvent` / `live.onDeviceEvent`
    // with `{category: 'pipeline.progress' | 'pipeline.inference-result'
    // | 'pipeline.audio-inference-result'}`.

    // Per-device pipeline step CRUD and the per-camera detector settings
    // store are gone (Phase 4b, D927). The executor is stateless w.r.t.
    // cameras — it receives `steps`, their models and settings inline on
    // every `runPipeline` call.
  },
} as const satisfies CapabilityDefinition

export type IPipelineExecutorProvider = InferProvider<typeof pipelineExecutorCapability>

export {
  AvailableEngineSchema,
  EngineDeviceInfoSchema,
  EngineProvisioningSchema,
  ModelSubstitutionSchema,
  PipelineAddonSchemaSchema,
  PipelineDefaultStepSchema,
  PipelineEngineChoiceSchema,
  PipelineModelOptionSchema,
  // Schema types — consumed by pipeline-schema.ts to derive TS types
  PipelineSchemaSchema,
  PipelineSlotSchemaSchema,
  PipelineValidationIssueSchema,
  PipelineValidationResultSchema,
}
