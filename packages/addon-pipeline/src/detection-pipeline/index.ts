/**
 * addon-detection-pipeline — unified detection pipeline for CamStack.
 *
 * Single addon replaces 13 separate vision addon classes.
 * Each pipeline step is a class implementing IPipelineStep.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  ConfigUISchemaWithValues,
  ModelCatalogEntry,
  ProviderRegistration,
} from '@camstack/types'
import {
  BaseAddon,
  createEvent,
  detectionPipelineCapability,
  EventCategory,
  hydrateSchema,
  loadContributionCapability,
  pipelineExecutorCapability,
} from '@camstack/types'
import { pickNodePlatformArch } from '../shared/node-topology-platform.js'
import { pickBestRuntime } from './auto-pick.js'
import { startEventLoopStallMonitor } from '@camstack/system/addon-utils'
import {
  overridesEqual,
  type PoolProvisioningOverride,
  readOperatorOverride,
} from './engine/pool-provisioning.js'
import { normalizeEngineNodeId } from './engine-store-keys.js'
import { DetectionPipelineProvider } from './provider.js'
import { ensurePythonReady } from './python-readiness.js'
import { ALL_STEPS } from './registry/step-definitions.js'
import {
  type PoolBatchMode,
  type ProbedHardware,
  type RuntimeEnv,
  type RuntimeId,
  type RuntimePoolProfile,
  shouldInstallOpenvino,
  shouldInstallWebgpu,
  tuningFor,
} from './runtimes.js'

// ---------------------------------------------------------------------------
// Embedded Python — file resolution
// ---------------------------------------------------------------------------

/**
 * Locate the addon's bundled `python/` dir at runtime. Mirrors the
 * resolution done in `shared-inference-pool.ts:resolveScriptPath` —
 * tries the published package first (resolves through node_modules),
 * then a few `__dirname`-relative candidates for the in-tree dev build.
 *
 * Returns the directory containing `inference_pool.py` and the
 * `requirements*.txt` files installed via `ctx.deps.installPythonRequirements`.
 */
function resolveAddonPythonDir(): string {
  // Phase D bundle merge: detection-pipeline now lives inside
  // `@camstack/addon-pipeline/dist/detection-pipeline/`. Python files
  // ship at the bundle root (`addons/@camstack/addon-pipeline/python/`)
  // so the manifest's `python.requirements: "./python/requirements.txt"`
  // resolves cleanly. From this addon's compiled file at
  // `dist/detection-pipeline/index.{js,mjs}`, that's `../../python`.
  const candidates: string[] = []
  try {
    const pkgPath = require.resolve('@camstack/addon-pipeline/package.json')
    candidates.push(path.join(path.dirname(pkgPath), 'python'))
  } catch {
    // package not resolvable from here (in-tree build / before npm install)
  }
  candidates.push(
    path.join(__dirname, '../../python'), // dist/detection-pipeline/ → bundle/python/
    path.join(__dirname, '../python'),
    path.join(__dirname, '../../../python'),
  )
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'inference_pool.py'))) return c
  }
  throw new Error(
    `addon-pipeline/detection-pipeline: python/ dir not found. Searched:\n${candidates.join('\n')}`,
  )
}

export type { PoolModelConfig, PostprocessorType, StepDefinition } from '@camstack/types'
export { DetectionPipelineProvider } from './provider.js'
// Re-export for consumers
export {
  ALL_STEPS,
  getDefaultModelForFormat,
  getStepDefinition,
} from './registry/step-definitions.js'
export { shouldInstallOpenvino, shouldInstallWebgpu } from './runtimes.js'

// ---------------------------------------------------------------------------
// Platform-aware default engine selection
// ---------------------------------------------------------------------------

/**
 * Select the best inference engine for the current platform.
 * Order: CoreML (macOS ARM) > CUDA (NVIDIA) > OpenVINO (Intel) > CPU
 */

// ---------------------------------------------------------------------------
// Addon class
// ---------------------------------------------------------------------------

// Phase 2a of the pipeline-settings migration (see
// docs/pipeline-settings-migration.md) — start surfacing the addon's
// own tunables. `concurrency` is the first field on the schema:
// prepare + predict ThreadPoolExecutor pool size inside
// inference_pool.py.
//
// Orchestration-level settings that used to live here
// (maxConcurrentInferences / motionStreamProfile / motionFps / ...)
// remain owned elsewhere:
//   - motion/detection stream profiles, FPS, cooldown → pipeline-orchestrator
//   - maxConcurrentInferences / maxQueueDepth / targetLoad / minThrottledFps
//     → pipeline-runner
//
// Engine SELECTION is not an operator choice and has no persisted key: each
// node runs a device-array of inference pools and the node-default pool derives
// live from that node's hardware. `getGlobalSettings()` is overridden only to
// compute hardware-driven suggested defaults and the substitutions readout.

type BatchMode = PoolBatchMode

/**
 * Every "Inference executor" field below is `perNode: true` — its persisted key
 * is `<field>@<nodeId>` in the hub-central store, and `BaseAddon.resolveConfig`
 * resolves THIS node's key with no bare-key fallback. So "applies to every pool
 * on the node" means exactly that: the node whose form the operator saved, and
 * no other. `numStreams` / `intraOpThreads` have no UI field, so they stay
 * cluster-wide — they are inert at 0 (auto) and nothing writes them today.
 */
interface DetectionPipelineConfig {
  /**
   * Python inference-pool worker concurrency (threads inside ONE pool
   * subprocess, sharing one model context).
   * `0` = auto: each pool takes its OWN runtime's registry value
   * (`runtimes.ts` `RUNTIME_DETAIL[…].tuning`) — onnx 4, openvino 1, coreml 1,
   * edgetpu 1. A non-zero value is an operator override and applies to EVERY
   * pool on THIS node whatever runtime it runs.
   */
  readonly concurrency: number
  /**
   * Pool batch dispatch strategy. The suggested default is injected by
   * `getGlobalSettings(overlay)` from the node's DERIVED default runtime
   * (`pickBestRuntime`), not from any persisted engine selection.
   *   - 'none'   : one predict_fn per item (no batching)
   *   - 'list'   : MSG_INFER_BATCH dispatched as `model.predict([{},{}...])`
   *   - 'window' : per-model accumulator coalesces concurrent MSG_INFER_RAW
   *                calls within `windowMs`, flushes via single batched predict.
   */
  readonly batchMode: BatchMode | ''
  /** Window-mode accumulator flush window (ms). Only honored when batchMode='window'. 0 = auto. */
  readonly windowMs: number
  /** Max items per batched predict call. Only honored when batchMode!='none'. 0 = auto. */
  readonly maxBatchSize: number
  /** OpenVINO num_streams hint. 0 = auto. */
  readonly numStreams: number
  /** ONNX Runtime intra-op thread count. 0 = auto. */
  readonly intraOpThreads: number
  /**
   * Number of independent Python subprocess workers in the inference
   * pool. Each worker holds its own MLModel copy + predict context AND its own
   * `POOL_MAX_IN_FLIGHT` budget; inference dispatches round-robin across them,
   * so this is the only knob that lifts a pool saturating on ONE context.
   * 0 = auto: the pool's own runtime registry value, which is 1 on every
   * runtime today — they each manage their internal parallelism, and a second
   * Coral is a second POOL, not a second worker. Model load/unload propagate to
   * all workers, so RAM cost scales linearly with `numWorkers × modelSize`.
   */
  readonly numWorkers: number
  /**
   * Read-only UI surface: node-local model substitutions currently in
   * effect — a step's chosen model lacks a build for this node's engine
   * format, so a compatible default is running instead (format:
   * `"<addonId>: <chosen>→<running>"`, comma-joined). Empty when every
   * step's chosen model matches this node's format. Computed live in
   * `getGlobalSettings` from `provider.getActiveModelSubstitutions()`;
   * never persisted.
   */
  readonly activeModelSubstitutions: string
}

const DEFAULT_CONFIG: DetectionPipelineConfig = {
  concurrency: 0,
  batchMode: '',
  windowMs: 0,
  maxBatchSize: 0,
  numStreams: 0,
  intraOpThreads: 0,
  numWorkers: 0,
  activeModelSubstitutions: '',
}

/**
 * Cadence for the per-node engine-inventory snapshot. Engines change
 * slowly (manual spin/kill, idle eviction, attach/detach). 5 s strikes
 * a balance between dashboard freshness and bus traffic.
 */
const ENGINE_METRICS_SNAPSHOT_INTERVAL_MS = 5_000
/** Heartbeat fallback when the engine inventory hasn't changed. */
const ENGINE_METRICS_HEARTBEAT_MS = 60_000

/** Engine list dedup key — drops `idleMs` (monotonic counter on
 *  idle engines) so the defer matches as long as the inventory
 *  shape (engineKey / modelsLoaded / inUseByCameras / kind) is
 *  stable. The bus-emitted payload still includes idleMs verbatim. */
function stableEngineKey(engines: readonly unknown[]): string {
  const stripped = engines.map((e) => {
    if (!e || typeof e !== 'object') return e
    const obj = e as Record<string, unknown>
    const { idleMs: _idleMs, ...rest } = obj
    return rest
  })
  return JSON.stringify(stripped)
}

/**
 * Probe result for a TARGET node: the gpu/npu detail plus the probed node's
 * OWN `platform`/`arch` (carried by `PlatformCapabilities.hardware`). The hub
 * addon serves `getGlobalSettings` for every node, and the platform-compat
 * snap-back there is only correct against the TARGET node's platform — using
 * the serving hub's `process.platform` let an impossible backend (openvino on
 * a darwin agent) pass the check (CB3 guard gap #1). `platform`/`arch` are
 * optional: a canned test double or an older probe may omit them, in which
 * case the caller falls back to the local process values.
 */
export interface ProbedNodeHardware extends ProbedHardware {
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

/** Topology-sourced OS truth for a node (registration self-report). */
export interface TopologyPlatform {
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

/**
 * Narrow a topology-reported platform string to the runtime-relevant
 * `NodeJS.Platform` values the engine cascade branches on (darwin/linux/win32).
 * A type guard, not a cast; any other value → undefined so the caller floors to
 * `process.platform`. These three match `HardwarePlatformSchema` in the cap.
 */
function toNodePlatform(value: string | undefined): NodeJS.Platform | undefined {
  return value === 'darwin' || value === 'linux' || value === 'win32' ? value : undefined
}

/**
 * Slider keys on the "Inference executor" section that map 1:1 onto a
 * {@link RuntimePoolProfile} field. Used to inject the node-default runtime's
 * registry value as the field's suggested default in `getGlobalSettings`.
 */
const PROFILE_SLIDER_KEYS = [
  'concurrency',
  'numWorkers',
  'windowMs',
  'maxBatchSize',
  'numStreams',
  'intraOpThreads',
] as const

type ProfileSliderKey = (typeof PROFILE_SLIDER_KEYS)[number]

function isProfileSliderKey(key: string): key is ProfileSliderKey {
  return PROFILE_SLIDER_KEYS.some((k) => k === key)
}

export default class DetectionPipelineAddon extends BaseAddon<DetectionPipelineConfig> {
  private provider: DetectionPipelineProvider | null = null

  /** Last non-null probed hardware PER NODE — reused when the probe transiently
   *  returns null so offered backends / device lists don't collapse. Keyed by
   *  node because the hub addon probes other nodes when serving their config.
   *  Carries the probed node's platform/arch too, so a transient null probe
   *  doesn't flip a remote node's env back to the serving hub's platform. */
  private readonly lastGoodHardwareByNode = new Map<string, ProbedNodeHardware>()
  private engineMetricsTimer: ReturnType<typeof setInterval> | null = null
  /** Stops the event-loop stall monitor on shutdown. */
  private stopStallMonitor: (() => void) | null = null
  /** Snapshot-equality cache for engine-metrics emit. Most ticks
   *  the engine inventory is unchanged (no model load/unload), so
   *  we skip the bus emit and let the heartbeat re-emit at
   *  ENGINE_METRICS_HEARTBEAT_MS for liveness. */
  private lastEmittedEngineSnapshot: { json: string; emittedAt: number } | null = null
  /**
   * Last-applied OPERATOR OVERRIDE, taken at the end of `onInitialize` and
   * refreshed at the end of `onConfigChanged`. Lets the change handler diff the
   * current config against the snapshot and decide whether a pool respawn is
   * necessary — most config edits (engine cascade, audio settings) don't touch
   * the tuning fields and don't deserve a multi-second model reload.
   *
   * The per-runtime registry values are compile-time constants resolved inside
   * each pool, so they can never be the reason for a respawn; only an operator
   * edit can.
   */
  private lastAppliedOverride: PoolProvisioningOverride = {}
  /**
   * Embedded Python path resolved once at boot via
   * `ctx.deps.ensurePython()`. Empty string means the download failed
   * — the provider's
   * `ensureBackendDeps` and EngineFactory's `initPythonPool` raise a
   * clear error in that case.
   */
  private pythonPath: string = ''
  /**
   * Absolute path to the addon's bundled `python/` dir (resolved once
   * at boot), passed through to the provider so per-backend
   * `requirements-<runtime>.txt` files can be located at lazy-install
   * time.
   */
  private pythonAddonDir: string = ''

  constructor() {
    super(DEFAULT_CONFIG)
  }

  protected globalSettingsSchema() {
    // Base (static) schema — the dynamic cascade options are injected
    // by the `getGlobalSettings()` override below based on the current
    // runtime + backend values. Keeping a static base lets the
    // addon-registry introspection machinery (which calls this method
    // without a live store) still see every field.
    return this.schema({
      sections: [
        {
          id: 'engine',
          title: 'Object detection',
          tab: 'engine',
          // Render order within the "Inference Engine" tab. Lower goes
          // first; detection sits at 0 (operator-priority section —
          // vision is the dominant load on the node), audio-analyzer's
          // `audio-engine` follows at 10.
          order: 0,
          // Co-located on the "Inference Engine" tab with `audio-analyzer`'s
          // `audio-engine` section. This one drives vision inference
          // (object detection + downstream face/plate steps that share the
          // same runtime); the audio-analyzer one drives audio
          // classification. The title is intentionally "Object detection"
          // (not "Vision" or "Detection engine") because every section
          // shown on this tab is an inference engine — the modality is
          // what disambiguates them.
          description:
            'Vision-detection execution provider (object detection, face detection, plate OCR). ' +
            'Inference always runs via the embedded Python runtime. Provider and hardware ' +
            'options are gated by what the platform probe reports as available on this host. ' +
            'Changes restart the addon.',
          // Engine SELECTION is no longer operator-facing: each node runs a
          // device-array of inference pools balanced per-session, and the
          // node-default pool is derived live from the node's own hardware.
          // The only field left here is the read-only model-substitution
          // status readout. Per-device enable/weight/cap/pin config lives on
          // the Pipeline→Weights placement board.
          fields: [
            this.field({
              type: 'text',
              key: 'activeModelSubstitutions',
              label: 'Model substitutions',
              description:
                "Node-local model substitutions currently in effect: a step's chosen model has " +
                "no build for this node's engine format, so a compatible default is running " +
                'instead (format: "step: chosen→running"). Hidden when every step matches.',
              readonlyField: true,
              default: '',
              showWhen: { field: 'activeModelSubstitutions', notEquals: '' },
            }),
          ],
        },
        // Every field in this section is `perNode: true`. The provisioning it
        // overrides is a property of the HOST — a Mac mini's CoreML pools and
        // the hub's OpenVINO pools have nothing in common — and the store this
        // addon writes is hub-central and shared by every node (the
        // `settings-store` cap is a hub singleton). Before the marker, one
        // operator save wrote a BARE key that every node then resolved, so
        // raising the Mac's subprocess count also doubled the hub's model RAM.
        // The module doc of `types/addon/per-node-store.ts` has the mechanics;
        // absent `<key>@<nodeId>` ⇒ the field default (auto), never another
        // node's value.
        {
          id: 'inference-executor',
          title: 'Inference executor',
          tab: 'scheduler',
          fields: [
            this.field({
              type: 'select',
              key: 'batchMode',
              label: 'Batch dispatch mode',
              description:
                'How the Python pool GROUPS predict requests — it never changes a ' +
                "model's compiled batch SHAPE, which is derived from (engine, device) " +
                'at load and is not configurable. ' +
                '`none` = one call per frame. ' +
                '`window` = per-model accumulator coalesces concurrent calls within Window (ms). ' +
                'Auto uses the matrix-sweep default for the current backend. ' +
                'Applies to THIS node only.',
              options: [
                { value: '', label: 'Auto (backend default)' },
                { value: 'none', label: 'None (one call per frame)' },
                { value: 'list', label: 'List (per-batch model.predict([list]))' },
                { value: 'window', label: 'Window (cross-camera accumulator)' },
              ],
              default: '',
              perNode: true,
              // Always shown: the node runs a device-array of backends
              // concurrently, so this can no longer key off a single scalar
              // `engineBackend` (A1). Batch dispatch applies per pool regardless.
            }),
            this.field({
              type: 'slider',
              key: 'windowMs',
              label: 'Window flush (ms)',
              description:
                'Window-mode accumulator: max time to wait for additional concurrent predicts before flushing. ' +
                'Lower = lower latency, higher = better throughput. Auto = backend default. ' +
                'Applies to THIS node only.',
              min: 0,
              max: 50,
              step: 1,
              default: undefined,
              showValue: true,
              nullable: true,
              nullLabel: 'Auto',
              perNode: true,
              showWhen: { field: 'batchMode', notEquals: 'none' },
            }),
            this.field({
              type: 'slider',
              key: 'maxBatchSize',
              label: 'Max batch size',
              description:
                'Cap on how many requests are GROUPED into one batched predict call. ' +
                "Not the model's compiled batch shape — that is derived from " +
                '(engine, device) at load and is not configurable; a stacked ' +
                'tensor is only ever built for an export that declares a flexible ' +
                'batch axis itself. Auto = backend default. Applies to THIS node only.',
              min: 1,
              max: 16,
              step: 1,
              default: undefined,
              showValue: true,
              nullable: true,
              nullLabel: 'Auto',
              perNode: true,
              showWhen: { field: 'batchMode', notEquals: 'none' },
            }),
            this.field({
              type: 'slider',
              key: 'concurrency',
              label: 'Pool threads',
              description:
                'Python inference-pool prepare + predict THREADS inside one pool ' +
                'subprocess — they share one model context. ' +
                'Auto = backend default (CoreML: 1, OpenVINO: 1, ONNX: 4). ' +
                'Raising this does not help CoreML (it serialises per model ' +
                'context) — use Pool subprocesses instead. Applies to THIS node only.',
              min: 1,
              max: 8,
              step: 1,
              default: undefined,
              showValue: true,
              nullable: true,
              nullLabel: 'Auto',
              perNode: true,
            }),
            this.field({
              type: 'slider',
              key: 'numWorkers',
              label: 'Pool subprocesses',
              description:
                'Number of independent Python pool subprocesses. Each ' +
                'holds its own MLModel copy + ANE/GPU/CPU dispatch context, and ' +
                'its OWN in-flight cap — inference round-robins across them, so ' +
                'this is the knob that lifts a saturated single-context pool. ' +
                'RAM cost scales linearly with subprocesses × model size. ' +
                'Auto = 1 on every runtime. Applies to THIS node only.',
              min: 1,
              max: 8,
              step: 1,
              default: undefined,
              showValue: true,
              nullable: true,
              nullLabel: 'Auto',
              perNode: true,
            }),
          ],
        },
      ],
    })
  }

  /**
   * Override to inject the read-only model-substitution status + the
   * per-backend tuning-slider defaults.
   *
   * Engine SELECTION is no longer operator-facing (the elected single-engine
   * cascade was removed): each node runs a device-array of inference pools
   * balanced per-session, and the node-default pool is derived live from the
   * node's own hardware. So this override no longer offers a backend/device
   * dropdown or a probed/active-engine readout — it only:
   *   1. resolves the node's derived-default backend (via the probe) to suggest
   *      the matrix-tuned slider defaults that won the bench for that backend, and
   *   2. surfaces the live `activeModelSubstitutions` readout.
   */
  override async getGlobalSettings(
    overlay?: Record<string, unknown>,
    _cap?: string,
    nodeId?: string,
  ): Promise<ConfigUISchemaWithValues | null> {
    // The hub addon answers for every node, so resolve the REQUESTED node's
    // hardware (not this instance's). Falls back to self for a node-agnostic
    // caller.
    const targetNode = nodeId ? normalizeEngineNodeId(nodeId) : this.localNodeId()
    // ctx-not-wired guard: during the ~1s restart window the settings store
    // isn't readable yet. Return null so callers keep the last-known view rather
    // than serving fabricated empty-store defaults. (There is no longer a
    // persisted per-node engine selection to protect — an empty store is a
    // harmless genuine first boot; only the truly-unreadable case returns null.)
    const rawStored = await this.resolveUiSettingsStore(targetNode)
    if (rawStored === null) return null
    const merged = overlay ? { ...rawStored, ...overlay } : rawStored

    // The node's derived-default backend drives ONLY the suggested tuning
    // defaults (the matrix-tuned per-backend slider values) — never an operator
    // engine election. Probe the TARGET node's hardware and derive its default
    // runtime the same way the provider does at boot.
    const env = await this.probeHardwareEnv(targetNode)
    const backend: RuntimeId = pickBestRuntime(env, null).runtimeId

    // Live node-local model-substitution readout (a step's chosen model has no
    // build for this node's format → a compatible default is running instead).
    const substitutions = this.provider?.getActiveModelSubstitutions() ?? []
    const activeModelSubstitutions =
      substitutions.length === 0
        ? ''
        : substitutions.map((s) => `${s.addonId}: ${s.chosen}→${s.running}`).join(', ')

    const raw = { ...merged, activeModelSubstitutions }

    const schema = this.globalSettingsSchema()
    if (!schema) return { sections: [] }

    // Suggested field defaults = the registry row of the node's DEFAULT runtime.
    // They are a UI hint only, and only for that one pool: a node runs a pool
    // per accelerator and each resolves its own runtime's row at build time
    // (`engine/pool-provisioning.ts`). A value the operator actually sets here
    // is an override and applies to every pool on the node.
    // Persisted values still take precedence (hydrateSchema lays raw over defaults).
    const tuning: RuntimePoolProfile = tuningFor(backend)

    const patched = {
      ...schema,
      sections: schema.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => {
          if (field.type === 'select') {
            if (field.key === 'batchMode') {
              return { ...field, default: tuning.batchMode }
            }
          }
          if (field.type === 'slider' && 'key' in field) {
            // Per-backend slider max overrides — CoreML serializes per-context
            // so >4 prepare workers add overhead without throughput. OpenVINO/
            // ONNX inherit the schema default (32) which is already reasonable.
            const sliderField = field
            let patchedField = isProfileSliderKey(sliderField.key)
              ? { ...sliderField, default: tuning[sliderField.key] }
              : sliderField
            if (sliderField.key === 'concurrency' && backend === 'coreml') {
              patchedField = { ...patchedField, max: 4 }
            }
            return patchedField
          }
          return field
        }),
      })),
    }
    return hydrateSchema(patched, raw)
  }

  /**
   * Resolve the runtime env (platform + arch + probed hardware) used to derive
   * the OFFERED backend list. The hardware comes from the platform-probe cap
   * (`getCapabilities`); when the cap isn't reachable yet (cold-start / probe
   * addon not installed) `hardware` is null, which the registry collapses to
   * the safe minimum (onnx floor; default-only devices).
   *
   * Protected seam — overridable by tests (canned hardware) and reused by the
   * Phase 2 auto-pick path. NEVER reads install state.
   */
  /**
   * Resolve the persisted UI settings store, or `null` when it can't be read
   * right now (ctx/settings not wired — mid-restart). A readable-but-empty
   * store (genuine first boot) returns `{}`, never null. `getGlobalSettings`
   * uses the null signal to avoid serving fabricated empty-store defaults
   * during the restart window. Seam kept protected so tests can drive the
   * unreadable vs empty vs populated cases without faking a full AddonContext.
   *
   * The store is PROJECTED onto `nodeId` (the node the UI is asking about, not
   * necessarily this instance — the hub addon answers for every node): every
   * `perNode: true` field of the Inference-executor section hydrates from that
   * node's `<key>@<nodeId>` value, and `<key>@<other-node>` never leaks onto the
   * bare field. `resolveGlobalStore` is the base's sanctioned seam for exactly
   * this — reading `ctx.settings.readAddonStore()` raw here would show the hub's
   * numbers on every node's form.
   */
  protected async resolveUiSettingsStore(nodeId?: string): Promise<Record<string, unknown> | null> {
    if (!this.ctxIfReady?.settings) return null
    return this.resolveGlobalStore(nodeId)
  }

  protected async probeHardwareEnv(nodeId?: string): Promise<RuntimeEnv> {
    const node = nodeId ?? this.localNodeId()
    const hardware = await this.resolveProbeHardware(node)
    // Reuse the last good probe result when the probe transiently returns null
    // (platform-probe cap briefly unreachable). Without this the offered
    // backends + device lists collapse to the onnx/cpu floor mid-session even
    // though the hardware hasn't changed. Hardware is effectively static for a
    // running node, so a stale-but-correct cache is strictly safer than a
    // transient null. Cached per node (the hub serves every node's options).
    if (hardware) this.lastGoodHardwareByNode.set(node, hardware)
    const effective = hardware ?? this.lastGoodHardwareByNode.get(node) ?? null
    // platform/arch must describe the TARGET node, not the serving instance:
    // the hub addon answers `getGlobalSettings` for every node, and the
    // snap-back there rejects platform-impossible backends (openvino on
    // darwin) — a check that is only correct against the PROBED node's
    // platform (F3/CB3).
    //
    // Three-tier source, topology-FIRST (closes CB3): for a remote target the
    // platform/arch come from cluster topology (`nodes.topology`, the
    // registration self-report — hub-local, ALWAYS available even before the
    // async accelerator probe completes), then the accelerator probe's own
    // report, then this process's values. Sourcing platform from topology (not
    // the async probe) means a never-yet-probed remote node no longer inherits
    // the serving hub's OS, so a platform-valid selection (e.g. openvino on a
    // Linux agent) survives the snap-back even while its GPU probe is pending.
    // For self, `process.platform` is authoritative (identical by definition).
    const isRemote = node !== this.localNodeId()
    const topo = isRemote ? await this.resolveTopologyPlatform(node) : null
    const platform =
      (isRemote ? (topo?.platform ?? effective?.platform) : undefined) ?? process.platform
    const arch = (isRemote ? (topo?.arch ?? effective?.arch) : undefined) ?? process.arch
    return { platform, arch, hardware: effective }
  }

  /**
   * Read the TARGET node's platform/arch from cluster topology — the
   * registration self-report (`nodes.topology`), which is hub-local and
   * available immediately, independent of the node's async accelerator probe.
   * Mirrors the audio analyzer's `resolveNodePlatform` (the D6 reference
   * pattern) so detection + audio share ONE topology-read path. Returns null
   * when topology is unreachable (caller falls back to the probe report, then
   * `process.platform`). Narrows the reported platform to the runtime-relevant
   * `NodeJS.Platform` values via a type guard (no cast); any other value is
   * dropped so the caller floors safely.
   */
  protected async resolveTopologyPlatform(nodeId: string): Promise<TopologyPlatform | null> {
    try {
      const topo = await this.ctxIfReady?.api?.nodes?.topology.query()
      const picked = pickNodePlatformArch(topo, nodeId)
      return { platform: toNodePlatform(picked.platform), arch: picked.arch }
    } catch {
      return null
    }
  }

  /**
   * Fetch the probed hardware from the platform-probe cap for `nodeId` (default
   * = self). Returns null when the cap is not reachable (caller falls back to
   * the registry's safe minimum). Carries the probed node's `platform`/`arch`
   * (from `PlatformCapabilities.hardware`) so `probeHardwareEnv` can build the
   * env for the TARGET node rather than the serving one.
   */
  protected async resolveProbeHardware(nodeId?: string): Promise<ProbedNodeHardware | null> {
    try {
      const api = this.ctxIfReady?.api
      if (!api) return null
      // Probe the REQUESTED node. `platform-probe` is a `singleton` cap that
      // resolves to the HUB by default — wrong hardware for a remote agent. The
      // hub addon serves EVERY node's settings, so to offer correct per-node
      // engine options it must probe THAT node's hardware. Pass the target as the
      // cap INPUT (`nodeId`): the generated router's `resolveProvider` forwards to
      // that node's platform-probe provider (local for hub, Moleculer proxy for a
      // remote agent). A `nodePin` context is ignored by the singleton mount, so
      // it returned the HUB's hardware for every remote node.
      const node = nodeId ?? this.localNodeId()
      const caps =
        node === this.localNodeId()
          ? await api.platformProbe.getCapabilities.query()
          : await api.platformProbe.getCapabilities.query({ nodeId: node })
      const hw = caps?.hardware
      if (!hw) return null
      return {
        npu: hw.npu ? { type: hw.npu.type } : null,
        gpu: hw.gpu ? { type: hw.gpu.type } : null,
        coral: hw.coral ?? null,
        // The probed node's OWN platform/arch — NOT this process's. Used by
        // `probeHardwareEnv` when the target is a remote node (F3/CB3).
        platform: hw.platform,
        arch: hw.arch,
      }
    } catch {
      return null
    }
  }

  /**
   * Bare node id for this instance. MUST match the provider's
   * `localProbeNodeId()` (kernel.localNodeId, default 'hub') so the per-node
   * settings projection here and the provider's own node targeting agree. The
   * old `?? this.ctx.id` fallback resolved to the ADDON id
   * ('detection-pipeline') when kernel.localNodeId was absent, so UI saves
   * landed on a key the provider never read.
   */
  private localNodeId(): string {
    return normalizeEngineNodeId(this.ctxIfReady?.kernel?.localNodeId ?? 'hub')
  }

  /**
   * The operator's explicit deviations from the per-runtime registry — and
   * NOTHING else.
   *
   * This used to be `resolveBackendTuning()`: it read `tuningFor(<the node's
   * default backend>)` and handed the whole resolved row to the provider, which
   * passed it verbatim to every pool it built. That is how an `openvino:npu`
   * pool on an onnx-default node came up with onnx's `concurrency: 4`. The
   * per-runtime values now resolve inside each pool
   * (`engine/pool-provisioning.ts`), keyed by that pool's own runtime, so
   * nothing backend-shaped may be computed here.
   *
   * Precedence, in full: an operator override below wins over the pool's
   * runtime registry row; an "Auto" field (slider `0`, select `''`) is not an
   * override. An override is node-wide by design — the operator set it against
   * a node, not against a runtime.
   */
  private resolveOperatorOverride(): PoolProvisioningOverride {
    return readOperatorOverride(this.config)
  }

  // resolveModelsDir is inherited from BaseAddon — the single centralized
  // node-local resolver (`<nodeDataDir>/models`). No per-addon override.

  /**
   * Construct a fresh provider carrying the operator override. Single source of
   * truth for the provider wiring — shared by `onInitialize` and the
   * `onConfigChanged` pool respawn. NOTHING backend-derived is passed: each
   * pool resolves its own runtime's registry row.
   */
  private buildProvider(
    modelsDir: string,
    override: PoolProvisioningOverride,
  ): DetectionPipelineProvider {
    if (!this.ctx.settings) {
      throw new Error('DetectionPipelineAddon: ctx.settings not available')
    }
    return new DetectionPipelineProvider(
      this.ctx.settings,
      modelsDir,
      this.ctx.logger,
      this.ctx.eventBus ?? null,
      () => ({ sections: [] }),
      {
        provisioning: override,
        pythonPath: this.pythonPath,
        pythonAddonDir: this.pythonAddonDir,
      },
    )
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const modelsDir = await this.resolveModelsDir()

    if (!this.ctx.settings) {
      throw new Error('DetectionPipelineAddon: ctx.settings not available')
    }

    // The 2026-08-01/02 fleet stall freezes THIS process for 22-88s at a time —
    // proven by the 10s stats timer skipping, not by anything in the inference
    // path. GC and a synchronous block are indistinguishable from outside, so
    // the process has to say which it was.
    this.stopStallMonitor = startEventLoopStallMonitor(this.ctx.logger)

    // Embedded Python — base pip requirements (numpy + Pillow) are
    // installed by the kernel BEFORE `onInitialize` runs, driven by the
    // `python.requirements` field in this addon's package.json manifest
    // (see `kernel/src/deps/manifest-python-deps.ts`). Here we only
    // resolve the bin path + addon python/ dir for downstream wiring.
    // Backend-specific deps (coremltools / onnxruntime / openvino) are
    // installed lazily by the provider before the matching
    // `EngineFactory` is constructed (see `provider.ts:ensureBackendDeps`).
    this.pythonAddonDir = resolveAddonPythonDir()
    const py = await ensurePythonReady(this.ctx.deps, this.ctx.logger)
    if (py.ok && py.pythonPath) {
      this.pythonPath = py.pythonPath
    } else {
      this.ctx.logger.warn(
        'Detection engine boot continues without Python — selection will provision on demand',
        {},
      )
    }

    // Proactive OpenVINO install: when Intel iGPU or NPU is detected, install
    // the openvino Python package now so it is actually RUNNABLE by the time the
    // engine is selected. Backend support is hardware-driven (platform-probe
    // scores openvino on Intel regardless of install state); this install is what
    // makes `loadEngine`'s runtime gate (`isPythonBackendAvailable`) pass instead
    // of falling back to the onnx floor on first use.
    //
    // This runs unconditionally against the requirements file regardless of
    // whether the operator has selected openvino as their engine — it does NOT
    // change the current engine selection. `installPythonRequirements` is
    // idempotent (short-circuits on a hash marker), so subsequent restarts are
    // a no-op after the first install. An install failure only logs a warning
    // and does NOT abort addon init — the onnx-cpu baseline is always available.
    //
    // Hardware is queried via the platform-probe cap (same path the addon uses
    // in `resolveAvailableBackends`). If the cap isn't wired yet, the hardware
    // query throws and is caught — the proactive install is simply skipped.
    await this.proactivelyInstallOpenvino()

    // The provider is built ONCE. The old code built it twice — the pool tuning
    // used to be resolved from the node's default backend, which is only known
    // after `setApi`, so a second provider had to be constructed and re-wired
    // to correct it. Pool tuning is now resolved per pool from that pool's own
    // runtime, so nothing here depends on the engine pick and there is nothing
    // to reconcile.
    this.provider = this.buildProvider(modelsDir, this.resolveOperatorOverride())
    await this.provider.init()
    await this.provider.setApi(this.ctx)

    // NOTE: the boot safety-net (`ensureBootEngineProvisioned`) and the
    // `platform-probe.phase 'done'` re-pick subscription were DELETED:
    // `setApi` above now gates the first pick on the readiness registry
    // (`awaitReady('platform-probe', {type:'node', nodeId})`), and
    // platform-probe only flips `ready` once its FULL async probe is done —
    // so the pick already sees the real accelerators and no post-hoc
    // convergence path is needed.
    // Pre-warm the Python inference pool before returning. `BaseAddon`
    // auto-emits `system.ready-state → ready` right after `onInitialize`
    // resolves, so consumers that `awaitReady('pipeline-executor', …)`
    // get a truly-callable signal and never hit
    // `SharedInferencePool: not initialized` on the first frame.
    await this.provider.warmPool()

    // Periodic engine-inventory snapshot. UI Engines tab subscribes to
    // `pipeline.engine-metrics-snapshot` instead of polling
    // `pipelineExecutor.listLoadedEngines`.
    this.engineMetricsTimer = setInterval(
      () => this.emitEngineMetricsSnapshot(),
      ENGINE_METRICS_SNAPSHOT_INTERVAL_MS,
    )

    this.lastAppliedOverride = this.resolveOperatorOverride()

    // Split registration: the system cap holds the compute path
    // (engines / templates / models / runPipeline); the device-scoped
    // detection-pipeline cap is the bindable row every camera sees in
    // the device-manager bindings UI. The same provider instance serves
    // both — detection-pipeline's exposesDeviceSettings:true contract
    // (3 contribution methods) is already implemented on the provider.
    return [
      { capability: pipelineExecutorCapability, provider: this.provider },
      {
        capability: detectionPipelineCapability,
        provider: this.provider,
      },
      // The shared inference pool declares that it CANNOT be attributed to a
      // camera. Reported as data rather than left for an observer to infer —
      // "this process is shared" and "nobody knows what this process is" are
      // different findings and must not look alike.
      {
        capability: loadContributionCapability,
        // `this.provider` is non-null on every path that reaches this return
        // (it is built above), but the field is nullable for the pre-boot
        // window. An empty list is the honest answer for a pool that does not
        // exist yet — not an error, and not a zero-cost claim.
        provider: { list: async () => (await this.provider?.loadContributions()) ?? [] },
      },
    ]
  }

  /**
   * Emit a single `pipeline.engine-metrics-snapshot` event with the
   * current engine inventory for this node. Source of truth is the
   * provider's `listLoadedEngines` method (same data the cap returns).
   */
  private emitEngineMetricsSnapshot(): void {
    const provider = this.provider
    const eventBus = this.ctx.eventBus
    if (!provider || !eventBus) return
    void Promise.resolve(provider.listLoadedEngines())
      .then((engines) => {
        const rawNodeId = this.ctx.kernel.localNodeId ?? this.ctx.id
        const nodeId = rawNodeId.includes('/') ? rawNodeId.split('/')[0]! : rawNodeId
        const timestamp = Date.now()
        // Snapshot-equality skip — engine inventory rarely changes
        // (model load/unload). Same pattern as pipeline-runner's
        // emitMetricsSnapshot.
        //
        // `idleMs` ticks up every poll on idle engines — strip it
        // from the dedup key so the defer actually fires. Full
        // payload still carries the live value when an emit happens.
        const json = stableEngineKey(engines)
        const prev = this.lastEmittedEngineSnapshot
        const heartbeatDue = !prev || timestamp - prev.emittedAt >= ENGINE_METRICS_HEARTBEAT_MS
        if (prev && prev.json === json && !heartbeatDue) return
        this.lastEmittedEngineSnapshot = { json, emittedAt: timestamp }
        eventBus.emit(
          createEvent(
            EventCategory.PipelineEngineMetricsSnapshot,
            { type: 'node', id: nodeId, nodeId },
            { nodeId, engines, timestamp },
          ),
        )
      })
      .catch(() => {
        // Soft-fail: dashboards tolerate a missing tick.
      })
  }

  getModelCatalog(): ModelCatalogEntry[] {
    // Exclude LEGACY (superseded / consolidated) models — this is the
    // "offerable catalog", mirroring `buildSchemaSlots`' `legacy !== true`
    // filter. Legacy entries stay resolvable when explicitly pinned but are
    // never surfaced as fresh choices.
    return ALL_STEPS.flatMap((s) => s.models.filter((m) => m.legacy !== true))
  }

  /**
   * Proactively install the OpenVINO Python package when Intel hardware
   * (iGPU or NPU) is detected. Called once from `onInitialize`, before the
   * provider is constructed, so the module is RUNNABLE when the engine is
   * first loaded (gated by `loadEngine`'s `isPythonBackendAvailable` check).
   *
   * Failure is non-fatal: a warning is logged and the addon continues with
   * the onnx-cpu baseline. The hardware resolve itself is also best-effort —
   * if the kernel resolver isn't wired yet the error is caught here.
   */
  private async proactivelyInstallOpenvino(): Promise<void> {
    if (!this.pythonAddonDir || !this.pythonPath) return
    try {
      // THIS node's own accelerators, from the local kernel resolver (mirror of
      // ctx.kernel.hwaccel) — not the platform-probe singleton, so a forked agent
      // child decides its install from its OWN hardware, never the hub's.
      const hw = await this.ctx.kernel?.inferenceEngine?.resolveHardware()
      const hardware = {
        platform: process.platform,
        gpu: hw?.gpu ?? null,
        npu: hw?.npu ?? null,
      }
      if (shouldInstallOpenvino(hardware)) {
        this.ctx.logger.info(
          'OpenVINO-capable hardware detected — proactively installing OpenVINO Python package',
          {
            meta: {
              gpu: hardware.gpu?.type ?? null,
              npu: hardware.npu?.type ?? null,
            },
          },
        )
        const requirementsFile = path.join(this.pythonAddonDir, 'requirements-openvino.txt')
        await this.ctx.deps.installPythonRequirements(requirementsFile)
        this.ctx.logger.info('Proactive OpenVINO install complete')
      }
      if (shouldInstallWebgpu(hardware)) {
        this.ctx.logger.info('AMD iGPU detected — proactively installing ONNX WebGPU plugin', {
          meta: { gpu: hardware.gpu?.type ?? null },
        })
        const webgpuReq = path.join(this.pythonAddonDir, 'requirements-webgpu.txt')
        await this.ctx.deps.installPythonRequirements(webgpuReq)
        this.ctx.logger.info('Proactive WebGPU install complete')
      }
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'Proactive accelerator Python install failed — falling back to onnx-cpu baseline',
        { meta: { error: err instanceof Error ? err.message : String(err) } },
      )
    }
  }

  protected async onShutdown(): Promise<void> {
    if (this.stopStallMonitor) {
      this.stopStallMonitor()
      this.stopStallMonitor = null
    }
    if (this.engineMetricsTimer) {
      clearInterval(this.engineMetricsTimer)
      this.engineMetricsTimer = null
    }
    if (this.provider) {
      await this.provider.shutdown()
      this.provider = null
    }
  }

  /**
   * BaseAddon calls `onConfigChanged` after every settings write. This is the
   * SOLE apply path for tuning changes — none of those fields declare
   * `requiresRestart` anymore (an addon restart re-probes hardware + reloads
   * every model on every set, which is exactly what we want to avoid): a changed
   * OPERATOR OVERRIDE drives an in-place pool respawn. The per-runtime registry
   * values cannot change at runtime, so they can never trigger one. The engine
   * SELECTION is no longer operator-facing — the node-default backend is derived
   * once at boot (`setApi` → `resolveAutoEngine`) from static hardware, so there
   * is no per-write engine re-select. The respawn applies optimistically — the
   * inference gate stays closed for the short re-spin, frames are dropped (never
   * crashed), no addon bounce.
   */
  protected async onConfigChanged(): Promise<void> {
    const next = this.resolveOperatorOverride()
    if (overridesEqual(next, this.lastAppliedOverride)) return
    if (!this.provider) {
      this.lastAppliedOverride = next
      return
    }
    this.ctx.logger.info('detection-pipeline tuning override changed — respawning pool', {
      meta: { prev: this.lastAppliedOverride, next },
    })
    try {
      await this.provider.shutdown()
    } catch (err) {
      this.ctx.logger.warn('provider shutdown failed during tuning respawn', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    // Rebuild provider with the fresh override. Mirrors the construction path
    // in `onInitialize` so the new pool comes up with the same dependency
    // wiring.
    const modelsDir = await this.resolveModelsDir()
    this.provider = this.buildProvider(modelsDir, next)
    await this.provider.init()
    await this.provider.setApi(this.ctx)
    await this.provider.warmPool()
    this.lastAppliedOverride = next
    this.ctx.logger.info('detection-pipeline pool respawn complete')
  }
}
