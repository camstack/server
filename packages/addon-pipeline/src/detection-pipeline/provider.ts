/**
 * DetectionPipelineProvider — implements IPipelineExecutorProvider.
 *
 * This is the main provider that consumers (DetectionWiring, Benchmark, tRPC)
 * interact with. It manages the engine factory, pipeline executor, and config persistence.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// eslint-disable-next-line no-restricted-imports -- model-download helpers are a build-time dep, not a runtime addon coupling. Same waiver `addon-embedding-encoder` uses for `ModelDownloadService`. The duplicate copy that lived at `./engine/model-downloader.ts` was deleted; canonical implementation lives in `@camstack/system/download/model-downloader`.
import {
  adoptModelRevisions,
  deleteModelFromDisk,
  ensureModel,
  isModelDownloaded,
} from '@camstack/system/addon-utils'
import type {
  CoralInfo,
  AddonCapabilityInfo,
  AddonContext,
  AudioChunkInput,
  AvailableEngine,
  BackendInfo,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DeviceProxy,
  FrameHandle,
  FrameInput,
  FrameResult,
  IAddonResolver,
  InferenceCapabilities,
  InferenceInput,
  IPipelineExecutorProvider,
  IScopedLogger,
  KernelInferenceHardware,
  ModelAvailability,
  ModelCatalogEntry,
  ModelFormat,
  ModelFormatStatus,
  EffectiveTuning,
  EffectiveTuningInput,
  NativeCropRef,
  PipelineDefaultStep,
  RootStepSupply,
  StepDefinition,
  PipelineEngineChoice,
  PipelineExecutionPlane,
  PipelineRunInput,
  PipelineSchema,
  PipelineStepInput,
  PipelineValidationIssue,
  PipelineValidationResult,
  PythonBackendInfo,
  RawFrameFormat,
} from '@camstack/types'
import {
  APPLE_SA_TO_MACRO,
  createEvent,
  EventCategory,
  enumerateInferenceDevices,
  errMsg,
  type IEventBus,
  nodePin,
  sleep,
  YAMNET_TO_MACRO,
} from '@camstack/types'
import type { LoadContribution } from '@camstack/types'
import { rootSuppliesOf } from '@camstack/types'
import { readProcessCost } from '@camstack/types/node'
import { formatPrecision, modelOnDiskState } from './model-format-facts.js'
import { localFrameRegistry } from '../session-decode/local-frame-registry.js'
import { ClusterModelSource } from '../shared/cluster-model-source.js'
import {
  ClusterModelSwitchLog,
  ClusterUnknownRefusalLog,
  unknownStepsNamed,
} from './cluster-model-switch-log.js'
import { getSharp } from '../shared/lazy-sharp.js'
import { type ClusterModelRefusal } from './cluster-model-resolution.js'
import { resolveDefaultDetectionModel } from './default-detection-model.js'
import { BACKEND_TO_POOL_RUNTIME, EngineFactory } from './engine/engine-factory.js'
import type { PoolCompileFinishedLate } from './engine/shared-inference-pool.js'
import { ModelLoadGovernor, type ModelLoadVerdict } from './engine/model-load-governor.js'
import { StepVariantLoadError } from './engine/pipeline-model-manager.js'
import { IdlePoolReaper } from './engine/idle-pool-reaper.js'
import {
  BenchmarkPools,
  benchmarkKeyOf,
  benchmarkPlacementOf,
  isBenchmarkRun,
} from './engine/benchmark-pools.js'
import { placedModelsOf } from './engine/coral-cocompiled-set.js'
import {
  type InferenceDeviceUnhealthy,
  InferenceDeviceLivenessSupervisor,
  InferenceDeviceUnusableError,
} from './engine/inference-device-liveness.js'
import { FrameReelectionNotes, routeLiveFrameDevice } from './engine/frame-device-reelection.js'
import { createDetectionPoolMemoryGuard, type GuardedPool } from './engine/pool-memory-guard.js'
import {
  closureVersionFromRunnerPath,
  createInferenceTimeoutGuard,
} from './engine/inference-timeout-guard.js'
import {
  type PoolProvisioningOverride,
  resolvePoolProvisioning,
} from './engine/pool-provisioning.js'
import { deviceKeyOf, resolveDeviceEngine } from './engine/resolve-device-engine.js'
import { buildSubtreeCanRun } from '../pipeline-runner/device-jump.js'
import { CustomModelCatalog } from '../shared/custom-model-catalog.js'
import {
  collectFramePlaneSteps,
  flattenEnabledVideoSteps,
  pruneUnrunnableDetailSteps,
} from './engine/step-utils.js'
import { checkReplayPin, resolveTreeRoot } from './model-pin.js'
import { EngineProvisioner, type EngineProvisioningState } from './engine-provisioner.js'
import {
  createRootFrameViewResolver,
  type RootFrameViewResolver,
} from './frame-ref-view-provider.js'
import type { AbsoluteBbox } from './pipeline/crop-utils.js'
import { resolvePackageCropBbox } from './pipeline/crop-zone.js'
import { PipelineExecutor, type RootInputViewProvider } from './pipeline/executor.js'
import type { NativeFaceCropProvider } from './pipeline/face-align.js'
import { composeCropRoiToFrameNorm } from './pipeline/native-crop-compose.js'
import { buildExecutableTree } from './pipeline/tree-builder.js'
import { mergeCustomModels } from './registry/custom-models.js'
import {
  annotateConfigSchemaForModels,
  withRootSuppliedLabelDefaults,
} from './registry/model-knob-applicability.js'
import {
  ALL_PIPELINE_STEPS,
  getDefaultModelForFormat,
  getStepDefinition,
  resolveModelForFormat,
} from './registry/step-definitions.js'
import { resolveModelDefaultConfidence } from './registry/effective-confidence.js'
import {
  defaultDeviceFor,
  envToHardwareInfo,
  modelFormatFor,
  type ProbedHardware,
  pythonRequirementsFor,
  type RuntimeEnv,
  type RuntimeId,
  runtimeDevices,
  supportedRuntimes,
} from './runtimes.js'
import {
  collectSubstitutions,
  collectUnknownAddonIssues,
  collectZeroBuildIssues,
  type ModelSubstitution,
  resolveInputSteps,
  type StepResolutionEngine,
} from './step-resolution.js'
import { applyZoneRuleGate } from './zone-gate.js'

/** Event source of the inference-timeout guard's liveness findings. */
const TIMEOUT_GUARD_SOURCE = { type: 'addon', id: 'detection-pipeline' } as const

// ---------------------------------------------------------------------------
// Python module name per inference backend (informational; surfaced via
// `getCapabilities`). The actual subprocess pool checks for these at boot.
// ---------------------------------------------------------------------------

function pythonModuleForBackend(backend: string): string {
  switch (backend) {
    case 'coreml':
      return 'coremltools'
    case 'openvino':
      return 'openvino'
    case 'onnx':
      return 'onnxruntime'
    default:
      return backend
  }
}

/**
 * Minimal `FrameResult` builder for the batched fast path. Mirrors the
 * subset of fields produced by the full executor pipeline that the
 * batch benchmark cares about (one detection list per frame). Trees
 * with crop children, per-step settings filtering, or non-detection
 * step shapes always go through `runPipeline` and use the canonical
 * `result-assembler.ts` instead — this fast path is intentionally narrow.
 */
function assembleBatchedFrameResult(
  raw: Record<string, unknown>,
  frame: FrameInput,
  modelId: string,
  deviceId: number,
  inferenceMs: number,
  wallMs: number,
): FrameResult {
  const dets = Array.isArray(raw['detections'])
    ? (raw['detections'] as Array<Record<string, unknown>>)
    : []
  const frameId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    kind: 'frame',
    frameId,
    deviceId,
    timestamp: Date.now(),
    width: frame.width,
    height: frame.height,
    detections: dets.map((d, i) => {
      const cls = typeof d['class'] === 'string' ? d['class'] : 'unknown'
      const score = typeof d['score'] === 'number' ? d['score'] : 0
      const bbox = (d['bbox'] ?? {}) as Record<string, unknown>
      const x = typeof bbox['x'] === 'number' ? bbox['x'] : 0
      const y = typeof bbox['y'] === 'number' ? bbox['y'] : 0
      const w = typeof bbox['w'] === 'number' ? bbox['w'] : 0
      const h = typeof bbox['h'] === 'number' ? bbox['h'] : 0
      return {
        id: `${frameId}-${i}`,
        kind: 'first-level' as const,
        macroClass: cls,
        score,
        bbox: { x, y, width: w, height: h },
        labels: [],
      }
    }),
    debug: {
      totalInferenceMs: typeof raw['inferenceMs'] === 'number' ? raw['inferenceMs'] : inferenceMs,
      // Server-side wall — full provider-internal cost incl. preprocess +
      // predict + IPC roundtrip. UI uses this to attribute transport
      // overhead vs server work; without it the UI sees serverWallMs=0
      // and treats everything as transport.
      wallMs: Math.round(wallMs * 100) / 100,
      stepTimings: [
        {
          source: modelId,
          modelId,
          ms: inferenceMs,
          detectionCount: dets.length,
        },
      ],
      // Python-pool stage split — surfaces preprocess vs predict separately
      // so the bench UI can pinpoint where the 50ms inference budget lands.
      ...(typeof raw['preprocessMs'] === 'number' ? { preprocessMs: raw['preprocessMs'] } : {}),
      ...(typeof raw['predictMs'] === 'number' ? { predictMs: raw['predictMs'] } : {}),
      ...(typeof raw['batchSize'] === 'number' ? { batchSize: raw['batchSize'] } : {}),
    },
  }
}
// KEY_DEVICE_STEPS_PREFIX removed in Phase 4b — per-device pipeline
// content lives on the orchestrator (`pipelineOrchestrator.pipelines/
// <deviceId>`) now.

// `isOrchestratorSettings` removed — orchestration settings moved to the
// `pipeline-orchestrator` addon in the pipeline page redesign. This addon
// no longer reads/writes motion fps, detection fps, cooldown, or related
// fields — those are queried via the orchestrator cap.
//
// Benchmark helpers (STEP_REFERENCE_IMAGES, computeLatencyStats,
// loadReferenceImageBase64, isBenchmarkHistoryArray, resolveReferenceImagesDir)
// moved to `@camstack/addon-benchmark` (2026-04-14) along with the runBenchmark
// / history methods. This provider only keeps `runPipeline` + reference-image
// listing, which addon-benchmark now consumes via the cap router.

function resolveReferenceAudioDir(): string | null {
  // Same resolution strategy as `resolveRefImagesDir` — see that
  // method for the rationale. The launcher's cwd
  // (`server/backend/dist`) has no walk-up that reaches the repo's
  // `assets/`, so cwd-only candidates miss every layout we run.
  const candidates = [
    path.resolve(__dirname, 'assets/reference-audio'),
    path.resolve(__dirname, '../assets/reference-audio'),
    // Deployed layout: bundle entry is `dist/detection-pipeline/index.js`,
    // so the addon-root `assets/` (shipped via files:["assets"]) is two up.
    path.resolve(__dirname, '../../assets/reference-audio'),
    path.resolve(__dirname, '../../../assets/reference-audio'),
    path.resolve(process.cwd(), 'assets/reference-audio'),
    path.resolve(process.cwd(), '../assets/reference-audio'),
    path.resolve(process.cwd(), '../../assets/reference-audio'),
    path.resolve(process.cwd(), '../../../assets/reference-audio'),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

function loadReferenceAudioBase64(filename: string): string {
  const dir = resolveReferenceAudioDir()
  if (!dir) throw new Error('Reference audio directory not found')
  const filePath = path.join(dir, filename)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Reference audio file not found: ${filename}`)
  }
  return fs.readFileSync(filePath).toString('base64')
}

/** Parse a WAV file (16-bit PCM) into an AudioChunkInput for classification. */
function parseWavToAudioChunk(filePath: string): AudioChunkInput {
  const buf = fs.readFileSync(filePath)
  // Standard 44-byte WAV header, 16-bit PCM samples
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2)
  const float32 = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    float32[i] = pcm[i]! / 32768.0
  }
  // AudioChunkInput.data must be Uint8Array (raw f32le bytes) so the MsgPack
  // UDS transport preserves the bytes exactly.  Convert the Float32Array to its
  // underlying byte representation here; receivers reconstruct the Float32Array
  // view with: new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
  const data = new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength)
  return { data, sampleRate: 16000, channels: 1, timestamp: Date.now() }
}

// `DEFAULT_ORCHESTRATOR` removed — orchestration defaults moved to the
// `pipeline-orchestrator` addon's getConfigSchema.

/** Structural equality for PipelineEngineChoice — ignores undefined `device`. */
function enginesEqual(a: PipelineEngineChoice, b: PipelineEngineChoice): boolean {
  return (
    a.runtime === b.runtime &&
    a.backend === b.backend &&
    a.format === b.format &&
    (a.device ?? null) === (b.device ?? null)
  )
}

/** A dispatch's load refused before it was issued: a back-off, or a refusal by name. */
class ModelLoadRefusedError extends Error {
  readonly model: string
  readonly state: string

  constructor(message: string, model: string, state: string) {
    super(message)
    this.name = 'ModelLoadRefusedError'
    this.model = model
    this.state = state
  }
}

/** One in-flight model load, and the failure generation it produced. */
interface ModelLoadFlight {
  readonly work: Promise<void>
  readonly generation: number | null
}

/** `step/model` — how the governor and the log lines name a model. */
function stepModelKey(step: PipelineDefaultStep): string {
  return `${step.addonId}/${step.modelId}`
}

/** The reporting state a refusal verdict stands for. */
function stateOf(verdict: Exclude<ModelLoadVerdict, { kind: 'go' }>): string {
  return verdict.kind === 'refused' ? 'refused' : `failed:${verdict.generation}`
}

/** Who asked for a model load — for the line a rejection writes. */
interface ModelLoadContext {
  /** The camera whose dispatch needed the model, when there is one. */
  readonly deviceId?: number
  readonly deviceKey?: string
  /**
   * What a failed load costs THIS dispatch (D657), named on the per-camera
   * line: the dispatch runs on without the step, it lost its root, or — a
   * call that is all-or-nothing (benchmark, replay) — it failed whole.
   * Absent on the whole-set path (benchmark batch), where any failure fails
   * the call.
   */
  readonly outcome?: DispatchLoadOutcome
}

/** What one step's failed load costs its dispatch (D657). */
type DispatchLoadOutcome = 'step-dropped' | 'root-lost' | 'call-failed'

/**
 * Whether a dispatch may run without a step whose model did not load (D657).
 * `partial`: a camera's LIVE dispatch — it names its camera and is not a
 * replay — keeps producing with what loaded. `all-or-nothing`: every other
 * call (a benchmark run, a replay, a capacity ramp) measures or reproduces
 * exactly what it names, so a missing step fails the whole call, by name.
 */
type DispatchLoadPolicy = 'partial' | 'all-or-nothing'

/** The load policy of a `runPipeline` call — see {@link DispatchLoadPolicy}. */
function dispatchLoadPolicyOf(input: PipelineRunInput): DispatchLoadPolicy {
  return input.deviceId !== undefined && input.replay !== true ? 'partial' : 'all-or-nothing'
}

/** A step of a dispatch whose model did not load, and why (D657). The step INSTANCE, not its id. */
interface DispatchStepLoadFailure {
  readonly step: PipelineDefaultStep
  readonly error: unknown
}

/**
 * An all-or-nothing call lost steps to failed loads (D657). Names every one,
 * so a benchmark never reports timings for a tree it did not run.
 */
class DispatchStepsNotLoadedError extends Error {
  readonly failedSteps: readonly string[]
  constructor(failures: readonly DispatchStepLoadFailure[]) {
    const named = failures.map(
      (f) =>
        `${f.step.addonId}/${f.step.modelId} (${f.error instanceof Error ? f.error.message : String(f.error)})`,
    )
    super(
      `pipeline steps failed to load — the call runs all of them or none: ${named.join('; ')}`,
      {
        cause: failures[0]?.error,
      },
    )
    this.name = 'DispatchStepsNotLoadedError'
    this.failedSteps = failures.map((f) => `${f.step.addonId}/${f.step.modelId}`)
  }
}

/**
 * A step's model artifact cannot be made present for the pool's format — no
 * build for that format, a custom model missing from this node, a download
 * that failed. Named by step and model so the failure is charged to THAT
 * model only (D657): a plain `Error` was charged to every model of the set,
 * and one face model with no tflite build backed the Coral's root detector
 * off for minutes.
 */
class StepModelArtifactError extends Error {
  readonly stepId: string
  readonly modelId: string
  constructor(stepId: string, modelId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'StepModelArtifactError'
    this.stepId = stepId
    this.modelId = modelId
  }
}

/** The one model a failed load is charged to, when the error names it. */
function failedModelOf(err: unknown): string | null {
  if (err instanceof StepVariantLoadError || err instanceof StepModelArtifactError) {
    return `${err.stepId}/${err.modelId}`
  }
  return null
}

/**
 * `steps` without the subtrees of the steps whose model did not load (D657).
 * A step's children consume its output, so they leave with it. Matched by
 * INSTANCE: two steps of one addon in a tree are two steps.
 */
function withoutFailedSteps(
  steps: readonly PipelineDefaultStep[],
  failed: ReadonlySet<PipelineDefaultStep>,
): PipelineDefaultStep[] {
  const kept: PipelineDefaultStep[] = []
  for (const step of steps) {
    if (failed.has(step)) continue
    kept.push(
      step.children && step.children.length > 0
        ? { ...step, children: withoutFailedSteps(step.children, failed) }
        : step,
    )
  }
  return kept
}

/**
 * The reason a condemned pool is charged against its device's restart budget.
 * A pool recycled because it HUNG (D653) names the hang — `inference device
 * FAILED … reason: pool worker is not ready` could not tell a GPU compile that
 * never returned from a crash.
 */
function deathReasonOf(factory: EngineFactory): string {
  return factory.getDeathCause()?.message ?? 'pool worker is not ready'
}

// ---------------------------------------------------------------------------
// Engine catalog (hardware-driven)
// ---------------------------------------------------------------------------

/** A registry-offered engine plus its probe-driven device list. */
interface EngineWithDevices {
  readonly engine: {
    readonly runtime: 'python'
    readonly backend: RuntimeId
    readonly format: 'onnx' | 'openvino' | 'coreml' | 'tflite'
    readonly device: string
  }
  readonly devices: readonly { readonly id: string; readonly label: string }[]
}

/** Build a `RuntimeEnv` from the running process + probed hardware. */
function runtimeEnvFromProcess(hardware: ProbedHardware | null): RuntimeEnv {
  return { platform: process.platform, arch: process.arch, hardware }
}

/** Normalize the loose probe hardware shape into a typed `ProbedHardware`. */
function toProbedHardware(
  hw: {
    npu?: { type: string } | null
    gpu?: { type: string } | null
    coral?: CoralInfo | null
  } | null,
): ProbedHardware | null {
  if (!hw) return null
  return {
    npu: hw.npu ? { type: hw.npu.type } : null,
    gpu: hw.gpu ? { type: hw.gpu.type } : null,
    coral: hw.coral ?? null,
  }
}

// ---------------------------------------------------------------------------
// Safe-floor engine — Python ONNX on CPU.
//
// This is the conservative default used in two situations:
//   1. Constructor initialisation (before init() loads the persisted choice).
//   2. Any path that previously fell back to the deleted `detectBestEngine()`
//      static method (loadEngine unavailable-backend fallback, reprobeEngine
//      when the platform-probe cap is unreachable).
//
// The real hardware-driven selection happens in `resolveAutoEngine()`, which
// resolves LIVE from the local kernel inference resolver (never persisted).
// ---------------------------------------------------------------------------

const ONNX_FLOOR: PipelineEngineChoice = {
  runtime: 'python',
  backend: 'onnx',
  format: 'onnx',
  device: 'cpu',
}

/**
 * How long the first-boot pick waits for the node's `platform-probe` to flip
 * `ready` (= its FULL async probe done, embedded-Python install included).
 * MUST stay finite — `readinessRegistry.awaitReady` defaults to Infinity,
 * which would wedge `setApi` (and the addon's onInitialize) forever on a
 * node whose probe never completes. On timeout the pick proceeds
 * conservatively (platform floor, never persisted when non-authoritative).
 */
const PROBE_READY_TIMEOUT_MS = 120_000

/**
 * Bound for the direct `platformProbe.getCapabilities` reconcile RPC issued
 * when the readiness gate times out (D8: readiness events are telemetry —
 * lossy — so a timed-out registry wait is reconciled against the provider
 * itself before conceding to the conservative floor). `getCapabilities`
 * resolves only once the probe is complete, so an answer IS readiness; the
 * race bound keeps a wedged transport from wedging `setApi`.
 */
const PROBE_DIRECT_RPC_TIMEOUT_MS = 60_000

/**
 * Build the onnx-cpu floor pick using `pickBestRuntime` with a null hardware
 * env.  Used wherever the old `detectBestEngine()` sync probe fell back — the
 * result is identical (onnx / cpu) but is now derived through the shared rules
 * instead of duplicated inline.
 */
/**
 * Process-wide options threaded from the addon into every pool this provider
 * builds. Deliberately holds NO resolved tuning — see `provisioning`.
 */
export interface ExecutorOptions {
  /**
   * The operator's explicit deviations from the per-runtime registry, applied
   * on top of EVERY pool's own runtime profile. Empty/absent ⇒ each pool runs
   * pure registry values for its own runtime.
   */
  readonly provisioning?: PoolProvisioningOverride
  readonly pythonPath?: string
  readonly pythonAddonDir?: string
}

/** Input of {@link DetectionPipelineProvider.resolveStepsForDispatch}. */
interface DispatchResolutionArgs {
  readonly steps: readonly PipelineStepInput[]
  /** Per-call device routing (`<backend>:<device>`), absent ⇒ node default pool. */
  readonly deviceKey: string | undefined
  /** Camera id for `tags: { deviceId }` on gate logs; absent on benchmark paths. */
  readonly deviceId: number | undefined
  /**
   * Execution plane of THIS call (two-plane design). `'frame'` (the live
   * per-frame dispatch) executes only root-plane steps, so the capability
   * gate covers only those — detail children are gated (and device-jumped)
   * at their own per-track dispatch. Any other value executes the whole
   * passed tree inline on one pool and keeps the whole-tree gate.
   */
  readonly plane: PipelineExecutionPlane | undefined
}

/** Result of {@link DetectionPipelineProvider.resolveStepsForDispatch}: the
 *  step tree resolved for the engine that will ACTUALLY run it, and the
 *  deviceKey to dispatch on (`undefined` after a node-local fallback). */
interface DispatchStepResolution {
  readonly deviceKey: string | undefined
  readonly steps: PipelineDefaultStep[]
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DetectionPipelineProvider implements IPipelineExecutorProvider {
  private engineFactory: EngineFactory | null = null
  /**
   * The pools a benchmark call loads its models into (D910): one separate
   * worker per device, never `factoriesByDevice` and never the node-default
   * pool, so a compile that kills its worker cannot take live detection down.
   */
  private readonly benchmarkPools = new BenchmarkPools<EngineFactory, PipelineEngineChoice>({
    create: (deviceKey, engine) => this.createBenchmarkFactory(deviceKey, engine),
    onDisposeError: (deviceKey, err) =>
      this.log.warn('Idle benchmark pool dispose failed', {
        meta: { deviceKey, error: err instanceof Error ? err.message : String(err) },
      }),
  })

  /**
   * Per-device engine factories (Phase 2 multi-device), keyed by deviceKey
   * (`<backend>:<device>`, e.g. `openvino:npu`, `edgetpu:usb`). Each is its own
   * inference pool, warm CONCURRENTLY — so the node runs detection on NPU + iGPU
   * + Coral in parallel. The default (node current-engine) pool stays
   * `this.engineFactory`; device routing is a LOCAL per-dispatch choice that
   * never mutates shared state, so concurrent multi-device sessions don't race.
   */
  private factoriesByDevice: Map<string, EngineFactory> = new Map()

  /**
   * This addon's `load-contribution`: the shared inference pool, DECLARING
   * that it cannot be attributed to a camera.
   *
   * The renunciation is data, not a deduction. One python process per (node,
   * runtime, hardware device) serves every camera on the node, so no
   * `deviceId` is true of it — `deviceId: null` and
   * `attribution: 'unattributable'` say exactly that, and a consumer that
   * plots per-camera load must exclude it rather than apportion it. The pool's
   * pids are included so the node's process snapshot can mark those processes
   * CLAIMED-but-shared instead of unknown; without them a reader cannot tell
   * "shared cost, reported" from "process nobody knows about".
   *
   * Per-camera inference MILLISECONDS are counted elsewhere and are a
   * different quantity — how much of the pool a camera asked for, never how
   * many CPU seconds it cost. They are deliberately not smuggled in here.
   */
  async loadContributions(): Promise<readonly LoadContribution[]> {
    const factories: readonly (readonly [string, EngineFactory])[] = [
      ...(this.engineFactory === null ? [] : ([['default', this.engineFactory]] as const)),
      ...this.factoriesByDevice.entries(),
    ]
    const out: LoadContribution[] = []
    for (const [deviceKey, factory] of factories) {
      for (const pid of factory.getPoolPids()) {
        out.push({
          role: 'detection',
          deviceId: null,
          attribution: 'unattributable',
          unit: `inference pool ${deviceKey}`,
          pid,
          ...(await readProcessCost(pid)),
        })
      }
    }
    return out
  }
  private executor: PipelineExecutor | null = null
  private currentSteps: PipelineDefaultStep[] | null = null
  private currentEngine: PipelineEngineChoice
  private readonly log: IScopedLogger

  /** Addon context — ctx.api resolves lazily (direct caller created after boot) */
  private addonCtx: AddonContext | null = null

  /**
   * Short-lived cache of custom models pulled from the `custom-model-registry`
   * collection cap, grouped by step id. TTL-bounded so the picker / resolution
   * paths don't issue a cap round-trip on every call. Empty map = no provider
   * (or a query failure) → behaviour identical to the static-catalog-only path.
   */
  private readonly customModels = new CustomModelCatalog({
    warn: (message, extras) => this.log.warn(message, extras),
  })

  /**
   * SYNC custom-model lookup handed to every live {@link EngineFactory} so
   * `buildPoolModelConfigForStep` can resolve an operator-registered model at
   * pool-load time. Reads the {@link customModels} snapshot — every load
   * path (`ensureModelsForSteps`, `ensureModelsForCurrentSteps`) refreshes the
   * cache via `resolveModelEntry` BEFORE `loadAdditional`/`applyConfig`, so
   * the snapshot is fresh when the pool asks. Without this seam a selected
   * custom model failed the WHOLE pool applyConfig with
   * `Model "X" not found in step "Y" catalog`.
   */
  private readonly customModelResolver = (
    stepId: string,
    modelId: string,
  ): ModelCatalogEntry | undefined =>
    this.customModels
      .current()
      .get(stepId)
      ?.find((m) => m.id === modelId)

  /**
   * Per-device {@link DeviceProxy} cache used for zone gating at the
   * runtime path. Reads `state.zones.value` + `state.zoneRules.value`
   * synchronously per frame so detections inside an `exclude` zone
   * never reach the tracker downstream — saves the tracking + event
   * cost on top of the analytics-side filter.
   */
  private readonly deviceProxies = new Map<number, DeviceProxy>()
  private readonly proxyUnsubs = new Map<number, ReadonlyArray<() => void>>()

  /**
   * The cluster-wide model row for `modelScope: 'cluster'` steps
   * (`face-embedding`, `clip-embedding`) — read from the orchestrator's global
   * settings, cluster-scoped, TTL-cached. See `shared/cluster-model-source.ts`
   * for why it is not carried on the attach config and never node-scoped.
   *
   * Refreshed on the ASYNC boundary (`runPipeline`) and read SYNCHRONOUSLY by
   * `inputStepsToPipelineSteps`, which runs per dispatch and must not await.
   */
  private readonly clusterModels = new ClusterModelSource({
    logger: {
      info: (message, extras) => this.log.info(message, extras),
      warn: (message, extras) => this.log.warn(message, extras),
    },
  })
  /** One line per camera when a cluster-scoped step starts running another model (D658). */
  private readonly clusterModelSwitchLog = new ClusterModelSwitchLog({
    info: (message, extras) => this.log.info(message, extras),
  })
  /** One line per (camera, step) while a cluster step is refused as unknown (D658). */
  private readonly clusterUnknownLog = new ClusterUnknownRefusalLog({
    warn: (message, extras) => this.log.warn(message, extras),
  })

  /**
   * Last logged "step configured" signature — used to dedupe the
   * per-step debug trail so it only fires on actual config CHANGE
   * (not on every frame). `runPipeline` is called once per decoded
   * frame (up to detectionFps × N cameras), so even at debug level
   * the per-step dump produced ~50 lines/sec/camera and drowned the
   * Cluster log viewer.
   */
  private lastStepsSignature: string | null = null

  /**
   * Dedup guard for the live per-camera dispatch path
   * (`inputStepsToPipelineSteps`) — an unknown-addon skip or a runtime
   * model substitution logs ONCE per distinct signature instead of once
   * per decoded frame (that method runs up to detectionFps × N cameras
   * times/sec). Never cleared — it's a log-noise guard, not runtime
   * state, and the key space (addonId/model combos) is small and stable.
   */
  private loggedLiveDispatchIssues = new Set<string>()

  /**
   * Lazy detection-engine runtime provisioner (Phase 2). Owns the
   * idle → installing → verifying → ready state machine for the
   * currently-selected engine and is the SOLE authority the inference
   * gate (`assertEngineReady`) and the cap snapshot
   * (`getEngineProvisioning`) read from. Built lazily once the addon
   * context is wired (real effects need `ctx.deps` + the python dir),
   * so it is null on a freshly-constructed provider — in which case the
   * gate reports the cold `idle` state and refuses inference.
   */
  private provisioner: EngineProvisioner | null = null

  /**
   * Gate A (config-correctness gate at engine change). Human-readable config
   * issues — model substitutions and zero-build steps — for the CURRENT
   * node-default tree against `this.currentEngine.format`. Recomputed
   * EAGERLY by {@link recomputeConfigIssues} whenever the engine actually
   * changes (see `onEngineSelectionChanged`), rather than relying on a
   * `nodeDefaultSteps()` call that may never happen on a camera-only node.
   * Merged into {@link getEngineProvisioning}'s snapshot; never consulted by
   * `assertEngineReady` — this gate SURFACES, it does not block inference.
   */
  private configIssues: readonly string[] = []

  /**
   * True when `init()` found no persisted engine choice (first boot).
   * `setApi()` reads this flag and auto-picks the best supported runtime
   * using probe data (hardware + bestScore hint), persists the selection,
   * then clears the flag.
   */
  private needsAutoPick = false

  /**
   * Idle-TTL for a per-device inference pool (multi-device C3). A device pool
   * with no dispatch for this long is disposed and recreated on next use — the
   * memory guardrail that keeps `factoriesByDevice` from accumulating warm pools
   * forever as an operator toggles device sets over a long run.
   *
   * It was 120s, on the stated assumption that this was "well above any real
   * inter-session gap for an active camera". Measured 2026-08-02, that is
   * false: detection is dispatched ON MOTION, so at night the gap between
   * events routinely exceeds two minutes, and the eviction fires constantly.
   * The rebuild is not cheap — `ensureModelsForSteps` loads EVERY enabled step
   * into the fresh factory, which on the hub is seven models
   * (yolov9m-320-int8, scrfd-2.5g, arcface-r100, yolov8n-plate,
   * vgg_english_g2, mobileclip-s1-vision, yolov8n-package — the set of that
   * date; all but the root detector have since been replaced, D703/D719).
   * The hub log shows
   * the cycle plainly: `COMPILE ×7` → shed within 7-15s → `EVICT` ~2.5 min
   * later → repeat. So the first seconds of a motion event — precisely when
   * detection matters — were spent recompiling models that had just been
   * thrown away.
   *
   * Hours, not minutes. At this TTL only a pool that is genuinely unused
   * (device disabled, routing changed) is reclaimed, which is what the
   * guardrail was for; a nightly lull no longer costs a recompile. Override
   * via env for a memory-constrained node.
   */
  private static readonly DEVICE_POOL_IDLE_TTL_MS = Math.max(
    60_000,
    Number(process.env['CAMSTACK_DEVICE_POOL_IDLE_TTL_MS']) || 6 * 60 * 60 * 1000,
  )
  private readonly deviceReaper = new IdlePoolReaper({
    ttlMs: DetectionPipelineProvider.DEVICE_POOL_IDLE_TTL_MS,
    dispose: (deviceKey) => this.disposeDevicePool(deviceKey),
    onError: (deviceKey, err) =>
      this.log.warn('Idle device pool dispose failed', {
        meta: {
          deviceKey,
          error: err instanceof Error ? err.message : String(err),
        },
      }),
  })

  /**
   * RSS bound + periodic memory telemetry for the Python inference pools
   * (2026-08-18 OOM audit: the pools, not the recorder, were the host's OOM
   * driver — grow for hours, kernel-killed at 3.8/8.8 GB, respawn, repeat).
   * Policy, restart budget and the `pool memory` Loki line live in
   * `@camstack/types` (`PoolMemoryWatchdog`); this provider only enumerates
   * its pools and exposes its EXISTING dispose-and-recreate machinery as the
   * restart action. Started in `init()`, stopped in `shutdown()`.
   */
  private poolMemoryGuard: ReturnType<typeof createDetectionPoolMemoryGuard> | null = null
  /** Compares this node's inference-timeout rate across closure updates. */
  private inferenceTimeoutGuard: ReturnType<typeof createInferenceTimeoutGuard> | null = null

  /** Watchdog view of the live pools: the node-default pool plus every
   *  per-device pool. Keys are stable per pool identity so the watchdog's
   *  baseline tracks one pool across sweeps. */
  private listGuardedPools(): readonly GuardedPool[] {
    const pools: GuardedPool[] = []
    if (this.engineFactory) {
      pools.push({
        key: `default:${deviceKeyOf(this.currentEngine)}`,
        factory: this.engineFactory,
      })
    }
    for (const [deviceKey, factory] of this.factoriesByDevice) {
      pools.push({ key: deviceKey, factory })
    }
    return pools
  }

  /**
   * Watchdog restart action — the same dispose-then-lazy-recreate the idle
   * reaper and the tuning respawn already use, never a second lifecycle. The
   * map/field is cleared FIRST so a concurrent dispatch rebuilds fresh via
   * the single-flight guards instead of grabbing the disposing instance;
   * models reload on the next dispatch via `ensureModelsForSteps`. Frames
   * arriving during the seconds-long re-spin are dropped (and counted by the
   * existing shed/timeout paths), not crashed — a bounded gap, unlike the
   * kernel's alternative.
   */
  private async restartGuardedPool(key: string): Promise<void> {
    if (key.startsWith('default:')) {
      const factory = this.engineFactory
      if (!factory) return
      this.engineFactory = null
      await factory.dispose()
      return
    }
    const factory = this.factoriesByDevice.get(key)
    if (!factory) return
    this.factoriesByDevice.delete(key)
    this.deviceReaper.cancel(key)
    await factory.dispose()
  }

  /** Read the addon settings store (all keys). */
  private readonly readStore: () => Promise<Record<string, unknown>>
  /** Write a patch to the addon settings store. */
  private readonly writeStore: (patch: Record<string, unknown>) => Promise<void>

  constructor(
    settings: {
      readAddonStore(): Promise<Record<string, unknown>>
      writeAddonStore(patch: Record<string, unknown>): Promise<void>
    },
    private readonly modelsDir: string,
    logger: IScopedLogger,
    private readonly eventBus: IEventBus | null = null,
    /**
     * Closure that returns the addon's config schema. Injected by the addon
     * class at construction so the provider can serve `getDetectionConfigSchema`
     * directly. The addon owns both pieces — no public setter needed.
     */
    private readonly detectionConfigSchemaSource: (() => ConfigUISchema) | null = null,
    /**
     * Executor options forwarded to every `EngineFactory` this provider builds.
     *
     * `provisioning` is the OPERATOR OVERRIDE ONLY — never a resolved tuning.
     * Each pool resolves its concurrency / worker count / batch tuning from its
     * OWN runtime's registry row (`engine/pool-provisioning.ts`), so a node
     * whose default is onnx no longer hands `concurrency: 4` to its openvino
     * NPU pool.
     *
     * `pythonPath` is the absolute path to the embedded Python (resolved
     * once by the addon class via `ctx.deps.ensurePython()`); required
     * whenever `runtime: 'python'` is selected. `pythonAddonDir` points
     * to this addon's `python/` dir at runtime — used to locate the
     * `requirements*.txt` files that drive lazy backend installs.
     */
    private readonly executorOptions: ExecutorOptions = {},
  ) {
    this.log = logger
    this.readStore = () => settings.readAddonStore()
    this.writeStore = (patch) => settings.writeAddonStore(patch)
    // In-memory placeholder only — NOT a selected/provisioned default. The
    // real engine is set by init() (explicit persisted override) or, for the
    // `'auto'` default, by resolveAutoEngine() live from the local kernel
    // resolver. Nothing is provisioned, downloaded, or persisted off this value;
    // the inference gate stays closed until a real pick lands.
    this.currentEngine = ONNX_FLOOR
    this.log.info('Engine pick pending (placeholder until probe / persisted selection)', {
      meta: {
        runtime: this.currentEngine.runtime,
        backend: this.currentEngine.backend,
        format: this.currentEngine.format,
      },
    })
  }

  /**
   * Record the revision of every catalog model already on this node whose
   * weight file hashes to it (D744), so the model listing reports those copies
   * as downloaded without fetching them again. Background and offline: it
   * reads files only. A copy holding other bytes is left for `ensureModel`,
   * which fetches it the next time something needs it.
   */
  private adoptHostedModelRevisions(): void {
    const entries = ALL_PIPELINE_STEPS.flatMap((s) => s.definition.models)
    void adoptModelRevisions(this.modelsDir, entries).then(
      (report) => {
        if (report.adopted.length === 0 && report.stale.length === 0) return
        this.log.info('Model copies checked against their mirror revision', {
          meta: { adopted: report.adopted.length, stale: report.stale },
        })
      },
      (err: unknown) => {
        this.log.warn('Model revision check failed — copies are proven on their next download', {
          meta: { error: errMsg(err) },
        })
      },
    )
  }

  /**
   * Call after construction. The node-default engine is always DERIVED live
   * from this node's own hardware (there is no persisted operator override
   * anymore — the elected single-engine cascade was removed). Defer the derive
   * to `setApi()` where the probe cap / kernel resolver is reachable.
   */
  async init(): Promise<void> {
    this.needsAutoPick = true
    this.log.info('Node-default engine derive deferred to setApi()')
    this.adoptHostedModelRevisions()
    // Arm the pool memory watchdog for this provider's lifetime. Sweeps are
    // no-ops while no pool is spawned; `shutdown()` stops it (tuning respawns
    // rebuild the provider, so the guard follows the pools it watches).
    if (!this.poolMemoryGuard) {
      this.poolMemoryGuard = createDetectionPoolMemoryGuard(
        {
          listPools: () => this.listGuardedPools(),
          restartPool: (key) => this.restartGuardedPool(key),
        },
        this.log,
      )
      this.poolMemoryGuard.start()
    }
    if (!this.inferenceTimeoutGuard) {
      const nodeId = this.localProbeNodeId()
      this.inferenceTimeoutGuard = createInferenceTimeoutGuard({
        readTotalTimeouts: () =>
          this.listGuardedPools().reduce(
            (sum, pool) => sum + pool.factory.getPoolBacklog().timedOut,
            0,
          ),
        readStore: () => this.readStore(),
        writeStore: (patch) => this.writeStore(patch),
        // The closure version is the fingerprint: it is what an
        // `applyServerUpdate` changes. Read from the closure this runner was
        // started from — `server-management` is server-provided and the
        // parent refuses to route it for a forked addon.
        resolveFingerprint: async () =>
          closureVersionFromRunnerPath(process.argv[1], {
            readFile: (path) => {
              try {
                return fs.readFileSync(path, 'utf8')
              } catch {
                return null
              }
            },
          }),
        emitFailed: (finding) => {
          this.eventBus?.emit(
            createEvent(EventCategory.SystemLivenessFailed, TIMEOUT_GUARD_SOURCE, finding),
          )
        },
        emitRecovered: (findingId) => {
          this.eventBus?.emit(
            createEvent(EventCategory.SystemLivenessRecovered, TIMEOUT_GUARD_SOURCE, { findingId }),
          )
        },
        nodeId,
        log: this.log.child('inference-timeout-guard'),
      })
      this.inferenceTimeoutGuard.start()
    }
  }

  /**
   * Lazy-install the pip requirements file matching `engine.backend` into
   * the embedded Python before the inference pool spawns. No-op for
   * backends with no requirements file on disk, or before the addon
   * context has been wired (warm-pool race window).
   *
   * Idempotent — `installPythonRequirements` short-circuits on a hash
   * marker, so back-to-back EngineFactory rebuilds (benchmark overrides,
   * tuning respawns) skip the pip subprocess after the first install.
   */
  private async ensureBackendDeps(engine: PipelineEngineChoice): Promise<void> {
    if (!this.addonCtx) return
    const pythonAddonDir = this.executorOptions.pythonAddonDir
    if (!pythonAddonDir) return
    const poolRuntime = BACKEND_TO_POOL_RUNTIME[engine.backend]
    if (!poolRuntime) return
    const file = path.join(pythonAddonDir, `requirements-${poolRuntime}.txt`)
    if (!fs.existsSync(file)) return
    await this.addonCtx.deps.installPythonRequirements(file)
  }

  /**
   * Warm the Python inference pool up-front so consumers that hit
   * `runPipeline` on the first frame don't race the pool's spawn
   * (`SharedInferencePool: not initialized`). Called from the addon's
   * `onInitialize` so `BaseAddon.autoEmitReadiness` fires `ready`
   * only after the pool is actually callable — consumers that
   * `awaitReady('pipeline-executor', {node:…})` now get a true
   * "callable" signal, not a "process started" signal.
   *
   * Idempotent: delegates to `ensureEngineFactory` which short-circuits
   * on a warmed pool.
   */
  async warmPool(): Promise<void> {
    // Pre-warm is gated on the engine provisioner (Phase 2): if the
    // selected runtime isn't `ready` yet (installing / verifying / failed
    // at boot), skip the pre-warm rather than building a pool against an
    // un-provisioned runtime. The first real frame goes through
    // `ensureExecutor` which re-checks the gate and warms lazily once
    // provisioning completes — no inference happens before READY, and no
    // crash-loop (skip, don't throw, on boot).
    if (this.getEngineProvisioning().state !== 'ready') {
      this.log.info('warmPool deferred — engine not provisioned yet', {
        meta: { state: this.getEngineProvisioning().state },
      })
      return
    }
    await this.ensureEngineFactory()
  }

  /** True when the engine provisioning machine reports inference-ready. */
  isReady(): boolean {
    return this.getEngineProvisioning().state === 'ready'
  }

  /** Store the addon context. ctx.api is a lazy getter resolved at call time. */
  async setApi(addonCtx: unknown): Promise<void> {
    this.addonCtx = addonCtx as AddonContext
    // The engine provisioner's real effects need `ctx.deps` (pip install)
    // and the python dir, so it can only be built once the context is
    // wired. Build it lazily here and kick off provisioning for the
    // engine `init()` loaded (or the platform default). Boot is the
    // FIRST `select()` — the inference gate (`assertEngineReady`) stays
    // closed until the machine reaches `ready`.
    if (!this.needsAutoPick) {
      this.startProvisioningForCurrentEngine()
      return
    }
    // SINGLE readiness gate for the first-boot pick (replaces four historical
    // workarounds: the `useCapability().isReady` poll, the global-scope
    // `onCapabilityStateChange('platform-probe')` listener, the
    // `ensureBootEngineProvisioned` boot safety-net and the
    // `platform-probe.phase 'done'` re-pick subscription). platform-probe now
    // emits `ready` on `{type:'node', nodeId}` ONLY once its FULL async probe
    // (hardware + embedded-Python EP scoring) completes, so awaiting that
    // edge IS the "probe done" signal — the pick below sees the node's REAL
    // accelerators, no onnx-floor-then-converge dance. Each node awaits its
    // OWN record (the local platform-probe emission — not hydrate-dependent).
    const nodeId = this.localProbeNodeId()
    const registry = this.addonCtx.kernel?.readinessRegistry
    if (registry) {
      try {
        // FINITE timeout, always — `awaitReady` defaults to Infinity, which
        // would wedge onInitialize forever on a node whose probe never
        // completes. On timeout we fall through to a CONSERVATIVE pick: the
        // node boots alive on the platform floor, and `resolveAutoEngine`
        // never persists the `'auto'` pick anyway, so the next boot
        // re-resolves the real hardware-driven runtime.
        await registry.awaitReady(
          'platform-probe',
          { type: 'node', nodeId },
          { timeoutMs: PROBE_READY_TIMEOUT_MS },
        )
      } catch (err) {
        // Reconcile round (D8): readiness events are telemetry and can be
        // lost across the UDS/Moleculer hops (2026-07-17 incident: the
        // probe HAD completed — "Platform probe complete" logged — but the
        // `ready` delta never reached this process's registry). Before
        // conceding to the conservative floor, ask the AUTHORITY — the
        // provider itself. `getCapabilities` resolves only once the probe
        // is done, so an answer here IS readiness, whatever the local
        // registry saw. Bounded so a wedged transport cannot wedge
        // onInitialize (the exact failure this gate's finite timeout
        // exists to prevent).
        const reconciled = await this.probePlatformReadinessDirect()
        if (reconciled) {
          this.log.info(
            'platform-probe readiness reconciled via direct probe RPC (ready event lost)',
            { meta: { nodeId, timeoutMs: PROBE_READY_TIMEOUT_MS } },
          )
        } else {
          this.log.warn(
            'platform-probe readiness gate timed out — conservative engine pick (floor is not persisted)',
            {
              meta: {
                nodeId,
                timeoutMs: PROBE_READY_TIMEOUT_MS,
                error: errMsg(err),
              },
            },
          )
        }
      }
    }
    await this.resolveAutoEngine()
    this.needsAutoPick = false
    this.startProvisioningForCurrentEngine()

    // Gate A (config-correctness) — eagerly surface config issues for the
    // node-default format now that the engine is derived, instead of waiting on
    // a `nodeDefaultSteps()` call a camera-only node may never make. Previously
    // driven off the (now-removed) engine-change hook; the node default is
    // derived once here, so this is the single eager entry point.
    await this.recomputeConfigIssues().catch((err: unknown) => {
      this.log.warn('config-issue recompute failed after node-default derive', {
        meta: { error: errMsg(err) },
      })
    })
  }

  /**
   * Authoritative platform-probe reconcile: query THIS NODE's probe provider
   * DIRECTLY over the cap plane. The RPC resolves only once the async probe
   * has completed (`getCapabilities` awaits the probe promise), so a
   * successful answer proves readiness independent of the (lossy)
   * `system.ready-state` event stream. Bounded by
   * {@link PROBE_DIRECT_RPC_TIMEOUT_MS}; `false` on any failure.
   *
   * PINNED, always. The previous version issued an UNPINNED `getCapabilities`
   * and its docblock claimed that "routes to this node's own in-process
   * provider (agent parent / hub)". On an agent that is false and always has
   * been: a forked child's unowned cap call reaches the agent's
   * `onUnownedCall`, which has no `CapRouteResolver` and no outbound
   * in-process lookup, so it goes straight to `forwardToHub` → the HUB's
   * platform-probe singleton. Every "readiness reconciled via direct probe
   * RPC (ready event lost)" line ever logged on an agent therefore proved the
   * HUB's probe had finished — not the local node's.
   *
   * That false positive is not cosmetic. It is a readiness gate answering yes
   * on another machine's evidence, and it is exactly the log line that made a
   * node with NO platform-probe addon at all (agent-a, 2026-08-07: its
   * `@camstack/system` package had been renamed out of `/data/addons`) look
   * like a node with a lossy event path. The pin makes the answer local: an
   * inline `nodeId` is the routing pin that survives the forked-addon → parent
   * UDS hop (`parent-unowned-call.ts`), the same mechanism the orchestrator's
   * `probeNodeInferenceDevices` already uses. A node whose own probe cannot be
   * reached now reports NOT ready — which is the truth, and which routes to
   * the conservative-floor WARN that says so.
   */
  private async probePlatformReadinessDirect(): Promise<boolean> {
    const api = this.addonCtx?.api
    if (!api) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const bound = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PROBE_DIRECT_RPC_TIMEOUT_MS)
      })
      const result = await Promise.race([
        api.platformProbe.getCapabilities.query({
          nodeId: this.localProbeNodeId(),
        }),
        bound,
      ])
      return result !== null
    } catch {
      return false
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Derive the node-default engine LIVE from this node's own kernel inference
   * resolver (`ctx.kernel.inferenceEngine`) — the runtime mirror of
   * `ctx.kernel.hwaccel`. Each node (hub + forked worker + remote agent)
   * resolves its OWN accelerators in-process, so a forked agent child never
   * adopts the hub's runtime from the `platform-probe` singleton.
   *
   * The default is the TOP-SCORED CONCRETE device from the SAME
   * `enumerateInferenceDevices` enumeration the orchestrator balances over
   * (e.g. `openvino:npu`, not `openvino:auto`) — NOT `pickBestRuntime`, whose
   * `defaultDeviceFor('openvino')` is the abstract `'auto'` sentinel. This is
   * load-bearing for pool COLLAPSE (D2/NEW-1): a `deviceKey`-less/lone session
   * routes through the default pool, and a balanced session that picks the same
   * top device (`openvino:npu`) must reuse THAT pool via `resolveDeviceFactory`'s
   * `enginesEqual(engine, currentEngine)` check — which only matches when the
   * default carries the concrete device, not `'auto'`. An abstract `'auto'`
   * default would spawn a THIRD pool contending with the per-device npu/gpu pools
   * on the same physical accelerators (double model load / VRAM). Falls back to
   * the onnx/cpu floor when the enumeration is empty. NEVER persists — recomputed
   * every boot from the local hardware, inherently self-healing.
   */
  private async resolveAutoEngine(): Promise<void> {
    // Engine selection is DETERMINISTIC from the node's own platform/arch
    // (authoritative via `process` inside `envToHardwareInfo`) plus the local
    // kernel resolver's gpu/npu detail. The hardware CAPABILITY (a Mac has
    // CoreML/ANE, an Intel box has OpenVINO) drives the pick — no probe wait,
    // no race, no EP-availability hint (EPs install lazily on selection).
    let hardware: KernelInferenceHardware | null = null
    try {
      hardware = (await this.addonCtx?.kernel?.inferenceEngine?.resolveHardware()) ?? null
    } catch {
      // Resolver unavailable (cold-start race / bare test kernel) — the
      // onnx/cpu floor below still keeps the node alive.
    }
    const env = runtimeEnvFromProcess(hardware ? toProbedHardware(hardware) : null)
    // `enumerateInferenceDevices` returns descriptors sorted best-score-first
    // (NPU > iGPU > … > CPU floor), one per PHYSICAL accelerator — the exact set
    // the orchestrator balances over. The top available descriptor is the node
    // default; its `key` (`openvino:npu`, `edgetpu:usb`, bare `cpu`, …) resolves
    // to the SAME engine `resolveDeviceFactory` builds for a balanced session on
    // that device, so the two share one pool.
    const devices = enumerateInferenceDevices(envToHardwareInfo(env))
    const top = devices.find((d) => d.available) ?? devices[0]
    this.currentEngine = top ? resolveDeviceEngine(top.key) : ONNX_FLOOR
    this.log.info('Derived node-default engine (local kernel)', {
      meta: {
        deviceKey: top?.key ?? 'onnx:cpu(floor)',
        backend: this.currentEngine.backend,
        device: this.currentEngine.device ?? null,
        hadHardware: hardware !== null,
      },
    })
  }

  /**
   * The RUNTIME that `'auto'` actually resolved to on this node (the live
   * `currentEngine.backend`), narrowed to a {@link RuntimeId}. The addon feeds
   * this into `resolveBackendTuning` when the stored config is `'auto'`, so the
   * pool tuning + respawn detection track the RESOLVED backend rather than the
   * `'auto'` sentinel (which would otherwise floor to onnx tuning).
   */
  resolvedEngineBackend(): RuntimeId {
    const backend = this.currentEngine.backend
    return backend === 'openvino' || backend === 'coreml' || backend === 'edgetpu'
      ? backend
      : 'onnx'
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Engine runtime provisioning (Phase 2)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Map a backend string to a known RuntimeId, flooring to onnx. */
  private toRuntimeId(backend: string): RuntimeId {
    const known: readonly RuntimeId[] = ['onnx', 'openvino', 'coreml', 'edgetpu']
    return known.find((id) => id === backend) ?? 'onnx'
  }

  /**
   * Build the {@link EngineProvisioner} with REAL effects. Built lazily
   * (effects need `addonCtx.deps` + the python dir), so the machine only
   * exists once the context is wired. The machine is the SOLE authority
   * the inference gate and the cap snapshot read.
   */
  private buildProvisioner(): EngineProvisioner {
    return new EngineProvisioner({
      requirementsFor: pythonRequirementsFor,
      modelFormatFor,
      installRequirements: async (files) => {
        const pythonAddonDir = this.executorOptions.pythonAddonDir
        if (!pythonAddonDir || !this.addonCtx) return
        for (const basename of files) {
          const file = path.join(pythonAddonDir, basename)
          if (!fs.existsSync(file)) continue
          await this.addonCtx.deps.installPythonRequirements(file)
        }
      },
      ensureModelForFormat: async (format) => {
        await this.ensureModelsForCurrentSteps(format)
      },
      verify: async (backend, device) => {
        await this.verifyEngine(backend, device)
      },
      now: () => Date.now(),
      setTimer: (ms, cb) => {
        const t = setTimeout(cb, ms)
        return () => clearTimeout(t)
      },
      onChange: (state) => {
        this.log.info('engine provisioning', { meta: { ...state } })
        this.emitEngineProvisioning(state)
      },
    })
  }

  /**
   * (Re)build the provisioner and `select()` the engine currently held in
   * `this.currentEngine`. Idempotent: a fresh `select()` bumps the
   * machine's generation so any in-flight provisioning for a superseded
   * engine is ignored. No-op for non-python engines (nothing to install /
   * verify — the gate treats them as ready immediately below).
   */
  private startProvisioningForCurrentEngine(): void {
    if (!this.provisioner) {
      this.provisioner = this.buildProvisioner()
    }
    const engine = this.currentEngine
    const runtimeId = this.toRuntimeId(engine.backend)
    const device = engine.device ?? 'cpu'

    // Thrash guard (review): `onConfigChanged` fires this on EVERY config
    // write (a tuning slider, a per-camera tweak), not just an engine-
    // cascade delta. `EngineProvisioner.select()` is pure/always-acts —
    // it bumps generation → installing → verifying → ready on every call.
    // Re-selecting the SAME engine would flip a READY machine back through
    // installing/verifying (transiently closing the inference gate, spawning
    // a throwaway verify probe, emitting spurious events). So SKIP when the
    // selection is unchanged AND the machine is already running (state !==
    // 'idle'). Boot (first select from idle, runtimeId === null) MUST still
    // proceed. A same-selection write while 'failed' is also skipped — the
    // existing backoff retry keeps running; we never reset it.
    const snapshot = this.provisioner.state
    const sameSelection = snapshot.runtimeId === runtimeId && snapshot.device === device
    if (sameSelection && snapshot.state !== 'idle') {
      return
    }

    // Engine (hence model FORMAT) changed → drop the cached step tree so
    // `resolveStepModels` re-resolves each step's model for the new
    // format on the next `nodeDefaultSteps`.
    if (!sameSelection) {
      this.currentSteps = null
    }

    // Non-python engines have no pip/model provisioning step; select() with
    // a runtime id keeps the snapshot honest (device + runtimeId populated)
    // and the machine drives straight to ready so the gate opens.
    this.provisioner.select(runtimeId, device)
  }

  /**
   * Gate A (config-correctness gate at engine change) — eagerly re-resolve
   * the node-default step tree for `this.currentEngine.format` and compute
   * human-readable config issues from the result:
   *   - model substitutions (`getActiveModelSubstitutions()`, populated as a
   *     side effect of the `nodeDefaultSteps()` re-resolve below) — a step's
   *     chosen model lacks a build for this format, so the format default
   *     runs instead (degraded but loadable).
   *   - zero-build steps (`collectZeroBuildIssues`) — a step whose FULL
   *     catalog has no model at all with a build for this format (not even
   *     the format default is loadable).
   *
   * Never throws — this is an additive diagnostic surface, not an
   * enforcement point (`assertEngineReady` still owns readiness). Any
   * failure clears `configIssues` and logs a warning rather than
   * propagating out of the engine-change path.
   */
  private async recomputeConfigIssues(): Promise<void> {
    this.configIssues = []
    try {
      const steps = await this.nodeDefaultSteps()
      if (!steps) return
      const format = this.currentEngine.format
      const substitutionIssues = this.getActiveModelSubstitutions().map(
        (s) => `${s.addonId}: chose ${s.chosen}, running ${s.running} (${s.format})`,
      )
      const zeroBuildIssues = collectZeroBuildIssues(
        flattenSteps(steps),
        format,
        this.mergedStepDefOrThrow,
      ).map((i) => `${i.addonId}: no model has a ${i.format} build`)
      this.configIssues = [...substitutionIssues, ...zeroBuildIssues]
    } catch (err: unknown) {
      this.configIssues = []
      this.log.warn('engine-change config gate failed — no config issues surfaced', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Per-node engine-provisioning snapshot. The cap routes `{ nodeId }` for
   * provider resolution only (the router strips it); each node returns its
   * own local machine state. Cold (pre-`setApi`) provider → `idle`. Merges
   * in Gate A's `configIssues` (see {@link recomputeConfigIssues}) when
   * non-empty — additive, never overrides the provisioner's own fields.
   */
  getEngineProvisioning(): EngineProvisioningState {
    const base: EngineProvisioningState = this.provisioner?.state ?? {
      runtimeId: null,
      device: null,
      state: 'idle',
    }
    return this.configIssues.length ? { ...base, configIssues: [...this.configIssues] } : base
  }

  /**
   * Inference gate. Rejects with the current phase/error unless the engine
   * provisioning machine is `ready`. Callers (`ensureExecutor`) surface the
   * state and skip inference for the cycle rather than falling back — the
   * cross-process frame caller (`pipeline-runner.runInference`) already
   * catches and drops the frame, so a throw here never crash-loops.
   */
  async assertEngineReady(): Promise<void> {
    const s = this.getEngineProvisioning()
    if (s.state !== 'ready') {
      throw new Error(`Detection engine not ready: ${s.state}${s.error ? ` — ${s.error}` : ''}`)
    }
  }

  /**
   * Download the model artifacts for `format` needed by the currently
   * configured steps. Reuses the existing model-download path
   * (`ensureModelsForSteps`/`downloadWithRetry`), specialised to the
   * provisioning format by temporarily projecting the current engine onto
   * `format` for the download fan-out.
   */
  private async ensureModelsForCurrentSteps(format: ModelFormat): Promise<void> {
    const steps = await this.nodeDefaultSteps()
    if (!steps || steps.length === 0) return
    for (const step of flattenSteps(steps)) {
      if (!step.enabled) continue
      const modelEntry = await this.resolveModelEntry(step.addonId, step.modelId)
      if (!modelEntry) continue
      if (isModelDownloaded(this.modelsDir, modelEntry, format)) continue
      await this.downloadWithRetry(modelEntry, format, 3)
    }
  }

  /**
   * 1-shot import + compile probe for `(backend, device)`. Spawns a
   * throwaway Python inference pool with EMPTY steps via the existing
   * `EngineFactory.initialize([])` path — this imports the selected
   * runtime (onnxruntime / openvino / coremltools) and throws on a
   * `ModuleNotFoundError` or a runtime-load/compile error — then disposes
   * the pool. No models are loaded; the probe only proves the runtime is
   * importable on this host. No-op (resolves) for non-python engines.
   */
  private async verifyEngine(backend: RuntimeId, device: string): Promise<void> {
    if (!this.executorOptions.pythonPath) {
      throw new Error('verifyEngine: pythonPath not resolved — embedded Python unavailable')
    }
    const engine: PipelineEngineChoice = {
      runtime: 'python',
      backend,
      format: modelFormatFor(backend),
      device,
    }
    const probe = new EngineFactory({
      engine,
      modelsDir: this.modelsDir,
      logger: this.log.child('engine-verify'),
      pythonPath: this.executorOptions.pythonPath,
      // A throwaway import/compile probe: pin it to the smallest possible pool
      // regardless of the runtime's profile or the operator's override — it
      // loads no models and must not contend with the live pools.
      provisioning: { concurrency: 1, numWorkers: 1 },
    })
    try {
      await probe.initialize([])
    } finally {
      await probe.dispose().catch(() => undefined)
    }
  }

  /**
   * Emit the {@link EventCategory.PipelineEngineProvisioning} telemetry
   * event on every machine transition so the Pipeline page can drive a
   * live per-node indicator without polling the cap snapshot.
   */
  private emitEngineProvisioning(state: EngineProvisioningState): void {
    const eventBus = this.addonCtx?.eventBus ?? this.eventBus
    if (!eventBus) return
    const rawNodeId = this.addonCtx?.kernel?.localNodeId ?? 'hub'
    const nodeId = rawNodeId.includes('/') ? rawNodeId.split('/')[0]! : rawNodeId
    eventBus.emit(
      createEvent(
        EventCategory.PipelineEngineProvisioning,
        { type: 'node', id: nodeId, nodeId },
        { ...state },
      ),
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Schema & Configuration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch this node's inference HARDWARE (gpu/npu) for engine + device gating,
   * from the local kernel resolver. Returns null when the resolver is not wired
   * yet (cold-start), so callers fall back to the registry's safe minimum. The
   * engine OFFER derives from hardware ONLY — install state never gates it.
   */
  /**
   * The local Moleculer node id (child-suffix stripped). Used to scope this
   * node's engine-cascade store keys (`<key>@<node>`). Hardware itself is now
   * resolved in-process via `ctx.kernel.inferenceEngine` (never the
   * `platform-probe` singleton, whose no-nodeId query resolved to the HUB and
   * pinned a device a remote agent couldn't run) — so this id is a store-scoping
   * concern, not a probe-routing one.
   */
  private localProbeNodeId(): string {
    const raw = this.addonCtx?.kernel?.localNodeId ?? 'hub'
    return raw.includes('/') ? raw.split('/')[0]! : raw
  }

  private async fetchProbeGatingData(): Promise<{
    hardware: KernelInferenceHardware | null
  }> {
    try {
      // Resolve THIS node's own accelerators from the local in-process kernel
      // resolver — the runtime mirror of `ctx.kernel.hwaccel`. Never the
      // `platform-probe` singleton (a no/wrong-node query resolves to the HUB's
      // hardware on a forked agent child). Combined with `process.platform/arch`
      // downstream, this is always the local node's true env.
      const hardware = (await this.addonCtx?.kernel?.inferenceEngine?.resolveHardware()) ?? null
      return { hardware }
    } catch {
      return { hardware: null }
    }
  }

  /**
   * Pull custom models from the `custom-model-registry` collection cap,
   * grouped by step id. 5s TTL cache. Fully graceful: when no provider is
   * registered (or the query fails) it returns an empty map and logs at most
   * a warning — callers then behave exactly like the static-catalog path.
   */
  private async getCustomModels(): Promise<ReadonlyMap<string, readonly ModelCatalogEntry[]>> {
    return this.customModels.refresh(this.addonCtx?.api)
  }

  /**
   * A step's definition MERGED with its custom models, synchronously, from
   * the last custom-model read (D657 round 2). Every placement gate here
   * judges this catalog — the one the orchestrator's schema carries.
   */
  private readonly mergedStepDef = (addonId: string): StepDefinition | null =>
    this.customModels.stepDefinition(addonId)

  /** {@link mergedStepDef} as the throwing lookup `collectZeroBuildIssues` takes. */
  private readonly mergedStepDefOrThrow = (addonId: string): StepDefinition => {
    const def = this.mergedStepDef(addonId)
    if (def === null) throw new Error(`Unknown pipeline step: "${addonId}"`)
    return def
  }

  /**
   * Resolve a model id within a step to a catalog entry — static catalog
   * first, then the custom registry. Returns undefined if neither has it.
   */
  private async resolveModelEntry(
    addonId: string,
    modelId: string,
  ): Promise<ModelCatalogEntry | undefined> {
    const fromCatalog = getStepDefinition(addonId).models.find((m) => m.id === modelId)
    if (fromCatalog) return fromCatalog
    const custom = await this.getCustomModels()
    return custom.get(addonId)?.find((m) => m.id === modelId)
  }

  async getSchema(engine?: PipelineEngineChoice): Promise<PipelineSchema> {
    if (!engine || !engine.runtime) engine = await this.getSelectedEngine()
    const customByStep = await this.getCustomModels()
    const { hardware } = await this.fetchProbeGatingData()
    const env = runtimeEnvFromProcess(toProbedHardware(hardware))
    const enginesWithDevices = this.getAvailableEnginesWithDevices(env)
    // A node can host MULTIPLE inference-device formats concurrently
    // (multi-device): the node's SELECTED engine format PLUS every other format
    // its hardware can actually run — e.g. a node whose selected engine is
    // `onnx` but which also has a Coral runs `tflite` on that device pool. The
    // catalog must carry every such format's models, otherwise a per-DEVICE
    // format check for a device whose format differs from the node's selected
    // engine (the resolver's skip-gate, the steps matrix, the per-device model
    // editor) finds ZERO compatible models and wrongly skips the ROOT — the
    // exact edgetpu/tflite "no-compatible-model on every step" failure. Each
    // downstream consumer re-filters by its specific format (`m.formats[fmt]`),
    // so this union never leaks an off-format model into a format-scoped view.
    // A single-engine node (only `onnx` available) yields exactly the old
    // single-format catalog — no change for the common case.
    const catalogFormats = new Set<ModelFormat>([
      engine.format,
      ...enginesWithDevices.map((e) => e.engine.format),
    ])
    const slots = buildSchemaSlots(catalogFormats, this.modelsDir, customByStep)
    return {
      availableEngines: enginesWithDevices.map((e) => this.toAvailableEngine(e)),
      selectedEngine: { ...engine },
      slots,
    }
  }

  async getAvailableEngines(): Promise<PipelineEngineChoice[]> {
    const { hardware } = await this.fetchProbeGatingData()
    const env = runtimeEnvFromProcess(toProbedHardware(hardware))
    return this.getAvailableEnginesWithDevices(env).map((e) => ({
      ...e.engine,
    }))
  }

  /**
   * Build the engine catalog from the HARDWARE-supported runtime set.
   *
   * The offered backend list comes from `supportedRuntimes(env)` — platform,
   * arch and probed hardware ONLY, never from which Python packages are
   * installed (install state is provisioned on demand in Phase 2). Each
   * engine's device list is `runtimeDevices(backend, env.hardware)` (probe-
   * driven; default-only when `env.hardware` is null). The result is
   * conservative when the probe is unreachable: onnx floor + default device.
   */
  getAvailableEnginesWithDevices(env: RuntimeEnv): readonly EngineWithDevices[] {
    return supportedRuntimes(env).map((id) => ({
      engine: {
        runtime: 'python' as const,
        backend: id,
        format: modelFormatFor(id),
        device: defaultDeviceFor(id),
      },
      devices: runtimeDevices(id, env.hardware).map((d) => ({
        id: d.value,
        label: d.label,
      })),
    }))
  }

  /**
   * Adapt an {@link EngineWithDevices} (registry shape) to the wire
   * {@link AvailableEngine} consumed by `PipelineSchema.availableEngines`.
   */
  private toAvailableEngine(e: EngineWithDevices): AvailableEngine {
    return {
      engine: {
        runtime: e.engine.runtime,
        backend: e.engine.backend,
        format: e.engine.format,
      },
      devices: e.devices.map((d) => ({ id: d.id, label: d.label })),
      defaultDevice: e.engine.device,
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Global Pipeline State
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve every step's model for this node's engine format via the shared
   * `resolveModelForFormat`, and surface any substitution. `step.engine?.format`
   * is gone — `this.currentEngine.format` is the only format source (engine is
   * node-local).
   *
   * Rebuilds `modelSubstitutions` from scratch (via {@link collectSubstitutions})
   * on every call, from the FULL tree being resolved, so the map always
   * reflects EXACTLY the substitutions in effect for the current tree+format —
   * a step whose chosen model becomes compatible again (e.g. after the
   * operator switches the engine to a format it supports) is cleared here
   * instead of leaking a stale "chose X → running Y" entry.
   */
  private resolveStepModels(steps: PipelineDefaultStep[]): PipelineDefaultStep[] {
    const format = this.currentEngine.format
    const substitutions = collectSubstitutions(steps, format)
    this.modelSubstitutions = new Map(substitutions.map((s) => [s.addonId, s]))
    for (const s of substitutions) {
      this.log.info('Step model lacks engine format — running format default (node-local)', {
        meta: {
          step: s.addonId,
          chosen: s.chosen,
          running: s.running,
          format: s.format,
        },
      })
    }
    return this.resolveStepModelTree(steps, format)
  }

  /** Pure recursive resolver — builds the resolved step tree without touching `modelSubstitutions`. */
  private resolveStepModelTree(
    steps: PipelineDefaultStep[],
    format: ModelFormat,
  ): PipelineDefaultStep[] {
    return steps.map((step) => {
      const resolved = resolveModelForFormat(step.addonId, step.modelId ?? null, format)
      const children = step.children?.length
        ? this.resolveStepModelTree([...step.children], format)
        : step.children
      return resolved === step.modelId && children === step.children
        ? step
        : { ...step, modelId: resolved, ...(children ? { children } : {}) }
    })
  }

  // Latest model substitutions (chose X → running Y for this node's format),
  // keyed by addonId. Surfaced in the detection-pipeline settings status so an
  // operator sees a degraded model instead of it silently swapping. The WHOLE
  // map is replaced on every `resolveStepModels` pass (see above) — never
  // mutated entry-by-entry — so a no-op resolve clears prior entries instead
  // of leaving them stale.
  private modelSubstitutions = new Map<string, ModelSubstitution>()

  getActiveModelSubstitutions(): ReadonlyArray<ModelSubstitution> {
    return [...this.modelSubstitutions.values()]
  }

  /**
   * PURE node-default step tree — computed on demand, never persisted, and
   * PRIVATE (D927): it is not the model any camera ran, so no caller outside
   * this provider may read it. It serves Gate A's config-issue probe and the
   * engine provisioning's model download.
   *
   * The object-detection default is hardware-aware (this node's resolved
   * backend + device via `resolveDefaultDetectionModel`); every other step
   * keeps its flat per-format default. The result is cached in
   * `currentSteps` only as a memo — the cache is dropped whenever the
   * engine (hence model format) changes, so a re-read always reflects the
   * live engine.
   */
  private async nodeDefaultSteps(): Promise<PipelineDefaultStep[] | null> {
    if (this.currentSteps) return this.currentSteps
    const detectionModelId = resolveDefaultDetectionModel(
      this.currentEngine.backend,
      this.currentEngine.device ?? null,
      this.currentEngine.format,
    )
    const defaults = buildDefaultStepTree(this.currentEngine.format, detectionModelId)
    if (defaults.length === 0) return null
    this.currentSteps = this.resolveStepModels(defaults)
    return this.currentSteps
  }

  /**
   * Task G5 (Gate B) — pre-init config-correctness gate. PURE COMPUTE
   * against `this.currentEngine.format`: resolves `steps` the same way the
   * runtime dispatch path (`resolveInputSteps`) would and reports what
   * WOULD happen, without touching `this.modelSubstitutions` (that node-
   * global map stays the exclusive property of `resolveStepModels`, the
   * node-default tree resolver — writing it here would race two
   * independent callers over the same field). Called by the orchestrator
   * at attach time, node-pinned to the target node.
   *
   * Composes three pure helpers from `step-resolution.ts`, ALL scoped to
   * ENABLED steps only (a disabled step's subtree — and any unknown addonId
   * or incompatible model inside it — contributes NO issue and NO
   * substitution; it will never execute, so flagging it is false-positive
   * noise):
   *   - `collectSubstitutions`  → `substitutions` (informational, never
   *     affects `ok`).
   *   - `collectUnknownAddonIssues` → `unknown-addon` HARD issues.
   *   - `collectZeroBuildIssues` (over the enabled, non-audio-classifier
   *     subset — mirrors Gate A's `flattenSteps`/`flattenEnabledVideoSteps`
   *     filter, since audio backends are validated by audio-analyzer, not
   *     against this node's VIDEO engine format) → `no-format-build` HARD
   *     issues.
   *
   * `collectSubstitutions` and `collectUnknownAddonIssues` recurse into
   * `children` themselves, so the enabled-scoping is applied ONCE up front
   * via {@link pruneToEnabledSteps} (which drops a disabled step's whole
   * subtree) rather than re-implemented inside each collector.
   *
   * Never throws — any unexpected failure degrades to a clean `ok: true`
   * result with a warning logged, same posture as `recomputeConfigIssues`.
   */
  async validatePipeline(input: {
    readonly steps: readonly PipelineStepInput[]
    /** Validate against THIS device pool's format; absent ⇒ the node default (D646). */
    readonly deviceKey?: string
  }): Promise<PipelineValidationResult> {
    let format = this.currentEngine.format
    try {
      if (input.deviceKey !== undefined) {
        try {
          format = resolveDeviceEngine(input.deviceKey).format
        } catch (err: unknown) {
          // A pool this node cannot even name is a HARD answer, not the
          // clean pass the outer catch would give (D646).
          return {
            ok: false,
            issues: [{ addonId: '*', kind: 'unknown-device', detail: errMsg(err) }],
            substitutions: [],
            format,
          }
        }
      }
      const steps = input.steps
      const enabledSteps = this.pruneToEnabledSteps(steps)
      const substitutions = collectSubstitutions(enabledSteps, format)
      const unknownAddonIssues = collectUnknownAddonIssues(enabledSteps)
      const zeroBuildIssues = collectZeroBuildIssues(
        this.flattenEnabledVideoStepInputs(steps),
        format,
        this.mergedStepDefOrThrow,
      )
      const issues: PipelineValidationIssue[] = [
        ...unknownAddonIssues.map(
          (u): PipelineValidationIssue => ({
            addonId: u.addonId,
            kind: 'unknown-addon',
            detail: `${u.addonId}: no registered step definition`,
          }),
        ),
        ...zeroBuildIssues.map(
          (z): PipelineValidationIssue => ({
            addonId: z.addonId,
            kind: 'no-format-build',
            detail: `${z.addonId}: no model has a ${z.format} build`,
          }),
        ),
      ]
      return { ok: issues.length === 0, issues, substitutions, format }
    } catch (err: unknown) {
      this.log.warn('validatePipeline failed — reporting a clean result', {
        meta: { error: errMsg(err) },
      })
      return { ok: true, issues: [], substitutions: [], format }
    }
  }

  /**
   * Prune `steps` to ENABLED steps only, recursing into ENABLED children —
   * a disabled step's whole subtree is dropped, never partially kept. This
   * is the enabled-only tree shape `collectSubstitutions` and
   * `collectUnknownAddonIssues` need in {@link validatePipeline}: both
   * recurse into `children` themselves (unlike `flattenEnabledVideoStepInputs`,
   * which flattens AND excludes `audio-classifier`), so pruning once up
   * front — without touching the audio/video split — is enough to make
   * Gate B's three checks agree on scope. Pure; returns the original array
   * reference when nothing changed.
   */
  private pruneToEnabledSteps(steps: readonly PipelineStepInput[]): readonly PipelineStepInput[] {
    const result: PipelineStepInput[] = []
    let changed = false
    for (const step of steps) {
      if (!step.enabled) {
        changed = true
        continue
      }
      const prunedChildren = step.children?.length
        ? this.pruneToEnabledSteps(step.children)
        : step.children
      if (prunedChildren !== step.children) {
        changed = true
        result.push({ ...step, children: prunedChildren })
      } else {
        result.push(step)
      }
    }
    return changed ? result : steps
  }

  /**
   * Flatten `steps` (recursing into ENABLED children only — a disabled
   * step's subtree is skipped entirely, mirroring
   * `flattenEnabledVideoSteps`) into `{addonId}` entries, excluding
   * `audio-classifier` steps: Gate B validates the VIDEO engine format
   * (`this.currentEngine.format`) only — audio backends resolve their own
   * format independently and are validated by the audio-analyzer addon.
   * An addonId whose `StepDefinition` lookup throws is skipped here (it is
   * already reported separately by `collectUnknownAddonIssues`).
   */
  private flattenEnabledVideoStepInputs(
    steps: readonly PipelineStepInput[],
  ): { readonly addonId: string }[] {
    const result: { readonly addonId: string }[] = []
    const walk = (nodes: readonly PipelineStepInput[]): void => {
      for (const step of nodes) {
        if (!step.enabled) continue
        try {
          if (getStepDefinition(step.addonId).slot === 'audio-classifier') continue
        } catch {
          continue // unknown addon — reported separately by collectUnknownAddonIssues
        }
        result.push({ addonId: step.addonId })
        if (step.children?.length) walk(step.children)
      }
    }
    walk(steps)
    return result
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Engine Management
  // ═══════════════════════════════════════════════════════════════════════════

  async getSelectedEngine(): Promise<PipelineEngineChoice> {
    return this.currentEngine
  }

  // setEngine removed in Phase 6c — engine is per-camera in the
  // stateless-pipeline model. The orchestrator's per-camera
  // `CameraPipelineConfig.engine` is the source of truth; Phase 4
  // (future) adds an engine cache on the executor keyed by engineKey
  // for fast per-frame dispatch.

  // ═══════════════════════════════════════════════════════════════════════════
  // Orchestrator Settings / Config Schema
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Moved to `@camstack/addon-pipeline-orchestrator` as part of the pipeline
  // page redesign. That addon now owns:
  //   - The ConfigUISchema sections for motion / detection / audio / balancer
  //     / failover (via its `getConfigSchema()` method)
  //   - The per-device settings storage under `addon:pipeline-orchestrator`
  //   - The typed accessors `getDeviceOrchestrationSettings` and
  //     `getGlobalOrchestrationSettings` on the pipeline-orchestrator cap
  //
  // The detection-pipeline addon no longer exposes orchestration settings
  // because they are not pipeline content — they are orchestration policy
  // (what stream to use, what fps to target, what classes to filter).
  // The pipeline-executor cap is intentionally blind to that layer.
  //
  // `getOrchestratorConfigSchema()` on IPipelineExecutorProvider still exists
  // as an interface method for backwards compatibility with hub dashboards
  // that query it during boot, but returns an empty schema from this addon.

  async getOrchestratorConfigSchema(): Promise<ConfigUISchema> {
    return { sections: [] }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Inference Capabilities
  // ═══════════════════════════════════════════════════════════════════════════

  async getCapabilities(_forceRefresh?: boolean): Promise<InferenceCapabilities> {
    const broker = this.addonCtx?.kernel?.cluster?.broker
    const agentId = broker?.nodeID ?? os.hostname()
    const agentName = agentId

    // Step → addon mapping. Each pipeline step is surfaced as an
    // AddonCapabilityInfo with its catalog of models + per-format
    // download status.
    const addons = ALL_PIPELINE_STEPS.map(
      (s): AddonCapabilityInfo => ({
        id: s.definition.id,
        name: s.definition.name,
        models: s.definition.models
          .filter((m) => m.legacy !== true)
          .map((m): ModelAvailability => {
            const formats: Record<string, ModelFormatStatus> = {}
            for (const [formatKey, entry] of Object.entries(m.formats)) {
              if (!entry) continue
              const downloaded = isModelDownloaded(this.modelsDir, m, formatKey as ModelFormat)
              const status: ModelFormatStatus = {
                url: entry.url,
                sizeMB: entry.sizeMB,
                downloaded,
                ...(downloaded
                  ? {
                      filePath: path.join(this.modelsDir, `${m.id}.${formatKey}`),
                    }
                  : {}),
              }
              formats[formatKey] = status
            }
            return {
              id: m.id,
              name: m.name,
              description: m.description,
              inputSize: m.inputSize,
              formats,
            }
          }),
      }),
    )

    // Runtime listing. The probe-gated engine table tells us which runtimes
    // are actually reachable on this host — backends the probe reports as
    // unavailable (e.g. coreml on Linux, openvino when pip module missing)
    // are omitted so the InferenceCapabilities surface stays honest.
    const { hardware } = await this.fetchProbeGatingData()
    const env = runtimeEnvFromProcess(toProbedHardware(hardware))
    const engines = this.getAvailableEnginesWithDevices(env)
    // Detection engines are Python-only (registry offers `runtime: 'python'`).
    const nodeBackends: BackendInfo[] = []
    const pythonBackends: PythonBackendInfo[] = []
    for (const e of engines) {
      pythonBackends.push({
        id: e.engine.backend,
        label: e.engine.backend.toUpperCase(),
        available: true,
        device: e.engine.device || e.devices[0]?.id || 'cpu',
        modelFormat: e.engine.format,
        pythonModule: pythonModuleForBackend(e.engine.backend),
      })
    }

    return {
      agentId,
      agentName,
      platform: os.platform(),
      arch: os.arch(),
      addons,
      runtimes: {
        node: {
          available: true,
          backends: nodeBackends,
          modelFormat: 'onnx',
        },
        python: {
          available: pythonBackends.length > 0,
          backends: pythonBackends,
        },
      },
      modelsDir: this.modelsDir,
    }
  }

  async getAddonModels(input: { addonId: string }): Promise<readonly ModelAvailability[]> {
    const caps = await this.getCapabilities()
    return caps.addons.find((a) => a.id === input.addonId)?.models ?? []
  }

  async getDetectionConfigSchema(): Promise<ConfigUISchema | null> {
    return this.detectionConfigSchemaSource?.() ?? null
  }

  async downloadModel(input: {
    modelId: string
    format: ModelFormat
    addonId: string
  }): Promise<{ filePath: string; sizeMB: number; durationMs: number }> {
    const { modelId, format, addonId } = input
    // Import+land registers then downloads on the same tick — force past the
    // custom-model TTL so a warm empty snapshot cannot hide the new id.
    await this.customModels.refresh(this.addonCtx?.api, { force: true })
    const modelEntry = await this.resolveModelEntry(addonId, modelId)
    if (!modelEntry) {
      throw new Error(`Model "${modelId}" not found in step "${addonId}" catalog`)
    }

    const formatEntry = modelEntry.formats[format]
    if (!formatEntry) {
      throw new Error(
        `Model "${modelId}" has no ${format} format. Available: ${Object.keys(modelEntry.formats).join(', ')}`,
      )
    }

    const totalBytes = formatEntry.sizeMB * 1024 * 1024
    const source = { type: 'pipeline', id: 'model-download' } as const
    let lastEmittedPercent = -1

    const emitProgress = (progress: number) => {
      this.eventBus?.emit({
        id: `model-download-${Date.now()}`,
        timestamp: new Date(),
        source,
        category: EventCategory.ModelDownloadProgress,
        data: { modelId, progress, totalMB: formatEntry.sizeMB },
      })
    }

    // Throttled progress callback — emit at most every 2% to avoid flooding the EventBus
    const onProgress = (downloaded: number, total: number | undefined) => {
      const effectiveTotal = total ?? totalBytes
      const percent =
        effectiveTotal > 0 ? Math.min(99, Math.round((downloaded / effectiveTotal) * 100)) : 0
      if (percent > lastEmittedPercent + 1) {
        lastEmittedPercent = percent
        emitProgress(percent)
      }
    }

    emitProgress(0)

    const startMs = Date.now()
    try {
      await this.downloadWithRetry(modelEntry, format, 3, onProgress)
      const durationMs = Date.now() - startMs

      const urlParts = formatEntry.url.split('/')
      const filename = urlParts[urlParts.length - 1] ?? `${modelEntry.id}.${format}`
      const filePath = path.join(this.modelsDir, filename)

      this.log.info('Model downloaded', {
        meta: { modelId, format, durationMs },
      })
      emitProgress(100)

      return { filePath, sizeMB: formatEntry.sizeMB, durationMs }
    } catch (err: unknown) {
      const msg = errMsg(err)
      this.log.error('Model download failed', {
        meta: { error: msg, modelId, format },
      })
      emitProgress(-1)
      throw err
    }
  }

  async deleteModel(input: {
    modelId: string
    format: ModelFormat
    addonId: string
  }): Promise<{ success: true }> {
    const { modelId, format, addonId } = input
    const modelEntry = await this.resolveModelEntry(addonId, modelId)
    if (!modelEntry) {
      throw new Error(`Model "${modelId}" not found in step "${addonId}" catalog`)
    }

    const deleted = deleteModelFromDisk(this.modelsDir, modelEntry, format)
    if (!deleted) {
      throw new Error(`Model "${modelId}" (${format}) is not downloaded — nothing to delete`)
    }

    this.log.info('Model deleted from disk', { meta: { modelId, format } })
    return { success: true }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pipeline Execution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Minimal detection-free `FrameResult` returned when a `frameHandle` read
   * misses (recycled slot / foreign / unmappable). Shape-identical to a
   * zero-detection runtime result so downstream consumers treat it as a
   * dropped frame, not an error.
   */
  private emptyFrameHandleResult(input: PipelineRunInput): FrameResult {
    return {
      kind: 'frame',
      frameId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      deviceId: input.deviceId ?? 0,
      timestamp: Date.now(),
      width: input.frameHandle?.width ?? 0,
      height: input.frameHandle?.height ?? 0,
      detections: [],
      debug: { totalInferenceMs: 0 },
    }
  }

  /**
   * Build the design-B native-face-crop provider for a runtime frame. Present
   * ONLY when the frame arrived as a retention `frameHandle` (the key the owning
   * pipeline-runner registered the frame's native surface under) and the sibling
   * `pipeline-runner` cap is reachable via `ctx.api`. Each call is a best-effort
   * round-trip pinned to the frame's OWNING node (`nodePin(handle.nodeId)` — the
   * node that decoded it, i.e. THIS node for a local frame, never a cross-node
   * hop) that returns the native ROI or `null` on a miss; the executor then
   * falls back to the downscaled crop, so behaviour is never worse than before.
   */
  private buildNativeFaceCropProvider(
    handle: FrameHandle | undefined,
  ): NativeFaceCropProvider | undefined {
    if (!handle) return undefined
    const api = this.addonCtx?.api
    if (!api) return undefined
    return async (roi, maxWidth) => {
      try {
        const native = await api.pipelineRunner.getNativeCrop.query(
          {
            handle,
            bbox: roi,
            ...(maxWidth !== undefined ? { maxWidth } : {}),
          },
          nodePin(handle.nodeId),
        )
        // `bytes` is absent on the compressed (`encodeJpeg`) path — this
        // caller never requests it, so an absent `bytes` means the runner
        // could not serve raw pixels: treat it as a miss and let the
        // executor fall back to the downscaled crop (same guard the
        // detail-plane builder below applies).
        if (!native || !native.bytes || native.width <= 0 || native.height <= 0) return null
        return {
          bytes: native.bytes,
          width: native.width,
          height: native.height,
        }
      } catch {
        // Best-effort: any transport/cap error → the executor's downscaled fallback.
        return null
      }
    }
  }

  /**
   * Build the native-crop provider for the DETAIL plane (`nativeCropRef` set by
   * `runDetailSubtree` when the parent crop came from the frame's native surface).
   * Same best-effort round-trip as {@link buildNativeFaceCropProvider}, but the
   * executor's ROI arrives normalized in the PARENT CROP's space, so it is first
   * re-composed into FRAME-normalized coordinates (via `cropFrameSpace`) before
   * hitting the native surface. This is what lets a leaf child (plate-ocr,
   * face-embedding) read native pixels even though the executor is running on a
   * cut of the frame, not the whole frame. A compose/native miss → `null` (the
   * executor falls back to the downscaled tile crop).
   */
  private buildNativeCropProviderFromRef(
    ref: NativeCropRef | undefined,
  ): NativeFaceCropProvider | undefined {
    if (!ref) return undefined
    const api = this.addonCtx?.api
    if (!api) return undefined
    const { handle, cropFrameSpace } = ref
    return async (roi, maxWidth) => {
      try {
        const frameRoi = composeCropRoiToFrameNorm(roi, cropFrameSpace, handle.width, handle.height)
        if (!frameRoi) return null
        const native = await api.pipelineRunner.getNativeCrop.query(
          {
            handle,
            bbox: frameRoi,
            ...(maxWidth !== undefined ? { maxWidth } : {}),
          },
          nodePin(handle.nodeId),
        )
        if (!native || !native.bytes || native.width <= 0 || native.height <= 0) return null
        return {
          bytes: native.bytes,
          width: native.width,
          height: native.height,
        }
      } catch {
        // Best-effort: any transport/cap/compose error → downscaled tile fallback.
        return null
      }
    }
  }

  async runPipeline(
    input: PipelineRunInput,
    onProgress?: (message: string) => void,
  ): Promise<FrameResult> {
    // Every progress milestone is forwarded both to the in-process
    // callback (legacy) and to the event bus as `pipeline.progress`.
    // The admin UI's Static Pipeline tab (ImageTab) subscribes to this
    // category and renders each `message` as a status line. Emitting on
    // the bus is the only way the UI can observe progress — the
    // `onProgress` closure can't cross a tRPC boundary, and runPipeline
    // is always invoked via tRPC from the benchmark worker.
    //
    // Every emission tags:
    //  - `nodeId`: the node that ran the pipeline (distinguishes emitters
    //    when multiple nodes run benchmarks concurrently)
    //  - `sessionId`: a unique per-run id so the UI can correlate a burst
    //    of messages into a single pipeline run. When the caller passes
    //    `input.sessionId` (UI-initiated one-shot), the server reuses it
    //    verbatim so the UI can filter `pipeline.progress` to its own run
    //    and ignore concurrent runtime dispatches from camera frames.
    //
    // The BUS half of that is for a caller that asked for a run. The live
    // camera path asks for nothing: it supplies neither `sessionId` nor a
    // subscriber, and its four pre-executor lines were 43% of every event
    // delivery decision on the hub (measured 107.7–112.3 events/s offered to
    // 38 runners, delivered to none — the busiest runner in the registry
    // receives 89.9/s across ALL categories, so no runner can be receiving
    // this one). `progressToBus` applies to those four the same gate the
    // executor branch already applies to the late ones. See
    // `docs/design/2026-08-29-event-bus-fanout-load.md` §3 and D290.
    // Refresh the CLUSTER model row before any step is resolved. TTL-cached, so
    // this is a no-op on all but one call a minute; `current()` is then
    // synchronous for the whole dispatch, which is what lets
    // `inputStepsToPipelineSteps` stay sync on the per-frame path. Swallows its
    // own failures and keeps the last known row — see `cluster-model-source.ts`.
    await this.clusterModels.refresh(this.addonCtx?.api)
    // A cluster step whose model the owner has not answered yet is dropped by
    // `resolveInputSteps`; the camera is told once (D658).
    this.clusterUnknownLog.note(input.deviceId ?? 0, input.steps, this.clusterModels.unknownSteps())
    // An all-or-nothing call (benchmark, replay, capacity ramp — D657) runs
    // exactly what it names or fails by name; it never quietly runs without a
    // cluster step the owner has not answered for.
    if (dispatchLoadPolicyOf(input) === 'all-or-nothing') {
      const unknown = unknownStepsNamed(input.steps, this.clusterModels.unknownSteps())
      if (unknown.length > 0) {
        throw new Error(
          `cluster-model-unknown: the owner has not answered which model the cluster runs for ${unknown.join(', ')} — the call runs all of its steps or none`,
        )
      }
    }
    // The placement gates below read the merged catalog synchronously (D657).
    await this.getCustomModels()

    const nodeId = this.addonCtx?.kernel?.localNodeId ?? 'hub'
    const sessionId =
      input.sessionId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    // Decided by the input shape alone, so it is available to `emit` — the
    // executor branch below reads this same const rather than re-deriving it,
    // because two copies of a gate is how the four early emits came to
    // disagree with the comment 300 lines down.
    const isRuntime = Boolean(input.frame || input.frameRef)
    // A caller that supplied its own `sessionId` asked for the stream and is
    // filtering on it: `runPipelineBatch` (provider.ts:3622) and the capacity
    // ramp (pipeline-runner/index.ts:1937) both send raw frames AND a
    // sessionId, so `isRuntime` alone would silently blank an operator's
    // benchmark. The live camera dispatch supplies neither — verified on the
    // hub, where every observed payload carried a minted `run-<ms>-<rand>`.
    // A REPLAY (D646) is frame after frame like a camera, not a one-shot a UI
    // is watching: it fans nothing out unless its caller named a session.
    const progressToBus = (!isRuntime && input.replay !== true) || input.sessionId !== undefined
    const emit = (
      message: string,
      extra?: {
        step?: string
        addonId?: string
        modelId?: string
        ms?: number
        engine?: { runtime: string; backend: string; device?: string }
      },
    ): void => {
      onProgress?.(message)
      // The in-process callback is free and always runs; only the bus fan-out
      // is gated. Nothing is dropped here that anyone reads — no runner
      // declares `pipeline.progress`, and both admin-UI consumers discard
      // every payload whose `sessionId` is not the one they asked for.
      if (!progressToBus) return
      this.eventBus?.emit(
        createEvent(
          EventCategory.PipelineProgress,
          { type: 'pipeline', id: 'pipeline-test' },
          {
            nodeId,
            sessionId,
            step: extra?.step ?? '-',
            addonId: extra?.addonId,
            modelId: extra?.modelId,
            ms: extra?.ms,
            ...(extra?.engine ? { engine: extra.engine } : {}),
            message,
          },
        ),
      )
    }

    // Per-phase latency breakdown surfaced in result.debug. Only populated
    // for benchmark / reference-image paths — runtime path returns early
    // with the raw executor result (no debug augmentation).
    const wallT0 = performance.now()
    let decodeMs: number
    let setupMs: number

    // Resolve image from frame (runtime), base64 (benchmark), binary
    // image (benchmark fast path), or reference. Exactly one source is
    // accepted; ambiguous input throws so we never silently prefer one
    // path over another.
    let rootInput: InferenceInput
    let imageWidth: number
    let imageHeight: number
    /**
     * Lazy JPEG accessor for crop-children execution. Encodes the raw
     * frame to JPEG once on first call and caches the result. JPEG-
     * source frames return their own buffer with no encode work. Trees
     * without crop children never invoke this — the raw fast path
     * stays JPEG-free end to end.
     */
    let jpegProvider: () => Promise<Buffer>
    const sources = [
      input.frame ? 'frame' : null,
      input.frameRef ? 'frameRef' : null,
      input.frameHandle ? 'frameHandle' : null,
      input.image ? 'image' : null,
      input.imageBase64 ? 'imageBase64' : null,
      input.referenceImage ? 'referenceImage' : null,
    ].filter((s): s is string => s !== null)
    if (sources.length === 0) {
      throw new Error(
        'runPipeline requires exactly one of: frame, frameRef, frameHandle, image, imageBase64, referenceImage',
      )
    }
    if (sources.length > 1) {
      throw new Error(`runPipeline received conflicting image sources: ${sources.join(', ')}`)
    }

    // The `frameHandle` input is DORMANT since the shm-ring removal
    // (2026-07-16): the runner always ships inline pixels now, and the CB5
    // shm passthrough that resolved a handle to pixels is gone. A handle can
    // only arrive under version skew (an old runner against a new executor);
    // there is no way to resolve its pixels here, so it degrades to an empty
    // FrameResult — cheap, before any engine work. The field stays defined so
    // no cap-surface change is needed.
    if (input.frameHandle) return this.emptyFrameHandleResult(input)
    const runtimeFrame: FrameInput | undefined = input.frame ?? undefined
    const runtimeFrameRef = input.frameRef

    const decodeT0 = performance.now()
    if (runtimeFrameRef) {
      imageWidth = runtimeFrameRef.width
      imageHeight = runtimeFrameRef.height
      // Replaced per root after tree/model resolution. The placeholder never
      // reaches an engine because `rootInputViewProvider` covers every root.
      rootInput = { kind: 'jpeg', data: Buffer.alloc(0) }
      jpegProvider = async () => {
        throw new Error('frameRef root view was requested before model resolution')
      }
      emit(`FrameRef: ${imageWidth}×${imageHeight} (${runtimeFrameRef.format})`)
    } else if (runtimeFrame) {
      // Runtime dispatch path (pipeline-runner → broker decoded frame or shm
      // FrameHandle). Dimensions come from the FrameInput; no JPEG probe needed.
      const frame = runtimeFrame
      imageWidth = frame.width
      imageHeight = frame.height
      // VIEW the underlying ArrayBuffer instead of copying — Buffer.from(Uint8Array)
      // copies the data, which on the raw-RGB hot path means cloning ~1.2MB
      // (640×640×3 native or 1280×720×3) on every call. The pool writes the
      // bytes into the python stdin pipe and never mutates them, so a view is
      // safe. Bench at parallel=4 dropped from 50fps to 20fps just from the
      // copy + GC pressure of this single line.
      const data = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
      if (frame.format === 'jpeg') {
        rootInput = { kind: 'jpeg', data }

        jpegProvider = async () => data
      } else if (frame.format === 'rgb' || frame.format === 'bgr' || frame.format === 'gray') {
        // Encode raw → JPEG before sending to the Python pool. The JPEG
        // is ~200KB vs 1.2MB raw RGB — saves ~30ms of pipe transfer per
        // call at the cost of ~3-5ms sharp encode. Net gain: ~25ms/call.
        // This is the production hot path (camera frames from broker).
        const channels = frame.format === 'gray' ? 1 : 3
        const sharp = await getSharp()
        const jpeg = await sharp(data, {
          raw: { width: frame.width, height: frame.height, channels },
        })
          .jpeg({ quality: 85, mozjpeg: false })
          .toBuffer()
        rootInput = { kind: 'jpeg', data: jpeg }

        jpegProvider = async () => jpeg
      } else {
        // yuv420 (and any future planar format) — encode to JPEG
        // upfront. Not on the hot path today: detection always
        // requests rgb/jpeg/gray.
        const sharp = await getSharp()
        const encoded = await sharp(data, {
          raw: { width: frame.width, height: frame.height, channels: 3 },
        })
          .jpeg({ quality: 80, mozjpeg: false })
          .toBuffer()
        rootInput = { kind: 'jpeg', data: encoded }

        jpegProvider = async () => encoded
      }
      emit(`Frame: ${imageWidth}×${imageHeight} (${frame.format})`)
    } else if (input.image) {
      // Binary fast path — caller already decoded base64 (or never had
      // it to begin with). Saves ~5ms base64 decode per call vs the
      // imageBase64 path, plus 33% payload on the Moleculer MsgPack hop.
      emit('Decoding image...')
      const data = Buffer.from(input.image.buffer, input.image.byteOffset, input.image.byteLength)
      const dims = await this.getJpegDimensions(data)
      imageWidth = dims.width
      imageHeight = dims.height
      rootInput = { kind: 'jpeg', data }
      jpegProvider = async () => data
      emit(`Image: ${imageWidth}×${imageHeight}`)
    } else if (input.imageBase64) {
      emit('Decoding image...')
      const data = Buffer.from(input.imageBase64, 'base64')
      const dims = await this.getJpegDimensions(data)
      imageWidth = dims.width
      imageHeight = dims.height
      rootInput = { kind: 'jpeg', data }
      jpegProvider = async () => data
      emit(`Image: ${imageWidth}×${imageHeight}`)
    } else {
      // referenceImage path (the last remaining source after the
      // exclusivity check above).
      emit(`Loading reference image: ${input.referenceImage!}`)
      const img = await this.getReferenceImage({
        filename: input.referenceImage!,
      })
      if (!img) throw new Error(`Reference image not found: ${input.referenceImage!}`)
      const data = Buffer.from(img.base64, 'base64')
      const dims = await this.getJpegDimensions(data)
      imageWidth = dims.width
      imageHeight = dims.height
      rootInput = { kind: 'jpeg', data }
      jpegProvider = async () => data
      emit(`Image: ${imageWidth}×${imageHeight}`)
    }
    decodeMs = performance.now() - decodeT0

    // Convert input steps → PipelineDefaultStep (enriching from StepDefinitions).
    // Phase 2 multi-device (Fable P0-3/P0-6): a per-call `deviceKey` (e.g.
    // `openvino:npu`, `edgetpu:usb`) drives model resolution too — otherwise the
    // NPU keeps the node's default instead of its own, and Coral keeps an
    // openvino model with no tflite build. The device's `device` feeds MODEL_BY_CLASS
    // (npu→our v9, gpu→v9) and its `format` picks the format build (tflite→ssd).
    // Precedence: deviceKey (live/orchestrator routing) > node.
    // Capability gate (cam-101): a deviceKey whose format an enabled step has
    // ZERO builds for falls back to the node-local default engine — see
    // `resolveStepsForDispatch`. `dispatchDeviceKey` is the post-gate routing.
    // A live frame whose elected device is in backoff (or failed) re-elects
    // onto the node default pool instead of being refused at the dead pool
    // for the rest of its session. Replays pin and refuse (D54), and a
    // measurement (`sessionId`: the capacity ramp, a batch) asked for THAT
    // device: only a camera's live dispatch re-elects.
    const liveDeviceKey =
      isRuntime &&
      input.replay !== true &&
      input.deviceId !== undefined &&
      input.sessionId === undefined
        ? this.routeLiveFrameDevice(input.deviceKey, input.deviceId)
        : input.deviceKey
    const dispatchResolution = this.resolveStepsForDispatch({
      steps: input.steps,
      deviceKey: liveDeviceKey,
      deviceId: input.deviceId,
      // Root-decides gate: the live runner sends `'frame'` (root-plane steps
      // only execute here), so a detail child never bounces the root off its
      // device — it defers to the detail-plane device jump instead.
      plane: input.plane,
    })
    const dispatchDeviceKey = dispatchResolution.deviceKey
    const benchmarkSteps = dispatchResolution.steps
    // Per-step debug-level logging — runPipeline fires once per decoded
    // frame (up to `detectionFps` per camera). Dedupe via a signature
    // so the per-step dump only fires when the steps config actually
    // changes (operator edit / new camera attach), not on every frame.
    const stepsSignature = JSON.stringify(
      benchmarkSteps.map((s) => ({
        id: s.addonId,
        settings: s.settings ?? {},
      })),
    )
    if (stepsSignature !== this.lastStepsSignature) {
      this.lastStepsSignature = stepsSignature
      for (const s of benchmarkSteps) {
        this.log.debug('step configured', {
          meta: {
            phase: 'runPipeline',
            step: s.addonId,
            settings: s.settings ?? {},
          },
        })
      }
    }
    const enabledSteps = flattenSteps(benchmarkSteps)
    emit(
      `Pipeline: ${enabledSteps.length} step(s) — ${enabledSteps.map((s) => s.addonId).join(' → ')}`,
    )
    // A REPLAY runs exactly what it names or nothing (D56): checked here,
    // before any pool is touched, against what resolution would actually run.
    if (input.replay === true) {
      const verdict = checkReplayPin({
        requested: input.steps,
        executing:
          input.plane === 'frame'
            ? collectFramePlaneSteps(benchmarkSteps, isDetailPlaneStep)
            : enabledSteps,
        requestedDeviceKey: input.deviceKey,
        dispatchDeviceKey,
        format: dispatchDeviceKey
          ? resolveDeviceEngine(dispatchDeviceKey).format
          : this.currentEngine.format,
      })
      if (verdict.kind === 'refused') {
        this.log.warn('replay refused — the node cannot run exactly what was pinned', {
          ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
          meta: { reason: verdict.reason, detail: verdict.detail, deviceKey: input.deviceKey },
        })
        throw new Error(`${verdict.reason}: ${verdict.detail}`)
      }
    }
    // A replay is the camera's own structure over stored pixels: the zone
    // gate and the crop-zone root apply exactly as they do to a live frame.
    const appliesCameraGates = isRuntime || input.replay === true

    // Ensure engine factory is initialized (do NOT require global steps — benchmark uses explicit steps)
    await this.ensureEngineFactory()
    // The engine is the node's own, always (D646). A benchmark used to send
    // `input.engine` and have it honoured by re-pointing `this.currentEngine`,
    // `this.engineFactory` and `this.executor` for the length of the call —
    // shared state, across awaits, on a node serving live cameras. A caller
    // picks an accelerator with `deviceKey`, which is a LOCAL choice below.
    const runEngine: PipelineEngineChoice = this.currentEngine
    // `device` falls back to 'default' in the label only — the event
    // payload keeps the actual value (which is always populated after
    // loadEngine fallback, but the label must never render as bare
    // `runtime/backend` for operator log parsing).
    const deviceLabel = runEngine.device ?? 'default'
    emit(`Engine: ${runEngine.runtime}/${runEngine.backend}/${deviceLabel}`, {
      step: 'engine',
      engine: {
        runtime: runEngine.runtime,
        backend: runEngine.backend,
        device: deviceLabel,
      },
    })
    const runtimeStr = `${runEngine.runtime}+${runEngine.backend}`
    const executor =
      this.executor ?? new PipelineExecutor({ engineRuntime: runtimeStr, logger: this.log })
    this.executor = executor
    // Phase 2 multi-device: route this call to its device pool when a
    // `deviceKey` survived the capability gate (e.g. `openvino:npu`,
    // `edgetpu:usb`), else the node's default engine pool. `dispatchFactory`
    // is a LOCAL choice — no shared state mutated, so concurrent sessions on
    // different devices don't race.
    const dispatchEngine = dispatchDeviceKey ? resolveDeviceEngine(dispatchDeviceKey) : runEngine
    // A benchmark (a one-shot image, no camera) loads into a pool of its own,
    // never the live one (D910): the models it names are the likeliest to be
    // cold, and a native compiler crash would take the live worker down.
    // The exception is an EXCLUSIVE device (an Edge TPU opens in one process
    // only): a second pool cannot open a Coral the cameras' pool holds, so its
    // benchmark goes through the live pool, as one more request on its queue.
    const benchmark = isBenchmarkRun(input)
    const placement = benchmarkPlacementOf(benchmark, deviceKeyOf(dispatchEngine))
    if (benchmark && placement === 'live-pool') {
      this.log.info('Benchmark on an exclusive device — served by the live pool', {
        meta: { deviceKey: deviceKeyOf(dispatchEngine) },
      })
    }
    const dispatchFactory =
      placement === 'benchmark-pool'
        ? await this.benchmarkPools.acquire(deviceKeyOf(dispatchEngine), dispatchEngine)
        : dispatchDeviceKey
          ? await this.resolveDeviceFactory(dispatchDeviceKey)
          : this.engineFactory!
    // `needsPoolUpdate`, never `isLoadedWithModel`: a step whose model is
    // already warm can still owe the pool a retuned decode setting (D214).
    const needed = enabledSteps.filter((s) => dispatchFactory.needsPoolUpdate(s))
    // What this dispatch runs: every step whose model is on the pool. A step
    // whose model did not load leaves the tree by name; the rest run (D657).
    let runSteps: readonly PipelineDefaultStep[] = benchmarkSteps
    const loadPolicy = dispatchLoadPolicyOf(input)
    if (needed.length > 0) {
      // A benchmark's load history is its own: a model it could not compile
      // must not back off, or refuse, the same model on the live device.
      const dispatchDeviceKeyLabel = benchmark
        ? benchmarkKeyOf(deviceKeyOf(dispatchEngine))
        : deviceKeyOf(dispatchEngine)
      // Only what will actually be ISSUED: a step backed off after a failure
      // stays "needed" on every frame, and naming it here would be a line per
      // frame. Its per-camera state line is written once, where it is refused.
      const toIssue = needed.filter(
        (s) =>
          this.loadGovernor.check(dispatchFactory, dispatchDeviceKeyLabel, [stepModelKey(s)])
            .kind === 'go',
      )
      if (toIssue.length > 0) {
        this.log.info('Benchmark: models to load', {
          meta: {
            count: toIssue.length,
            models: toIssue.map((s) => `${s.addonId}/${s.modelId}`),
          },
        })
      }
      for (const s of toIssue) {
        emit(`Loading model: ${s.addonName} (${s.modelId})...`, {
          step: s.addonId,
          addonId: s.addonId,
          modelId: s.modelId,
        })
      }
      const failures = await this.loadDispatchModels(
        benchmarkSteps,
        dispatchFactory,
        dispatchEngine.format,
        {
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
          deviceKey: dispatchDeviceKeyLabel,
        },
        loadPolicy,
      )
      runSteps = stepsSurvivingLoad(benchmarkSteps, failures, loadPolicy)
      emit(
        failures.length === 0 ? `All models loaded` : `Models loaded (${failures.length} failed)`,
      )
    }

    // Build a custom tree from the benchmark steps (not the global config)
    emit('Running inference...')
    // `runSteps`, never `benchmarkSteps`: a step D657 dropped for a failed load
    // is not in it, so it can neither throw here nor be reported twice.
    //
    // A child whose variant is STILL not warm (evicted between its load and
    // this build) is the same loss as a failed load, in the same vocabulary
    // and the same per-camera line (`model load for dispatch failed`, state
    // `not-warm`): dropped with its subtree on a live dispatch, the whole call
    // on an all-or-nothing one (D657). A missing ROOT variant throws (D658).
    const notWarm: DispatchStepLoadFailure[] = []
    const tree = buildExecutableTree(
      runSteps,
      // By (step, MODEL): the variant that runs the requested model, whose id
      // the tree then stamps. By step alone this answered the pool's ACTIVE
      // variant and stamped the requested id on its output (D658).
      (stepId, modelId) => dispatchFactory.getStepVariant(stepId, modelId),
      this.customModelResolver,
      (drop) => notWarm.push({ step: drop.step, error: new Error(drop.error) }),
    )
    if (notWarm.length > 0) {
      if (loadPolicy === 'all-or-nothing') throw new DispatchStepsNotLoadedError(notWarm)
      const dispatchDeviceKeyLabel = deviceKeyOf(dispatchEngine)
      for (const failure of notWarm) {
        const model = stepModelKey(failure.step)
        this.reportDispatchLoadLoss(
          {
            ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
            deviceKey: dispatchDeviceKeyLabel,
            outcome: 'step-dropped',
          },
          dispatchDeviceKeyLabel,
          [model],
          model,
          'not-warm',
          errMsg(failure.error),
        )
      }
    }
    // The model the ROOT actually runs, from the TREE — the variants that will
    // execute, after resolution, per-step loads and drops — stamped on the
    // result so a stored track names what produced it (D646, D658).
    // With it, the root's STEP (D925) — the confirmation gate re-judges a birth
    // with exactly this detector — and the inference DEVICE whose pool runs it:
    // the one this dispatch resolved, never the node default, so a stored
    // track names where it opened and closed when a camera's session hops
    // device (D916, D924).
    const treeRoot = resolveTreeRoot(tree.roots)
    const rootDeviceKey = deviceKeyOf(dispatchEngine)
    const stampRoot = (r: FrameResult): FrameResult =>
      treeRoot === undefined
        ? { ...r, rootDeviceKey }
        : { ...r, rootModelId: treeRoot.modelId, rootStepId: treeRoot.stepId, rootDeviceKey }
    // A replay runs a pinned model on purpose; it is not the camera switching.
    if (input.replay !== true) this.clusterModelSwitchLog.note(input.deviceId ?? 0, tree)
    // Setup phase ends at tree-build (last sync work before inference).
    // Excludes decode (already recorded) and the executor.run call itself.
    setupMs = performance.now() - wallT0 - decodeMs

    // Runtime (per-frame) dispatch wants minimal tracing; one-shot paths
    // (benchmark / reference-image) run on demand and can afford full
    // stepTimings. `summary` in runtime mode keeps detection-pipeline's
    // emit of PipelineInferenceResult informative without the per-step
    // trace overhead. A camera carries no detector settings of its own here:
    // the step's model and settings arrive with the steps (D927).
    // `isRuntime` is the const hoisted above `emit` — deliberately NOT
    // re-derived from `runtimeFrame`/`runtimeFrameRef` here, so the gate the
    // progress emits obey and the gate the executor obeys cannot drift.
    const effectiveDeviceId = input.deviceId ?? 0
    const effectiveTree = tree
    // Design B (generalized): bind a best-effort NATIVE crop provider to THIS
    // frame so leaf crop children (face-embedding AND plate-ocr / leaf
    // classifiers) read native pixels instead of the downscaled parent tile.
    // On the DETAIL plane the frame arrives as `image` + a `nativeCropRef`
    // (handle + the parent crop's frame-space rect); the provider re-composes
    // the executor's crop-normalized ROI into frame space. The legacy
    // `frameHandle` image-source path (dormant since shm removal) keeps the
    // direct provider. A miss / absence falls back to the downscaled crop.
    const nativeCropProvider =
      this.buildNativeCropProviderFromRef(input.nativeCropRef) ??
      this.buildNativeFaceCropProvider(input.frameHandle)

    // crop-zone frame prep: when the tree carries a `crop-zone` root
    // (`package-detection`), resolve the device's package-zone crop bbox so
    // the executor crops inference to the drawn package zones instead of the
    // full frame (design ADDENDUM 2026-07-17). Runtime + real-device only —
    // benchmark / reference paths have no zones bound and keep full-frame.
    // Reads the zones + `package`-stage rules off the same DeviceProxy state
    // mirror the zone gate uses (primed by `ensureDeviceProxy`).
    let cropZoneBbox: AbsoluteBbox | undefined
    if (
      appliesCameraGates &&
      effectiveDeviceId > 0 &&
      effectiveTree.roots.some((r) => r.definition.extractMode === 'crop-zone')
    ) {
      await this.ensureDeviceProxy(effectiveDeviceId)
      const proxy = this.deviceProxies.get(effectiveDeviceId)
      if (proxy) {
        const zones = proxy.state.zones.value?.zones ?? []
        const packageRules = proxy.state.zoneRules.value?.package ?? []
        cropZoneBbox =
          resolvePackageCropBbox(zones, packageRules, imageWidth, imageHeight) ?? undefined
      }
    }

    let frameViewResolver: RootFrameViewResolver | undefined
    let rootInputViewProvider: RootInputViewProvider | undefined
    if (runtimeFrameRef) {
      frameViewResolver = createRootFrameViewResolver(localFrameRegistry, runtimeFrameRef)
      rootInputViewProvider = async (root, crop) => {
        const view = await frameViewResolver!(
          root,
          crop
            ? {
                left: crop[0],
                top: crop[1],
                width: crop[2] - crop[0],
                height: crop[3] - crop[1],
              }
            : undefined,
        )
        const data = Buffer.from(view.data.buffer, view.data.byteOffset, view.data.byteLength)
        return {
          input: { kind: 'jpeg', data },
          jpegProvider: async () => data,
          width: view.width,
          height: view.height,
          geometry: view.geometry,
        }
      }
    }
    let executionSucceeded = false
    let execution: Awaited<ReturnType<PipelineExecutor['run']>>
    try {
      execution = await executor.run(
        effectiveTree,
        rootInput,
        jpegProvider,
        imageWidth,
        imageHeight,
        effectiveDeviceId,
        {
          traceVerbosity: isRuntime ? (this.eventBus ? 'summary' : 'off') : 'full',
          plane: input.plane,
          occasion: input.replay === true ? 'replay' : 'live',
          ...(input.suppliedRoot !== undefined ? { suppliedRoot: input.suppliedRoot } : {}),
        },
        nativeCropProvider,
        cropZoneBbox,
        rootInputViewProvider,
      )
      executionSucceeded = true
    } finally {
      frameViewResolver?.release(executionSucceeded ? 'success' : 'error')
    }
    const { result, trace } = execution

    if (isRuntime) {
      // Runtime path mirrors the legacy `runFrame` behaviour: emit a
      // `pipeline.trace` event (so the admin UI's trace consumer sees
      // per-camera runs) and skip the benchmark-only per-step progress
      // spam.
      if (trace && this.eventBus) {
        this.eventBus.emit(
          createEvent(
            EventCategory.PipelineTrace,
            { type: 'device', id: trace.deviceId, nodeId: 'hub' },
            trace,
          ),
        )
      }
      // Source-level zone gate — reads zones + detection rules off the
      // device-state mirror via the cached DeviceProxy and drops
      // detections in operator-excluded zones BEFORE they reach the
      // tracker. Async ensureDeviceProxy primes the cache on the
      // first frame; subsequent frames hit the gate sync. Skipping
      // the gate when proxy is unavailable preserves the legacy
      // "no filtering" behaviour for non-runtime callers + boot.
      if (effectiveDeviceId > 0) {
        await this.ensureDeviceProxy(effectiveDeviceId)
        // The gate runs AFTER the executor built the result (and its
        // trace), so its drops are the one discard class the counts can
        // never show — the gate records them on the discard trail
        // unconditionally, so a zone-gated box always leaves a ghost on
        // the overlay.
        return stampRoot(this.gateDetectionsByZoneRules(effectiveDeviceId, result))
      }
      return stampRoot(result)
    }

    // Emit one pipeline.progress per executed step so the UI can show a
    // per-step timing breakdown even though the executor doesn't stream
    // progress callbacks mid-run. stepTimings is populated in `full`
    // trace mode (always true for benchmark / reference-image runs).
    for (const t of result.debug?.stepTimings ?? []) {
      emit(`${t.source}${t.modelId ? ` (${t.modelId})` : ''} → ${t.ms}ms`, {
        step: t.source,
        addonId: t.source,
        modelId: t.modelId ?? undefined,
        ms: t.ms,
      })
    }

    emit(
      `Done — ${result.detections.length} detection(s) in ${result.debug?.totalInferenceMs ?? 0}ms`,
      {
        ms: result.debug?.totalInferenceMs,
      },
    )
    const wallMs = performance.now() - wallT0
    const inferMs = result.debug?.totalInferenceMs ?? 0
    const overheadMs = Math.max(0, wallMs - decodeMs - setupMs - inferMs)
    // A replay gets the camera's zone gate like a live frame (never emitted on
    // the live trace stream — that stays a runtime-only side effect above).
    const gated =
      input.replay === true && effectiveDeviceId > 0
        ? await this.ensureDeviceProxy(effectiveDeviceId).then(() =>
            this.gateDetectionsByZoneRules(effectiveDeviceId, result),
          )
        : result
    const augmented: FrameResult = {
      ...stampRoot(gated),
      debug: {
        ...gated.debug,
        decodeMs: Math.round(decodeMs * 100) / 100,
        setupMs: Math.round(setupMs * 100) / 100,
        wallMs: Math.round(wallMs * 100) / 100,
        overheadMs: Math.round(overheadMs * 100) / 100,
      },
    }
    return augmented
  }

  /**
   * Convert PipelineStepInput[] → PipelineDefaultStep[] by enriching from
   * StepDefinitions. This is the LIVE per-camera dispatch path — it runs
   * once per decoded frame (up to detectionFps × N cameras/sec) — so it
   * must NEVER throw. A thin adapter over the pure {@link resolveInputSteps}
   * seam: an unknown `addonId` (a bad step config sent by a camera
   * pipeline) is dropped from the tree and logged once (deduped, not
   * per-frame) at warn level instead of propagating as a per-frame error
   * loop. A runtime model substitution (the step's explicit model lacks a
   * build for this node's engine format, so the format default runs
   * instead) is logged once (deduped) at info level so an operator can see
   * a camera×node model swap instead of it happening silently. Does NOT
   * write `this.modelSubstitutions` — that map is owned exclusively by
   * `resolveStepModels` (see its doc comment); a second writer here would
   * corrupt it.
   *
   * `format` defaults to `this.currentEngine.format` (the node-default
   * pool); a `deviceKey` dispatch passes that device's format explicitly.
   */
  private inputStepsToPipelineSteps(
    steps: readonly PipelineStepInput[],
    format: ModelFormat = this.currentEngine.format,
    engine: StepResolutionEngine = {
      backend: this.currentEngine.backend,
      device: this.currentEngine.device ?? null,
    },
    /**
     * Sink for cluster refusals. Collected rather than logged because this
     * method is called SPECULATIVELY — see the note at the push below, and
     * `logClusterRefusals`, which tags the line with the camera.
     */
    clusterRefusalsOut?: ClusterModelRefusal[],
  ): PipelineDefaultStep[] {
    const { steps: resolvedSteps, diagnostics } = resolveInputSteps(
      steps,
      format,
      engine,
      this.clusterModels.current(),
      this.clusterModels.currentSettings(),
      this.clusterModels.unknownSteps(),
    )
    // Cluster refusals are NOT logged here. This method is called
    // SPECULATIVELY — `resolveStepsForDispatch` resolves against a candidate
    // device format and then throws that resolution away when the node-local
    // fallback wins. Logging here would fire a scary "refused" line for every
    // Coral dispatch whose face-embedding is then happily rescued onto the
    // node's onnx engine: a false alarm on every mixed-accelerator node, which
    // is how a real warning stops being read. The caller logs the refusals of
    // the resolution it actually RETURNS — see `logClusterRefusals`.
    if (clusterRefusalsOut) clusterRefusalsOut.push(...diagnostics.clusterRefusals)
    for (const addonId of diagnostics.unknownAddonIds) {
      this.logLiveDispatchIssueOnce(`unknown:${addonId}`, () =>
        this.log.warn('Live pipeline step references an unknown addon — dropping step', {
          meta: { addonId },
        }),
      )
    }
    for (const sub of diagnostics.substitutions) {
      this.logLiveDispatchIssueOnce(
        `${sub.addonId}|${sub.chosen}|${sub.running}|${sub.format}`,
        () =>
          this.log.info('Live pipeline step model substituted for engine format (node-local)', {
            meta: {
              step: sub.addonId,
              chosen: sub.chosen,
              running: sub.running,
              format: sub.format,
            },
          }),
      )
    }
    return resolvedSteps
  }

  /**
   * Announce the cluster-scope refusals of the resolution that is actually
   * being RETURNED — never of a speculative one.
   *
   * A refusal here means: this dispatch will run `stepId` with the cluster's
   * chosen model on an engine that ships no build of it, and NOTHING was
   * substituted in its place. `assertStepsRunnable` has already had its say
   * (it throws when the catalog ships nothing at all for the format); what
   * this line adds is the case the throw cannot see — the catalog has a build,
   * just not of the model the cluster chose — which without this line is the
   * quietest possible way to stop producing vectors.
   *
   * Deduped per (step, model, engine): a fleet of cameras on one incompatible
   * node produces one line, not one per track.
   */
  private logClusterRefusals(
    refusals: readonly ClusterModelRefusal[],
    deviceId: number | undefined,
    engineLabel: string,
  ): void {
    for (const refusal of refusals) {
      this.logLiveDispatchIssueOnce(
        `cluster-refused:${refusal.stepId}|${refusal.modelId}|${engineLabel}`,
        () =>
          this.log.warn(
            'cluster-scoped step: this engine ships no build of the CLUSTER model and nothing was substituted — a substitute encoder would put a second feature space in a shared vector index',
            {
              ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
              meta: {
                step: refusal.stepId,
                clusterModelId: refusal.modelId,
                format: refusal.format,
                formatsShipped: [...refusal.formatsShipped],
                engine: engineLabel,
                remedy: `choose a cluster model with a ${refusal.format} build, or take this engine out of the rotation for ${refusal.stepId}`,
              },
            },
          ),
      )
    }
  }

  /** Run `fn()` at most once per `key` for the lifetime of this provider instance. */
  private logLiveDispatchIssueOnce(key: string, fn: () => void): void {
    if (this.loggedLiveDispatchIssues.has(key)) return
    this.loggedLiveDispatchIssues.add(key)
    fn()
  }

  /**
   * Resolve a dispatch's step tree against its target engine, with the
   * CAPABILITY GATE + node-local engine fallback (cam-101, 2026-08-01;
   * per-step split 2026-08-01 evening).
   *
   * A per-call `deviceKey` (orchestrator device routing / detail-plane step
   * jump) selects an engine whose format every step EXECUTING IN THIS CALL
   * must actually ship a model build for. When such a step's catalog has
   * ZERO builds for that format (so not even `resolveModelForFormat`'s
   * substitution can rescue it), dispatching anyway means every frame
   * fails — before this gate it failed as a doomed 3-retry model download,
   * ~5.5s per frame, forever.
   *
   * The gated set is per-plane — the ROOT decides the dispatch device, a
   * child never bounces it (operator requirement: devices compensate for
   * each other's missing steps; the original whole-tree gate let ONE
   * tflite-less child knock the root off an otherwise-capable Coral):
   *
   *  - `'frame'` (the live per-frame path) executes only root-plane steps,
   *    so only those gate the device. Detail children that can NEVER run on
   *    this device are pruned from THIS dispatch (so `ensureModelsForSteps`
   *    doesn't fail the call on a format build that does not exist) and
   *    logged once — NOT dropped work: each runs later as its own per-track
   *    detail dispatch, where the runner's device-jump resolver
   *    (`resolveStepDevice`) places it on a same-node device that can run
   *    it, or warns no-candidate loudly.
   *  - any other plane (detail subtrees, benchmark, batch) executes the
   *    whole passed tree inline on ONE pool — a single call cannot split
   *    devices — so the whole-tree gate stays.
   *
   * Fallback is strictly NODE-LOCAL and ordered: the node's own selected
   * engine is the one and only fallback — frames never migrate to another node from here (that is the
   * orchestrator's tier). The fallback is logged ONCE per distinct
   * (deviceKey, steps, format) signature, with `tags: { deviceId }` when the
   * dispatch is camera-scoped.
   *
   * When the node's own engine ALSO cannot run a step, this throws — fast,
   * before any download attempt — and logs the full picture once (model,
   * its available formats, both engines tried). A genuinely impossible
   * configuration must stay loud, not vanish into a silent fallback chain.
   */
  private resolveStepsForDispatch(args: DispatchResolutionArgs): DispatchStepResolution {
    const { deviceKey, deviceId } = args
    const nodeFormat = this.currentEngine.format
    const nodeEngine: StepResolutionEngine = {
      backend: this.currentEngine.backend,
      device: this.currentEngine.device ?? null,
    }
    const nodeEngineLabel = `${nodeEngine.backend}/${nodeEngine.device ?? 'default'} (${nodeFormat})`

    const deviceEngine = deviceKey ? resolveDeviceEngine(deviceKey) : undefined
    if (deviceKey === undefined || deviceEngine === undefined) {
      const refusals: ClusterModelRefusal[] = []
      const steps = this.inputStepsToPipelineSteps(args.steps, nodeFormat, nodeEngine, refusals)
      this.assertStepsRunnable(steps, nodeFormat, deviceId, [nodeEngineLabel])
      this.logClusterRefusals(refusals, deviceId, nodeEngineLabel)
      return { deviceKey: undefined, steps }
    }

    const deviceFormat = deviceEngine.format
    const deviceStepEngine: StepResolutionEngine = {
      backend: deviceEngine.backend,
      device: deviceEngine.device ?? null,
    }
    const deviceRefusals: ClusterModelRefusal[] = []
    const steps = this.inputStepsToPipelineSteps(
      args.steps,
      deviceFormat,
      deviceStepEngine,
      deviceRefusals,
    )
    const framePlane = args.plane === 'frame'
    const gatedSteps = framePlane
      ? collectFramePlaneSteps(steps, isDetailPlaneStep)
      : flattenSteps(steps)
    const zeroBuild = collectZeroBuildIssues(gatedSteps, deviceFormat, this.mergedStepDefOrThrow)
    if (zeroBuild.length === 0) {
      if (!framePlane) {
        this.logClusterRefusals(deviceRefusals, deviceId, `${deviceKey} (${deviceFormat})`)
        return { deviceKey, steps }
      }
      // The runner's own jump predicate, on the whole subtree (D657): a
      // subtree the elected format cannot run is exactly one the detail
      // plane jumps, so it is never loaded here. A per-top-step "any build"
      // test counted the legacy Coral face stub, kept face-detection, and
      // loaded a model with no tflite build next to the root.
      const pruneResult = pruneUnrunnableDetailSteps(
        steps,
        isDetailPlaneStep,
        (subtree) => !buildSubtreeCanRun(subtree, this.mergedStepDef)(deviceFormat),
      )
      if (pruneResult.prunedAddonIds.length > 0) {
        const prunedList = pruneResult.prunedAddonIds.join(',')
        this.logLiveDispatchIssueOnce(
          `detail-defer:${deviceKey}:${deviceFormat}:${prunedList}`,
          () =>
            this.log.info(
              'Detail steps have no model build for the dispatch device format — deferred to the detail-plane device jump',
              {
                ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
                meta: {
                  deviceKey,
                  deviceFormat,
                  steps: [...pruneResult.prunedAddonIds],
                },
              },
            ),
        )
      }
      // A step PRUNED from this dispatch does not run here: it is deferred to
      // the detail-plane device jump, which will resolve it against whichever
      // device it lands on. Reporting its refusal here would fire a warning
      // about an engine the step was never going to use.
      this.logClusterRefusals(
        deviceRefusals.filter((r) => !pruneResult.removedAddonIds.includes(r.stepId)),
        deviceId,
        `${deviceKey} (${deviceFormat})`,
      )
      return { deviceKey, steps: pruneResult.steps }
    }

    const blockedSteps = zeroBuild.map((issue) => issue.addonId)
    this.logLiveDispatchIssueOnce(
      `capability-fallback:${deviceKey}:${deviceFormat}:${blockedSteps.join(',')}`,
      () =>
        this.log.warn(
          'Device pool cannot run step (no model build for its format) — falling back to the node-local default engine',
          {
            ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
            meta: {
              deviceKey,
              deviceFormat,
              steps: blockedSteps,
              fallbackEngine: nodeEngineLabel,
            },
          },
        ),
    )
    const fallbackRefusals: ClusterModelRefusal[] = []
    const fallbackSteps = this.inputStepsToPipelineSteps(
      args.steps,
      nodeFormat,
      nodeEngine,
      fallbackRefusals,
    )
    this.assertStepsRunnable(fallbackSteps, nodeFormat, deviceId, [
      `${deviceKey} (${deviceFormat})`,
      nodeEngineLabel,
    ])
    this.logClusterRefusals(fallbackRefusals, deviceId, nodeEngineLabel)
    return { deviceKey: undefined, steps: fallbackSteps }
  }

  /**
   * The loud, fast half of the capability gate: throw when any ENABLED step
   * has ZERO model builds for `format` — BEFORE any model download runs. The
   * error names the step, its chosen model, the formats the catalog actually
   * ships, and every engine that was tried, and is logged ONCE per distinct
   * signature (the throw itself still surfaces per dispatch, but costs
   * microseconds instead of a 3-retry download backoff).
   */
  private assertStepsRunnable(
    steps: readonly PipelineDefaultStep[],
    format: ModelFormat,
    deviceId: number | undefined,
    enginesTried: readonly string[],
  ): void {
    const zeroBuild = collectZeroBuildIssues(flattenSteps(steps), format, this.mergedStepDefOrThrow)
    if (zeroBuild.length === 0) return
    const detail = zeroBuild
      .map((issue) => {
        const step = flattenSteps(steps).find((s) => s.addonId === issue.addonId)
        const formats = availableFormatsForStep(issue.addonId)
        return `step "${issue.addonId}" (model "${step?.modelId ?? 'unknown'}") has no ${format} build (available: ${formats.join(', ') || 'none'})`
      })
      .join('; ')
    const message = `Pipeline dispatch impossible on this node: ${detail}. Engines tried: ${enginesTried.join(' → ')}.`
    this.logLiveDispatchIssueOnce(
      `unrunnable:${format}:${zeroBuild.map((i) => i.addonId).join(',')}`,
      () =>
        this.log.error('Pipeline step cannot run on any node-local engine', {
          ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
          meta: { format, enginesTried: [...enginesTried], detail },
        }),
    )
    throw new Error(message)
  }

  /**
   * In-flight model loads, per POOL and per MODEL SET (D653). Two dispatches
   * needing the same models on the same pool share ONE load and its outcome;
   * a dispatch needing a different set is never handed another set's failure
   * — it queues behind the pool's current load ({@link modelLoadTail}) and
   * then decides for itself. Keyed by pool, not node-wide: one GPU compile
   * that never returned held EVERY load on the node — the NPU's and the CPU's
   * too — behind it.
   */
  private readonly modelLoadInFlight = new Map<object, Map<string, ModelLoadFlight>>()
  /** The last load issued on each pool — loads into one pool run one at a time. */
  private readonly modelLoadTail = new Map<object, Promise<void>>()
  /** Stands in for "the node-default pool" before it exists. */
  private readonly nullPoolKey = {}
  /** Negative cache, per-model compile-timeout refusals, per-camera reporting (D653). */
  private readonly loadGovernor = new ModelLoadGovernor()

  /**
   * Load a dispatch's models ONE STEP AT A TIME (D657), and answer which steps
   * did not load. Never throws: each step is its own load, joined, backed off
   * and charged on its own model, so a step whose model cannot load on this
   * pool — no build for its format, a compile that failed — costs that step,
   * never the root or a sibling. The caller decides what the dispatch runs
   * without it ({@link stepsSurvivingLoad}).
   */
  private async loadDispatchModels(
    steps: readonly PipelineDefaultStep[],
    factory: EngineFactory | null,
    format: ModelFormat,
    context: ModelLoadContext,
    policy: DispatchLoadPolicy,
  ): Promise<readonly DispatchStepLoadFailure[]> {
    const failures: DispatchStepLoadFailure[] = []
    if (factory !== null) await this.noteCoralPlacement(steps, factory, format, context)
    // The same walk as `flattenEnabledVideoSteps` (disabled and audio steps,
    // and everything under them, load nothing), except that a step whose load
    // FAILED takes its subtree with it: its children consume its output and
    // leave the dispatch with it, so loading them would be work for nothing.
    const walk = async (nodes: readonly PipelineDefaultStep[], root: boolean): Promise<void> => {
      for (const step of nodes) {
        if (!step.enabled || step.slot === 'audio-classifier') continue
        if (factory === null || factory.needsPoolUpdate(step)) {
          try {
            await this.ensureModelsForSteps([{ ...step, children: [] }], factory, format, {
              ...context,
              outcome:
                policy === 'all-or-nothing' ? 'call-failed' : root ? 'root-lost' : 'step-dropped',
            })
          } catch (err) {
            failures.push({ step, error: err })
            continue
          }
        }
        await walk(step.children ?? [], false)
      }
    }
    await walk(steps, true)
    return failures
  }

  /**
   * Tell a Coral pool which models this dispatch places on it, and act on a
   * change of the co-compiled set it loads from (D724): download the set's
   * files for the models already resident and reload them — queued behind the
   * pool's other loads, so nothing loads from the old file meanwhile. Logged
   * once per change, tagged with the camera whose dispatch moved it.
   */
  private async noteCoralPlacement(
    steps: readonly PipelineDefaultStep[],
    factory: EngineFactory,
    format: ModelFormat,
    context: ModelLoadContext,
  ): Promise<void> {
    const change = factory.notePlacement(placedModelsOf(steps))
    if (change.kind === 'unchanged') return
    const deviceKey = context.deviceKey ?? deviceKeyOf(this.currentEngine)
    const tags = context.deviceId !== undefined ? { tags: { deviceId: context.deviceId } } : {}
    const placed = change.placed.map((p) => `${p.stepId}/${p.modelId}`)
    if (change.to.kind === 'set') {
      this.log.info(
        'Coral pool loads a co-compiled set — the models placed on it share the parameter cache',
        {
          ...tags,
          meta: {
            deviceKey,
            set: change.to.set.id,
            placed,
            fromSet: change.to.covered.map((p) => `${p.stepId}/${p.modelId}`),
            // Placed but in no member: compiled alone, they evict the set on every alternation.
            separatelyCompiled: change.to.uncovered.map((p) => `${p.stepId}/${p.modelId}`),
            previous: change.from.kind === 'set' ? change.from.set.id : null,
          },
        },
      )
    } else if (change.to.reason === 'no-set-covers-two') {
      this.log.warn(
        'Coral pool has no co-compiled set for the models placed on it — each is compiled alone, so they evict each other from the parameter cache on every alternation',
        {
          ...tags,
          meta: {
            deviceKey,
            placed,
            previous: change.from.kind === 'set' ? change.from.set.id : null,
            hint: 'keep the extra step off this Coral with its jumpDeviceKey, or place a combination a published set covers',
          },
        },
      )
    }
    const pool: object = factory
    const previous = this.modelLoadTail.get(pool) ?? Promise.resolve()
    const work = (async (): Promise<void> => {
      await previous
      for (const loaded of factory.listLoaded()) {
        const resolved = await this.resolveModelEntry(loaded.stepId, loaded.modelId)
        if (resolved === undefined) continue
        const entry = factory.entryForPool(loaded.stepId, resolved)
        if (!isModelDownloaded(this.modelsDir, entry, format))
          await this.downloadWithRetry(entry, format, 3)
      }
      const reloaded = await factory.reloadChangedModelFiles()
      if (reloaded.length > 0) {
        this.log.info('Coral pool reloaded its resident models from the new set', {
          ...tags,
          meta: { deviceKey, reloaded: reloaded.map((r) => `${r.stepId}/${r.modelId}`) },
        })
      }
    })()
    const tail = work.catch((err: unknown) => {
      this.log.error(
        'Coral pool could not move its resident models to the new set — they keep serving from the old files',
        {
          ...tags,
          meta: { deviceKey, error: errMsg(err) },
        },
      )
    })
    this.modelLoadTail.set(pool, tail)
    await tail
  }

  /** Ensure all models needed by steps are downloaded and loaded in the engine pool.
   * `factory`/`format` default to the node's engine; a per-device dispatch passes
   * that device's factory + format (Phase 2 multi-device). `context` names the
   * camera and the accelerator on the line a rejected load writes. */
  private async ensureModelsForSteps(
    steps: readonly PipelineDefaultStep[],
    factory: EngineFactory | null = this.engineFactory,
    format: ModelFormat = this.currentEngine?.format ?? 'onnx',
    context: ModelLoadContext = {},
  ): Promise<void> {
    const needed = this.stepsNeedingLoad(steps, factory)
    if (needed.length === 0) return
    const pool: object = factory ?? this.nullPoolKey
    const deviceKey = context.deviceKey ?? deviceKeyOf(this.currentEngine)
    const models = needed.map(stepModelKey)

    // Ask before issuing anything: a model that failed a moment ago on this
    // pool is not re-issued until its back-off passes, and one whose compile
    // timed out repeatedly on this device is refused by name.
    const refusal = this.loadRefusal(pool, deviceKey, models)
    if (refusal !== null) {
      this.reportDispatchLoadLoss(
        context,
        deviceKey,
        models,
        refusal.model,
        refusal.state,
        refusal.message,
      )
      throw refusal
    }

    const setKey = [...models].sort().join(',')
    let perPool = this.modelLoadInFlight.get(pool)
    if (perPool === undefined) {
      perPool = new Map()
      this.modelLoadInFlight.set(pool, perPool)
    }
    const joined = perPool.get(setKey)
    const flight =
      joined ?? this.issueModelLoad(pool, perPool, setKey, steps, factory, format, deviceKey)
    try {
      await flight.work
    } catch (err) {
      // EVERY dispatch that lost its frame says so, under its own camera —
      // once per state change, never once per frame.
      if (err instanceof ModelLoadRefusedError) {
        this.reportDispatchLoadLoss(context, deviceKey, models, err.model, err.state, err.message)
        throw err
      }
      const failed = failedModelOf(err) ?? models[0] ?? ''
      this.reportDispatchLoadLoss(
        context,
        deviceKey,
        models,
        failed,
        `failed:${flight.generation ?? 'unknown'}`,
        errMsg(err),
      )
      throw err
    }
  }

  /**
   * Why `models` may not be loaded on `pool` right now — a back-off after a
   * failure, or a refusal by name after repeated compile timeouts — or `null`.
   */
  private loadRefusal(
    pool: object,
    deviceKey: string,
    models: readonly string[],
  ): ModelLoadRefusedError | null {
    const verdict = this.loadGovernor.check(pool, deviceKey, models)
    if (verdict.kind === 'go') return null
    const message =
      verdict.kind === 'refused'
        ? `model ${verdict.model} is refused on ${deviceKey}: its compile timed out ${verdict.timeouts} times (${verdict.error}) — re-arm with pipelineExecutor.rearmInferenceDevice`
        : `model ${verdict.model} failed to load on ${deviceKey} ${verdict.failures} time(s); not retried for ${verdict.retryInMs}ms (${verdict.error})`
    return new ModelLoadRefusedError(message, verdict.model, stateOf(verdict))
  }

  /**
   * A compile that outlived its soft bound came back on `factory`'s pool
   * (D653 rounds 2-3). A SUCCESS wrote that model's cache and the worker loads
   * again, so that model's back-off is lifted at once rather than waited out;
   * no other model's is. A FAILURE is one more failure of that model, and its
   * back-off grows.
   */
  private noteLateCompile(
    factory: EngineFactory,
    deviceKey: string,
    event: PoolCompileFinishedLate,
  ): void {
    const models = this.loadGovernor.settleLateCompile(
      factory,
      deviceKey,
      event.model,
      event.ok,
      event.error ?? 'late compile failed',
    )
    if (event.ok) {
      this.log.info('model loadable again after late compile', {
        meta: { deviceKey, model: event.model, backoffLifted: models },
      })
      return
    }
    this.log.warn('late compile failed — the model stays backed off', {
      meta: { deviceKey, model: event.model, backoffExtended: models, error: event.error ?? null },
    })
  }

  /** The enabled steps the factory's pool does not reflect yet. */
  private stepsNeedingLoad(
    steps: readonly PipelineDefaultStep[],
    factory: EngineFactory | null,
  ): PipelineDefaultStep[] {
    const needed: PipelineDefaultStep[] = []
    for (const step of flattenSteps(steps)) {
      if (!step.enabled) continue
      // Not `isLoadedWithModel`: a warm (step, model) pair whose operator
      // settings changed still needs the pool retuned, and skipping it here is
      // precisely how a saved threshold reached nothing (D214).
      if (factory !== null && !factory.needsPoolUpdate(step)) continue
      needed.push(step)
    }
    return needed
  }

  /**
   * Issue ONE load for a model set on a pool, queued behind the pool's
   * previous load, and record its outcome with the governor. The set is
   * re-derived once the queue reaches it: the load ahead may have brought
   * some of it in.
   */
  private issueModelLoad(
    pool: object,
    perPool: Map<string, ModelLoadFlight>,
    setKey: string,
    steps: readonly PipelineDefaultStep[],
    factory: EngineFactory | null,
    format: ModelFormat,
    deviceKey: string,
  ): ModelLoadFlight {
    const previous = this.modelLoadTail.get(pool) ?? Promise.resolve()
    const flight: { work: Promise<void>; generation: number | null } = {
      work: Promise.resolve(),
      generation: null,
    }
    flight.work = (async (): Promise<void> => {
      await previous
      const needed = this.stepsNeedingLoad(steps, factory)
      if (needed.length === 0) return
      const models = needed.map(stepModelKey)
      // The load ahead of this one may have just failed or been refused: ask
      // again for what is ACTUALLY left to load (D653 round 2).
      const refusal = this.loadRefusal(pool, deviceKey, models)
      if (refusal !== null) throw refusal
      try {
        await this.downloadNeededModels(needed, format, factory)
        this.log.info('Loading additional models for benchmark', {
          meta: { count: needed.length, models, deviceKey },
        })
        await factory!.loadAdditional(needed)
      } catch (err) {
        flight.generation = this.recordModelLoadFailure(pool, deviceKey, models, err)
        throw err
      }
      this.loadGovernor.recordSuccess(pool, deviceKey, models)
    })()
    perPool.set(setKey, flight)
    const tail = flight.work.catch(() => undefined)
    this.modelLoadTail.set(pool, tail)
    void tail.then(() => {
      if (perPool.get(setKey) === flight) perPool.delete(setKey)
      if (this.modelLoadTail.get(pool) === tail) this.modelLoadTail.delete(pool)
    })
    return flight
  }

  /** Charge a failed load to the model that failed; say so once if it is now refused. */
  private recordModelLoadFailure(
    pool: object,
    deviceKey: string,
    models: readonly string[],
    err: unknown,
  ): number {
    // Charged to the model the error names, never to the whole set (D657).
    const named = failedModelOf(err)
    const failedModels = named !== null ? [named] : models
    const compileTimeout = err instanceof StepVariantLoadError && err.reason === 'compile-timeout'
    const poolModel = err instanceof StepVariantLoadError ? err.poolModel : null
    let generation = 0
    for (const model of failedModels) {
      const outcome = this.loadGovernor.recordFailure(
        pool,
        deviceKey,
        model,
        errMsg(err),
        compileTimeout,
        Date.now(),
        poolModel,
        err instanceof StepVariantLoadError ? err.reason : null,
      )
      generation = outcome.generation
      if (outcome.refusedNow) {
        this.log.error('model REFUSED on this device — its compile timed out repeatedly', {
          meta: {
            deviceKey,
            model,
            compileTimeouts: outcome.compileTimeouts,
            error: errMsg(err),
            device: 'keeps serving every other model',
            rearm: 'pipelineExecutor.rearmInferenceDevice',
          },
        })
      }
    }
    return generation
  }

  /**
   * One WARN per camera per state change of the model that cost it its frame.
   * The ERROR for the failed load itself is written once, where the load
   * failed (`Step variant load failed`); this line answers "which cameras
   * did it cost?", tagged so it can be counted per camera.
   */
  private reportDispatchLoadLoss(
    context: ModelLoadContext,
    deviceKey: string,
    models: readonly string[],
    model: string,
    state: string,
    error: string,
  ): void {
    if (!this.loadGovernor.shouldReport(context.deviceId, deviceKey, model, state)) return
    this.log.warn('model load for dispatch failed', {
      ...(context.deviceId !== undefined ? { tags: { deviceId: context.deviceId } } : {}),
      meta: {
        deviceKey,
        models,
        model,
        state,
        error,
        ...(context.outcome !== undefined ? { outcome: context.outcome } : {}),
      },
    })
  }

  /** Download any model of `needed` missing in `format` (the device's). */
  private async downloadNeededModels(
    needed: readonly PipelineDefaultStep[],
    format: ModelFormat,
    factory: EngineFactory | null = null,
  ): Promise<void> {
    // Download any missing models before loading (in `format`, the device's).
    // A failure names its step and model, so it is charged to that model only.
    for (const step of needed) {
      try {
        await this.ensureStepModelArtifact(step, format, factory)
      } catch (err) {
        throw new StepModelArtifactError(step.addonId, step.modelId, err)
      }
    }
  }

  /**
   * Make one step's model artifact present on disk for `format`, or say why it
   * cannot be. The entry is the one `factory`'s pool will LOAD — on a Coral
   * pool, a co-compiled set's file when the set stands for the model (D724).
   */
  private async ensureStepModelArtifact(
    step: PipelineDefaultStep,
    format: ModelFormat,
    factory: EngineFactory | null = null,
  ): Promise<void> {
    const resolved = await this.resolveModelEntry(step.addonId, step.modelId)
    const modelEntry =
      resolved && factory !== null ? factory.entryForPool(step.addonId, resolved) : resolved
    if (modelEntry && !isModelDownloaded(this.modelsDir, modelEntry, format)) {
      // A missing FORMAT BUILD is a configuration error, not a transient
      // network failure — it can never succeed on retry. Before this
      // check it went through `downloadWithRetry`'s 3-attempt backoff
      // (2s+4s ≈ 5.5s) on EVERY frame of a mis-routed camera (cam-101,
      // 2026-08-01). Fail immediately with the same message `ensureModel`
      // would have produced on attempt 1.
      if (modelEntry.formats[format] === undefined) {
        throw new Error(
          `Model "${modelEntry.id}" has no ${format} format build (available: ${Object.keys(modelEntry.formats).join(', ') || 'none'}) — not retrying a permanent format mismatch`,
        )
      }
      // A `camstack-local://` URL is a LOCAL-ARTIFACT convention, not a
      // fetchable endpoint: it names a file that must already sit in this
      // node's modelsDir (placed by a Model Studio upload/conversion, or
      // by `model-distributor`). Fail with the operator-actionable message
      // instead of letting `fetch('camstack-local://…')` throw a cryptic
      // URL-parse error after 3 pointless retries.
      if (modelEntry.formats[format]?.url.startsWith('camstack-local://') === true) {
        throw new Error(
          `Custom model "${modelEntry.id}" (${format}) is not present in this node's models directory — distribute it to this node from Model Studio before selecting it here`,
        )
      }
      this.log.info('Downloading model for step', {
        meta: { modelId: step.modelId, format, step: step.addonId },
      })
      await this.downloadWithRetry(modelEntry, format, 3)
    }
  }

  /** Download a model with retry + exponential backoff */
  private async downloadWithRetry(
    entry: import('@camstack/types').ModelCatalogEntry,
    format: import('@camstack/types').ModelFormat,
    maxRetries: number,
    onProgress?: import('@camstack/system').DownloadProgressCallback,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await ensureModel(this.modelsDir, entry, format, onProgress)
        this.log.info('Model downloaded successfully', {
          meta: { modelId: entry.id },
        })
        return
      } catch (err: unknown) {
        const msg = errMsg(err)
        if (attempt < maxRetries) {
          const delayMs = 2000 * Math.pow(2, attempt - 1) // 2s, 4s, 8s
          this.log.warn('Model download failed — retrying', {
            meta: {
              modelId: entry.id,
              attempt,
              maxRetries,
              error: msg,
              retryDelayMs: delayMs,
            },
          })
          await sleep(delayMs)
        } else {
          throw new Error(
            `Failed to download model "${entry.id}" after ${maxRetries} attempts: ${msg}`,
            { cause: err },
          )
        }
      }
    }
  }

  /** Parse JPEG/PNG dimensions without decoding the full image */
  private async getJpegDimensions(buf: Buffer): Promise<{ width: number; height: number }> {
    // Use sharp metadata (fast, reads only header)
    try {
      const sharp = await getSharp()
      const { width, height } = await sharp(buf).metadata()
      return { width: width ?? 640, height: height ?? 640 }
    } catch {
      // Fallback: JPEG SOF marker parsing
      return this.parseJpegDimensions(buf)
    }
  }

  /** Fast JPEG dimension parsing from SOF marker (no external deps) */
  private parseJpegDimensions(buf: Buffer): { width: number; height: number } {
    let i = 2 // skip SOI
    while (i < buf.length - 1) {
      if (buf[i] !== 0xff) break
      const marker = buf[i + 1]!
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = buf.readUInt16BE(i + 5)
        const width = buf.readUInt16BE(i + 7)
        return { width, height }
      }
      const segLen = buf.readUInt16BE(i + 2)
      i += 2 + segLen
    }
    return { width: 640, height: 640 }
  }

  // NOTE: the legacy single-addon `detect()` cap method was removed — it had
  // no real consumers (runtime dispatch is the stateless `runPipeline`).

  /**
   * Batched run — dispatches N raw frames against the same loaded
   * single-step model in one IPC round-trip via
   * `EngineFactory.batchInferRaw`. Falls back to N parallel
   * `runPipeline` calls when the fast path's preconditions don't hold
   * (multi-step tree, crop children, JPEG-only frames, Node ONNX
   * factory). Returns one minimally-shaped `FrameResult` per input
   * frame in input order.
   *
   * Used by `scripts/bench-batch-style.mts` for the batch benchmark —
   * collapsing N requests into one call amortises the per-call IPC
   * envelope overhead, which is what makes the batched path measurably
   * faster than N sequential `runPipeline` calls.
   */
  async runPipelineBatch(input: {
    readonly steps: readonly import('@camstack/types').PipelineStepInput[]
    readonly frames: readonly FrameInput[]
    readonly deviceId?: number
    readonly sessionId?: string
    readonly frameId?: number
    readonly deviceKey?: string
  }): Promise<{ readonly results: readonly FrameResult[] }> {
    this.log.debug('runPipelineBatch entry', {
      meta: {
        phase: 'batch',
        frames: input.frames.length,
        steps: input.steps.length,
        firstFrame: input.frames[0]
          ? {
              w: input.frames[0].width,
              h: input.frames[0].height,
              fmt: input.frames[0].format,
              bytes: input.frames[0].data.byteLength,
            }
          : null,
      },
    })
    try {
      return await this.runPipelineBatchImpl(input)
    } catch (err: unknown) {
      const msg = errMsg(err)
      const stack = err instanceof Error ? err.stack : undefined
      this.log.error('runPipelineBatch failed', {
        meta: { phase: 'batch', error: msg, stack },
      })
      throw err
    }
  }

  private async runPipelineBatchImpl(input: {
    readonly steps: readonly import('@camstack/types').PipelineStepInput[]
    readonly frames: readonly FrameInput[]
    readonly deviceId?: number
    readonly sessionId?: string
    readonly frameId?: number
    readonly deviceKey?: string
  }): Promise<{ readonly results: readonly FrameResult[] }> {
    if (input.frames.length === 0) return { results: [] }
    // The placement gate reads the merged catalog synchronously (D657).
    await this.getCustomModels()

    // Phase 2 multi-device (Fable P0-3/P0-6): a per-call `deviceKey` (e.g.
    // `openvino:npu`, `edgetpu:usb`) drives model resolution too — otherwise the
    // NPU keeps the node's default instead of its own, and Coral keeps an
    // openvino model with no tflite build. The device's `device` feeds MODEL_BY_CLASS
    // (npu→our v9, gpu→v9) and its `format` picks the format build (tflite→ssd).
    // Precedence: deviceKey (live/orchestrator routing) > node.
    // Same capability gate + node-local fallback as `runPipeline` (cam-101).
    const dispatchResolution = this.resolveStepsForDispatch({
      steps: input.steps,
      deviceKey: input.deviceKey,
      deviceId: input.deviceId,
      // Batch is the benchmark path and executes the whole tree inline on one
      // pool — no plane input exists on it, and the whole-tree gate applies.
      plane: undefined,
    })
    const dispatchDeviceKey = dispatchResolution.deviceKey
    const resolveFormat = dispatchDeviceKey
      ? resolveDeviceEngine(dispatchDeviceKey).format
      : this.currentEngine.format
    const benchmarkSteps = dispatchResolution.steps
    const enabledSteps = flattenEnabledVideoSteps(benchmarkSteps)
    if (enabledSteps.length === 0) {
      throw new Error('runPipelineBatch: no enabled steps')
    }
    const rootStep = enabledSteps[0]
    if (!rootStep) {
      throw new Error('runPipelineBatch: empty enabled-steps after flatten')
    }
    this.log.debug('runPipelineBatch enabled steps', {
      meta: {
        phase: 'batch',
        count: enabledSteps.length,
        first: {
          addonId: rootStep.addonId,
          modelId: rootStep.modelId,
          hasChildren: (rootStep.children?.length ?? 0) > 0,
        },
      },
    })

    // Fast path requirements:
    //   - exactly one root step (no children produced by tree-builder)
    //   - every frame raw rgb/bgr/gray with the same dimensions
    //   - factory exposes batch (Python pool path)
    const allRaw = input.frames.every(
      (f) => f.format === 'rgb' || f.format === 'bgr' || f.format === 'gray',
    )
    const firstFrame = input.frames[0]
    if (!firstFrame) {
      throw new Error('runPipelineBatch: empty frames after length check')
    }
    const uniformDims = input.frames.every(
      (f) => f.width === firstFrame.width && f.height === firstFrame.height,
    )
    // `enabledSteps` is the DFS-flattened ENABLED-only list. If it has
    // exactly one entry, the root has no enabled descendants — the
    // structural `rootStep.children` may still hold the detector's
    // disabled cropper/classifier tree the UI ships verbatim from
    // PipelineBuilder, so checking `rootStep.children.length === 0`
    // would wrongly reject the fast path on every benchmark run.
    const singleRoot = enabledSteps.length === 1

    // Bootstrap on the existing executor singleton — same code path as
    // benchmark's `runPipeline`. Models are loaded if missing.
    await this.ensureEngineFactory()

    // Phase 2 multi-device: route to the device's pool when a deviceKey
    // survived the capability gate.
    const factory = dispatchDeviceKey
      ? await this.resolveDeviceFactory(dispatchDeviceKey)
      : this.engineFactory
    if (!factory) throw new Error('runPipelineBatch: factory not initialised')

    const needed = enabledSteps.filter((s) => factory.needsPoolUpdate(s))
    if (needed.length > 0) {
      await this.ensureModelsForSteps(benchmarkSteps, factory, resolveFormat, {
        deviceKey: dispatchDeviceKey ?? deviceKeyOf(this.currentEngine),
      })
    }

    const canFastPath = singleRoot && allRaw && uniformDims && factory.supportsBatch()
    this.log.info('runPipelineBatch path decision', {
      meta: {
        phase: 'batch',
        canFastPath,
        singleRoot,
        allRaw,
        uniformDims,
        supportsBatch: factory.supportsBatch(),
      },
    })

    if (!canFastPath) {
      // Correctness fallback — runs the full executor per frame in
      // parallel. Loses the IPC amortisation but keeps the cap usable
      // for any tree shape.
      const results = await Promise.all(
        input.frames.map((frame) =>
          this.runPipeline({
            steps: input.steps,
            frame,
            deviceId: input.deviceId,
            sessionId: input.sessionId,
            deviceKey: dispatchDeviceKey,
          }),
        ),
      )
      return { results }
    }

    // Fast path — single batched IPC frame.
    const items = input.frames.map((frame) => ({
      raw: Buffer.from(frame.data),
      width: frame.width,
      height: frame.height,
      format: frame.format as RawFrameFormat,
    }))
    // Pass the bench-requested `modelId` explicitly so multi-slot
    // resolves to the warm bench variant instead of the runtime
    // active model. Before multi-slot, `loadAdditional` swapped
    // models inside a single slot — now it allocates a separate
    // index per (stepId, modelId), and we have to address it by
    // the same key here.
    this.log.info('runPipelineBatch fast path dispatch', {
      meta: {
        phase: 'batch',
        stepId: rootStep.addonId,
        modelId: rootStep.modelId,
        items: items.length,
        totalRawBytes: items.reduce((s, it) => s + it.raw.length, 0),
      },
    })
    const start = performance.now()
    // `frameId` (0 = untagged) pins a repeated benchmark frame to the pool's
    // preprocess cache so the sustained-throughput run measures PURE
    // inference (decode + preprocess happen once, not per inference).
    const rawResults = await factory.batchInferRaw(
      rootStep.addonId,
      items,
      rootStep.modelId,
      input.frameId ?? 0,
    )
    const totalMs = performance.now() - start
    this.log.info('runPipelineBatch fast path returned', {
      meta: {
        phase: 'batch',
        resultCount: rawResults.length,
        ms: Math.round(totalMs),
      },
    })

    const perFrameMs = totalMs / rawResults.length
    return {
      results: rawResults.map((raw, i) =>
        assembleBatchedFrameResult(
          raw,
          input.frames[i]!,
          rootStep.addonId,
          input.deviceId ?? 0,
          perFrameMs,
          perFrameMs,
        ),
      ),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reference Images
  // ═══════════════════════════════════════════════════════════════════════════

  async listReferenceImages(): Promise<Array<{ id: string; filename: string; sizeKB: number }>> {
    const dir = this.resolveRefImagesDir()
    if (!dir) return []
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
      .toSorted()
      .map((f) => {
        const stat = fs.statSync(path.join(dir, f))
        return {
          id: f.replace(/\.[^.]+$/, ''),
          filename: f,
          sizeKB: Math.round(stat.size / 1024),
        }
      })
  }

  async getReferenceImage(input: {
    filename: string
  }): Promise<{ base64: string; filename: string } | null> {
    const { filename } = input
    const dir = this.resolveRefImagesDir()
    if (!dir) return null
    const filePath = path.join(dir, filename)
    if (!fs.existsSync(filePath)) return null
    return { base64: fs.readFileSync(filePath).toString('base64'), filename }
  }

  private resolveRefImagesDir(): string | null {
    // Search order, from most-specific to most-generic:
    //   1. addon dist root          → ships alongside the bundle
    //   2. addon source root        → dev workspace where tsup runs from
    //   3. repo root (3 levels up)  → dev fallback when running the
    //      compiled launcher (`server/backend/dist/launcher.js`)
    //   4. cwd-anchored candidates  → legacy: kept as last-ditch when
    //      `__dirname` lives somewhere unexpected (Docker addon-cache
    //      copies the bundle into a sibling node_modules tree).
    //
    // The bug this fixes: cwd-only resolution misses every layout we
    // actually run — the launcher starts from `server/backend/dist`,
    // which has no walk-up that reaches the repo's `assets/`.
    const candidates = [
      path.resolve(__dirname, 'assets/reference-images'),
      path.resolve(__dirname, '../assets/reference-images'),
      // Deployed layout: bundle entry is `dist/detection-pipeline/index.js`,
      // so the addon-root `assets/` (shipped via files:["assets"]) is two up.
      path.resolve(__dirname, '../../assets/reference-images'),
      path.resolve(__dirname, '../../../assets/reference-images'),
      path.resolve(process.cwd(), 'assets/reference-images'),
      path.resolve(process.cwd(), '../assets/reference-images'),
      path.resolve(process.cwd(), '../../assets/reference-images'),
      path.resolve(process.cwd(), '../../../assets/reference-images'),
    ]
    return candidates.find((p) => fs.existsSync(p)) ?? null
  }

  // `orchestratorStatus` and `cameraDetectionStatus` shims removed with the
  // pipeline page redesign — UI consumers now query runner metrics directly
  // via `perNodePipeline.getLocalMetrics` / `getCameraMetrics`, which forward
  // to the `pipeline-runner` cap on the target node.

  // ═══════════════════════════════════════════════════════════════════════════
  // Per-device detection settings — moved into the Orchestrator tab.
  //
  // Object-detection step settings (enabled classes, per-class confidence
  // thresholds) live on the audio/video pipeline step's `getConfigSchema()`
  // and are edited via the orchestrator's per-step override mechanism. No
  // device-level surface remains on this addon.
  // ═══════════════════════════════════════════════════════════════════════════

  async getDeviceSettingsContribution(_input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    return null
  }

  async getDeviceLiveContribution(_input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    return null
  }

  async applyDeviceSettingsPatch(_input: {
    deviceId: number
    patch: Record<string, unknown>
  }): Promise<{ success: true }> {
    return { success: true }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Per-device pipeline step overrides
  //
  // Each device can override the global pipeline with its own step array.
  // Storage lives inside this addon's own IElementConfig namespace under
  // `devicePipelineSteps:<deviceId>` keys — no backend ConfigService
  // involvement. This makes the addon self-sufficient for per-device
  // pipeline overrides (Fase H.2 / capability self-sufficiency rule).
  // ═══════════════════════════════════════════════════════════════════════════

  // Per-device pipeline step CRUD removed in Phase 4b. The orchestrator
  // owns `pipelines/<deviceId>` — consumers call
  // `pipelineOrchestrator.{get,set,list}CameraPipeline` instead.

  // ═══════════════════════════════════════════════════════════════════════════
  // Addon Resolver
  // ═══════════════════════════════════════════════════════════════════════════

  async getAddonResolver(): Promise<IAddonResolver> {
    // The new pipeline doesn't use IAddonResolver — engines are managed directly.
    // Return a stub that throws to make it clear.
    return {
      resolve: async () => {
        throw new Error(
          'IAddonResolver is deprecated in addon-detection-pipeline. Use EngineFactory directly.',
        )
      },
      shutdownAll: async () => {
        if (this.engineFactory) {
          await this.engineFactory.dispose()
        }
      },
    }
  }

  async shutdown(): Promise<void> {
    this.poolMemoryGuard?.stop()
    this.poolMemoryGuard = null
    this.inferenceTimeoutGuard?.stop()
    this.inferenceTimeoutGuard = null
    if (this.engineFactory) {
      await this.engineFactory.dispose()
      this.engineFactory = null
      this.executor = null
    }
    // Dispose the per-device pools (Phase 2 multi-device).
    await this.benchmarkPools.disposeAll()
    this.deviceReaper.disposeAll() // stop idle timers before we dispose the pools (C3)
    const deviceFactories = Array.from(this.factoriesByDevice.values())
    this.factoriesByDevice.clear()
    await Promise.all(deviceFactories.map((f) => f.dispose().catch(() => undefined)))
    for (const id of Array.from(this.deviceProxies.keys())) this.releaseDeviceProxy(id)
  }

  /**
   * Resolve and cache a {@link DeviceProxy} for the given camera. Pins
   * the `state.zones` + `state.zoneRules` slice handles so `.value`
   * stays warm via the kernel runtime-state mirror, and runtime gate
   * reads in `runPipeline` are sync (zero per-frame round-trip).
   * Returns null when the addon context isn't available — the gate
   * falls back to "no filtering" instead of blocking inference.
   */
  private async ensureDeviceProxy(deviceId: number): Promise<DeviceProxy | null> {
    const cached = this.deviceProxies.get(deviceId)
    if (cached) return cached
    const ctx = this.addonCtx
    if (!ctx?.fetchDevice) return null
    try {
      const proxy = await ctx.fetchDevice(deviceId)
      this.deviceProxies.set(deviceId, proxy)
      const unsubs = [
        proxy.state.zones.subscribe(() => {
          /* keep slice warm */
        }),
        proxy.state.zoneRules.subscribe(() => {
          /* keep slice warm */
        }),
      ]
      this.proxyUnsubs.set(deviceId, unsubs)
      return proxy
    } catch (err: unknown) {
      this.log.debug('detection-pipeline ensureDeviceProxy failed — gating skipped', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  private releaseDeviceProxy(deviceId: number): void {
    const unsubs = this.proxyUnsubs.get(deviceId)
    if (unsubs) {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          /* swallow */
        }
      }
    }
    this.proxyUnsubs.delete(deviceId)
    this.deviceProxies.delete(deviceId)
  }

  /**
   * Apply detection-stage zone rules to a {@link FrameResult}. Drops
   * first-level detections whose center lies in an `exclude` rule's
   * zones (or, in whitelist mode, isn't in any `include` rule's
   * zones), and any `detail` children whose `parentId` references a
   * dropped first-level. Returns the original result unchanged when
   * the gate has nothing to filter (no zones, no rules, or no
   * detections).
   */
  private gateDetectionsByZoneRules(deviceId: number, result: FrameResult): FrameResult {
    if (deviceId <= 0) return result
    const proxy = this.deviceProxies.get(deviceId)
    if (!proxy) return result
    const zones = proxy.state.zones.value?.zones ?? []
    const rules = proxy.state.zoneRules.value?.detection ?? []
    // Pure gating (drop + `zone-gate` discard recording) lives in
    // `applyZoneRuleGate` — this wrapper only resolves the proxy state.
    return applyZoneRuleGate(result, zones, rules)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Bench frame cache (Python pool-side) ───────────────────────
  // Exposes the Python pool's frame cache to callers (pipeline-runner
  // bench actions). Caches 1.2MB once, subsequent infer calls send
  // only 5 bytes through the pipe.

  async cacheFrameInPool(input: {
    readonly data: Uint8Array
    readonly width: number
    readonly height: number
    readonly format: 'rgb' | 'bgr' | 'gray'
  }): Promise<{ frameId: number; width: number; height: number }> {
    await this.ensureEngineFactory()
    if (!this.engineFactory) throw new Error('cacheFrameInPool: factory not initialized')
    const buf = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength)
    return this.engineFactory.cacheFrameInPool(buf, input.width, input.height, input.format)
  }

  async inferCached(input: {
    readonly stepId: string
    readonly frameId: number
    readonly modelId: string
  }): Promise<Record<string, unknown>> {
    // A server closure that predates the field strips it before it gets here:
    // refused by name rather than timing whichever variant is active (D658).
    if (typeof input.modelId !== 'string' || input.modelId === '') {
      throw new Error(
        `inferCached: no modelId for step "${input.stepId}" — refusing rather than running the step's active variant`,
      )
    }
    await this.ensureEngineFactory()
    if (!this.engineFactory) throw new Error('inferCached: factory not initialized')
    return this.engineFactory.inferCached(input.stepId, input.frameId, input.modelId)
  }

  async uncacheFrame(input: { readonly frameId: number }): Promise<void> {
    if (!this.engineFactory) return
    await this.engineFactory.uncacheFrame(input.frameId)
  }

  /**
   * The tuning of the node's DEFAULT pool. Per-device pools each resolve their
   * own runtime's row, so this is not "the node's tuning" — the per-pool truth
   * is on each pool's `Python inference pool` log line and in `listLoadedEngines`.
   */
  /**
   * One pool's provisioning — the device pool named by `deviceKey`, else the
   * node default. Resolved with the SAME override `resolveDeviceFactory` and
   * `ensureEngineFactory` build the pool with, so the answer describes the
   * pool that ran the work (D646).
   */
  async getEffectiveTuning(input: EffectiveTuningInput = {}): Promise<EffectiveTuning> {
    const engine =
      input.deviceKey !== undefined ? resolveDeviceEngine(input.deviceKey) : this.currentEngine
    const p = resolvePoolProvisioning(engine, this.executorOptions.provisioning)
    return {
      deviceKey: input.deviceKey ?? null,
      runtime: p.runtime,
      batchMode: p.batchMode,
      windowMs: p.windowMs,
      maxBatchSize: p.maxBatchSize,
      concurrency: p.concurrency,
      numWorkers: p.numWorkers,
    }
  }

  // Private
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Ensure the engine factory + inference pool is initialized.
   * Does NOT require global steps — used by benchmark/test paths that provide their own steps.
   * If global steps exist, initializes with them. Otherwise, creates an empty pool.
   */
  private async ensureEngineFactory(): Promise<void> {
    // The node-default pool runs on a real accelerator too (on the hub,
    // `openvino:npu`), so it gets the SAME liveness gate and the SAME budget —
    // keyed on the device it actually is, which is also the key the balancer
    // knows it by. Nothing about "default" makes a corpse serveable.
    const defaultDeviceKey = deviceKeyOf(this.currentEngine)
    this.refuseIfDeviceUnusable(defaultDeviceKey)
    if (this.engineFactory) {
      if (this.engineFactory.isReady()) return
      const dead = this.engineFactory
      this.engineFactory = null
      this.noteFactoryDeath(defaultDeviceKey, dead)
      await dead.dispose().catch(() => undefined)
      this.refuseIfDeviceUnusable(defaultDeviceKey)
    }
    // Coalesce a cold burst onto ONE pool spawn, and — the part that actually
    // bled — do not PUBLISH `this.engineFactory` until its pool answered the
    // ready handshake. See {@link engineFactoryInflight}.
    const inflight = this.engineFactoryInflight
    if (inflight) {
      await inflight
      return
    }

    // Inference gate (Phase 2) — the SINGLE chokepoint every live
    // factory build flows through. The production camera-frame path is
    // `pipeline-runner.runInference → runPipeline.mutate → runPipeline()
    // → ensureEngineFactory()`; benchmark / operator paths
    // (`runPipelineBatch`, `cacheFrameInPool`, `inferCached`,
    // `spinEngine`) reach here too. Refuse to build the pool until the
    // provisioner reaches `ready`, throwing the current phase otherwise.
    // Every caller is crash-safe: the live frame caller
    // (`runInference`) try/catches and drops the frame; the benchmark /
    // operator callers are request/response RPCs whose rejection
    // surfaces an error to the operator (never a respawn loop); the
    // boot pre-warm (`warmPool`) skips (does not call this) before READY.
    // The invariant: until ready → no inference, surface state, never
    // crash-loop, never fall back to another runtime.
    const creation = (async (): Promise<EngineFactory> => {
      await this.assertEngineReady()
      await this.ensureBackendDeps(this.currentEngine)
      const factory = new EngineFactory({
        engine: this.currentEngine,
        modelsDir: this.modelsDir,
        logger: this.log.child('engine'),
        pythonPath: this.executorOptions.pythonPath ?? '',
        provisioning: this.executorOptions.provisioning,
        resolveCustomModel: this.customModelResolver,
        onCompileFinishedLate: (event) => this.noteLateCompile(factory, defaultDeviceKey, event),
      })
      try {
        // Initialize with empty steps — just creates the pool/runtime
        await factory.initialize([])
      } catch (err) {
        // The half-built pool never becomes visible, and its Python child is
        // reaped: a factory published in a failed state would serve
        // `not initialized` to every frame until the runner respawned.
        await factory.dispose().catch(() => undefined)
        this.log.error('Node-default pool failed to initialize', {
          meta: {
            deviceKey: defaultDeviceKey,
            backend: this.currentEngine.backend,
            device: this.currentEngine.device ?? null,
            error: errMsg(err),
          },
        })
        this.noteDeviceDeath(defaultDeviceKey, errMsg(err))
        throw err
      }
      // PUBLISH LAST. Every reader of `this.engineFactory` — including the
      // `if (this.engineFactory) return` above — treats a non-null field as
      // "the pool is callable", so assigning before the await is what turned a
      // 1-3.5 s spawn into a burst of destroyed frames.
      this.engineFactory = factory
      return factory
    })()

    this.engineFactoryInflight = creation
    try {
      await creation
    } finally {
      this.engineFactoryInflight = null
    }
  }

  /**
   * In-flight node-default pool creation. Single-flights
   * {@link ensureEngineFactory} exactly as `deviceFactoryInflight` does for the
   * per-device pools.
   *
   * Its absence was the chronic `PoolWorker[w0]: not initialized` storm
   * (1263 lines / 24 h, 2026-08-07): `this.engineFactory` was assigned BEFORE
   * `initialize()` was awaited, so every caller arriving during the 1-3.5 s
   * Python spawn took the early-exit and dispatched into a worker whose ready
   * handshake had not landed. The frames were logged as ERRORs and lost.
   *
   * The same bug was found and fixed twice before in this file — once for the
   * benchmark override cache (whose comment describes it verbatim) and once for
   * `resolveDeviceFactory` — which is why no `not initialized` line ever
   * carried a NON-default deviceKey. This is the third and last copy.
   *
   * It replaces a `private initPromise` field that was read here and assigned
   * NOWHERE: a dead lock that read, for as long as it existed, as if this path
   * were already guarded.
   */
  private engineFactoryInflight: Promise<EngineFactory> | null = null

  /**
   * Get (or lazily build) the inference-pool factory for an explicit device
   * (`<backend>:<device>`, e.g. `openvino:npu`, `edgetpu:usb`) — Phase 2
   * multi-device. Each device runs its OWN pool concurrently. Never mutates
   * `this.engineFactory`; when the requested device equals the node's current
   * engine the default pool is reused (no duplicate pool for the same device).
   */
  /**
   * In-flight device-pool creations, keyed by deviceKey. Single-flights
   * `resolveDeviceFactory` so two concurrent calls for the SAME device never
   * both spawn a pool — critical for single-context accelerators like the Coral
   * Edge TPU, where two pools racing to `load_delegate` on the one USB unit both
   * fail (the loser can't claim the already-held device).
   */
  private readonly deviceFactoryInflight = new Map<string, Promise<EngineFactory>>()

  /**
   * Per-`deviceKey` restart budget for the Python pools (D6 discipline).
   *
   * In-memory and per-runner ON PURPOSE. The terminal state means "this
   * accelerator aborted N times in a row a few minutes ago"; a runner respawn
   * re-derives it in three dispatches if it is still true, and persisting it
   * would outlive the driver update that fixes it. The operator's explicit
   * re-arm is {@link rearmInferenceDevice}, and the state is never invisible:
   * it is published on {@link getInferenceDeviceHealth}.
   */
  private readonly deviceLiveness = new InferenceDeviceLivenessSupervisor()

  /**
   * Throw if `deviceKey` is currently refused — before a single Python process
   * is spawned, a model index is allocated, or a frame is copied.
   *
   * The cost of NOT asking, measured: each frame of the 2026-08-25 storm ran
   * the full `models to load` → `allocateIndex` → `loadModel` → throw cycle at
   * 13 Hz for 31 hours, leaking one model index per frame — and past 254
   * (`encodeModelByte`) that pool could never have served inference again even
   * if its worker had come back.
   */
  /** Per camera, the last live-frame re-election said (see `frame-device-reelection.ts`). */
  private readonly frameReelections = new FrameReelectionNotes()

  /**
   * The deviceKey a live frame dispatches on: the elected one while it is
   * usable, else the node default pool. Each change is said once per camera,
   * naming the device — a camera whose frames silently moved pool, or were
   * silently refused, is the failure this exists to end.
   */
  private routeLiveFrameDevice(
    requestedDeviceKey: string | undefined,
    deviceId: number,
  ): string | undefined {
    const routing = routeLiveFrameDevice({
      requestedDeviceKey,
      defaultDeviceKey: deviceKeyOf(this.currentEngine),
      unusable: (key) => this.deviceLiveness.unusableReason(key),
    })
    const note = this.frameReelections.note(deviceId, routing)
    if (note !== null) {
      const tags = { tags: { deviceId } }
      if (note.kind === 're-elected') {
        this.log.warn(
          'elected inference device unusable — frames re-elected onto the default pool',
          {
            ...tags,
            meta: {
              deviceKey: note.from.deviceKey,
              state: note.from.state,
              deaths: note.from.deaths,
              lastError: note.from.lastError,
              reElectedTo: note.to,
            },
          },
        )
      } else if (note.kind === 'no-alternative') {
        this.log.warn('elected inference device unusable and no other pool here — frames refused', {
          ...tags,
          meta: {
            deviceKey: note.from.deviceKey,
            state: note.from.state,
            deaths: note.from.deaths,
            lastError: note.from.lastError,
          },
        })
      } else {
        this.log.info('elected inference device usable again — frames back on it', {
          ...tags,
          meta: { deviceKey: note.deviceKey },
        })
      }
    }
    return routing.deviceKey
  }

  private refuseIfDeviceUnusable(deviceKey: string): void {
    const unhealthy = this.deviceLiveness.unusableReason(deviceKey)
    if (unhealthy) throw new InferenceDeviceUnusableError(unhealthy)
  }

  /**
   * Record one pool death against the budget and SAY what was decided.
   *
   * One line per state change, not one per dispatch: the refusals that follow
   * are already carried by the rejected frame's own error. The `failed`
   * transition is an ERROR because it is the terminal state — an operator who
   * never sees this line has a silently half-dead node, which is the failure
   * this whole path exists to end.
   */
  private noteDeviceDeath(deviceKey: string, reason: string): void {
    const decision = this.deviceLiveness.recordDeath(deviceKey, reason)
    if (decision.action === 'failed') {
      this.log.error(
        'inference device FAILED — restart budget exhausted, no pool will be spawned',
        {
          meta: {
            deviceKey,
            deathsInWindow: decision.deathsInWindow,
            reason,
            rearm: 'pipelineExecutor.rearmInferenceDevice',
          },
        },
      )
      return
    }
    this.log.warn('inference pool died — rebuilding under the restart budget', {
      meta: {
        deviceKey,
        deathsInWindow: decision.deathsInWindow,
        backoffMs: decision.backoffMs,
        reason,
      },
    })
  }

  /**
   * Retire a dead per-device pool: drop it from the map FIRST (so a concurrent
   * dispatch rebuilds fresh through the single-flight guard rather than
   * grabbing the corpse), cancel its idle timer, charge the budget, then
   * dispose — which rejects whatever was still in flight on it with a reason
   * rather than letting those requests sit until their own deadlines.
   */
  private async condemnDeviceFactory(deviceKey: string, factory: EngineFactory): Promise<void> {
    if (this.factoriesByDevice.get(deviceKey) === factory) {
      this.factoriesByDevice.delete(deviceKey)
      this.deviceReaper.cancel(deviceKey)
      this.noteFactoryDeath(deviceKey, factory)
    }
    await factory.dispose().catch(() => undefined)
  }

  /**
   * Charge one dead pool to its device — unless it died of a compile that was
   * still running at its hard bound (D653, fix round 1). That death is not a
   * crash of the DEVICE: the model that hung was already counted when its
   * load answered `compile-timeout`, and the same model timing out again on
   * the respawn is refused by name (`ModelLoadGovernor`), which is what bounds
   * the respawns. A crash stays a crash.
   */
  private noteFactoryDeath(deviceKey: string, factory: EngineFactory): void {
    const cause = factory.getDeathCause()
    if (cause !== null && !cause.chargesDeviceBudget) {
      this.log.warn(
        'inference pool recycled after a compile hung — not charged to the device budget',
        {
          meta: { deviceKey, reason: cause.reason, cause: cause.message },
        },
      )
      return
    }
    this.noteDeviceDeath(deviceKey, cause?.message ?? 'pool worker is not ready')
  }

  /**
   * Every inference device this node currently refuses, and why.
   *
   * The CHANNEL the 2026-08-26 analysis found missing. Pool health lived
   * entirely inside this addon and reached no routing decision at any level:
   * the capability gate is keyed on model FORMAT and so is permanently blind
   * between `openvino:gpu` and `openvino:npu`, and the orchestrator's live
   * probe answers about HARDWARE, which was present the whole time. So the
   * balancer kept handing this node cameras by rotation — 20 sessions onto a
   * dead pool in 20 minutes — and every one of them lost its frames.
   *
   * Two sources, deliberately merged into one answer:
   *  - the breaker's own `failed` / `backoff` states, and
   *  - any factory currently cached but NOT ready. A pool nobody has dispatched
   *    to since it died has not yet been condemned by the dispatch path, and a
   *    device with no traffic is exactly the one that must stop being chosen
   *    BEFORE the traffic arrives. Charging the budget is the dispatch path's
   *    job; reporting is free and costs no spawn.
   *
   * Read-only and synchronous over in-memory state: it never probes, never
   * spawns, and never throws — the reader's whole safety argument rests on a
   * failed read changing nothing, and a read that can fail for its own reasons
   * would poison that.
   */
  async getInferenceDeviceHealth(): Promise<{
    readonly unhealthy: readonly InferenceDeviceUnhealthy[]
  }> {
    const byKey = new Map<string, InferenceDeviceUnhealthy>()
    for (const entry of this.deviceLiveness.unhealthy()) byKey.set(entry.deviceKey, entry)
    const live: readonly (readonly [string, EngineFactory])[] = [
      ...this.factoriesByDevice,
      ...(this.engineFactory
        ? [[deviceKeyOf(this.currentEngine), this.engineFactory] as const]
        : []),
    ]
    for (const [deviceKey, factory] of live) {
      if (factory.isReady() || byKey.has(deviceKey)) continue
      byKey.set(deviceKey, {
        deviceKey,
        state: 'backoff',
        since: Date.now(),
        deaths: 0,
        lastError: deathReasonOf(factory),
      })
    }
    return {
      unhealthy: [...byKey.values()].toSorted((a, b) => a.deviceKey.localeCompare(b.deviceKey)),
    }
  }

  /**
   * Operator re-arm of a terminally failed inference device: forget the budget
   * so the next dispatch builds a fresh pool.
   *
   * A terminal state with no way out is a silent fault dressed as a safety
   * feature. This is the way out, and it is the ONLY automatic-looking one on
   * offer: there is deliberately no timed probation, because the crash this
   * bounds is deterministic and a probation would simply respawn Python
   * forever at a slower rate. Re-arming a device that was never failed is a
   * no-op, reported as such.
   */
  async rearmInferenceDevice(input: {
    readonly deviceKey: string
  }): Promise<{ readonly rearmed: boolean }> {
    const rearmedDevice = this.deviceLiveness.rearm(input.deviceKey)
    // The models refused on this device by name (D653) are re-armed with it.
    const rearmedModels = this.loadGovernor.rearm(input.deviceKey)
    const rearmed = rearmedDevice || rearmedModels > 0
    this.log.info('inference device re-armed by operator', {
      meta: { deviceKey: input.deviceKey, rearmed, rearmedModels },
    })
    return { rearmed }
  }

  /**
   * Build the pool a benchmark loads into: a fresh worker for the engine of
   * `deviceKey`, outside the live pools' liveness budget and late-compile
   * bookkeeping (a benchmark's failure is a verdict about the benchmark).
   */
  private async createBenchmarkFactory(
    deviceKey: string,
    engine: PipelineEngineChoice,
  ): Promise<EngineFactory> {
    await this.ensureBackendDeps(engine)
    const factory = new EngineFactory({
      engine,
      modelsDir: this.modelsDir,
      logger: this.log.child(`bench:${deviceKey}`),
      pythonPath: this.executorOptions.pythonPath ?? '',
      provisioning: this.executorOptions.provisioning,
      resolveCustomModel: this.customModelResolver,
    })
    try {
      await factory.initialize([])
    } catch (err) {
      await factory.dispose().catch(() => undefined)
      this.log.error('Benchmark pool failed to initialize', {
        meta: { deviceKey, error: errMsg(err) },
      })
      throw err
    }
    this.log.info('Benchmark pool started — its loads stay out of the live pool', {
      meta: { deviceKey },
    })
    return factory
  }

  private async resolveDeviceFactory(deviceKey: string): Promise<EngineFactory> {
    const engine = resolveDeviceEngine(deviceKey)
    if (enginesEqual(engine, this.currentEngine)) {
      await this.ensureEngineFactory()
      return this.engineFactory!
    }
    // LIVENESS, not creation-race. The three single-flight guards in this file
    // protect a pool being BUILT; nothing protected against handing back one
    // that had already died. Ask first, before anything is spawned or touched.
    this.refuseIfDeviceUnusable(deviceKey)
    const existing = this.factoriesByDevice.get(deviceKey)
    if (existing) {
      if (existing.isReady()) {
        this.deviceReaper.touch(deviceKey) // keep-alive: reset the idle-TTL (C3)
        return existing
      }
      // A cached factory that is not ready is a CORPSE: `factoriesByDevice`
      // only ever receives a factory whose `initialize()` already resolved, and
      // a rebuild in progress is not in the map at all. Condemn it — under the
      // budget — instead of returning it for the 370 000th time.
      await this.condemnDeviceFactory(deviceKey, existing)
      this.refuseIfDeviceUnusable(deviceKey)
    }
    // Coalesce concurrent creations onto one in-flight promise (single-flight).
    const inflight = this.deviceFactoryInflight.get(deviceKey)
    if (inflight) return inflight

    const creation = (async (): Promise<EngineFactory> => {
      await this.ensureBackendDeps(engine)
      const factory = new EngineFactory({
        engine,
        modelsDir: this.modelsDir,
        logger: this.log.child(`engine:${deviceKey}`),
        pythonPath: this.executorOptions.pythonPath ?? '',
        provisioning: this.executorOptions.provisioning,
        resolveCustomModel: this.customModelResolver,
        onCompileFinishedLate: (event) => this.noteLateCompile(factory, deviceKey, event),
      })
      try {
        await factory.initialize([])
      } catch (err) {
        // A device pool that fails to come up drops every session routed to it.
        // Name the device HERE: the caller only sees a rejected dispatch, and
        // the pool's own log scope is the only other place the deviceKey
        // appears.
        this.log.error('Device pool failed to initialize', {
          meta: {
            deviceKey,
            backend: engine.backend,
            device: engine.device ?? null,
            provisioning: factory.provisioning,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        // Ensure the failed pool's child fully exits (releasing any partial
        // single-context USB claim) before the error propagates + a retry runs.
        await factory.dispose().catch(() => undefined)
        // A spawn that throws costs the same budget a spawn that dies later
        // does — otherwise a device whose pool never comes up at all is the one
        // shape that still retries forever.
        this.noteDeviceDeath(deviceKey, errMsg(err))
        throw err
      }
      this.factoriesByDevice.set(deviceKey, factory)
      this.deviceReaper.touch(deviceKey) // arm the idle-TTL for the new pool (C3)
      return factory
    })()

    this.deviceFactoryInflight.set(deviceKey, creation)
    try {
      return await creation
    } finally {
      this.deviceFactoryInflight.delete(deviceKey)
    }
  }

  /**
   * Dispose a single idle device pool (invoked by the {@link deviceReaper} when
   * `deviceKey` has had no dispatch for the idle-TTL). Removed from the map
   * FIRST so a concurrent `resolveDeviceFactory` recreates it fresh via the
   * single-flight guard rather than handing back the disposing instance.
   */
  private async disposeDevicePool(deviceKey: string): Promise<void> {
    const factory = this.factoriesByDevice.get(deviceKey)
    if (!factory) return
    this.factoriesByDevice.delete(deviceKey)
    await factory.dispose()
    this.log.info('Idle device pool evicted', {
      meta: {
        deviceKey,
        idleTtlMs: DetectionPipelineProvider.DEVICE_POOL_IDLE_TTL_MS,
      },
    })
  }

  // NOTE: `ensureExecutor` / `doInitialize` (the node-global "current
  // pipeline" boot path) were removed together with the legacy `detect()`
  // method — they were its only consumers. Live inference builds transient
  // trees per `runPipeline` call.

  /**
   * Phase 2c — flat per-addonId map holding the video-pipeline step
   * config (`modelId` / `settings`). No `enabled` field: whether an
   * addon step runs is a capability-binding concern, not a
   * pipeline-config one. Replaces the orchestrator's per-agent
   * `addonDefaults`. The map is the source of truth; the tree consumed
   * by the executor (`PipelineDefaultStep[]`) is materialised from
   * this map + catalog compat at read time (not done in this commit —
   * phase 2f wires the resolver through).
   */
  async getVideoPipelineSteps(): Promise<
    Record<
      string,
      {
        modelId: string
        settings: Readonly<Record<string, unknown>>
      }
    >
  > {
    const store = await this.readStore()
    const raw = store['videoPipelineSteps']
    if (raw === undefined || raw === null) return {}
    if (typeof raw !== 'object') return {}
    const result: Record<
      string,
      {
        modelId: string
        settings: Readonly<Record<string, unknown>>
      }
    > = {}
    for (const [addonId, cfg] of Object.entries(raw as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== 'object') continue
      const c = cfg as Record<string, unknown>
      if (typeof c.modelId !== 'string') continue
      result[addonId] = {
        modelId: c.modelId,
        settings:
          c.settings && typeof c.settings === 'object'
            ? (c.settings as Record<string, unknown>)
            : {},
      }
    }
    return result
  }

  async setVideoPipelineSteps(input: {
    readonly steps: Record<
      string,
      {
        modelId: string
        settings: Readonly<Record<string, unknown>>
      }
    >
  }): Promise<{ success: true }> {
    // Strip any legacy `enabled` field that a pre-migration caller may
    // still be sending — storage is `enabled`-free.
    const sanitized: Record<string, unknown> = {}
    for (const [addonId, cfg] of Object.entries(input.steps)) {
      sanitized[addonId] = {
        modelId: cfg.modelId,
        settings: { ...cfg.settings },
      }
    }
    await this.writeStore({ videoPipelineSteps: sanitized })
    this.log.info('videoPipelineSteps updated', {
      meta: { addons: Object.keys(sanitized).length },
    })
    return { success: true as const }
  }

  // ── Engine lifecycle (pipeline-executor cap) ─────────────────────────
  //
  // The detection-pipeline provider holds at most ONE engine at a time
  // (`currentEngine` + lazy `engineFactory`). These methods surface that
  // engine to the Pipeline → Engines tab, so the operator can see what's
  // resident in RAM and evict it without a full addon restart.
  //
  // `inUseByCameras` is not tracked here — it depends on pipeline-runner
  // attach state which lives in a different process. The UI joins this
  // list with runner.listAttached() to compute the "in use" column.

  async listLoadedEngines(): Promise<
    readonly {
      engineKey: string
      engine: PipelineEngineChoice
      modelsLoaded: readonly string[]
      inUseByCameras: readonly number[]
      kind: 'runtime' | 'device-pool'
      poolPid: number | null
      idleMs: number | null
      idleTtlMs: number | null
    }[]
  > {
    const out: {
      engineKey: string
      engine: PipelineEngineChoice
      modelsLoaded: readonly string[]
      inUseByCameras: readonly number[]
      kind: 'runtime' | 'device-pool'
      poolPid: number | null
      idleMs: number | null
      idleTtlMs: number | null
    }[] = []

    if (this.engineFactory) {
      const eng = this.currentEngine
      const engineKey = `${eng.runtime}/${eng.backend}/${eng.device ?? 'default'}`
      const loaded = this.engineFactory.listLoaded()
      out.push({
        engineKey,
        engine: eng,
        modelsLoaded: loaded.map((l) => `${l.stepId}/${l.modelId}`),
        inUseByCameras: [],
        kind: 'runtime',
        poolPid: this.engineFactory.getPoolPid(),
        idleMs: null,
        idleTtlMs: null,
      })
    }
    // Phase 2 multi-device: the concurrent per-device pools (`factoriesByDevice`,
    // keyed by `deviceKey`) run ALONGSIDE the runtime engine on different
    // accelerators (NPU / iGPU / Coral). Surface each so the Engines tab shows
    // every pool that's actually resident — without this the concurrent pools
    // are invisible and un-verifiable.
    for (const [deviceKey, factory] of this.factoriesByDevice) {
      const eng = resolveDeviceEngine(deviceKey)
      const loaded = factory.listLoaded()
      out.push({
        engineKey: `${eng.runtime}/${eng.backend}/${eng.device ?? 'default'} [${deviceKey}]`,
        engine: eng,
        modelsLoaded: loaded.map((l) => `${l.stepId}/${l.modelId}`),
        inUseByCameras: [],
        kind: 'device-pool',
        poolPid: factory.getPoolPid(),
        idleMs: null,
        idleTtlMs: null,
      })
    }
    return out
  }

  async spinEngine(input: { engine: PipelineEngineChoice }): Promise<{ success: true }> {
    // Tear down any pre-existing factory that targets a different engine,
    // then warm up an empty pool for the requested engine. Models load
    // lazily on the first `runPipeline` call that references them.
    const same =
      this.engineFactory &&
      this.currentEngine.runtime === input.engine.runtime &&
      this.currentEngine.backend === input.engine.backend &&
      (this.currentEngine.device ?? null) === (input.engine.device ?? null)
    if (same) return { success: true }
    if (this.engineFactory) {
      await this.engineFactory.dispose()
      this.engineFactory = null
      this.executor = null
    }
    this.currentEngine = input.engine
    await this.ensureEngineFactory()
    return { success: true }
  }

  async killEngine(input: {
    engine: PipelineEngineChoice
    force?: boolean
  }): Promise<{ success: boolean; reason?: string }> {
    if (!this.engineFactory) {
      return { success: false, reason: 'not loaded' }
    }
    const target = input.engine
    const matches = enginesEqual(this.currentEngine, target)
    if (!matches) {
      return { success: false, reason: 'engine mismatch' }
    }
    // inUse check deferred to caller — detection-pipeline cannot see
    // pipeline-runner attachments without crossing the transport layer.
    // UI invokes killEngine with `force:true` only after confirming no
    // attached cameras via runner.listAttached().
    await this.engineFactory.dispose()
    this.engineFactory = null
    this.executor = null
    this.log.info('Engine killed', {
      meta: { ...target, force: input.force ?? false },
    })
    return { success: true }
  }

  // ── Reference audio ──

  async getReferenceAudioFiles(): Promise<readonly { filename: string; sizeKb: number }[]> {
    const dir = resolveReferenceAudioDir()
    if (!dir) return []
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(wav|mp3|ogg|flac)$/i.test(f))
      .toSorted()
      .map((filename) => {
        const stats = fs.statSync(path.join(dir, filename))
        return { filename, sizeKb: Math.round(stats.size / 1024) }
      })
  }

  async getReferenceAudio(input: { filename: string }): Promise<{ base64: string }> {
    const { filename } = input
    return { base64: loadReferenceAudioBase64(filename) }
  }

  async getAudioCapabilities(): Promise<{
    activeBackend: string
    availableBackends: readonly {
      id: string
      name: string
      description: string
      available: boolean
      rawLabels?: readonly string[]
    }[]
    sampleRate: number
    chunkDurationMs: number
  }> {
    const isMac = process.platform === 'darwin'
    // Source the per-backend raw label sets from the macro mapping
    // tables — same data the classifier uses to aggregate to macros.
    // Sorted alphabetically for stable UI ordering.
    const yamnetLabels = Object.keys(YAMNET_TO_MACRO.mapping).toSorted((a, b) => a.localeCompare(b))
    const appleLabels = Object.keys(APPLE_SA_TO_MACRO.mapping).toSorted((a, b) =>
      a.localeCompare(b),
    )
    return {
      activeBackend: isMac ? 'apple-soundanalysis' : 'yamnet-onnx',
      availableBackends: [
        {
          id: 'yamnet-onnx',
          name: 'YAMNet ONNX',
          description: 'Google YAMNet — 521 classes, CPU',
          available: true,
          rawLabels: yamnetLabels,
        },
        {
          id: 'apple-soundanalysis',
          name: 'Apple SoundAnalysis',
          description: 'macOS built-in — 303 classes, Neural Engine',
          available: isMac,
          rawLabels: appleLabels,
        },
      ].filter((b) => b.available),
      sampleRate: 16000,
      chunkDurationMs: 500,
    }
  }

  async runAudioTest(input: {
    addonId: string
    modelId: string
    filename?: string
    settings?: Record<string, unknown>
  }): Promise<{
    success: boolean
    error?: string
    frame?: import('@camstack/types').AudioResult
  }> {
    const api = this.addonCtx?.api
    if (!api) {
      return {
        success: false,
        error: 'API not available — addon not fully initialized',
      }
    }

    const dir = resolveReferenceAudioDir()
    if (!dir) {
      return { success: false, error: 'Reference audio directory not found' }
    }

    // Use requested filename or fall back to first WAV
    let targetFilename = input.filename
    if (!targetFilename) {
      const audioFiles = await this.getReferenceAudioFiles()
      targetFilename = audioFiles.find((f) => f.filename.endsWith('.wav'))?.filename
    }
    if (!targetFilename) {
      return { success: false, error: 'No WAV reference audio file found' }
    }

    const filePath = path.join(dir, targetFilename)
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        error: `Audio file not found: ${targetFilename}`,
      }
    }
    const start = performance.now()
    try {
      const chunk = parseWavToAudioChunk(filePath)
      // AddonApi exposes every procedure as `{ query, mutate, subscribe }` —
      // the direct caller is wrapped in a proxy by AddonApiFactory so the
      // shape matches the WSS client transparently.
      const result = await api.audioAnalyzer.classify.query(chunk)
      const durationMs = Math.round(performance.now() - start)

      // ── Per-step settings from AudioAnalyzerStep.getConfigSchema() ──
      // Phase 7 (settings redesign): unified naming — the slider key is
      // now `minConfidence` for every threshold field across the
      // pipeline (was `minScore` in Phase 6). The full top-N ranked
      // list is surfaced via `debug.alternateLabels['audio-analyzer']`;
      // the user's `minConfidence` gates which of those become
      // AudioDetection entries.
      const settings = input.settings ?? {}
      const minConfidenceRaw = settings['minConfidence']
      const minConfidence = typeof minConfidenceRaw === 'number' ? minConfidenceRaw : 0

      // Raw ranked labels from the classifier (already sorted desc).
      const ranked = (result.labels ?? []).slice().toSorted((a, b) => b.score - a.score)

      // Build the top-N alternate list (fixed cap at 10 for the debug
      // panel — one entry is enough for most UIs, but top-10 fits the
      // benchmark inspector without bloating the payload).
      const alternateTopN = ranked.slice(0, 10).map((l) => ({
        label: l.className,
        score: l.score,
      }))

      // Each class above `minConfidence` becomes one AudioDetection
      // entry. The window spans the full classified chunk — compute
      // the duration from the raw f32le byte buffer length:
      // 4 bytes per sample (IEEE 754 float, little-endian).
      const sampleCount = chunk.data.byteLength / 4
      const startMs = 0
      const endMs = (sampleCount / chunk.sampleRate) * 1000
      const detections = ranked
        .filter((l) => l.score >= minConfidence)
        .map((l, i): import('@camstack/types').AudioDetection => ({
          id: `a${i + 1}`,
          kind: 'audio',
          startMs,
          endMs,
          macroClass: l.className,
          score: l.score,
          labels: [],
          debug: {
            stepLatencyMs: { 'audio-analyzer': result.inferenceMs },
            modelIds: { 'audio-analyzer': input.modelId },
            alternateLabels: {
              'audio-analyzer': alternateTopN,
            },
            ...(l.originalClass && l.originalClass !== l.className
              ? { originalClass: l.originalClass }
              : {}),
          },
        }))

      const frame: import('@camstack/types').AudioResult = {
        kind: 'audio-window',
        windowId: `audio-test-${Date.now()}`,
        deviceId: 0,
        timestamp: Date.now(),
        startMs,
        endMs,
        detections,
        debug: {
          totalInferenceMs: durationMs,
          stepTimings: [
            {
              source: 'audio-analyzer',
              modelId: input.modelId,
              ms: result.inferenceMs,
              detectionCount: detections.length,
            },
          ],
          engine: input.addonId,
        },
      }

      this.log.info('[audio-test] completed', {
        meta: {
          backend: input.addonId,
          file: targetFilename,
          detections: detections.length,
          ranked: ranked.length,
          minConfidence,
          inferenceMs: Number(result.inferenceMs.toFixed(1)),
          totalMs: durationMs,
        },
      })

      return { success: true, frame }
    } catch (err: unknown) {
      const msg = errMsg(err)
      this.log.error('failed', { meta: { phase: 'audio-test', error: msg } })
      return { success: false, error: msg }
    }
  }
}

// ---------------------------------------------------------------------------
// Schema builders (from step definitions)
// ---------------------------------------------------------------------------

export function buildSchemaSlots(
  formats: ReadonlySet<ModelFormat>,
  modelsDir: string,
  customByStep?: ReadonlyMap<string, readonly ModelCatalogEntry[]>,
): import('@camstack/types').PipelineSlotSchema[] {
  const slotMap = new Map<string, import('@camstack/types').PipelineAddonSchema[]>()
  const formatList = [...formats]

  for (const pipelineStep of ALL_PIPELINE_STEPS) {
    const step = pipelineStep.definition
    // Static catalog ∪ operator-registered custom models for this step
    // (static wins on an id collision), then keep any model with a build for
    // ANY of the node's hostable formats (see getSchema — the node's selected
    // engine PLUS every other format its hardware can run).
    const stepModels = mergeCustomModels(step.models, customByStep?.get(step.id) ?? [])
    // Hide LEGACY (superseded / consolidated) catalog models from the
    // selectable list — they stay resolvable when explicitly pinned, but are
    // not offered as new choices. Custom operator models carry no `legacy` flag
    // so they always pass.
    const availableModels = stepModels.filter(
      (m) => m.legacy !== true && formatList.some((f) => m.formats[f]),
    )
    if (availableModels.length === 0) continue

    const slot = step.slot
    if (!slotMap.has(slot)) slotMap.set(slot, [])

    // D214: decorate the schema with per-model knob applicability, computed
    // from the SAME model union the picker offers, so the editors can disable
    // an ineffective knob with its reason (fused-NMS decodes, macro classes a
    // custom labelmap cannot reach, class allow-lists that must offer the
    // model's own labels).
    const customIds = new Set((customByStep?.get(step.id) ?? []).map((m) => m.id))
    const configSchema = annotateConfigSchemaForModels({
      def: step,
      configSchema: pipelineStep.getConfigSchema(),
      models: availableModels,
      customModelIds: customIds,
      // D738 — each model's own default for a model-bound field (the floors),
      // from the same `getConfigSchema(model)` the runner hydrates from.
      schemaForModel: (entry) => pipelineStep.getConfigSchema(entry),
    })
    // D741 — while a root supplies this step's fine label, its threshold is
    // the root's label floor; each supplying root model's default is listed.
    const configSchemaWithRoots = withRootSuppliedLabelDefaults(
      step.id,
      configSchema,
      mergeCustomModels(
        getStepDefinition('object-detection').models,
        customByStep?.get('object-detection') ?? [],
      ),
    )

    slotMap.get(slot)!.push({
      id: step.id,
      name: step.name,
      slot: step.slot,
      inputClasses: step.inputClasses ?? [],
      outputClasses: step.outputClasses,
      childSlots: resolveChildSlots(step.slot),
      models: availableModels.map((m) => ({
        id: m.id,
        name: m.name,
        formats: Object.fromEntries(
          Object.entries(m.formats).map(([f, entry]) => {
            const format = f as ModelFormat
            // D746 — what is on disk (current / stale / missing) and the
            // build's precision, beside `downloaded` (= `onDisk === 'current'`).
            const onDisk = modelOnDiskState(modelsDir, m, format)
            const precision = formatPrecision(m, format)
            return [
              f,
              {
                downloaded: onDisk === 'current',
                sizeMB: entry!.sizeMB,
                onDisk,
                ...(precision !== undefined ? { precision } : {}),
              },
            ]
          }),
        ),
        // Carry the variant-grouping axes so the pipeline/device steppers render
        // the same grouped Family→Tier→Variant picker as the config UI. `legacy`
        // is always false here (availableModels is already legacy-filtered) but
        // passed through for shape fidelity.
        ...(m.group ? { group: m.group } : {}),
        ...(m.legacy !== undefined ? { legacy: m.legacy } : {}),
        provider: m.provider ?? 'camstack',
        // The floor in force for THIS model (D662): its own, else the step's.
        defaultConfidence: resolveModelDefaultConfidence(step, m),
        // What this ROOT model can supply (D730) — declared at import or
        // derived on read, the same `rootSuppliesOf` the runner decides with.
        ...modelSuppliesField(step, m),
      })),
      defaultModelId: step.defaultModelId,
      ...(step.defaultModelIdByFormat
        ? { defaultModelIdByFormat: { ...step.defaultModelIdByFormat } }
        : {}),
      ...(step.enabledByDefault !== undefined ? { enabledByDefault: step.enabledByDefault } : {}),
      // The STEP's default — the fallback for a model that declares none. The
      // per-model value in force is on each `models[]` entry above.
      defaultConfidence: step.defaultConfidence,
      ...(step.group ? { group: step.group } : {}),
      ...(configSchemaWithRoots.length > 0 ? { configSchema: configSchemaWithRoots } : {}),
    })
  }

  const slotPriority: Record<string, number> = {
    detector: 0,
    cropper: 1,
    classifier: 2,
    refiner: 3,
    'audio-classifier': 4,
  }
  const parentSlot: Record<string, string | null> = {
    detector: null,
    cropper: 'detector',
    classifier: 'cropper',
    refiner: 'detector',
    'audio-classifier': null,
  }

  const slotLabels: Record<string, string> = {
    detector: 'Detector',
    cropper: 'Cropper',
    classifier: 'Classifier',
    refiner: 'Refiner',
    'audio-classifier': 'Audio Classifier',
  }

  return Array.from(slotMap.entries()).map(([slot, addons]) => ({
    id: slot as import('@camstack/types').PipelineSlot,
    label: slotLabels[slot] ?? slot,
    priority: slotPriority[slot] ?? 99,
    parentSlot: (parentSlot[slot] ?? null) as import('@camstack/types').PipelineSlot | null,
    addons,
  }))
}

function resolveChildSlots(slot: string): import('@camstack/types').PipelineSlot[] {
  switch (slot) {
    case 'detector':
      return ['cropper', 'classifier', 'refiner']
    case 'cropper':
      return ['classifier', 'refiner']
    default:
      return []
  }
}

/**
 * V1 default: all steps enabled, heavy models. Kept for rollback.
 * Total model footprint: ~600 MB (ONNX), ~300 MB (CoreML)
 */
/** @internal Exported for rollback — use buildDefaultStepTree (v2) for production */
export function buildDefaultStepTreeV1(format: ModelFormat): PipelineDefaultStep[] {
  const makeStep = (
    stepId: string,
    children: PipelineDefaultStep[],
    opts?: { enabled?: boolean; modelId?: string },
  ): PipelineDefaultStep | null => {
    const def = getStepDefinition(stepId)
    const hasFormat = def.models.some((m) => m.formats[format])
    if (!hasFormat) return null

    return {
      addonId: def.id,
      addonName: def.name,
      slot: def.slot,
      inputClasses: def.inputClasses ?? [],
      outputClasses: def.outputClasses,
      enabled: opts?.enabled ?? true,
      modelId: opts?.modelId ?? getDefaultModelForFormat(stepId, format),
      children,
      ...(def.group ? { group: def.group } : {}),
    }
  }

  const faceEmbedding = makeStep('face-embedding', [])
  const faceDetection = makeStep('face-detection', faceEmbedding ? [faceEmbedding] : [])

  const plateOcr = makeStep('plate-ocr', [])
  const plateDetection = makeStep('plate-detection', plateOcr ? [plateOcr] : [])

  const animalClassifier = makeStep('animal-classifier', [])
  const vehicleClassifier = makeStep('vehicle-classifier', [])

  const rootChildren: PipelineDefaultStep[] = [
    faceDetection,
    plateDetection,
    animalClassifier,
    vehicleClassifier,
  ].filter((s): s is PipelineDefaultStep => s !== null)

  const root = makeStep('object-detection', rootChildren)
  return root ? [root] : []
}

/**
 * V2 default: the node-default step tree (never persisted — see
 * `nodeDefaultSteps`). The core detection + recognition steps are enabled; every
 * optional step is present with its catalog `enabledByDefault` (the animal and
 * vehicle classifiers on — their answer comes from the root model when it
 * declares them, D736 — the bird classifier and segmentation off).
 */
export function buildDefaultStepTree(
  format: ModelFormat,
  /**
   * Hardware-aware override for the OBJECT-DETECTION root's model id (from
   * {@link resolveDefaultDetectionModel}). When absent, the object-detection
   * root falls back to `getDefaultModelForFormat` like every other step —
   * preserving the flat-default behaviour for callers (and tests) that don't
   * pass a node engine. Only the object-detection slot is affected.
   */
  objectDetectionModelId?: string,
): PipelineDefaultStep[] {
  const makeStep = (
    stepId: string,
    children: PipelineDefaultStep[],
    opts?: { enabled?: boolean; modelId?: string },
  ): PipelineDefaultStep | null => {
    const def = getStepDefinition(stepId)
    const hasFormat = def.models.some((m) => m.formats[format])
    if (!hasFormat) return null

    return {
      addonId: def.id,
      addonName: def.name,
      slot: def.slot,
      inputClasses: def.inputClasses ?? [],
      outputClasses: def.outputClasses,
      enabled: opts?.enabled ?? true,
      modelId: opts?.modelId ?? getDefaultModelForFormat(stepId, format),
      children,
      ...(def.group ? { group: def.group } : {}),
    }
  }

  // Enabled: core detection + recognition pipeline
  const faceEmbedding = makeStep('face-embedding', [])
  const faceDetection = makeStep('face-detection', faceEmbedding ? [faceEmbedding] : [])
  const plateOcr = makeStep('plate-ocr', [])
  const plateDetection = makeStep('plate-detection', plateOcr ? [plateOcr] : [])
  // CLIP object embedding — ON by default so text→object semantic search works
  // cluster-wide. Runs per object crop (best-per-track), comparable cost to the
  // always-on face-embedding. A step-tree node is required: the enabledByDefault
  // flag alone never inserts it.
  const clipEmbedding = makeStep('clip-embedding', [])

  // The optional steps follow their catalog default — the animal and vehicle
  // classifiers are ON (sourced from the root model, D736), the bird
  // classifier and segmentation stay opt-in. One authority: the definition.
  const byCatalogDefault = (stepId: string): { enabled: boolean } => ({
    enabled: getStepDefinition(stepId).enabledByDefault ?? true,
  })
  const animalClassifier = makeStep('animal-classifier', [], byCatalogDefault('animal-classifier'))
  const birdClassifier = makeStep('bird-classifier', [], byCatalogDefault('bird-classifier'))
  const vehicleClassifier = makeStep(
    'vehicle-classifier',
    [],
    byCatalogDefault('vehicle-classifier'),
  )
  const segmentation = makeStep('segmentation', [], byCatalogDefault('segmentation'))

  const rootChildren: PipelineDefaultStep[] = [
    faceDetection,
    plateDetection,
    clipEmbedding,
    animalClassifier,
    birdClassifier,
    vehicleClassifier,
    segmentation,
  ].filter((s): s is PipelineDefaultStep => s !== null)

  // Object-detection default: the hardware-aware pick when supplied (node
  // engine known), else `getDefaultModelForFormat` (flat per-format default).
  const root = makeStep(
    'object-detection',
    rootChildren,
    objectDetectionModelId !== undefined ? { modelId: objectDetectionModelId } : undefined,
  )

  // Audio classifier — root-level step. Audio runs separately from video;
  // its engine is node-local (resolved by the executing runner at dispatch
  // time), never carried on the step — the model default follows the node's
  // format via `getDefaultModelForFormat`.
  const audioStep = makeStep('audio-classifier', [])

  const steps: PipelineDefaultStep[] = []
  if (root) steps.push(root)
  if (audioStep) steps.push(audioStep)
  return steps
}

/** Flatten a step tree into a flat list (DFS) — delegates to shared utility. */
function flattenSteps(steps: readonly PipelineDefaultStep[]): readonly PipelineDefaultStep[] {
  return flattenEnabledVideoSteps(steps)
}

/**
 * Catalog root-vs-detail plane of a step: a non-null `inputClasses` on the
 * DEFINITION marks a crop child served per-track on the detail plane —
 * mirrors the executor's frame-plane skip (`executeChildren`) and the
 * runner's `deriveDetailSteps`. Unknown addonIds (already dropped from
 * resolved trees) default to root-plane.
 */
function isDetailPlaneStep(addonId: string): boolean {
  try {
    return getStepDefinition(addonId).inputClasses !== null
  } catch {
    return false
  }
}

/** A root model's supplies for the schema, omitted when it supplies nothing. */
function modelSuppliesField(
  step: StepDefinition,
  model: ModelCatalogEntry,
): { readonly suppliesSteps?: readonly RootStepSupply[] } {
  if (step.inputClasses !== null) return {}
  const supplies = rootSuppliesOf(model, {
    labels: step.labels ?? [],
    ...(step.classMap !== undefined ? { classMap: step.classMap } : {}),
  })
  return supplies.length > 0 ? { suppliesSteps: supplies } : {}
}

/**
 * What a dispatch runs after its per-step loads (D657).
 *
 * An ALL-OR-NOTHING call (a benchmark, a replay — D56 — a capacity ramp) fails
 * on any failure, naming every step it lost ({@link DispatchStepsNotLoadedError}):
 * it measures or reproduces exactly what it names. A camera's LIVE dispatch
 * runs the tree without the steps whose model did not load, and fails — with
 * the first root's own named error — only when no root survives: a dispatch
 * with no root has nothing to produce.
 */
function stepsSurvivingLoad(
  steps: readonly PipelineDefaultStep[],
  failures: readonly DispatchStepLoadFailure[],
  policy: DispatchLoadPolicy,
): readonly PipelineDefaultStep[] {
  if (failures.length === 0) return steps
  if (policy === 'all-or-nothing') throw new DispatchStepsNotLoadedError(failures)
  const kept = withoutFailedSteps(steps, new Set(failures.map((f) => f.step)))
  if (kept.some((s) => s.enabled)) return kept
  const roots = new Set(steps)
  throw (failures.find((f) => roots.has(f.step)) ?? failures[0]!).error
}

/**
 * The union of model formats a step's catalog ships ANY build for — the
 * "Available: …" half of the capability-gate error. Unknown/custom addonIds
 * yield an empty list (no catalog to enumerate), never a throw.
 */
function availableFormatsForStep(addonId: string): readonly string[] {
  try {
    const def = getStepDefinition(addonId)
    const formats = new Set<string>()
    for (const model of def.models) {
      for (const format of Object.keys(model.formats)) formats.add(format)
    }
    return Array.from(formats).toSorted()
  } catch {
    return []
  }
}

// Per-backend device catalogs (COREML_DEVICES / OPENVINO_DEVICES /
// ONNX_PYTHON_DEVICES) were removed: the device list is now derived from the
// hardware-driven registry (`runtimeDevices(backend, hardware)` in runtimes.ts).
