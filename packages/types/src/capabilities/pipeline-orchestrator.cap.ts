import { z } from 'zod'
import { CameraSwitchGroupSchema, CameraSwitchIdSchema } from '../interfaces/camera-switches.js'
import { RecordingStorageModeSchema } from '../interfaces/recording-config.js'
import { StorageMigrationLeaseInputSchema } from '../interfaces/relocate.js'
import {
  AutoTuneApplyInputSchema,
  AutoTuneApplyResultSchema,
  AutoTuneOptionsSchema,
  AutoTunePlanSchema,
} from '../pipeline/auto-tune/plan-schemas.js'
import {
  EffectiveSharesSchema,
  LoadBalancingSharesInputSchema,
  PlacementStatsInputSchema,
  SetShareSourceInputSchema,
  PlacementStatsSchema,
  SuggestSharesInputSchema,
  SuggestSharesResultSchema,
} from '../pipeline/load-balancing/schemas.js'
import { CameraSensorsConfigSchema, CameraSensorsStatusSchema } from '../pipeline/camera-sensors.js'
import {
  ListNodeBenchmarkResultsInputSchema,
  NodeBenchmarkCandidatesSchema,
  NodeBenchmarkPlanSchema,
  NodeBenchmarkPreflightSchema,
  NodeBenchmarkResultViewSchema,
  NodeBenchmarkStatusSchema,
} from '../pipeline/node-benchmark/schemas.js'
import { CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS } from '../pipeline/cluster-model-scope.js'
import { NodeColorIdSchema } from '../node-color.js'
import { MODEL_FORMATS } from '../types/models.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { PipelineEngineChoiceSchema, PipelineStepInputSchema } from './pipeline-executor.cap.js'
import { RunnerLocalLoadSchema } from './pipeline-runner.cap.js'
import { CameraMetricsSchema } from './schemas/orchestrator-metrics.js'

// ── Per-camera pipeline config ─────────────────────────────────────
//
// Stateless-pipeline model (spec: 2026-04-18-stateless-pipeline-per-camera):
// the orchestrator owns per-camera pipelines. Runners never persist; they
// receive content via attachCamera. (There is no template library: D759.)

const CameraPipelineConfigSchema = z.object({
  engine: PipelineEngineChoiceSchema.optional(),
  steps: z.array(PipelineStepInputSchema).readonly(),
  audio: z
    .object({
      engine: PipelineEngineChoiceSchema.optional(),
      // Absent when the operator hasn't explicitly chosen an audio model —
      // the executing node resolves its own format default at runtime
      // (model selection is data-only: an absent modelId = the node's format default).
      modelId: z.string().optional(),
      enabled: z.boolean(),
      settings: z.record(z.string(), z.unknown()).readonly().optional(),
    })
    .nullable()
    .optional(),
})

// ── Per-(node,device) pipeline settings schemas ───────────────────────
// Per-(node,device) BASE provisioning for one step: the model + intrinsic
// settings the executing node applies for EVERY camera landing on that
// accelerator. Both fields optional (absent = the executor resolves its own
// format default at runtime). This is the model/format authority — it lives
// per-device because one node can host Coral (tflite) + NPU (openvino) + ANE
// (coreml) simultaneously, which share no format.
const DeviceStepConfigSchema = z.object({
  modelId: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  /**
   * Step-tree device jump (same-node, phase 1) — OPTIONAL manual override.
   * When set, this step runs on the named enabled device of the SAME node
   * (`<backend>:<device>`) instead of the camera's elected device, bypassing
   * the runtime AUTO-jump. The orchestrator rejects a `jumpDeviceKey` pointing
   * at a disabled/absent device on that node at save time. Absent ⇒ the runner
   * auto-jumps only when the effective device's format cannot run the step.
   */
  jumpDeviceKey: z.string().optional(),
})

// Agent settings: the per-node placement record. The model layer is NO
// longer per-node — it moved to `inferenceDevices[deviceKey].steps`
// (per-(node,device) base). `userChoice`, `hwaccel`, `audio`, and the
// authoritative engine triple all live in per-addon global settings
// (detection-pipeline / decoder-nodeav / audio-analyzer).
//
// Placement-model redesign (2026-07-05-cross-node-detection-epic): this
// per-node record is the SINGLE source of truth for node placement — it
// carries the four capability toggles (`detect`/`decode`/`audio`/`ingest`)
// that replaced the four flat orchestrator lists (`enabledNodes`,
// `enabledDecoderNodes`, `enabledAudioNodes`, `remoteSourcingNodes`), plus
// the capacity knobs `maxCameras` + `detectWeight`. Every capability is
// OPTIONAL: an unset flag inherits the node default (`hub` → capable, every
// other node → not), so an empty store keeps the classic hub-only cluster.
const AgentPipelineSettingsSchema = z.object({
  maxCameras: z.number().int().nonnegative().nullable().default(null),
  /** Per-node detection weight (relative share for the quota balancer). */
  detectWeight: z.number().positive().optional(),
  /** Node is eligible to run the detection pipeline (decode + inference). */
  detect: z.boolean().optional(),
  /**
   * DEPRECATED AND IGNORED. Decode is always co-located with its frame
   * consumer, so decode eligibility IS detect eligibility. Kept optional in
   * the schema ONLY so persisted stores written before the removal still
   * parse — no code reads it and no write path emits it.
   */
  decode: z.boolean().optional(),
  /** Node is eligible to run audio-analyzer sessions. */
  audio: z.boolean().optional(),
  /** Node is eligible to be the ingest / source-owner (serve the restream). */
  ingest: z.boolean().optional(),
  /**
   * This node's decode RAM budget, MB. Wins over the cluster
   * `nodeDecodeBudgetMb`; absent, the runner derives a share of the node's
   * own RAM unless the operator moved the cluster value (D365).
   */
  decodeBudgetMb: z.number().int().min(1024).max(65536).optional(),
  /** This node's live decode-worker cap. Wins over the cluster `maxLiveDecodeWorkers`. */
  maxLiveDecodeWorkers: z.number().int().min(1).max(32).optional(),
  /**
   * Operator override for the LAN host a cross-node decoder dials to reach
   * THIS node's restream (Cluster UI). Absent → auto-detect: a remote runner
   * falls back to its `CAMSTACK_HUB_URL`-derived host (the Moleculer address
   * it already uses to reach the hub). Set this only when the auto-detected
   * address is wrong (multi-homed host, NAT, custom interface).
   */
  reachableHost: z.string().optional(),
  /** Hub-persisted UI colour (`--color-node-*` theme tokens). */
  color: NodeColorIdSchema.optional(),
  /**
   * NODE-wide step settings (D927): `stepId → { key → value }`, applied on
   * every accelerator of the node under the device's own settings. Never a
   * model or a model-bound threshold. Written by `setNodeStepSettings`.
   */
  stepSettings: z.record(z.string(), z.record(z.string(), z.unknown()).readonly()).optional(),
  /**
   * Multi-device inference opt-in (Phase 4). Per-node map deviceKey → {enabled,
   * weight, steps}. Absent / all-disabled ⇒ the node's single default
   * accelerator (safe default); two+ enabled ⇒ the dispatcher balances
   * detection sessions across them so they run CONCURRENTLY. `steps` is the
   * per-(node,device) BASE provisioning (`stepId → {modelId?, settings?}`) —
   * the default model/settings for every camera landing on that accelerator;
   * a stepId absent ⇒ the step uses that device's format default.
   */
  inferenceDevices: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean(),
        weight: z.number().positive().optional(),
        maxSessions: z.number().int().positive().optional(),
        steps: z.record(z.string(), DeviceStepConfigSchema).optional(),
      }),
    )
    .optional(),
})

// Camera settings — sparse overlay. A model is chosen by the accelerator that
// runs it (D927): a camera turns steps on or off (`stepToggles`) and carries
// camera-semantic step settings (D754) — never a model, a model-bound
// threshold or a tree of its own.
// Camera-wide, field-level step settings: `[addonId] → { key → value }`,
// merged over the node base.
const CameraStepSettingsSchema = z.record(z.string(), z.record(z.string(), z.unknown()).readonly())

/** The three root-detector choices a camera has (D507: at most one root). */
export const CameraDetectionSourceSchema = z.enum(['pipeline', 'onboard', 'none'])
export type CameraDetectionSource = z.infer<typeof CameraDetectionSourceSchema>

const CameraPipelineSettingsSchema = z.object({
  stepToggles: z.record(z.string(), z.boolean()).optional(),
  stepSettings: CameraStepSettingsSchema.optional(),
})

/**
 * Pipeline placement record persisted by `addon-pipeline-orchestrator` via
 * the multi-level settings store. The orchestrator looks up these records
 * on every `DeviceStreamsRegistered` event to decide whether the camera
 * has a manual pipeline node pin (L1 affinity) or whether the load
 * balancer (L2 capacity / L3 hardware-aware) needs to pick one.
 *
 * Naming convention: `{Pipeline,Decoder}AssignmentSchema` — one schema per
 * placement domain managed by the orchestrator.
 */
const PipelineAssignmentSchema = z.object({
  deviceId: z.number(),
  /** Moleculer node id of the runner currently responsible for this camera. */
  agentNodeId: z.string(),
  /** True when the assignment was set manually, false when chosen by the balancer. */
  pinned: z.boolean(),
  /** Why this assignment was made — useful for debugging the load balancer. */
  reason: z.enum(['manual', 'capacity', 'hardware-affinity', 'failover', 'rebalance']),
  /** Unix timestamp (ms) when the assignment was last updated. */
  assignedAt: z.number(),
})

// NOTE — decoder-placement cleanup (2026-07): the `DecoderAssignmentSchema`
// and its cap surface (`assignDecoder` / `unassignDecoder` /
// `getDecoderAssignment` / `getDecoderAssignments`) were REMOVED. Decode is
// always co-located with its frame consumer (decode runs in the detection
// node's session-decode workers), so a per-camera decoder pin was purely
// advisory — consumed only by status/UI, never by decode placement. The
// camera-status `assignment.decoderNodeId` is the detection node, co-located
// by construction; the broker decodes nothing (D762).

/**
 * Per-agent load summary surfaced to the load balancer + dashboards.
 * Aggregated from each runner's `getLocalLoad` cap call. In the
 * `getAgentLoad` report, a single-device node's default-pool sessions (no
 * `deviceKey`) are credited to its one eligible device in `load.devices` —
 * the default pool IS that device (D745); the balancer's census stays raw.
 */
const AgentLoadSummarySchema = z.object({
  nodeId: z.string(),
  online: z.boolean(),
  load: RunnerLocalLoadSchema,
  /** Computed score used by the L2 capacity balancer (lower = less loaded). */
  score: z.number(),
  /** This node's decode hwaccel backend (per-node `probedBestHwaccel`), or null
   *  when not yet probed — for the cluster Pipeline table UI (P0.2). */
  decodeHwaccel: z.string().nullable(),
})

/**
 * Aggregate metrics across the whole detection cluster. Replaces the legacy
 * `IPipelineExecutorProvider.orchestratorStatus()` cap method as the
 * canonical source of truth for global pipeline health.
 */
const GlobalMetricsSchema = z.object({
  totalAgents: z.number(),
  onlineAgents: z.number(),
  totalCameras: z.number(),
  attachedCameras: z.number(),
  activeCameras: z.number(),
  /** Average inference time across all agents weighted by their camera count. */
  avgInferenceTimeMs: z.number(),
  /** Total queue depth across all agents. */
  queueDepth: z.number(),
})

/**
 * Per-node capability binding map: which addon implements each well-known
 * cap on the named node. Persisted hub-side under
 * `addon:pipeline-orchestrator` settings keyed by `nodeBindings.<nodeId>`.
 *
 * The kernel of each process consults its local copy of this map (via the
 * `capability.binding-changed` event subscription) when resolving
 * capability providers.
 */
const CapabilityBindingsSchema = z.record(z.string(), z.string())

/**
 * The cluster's single camera-source owner (`clusterRoles.ingestNode`) plus
 * its LAN-reachable host, if one is registered. See `getIngestOwner`.
 */
const IngestOwnerSchema = z.object({
  ownerNodeId: z.string(),
  reachableHost: z.string().optional(),
  configIssue: z.string().optional(),
})

// NOTE — Phase 6 cleanup (orchestrator settings rework):
//
// The `OrchestrationDeviceSettings` and `ResolvedOrchestrationSettings`
// types used to live here, along with the cap methods
// `getDeviceOrchestrationSettings` / `getDeviceOrchestrationOverrides`
// / `getGlobalOrchestrationSettings`. They were a central bottleneck
// that duplicated the standard addon settings store.
//
// Consumers now read per-device settings directly via the kernel
// helper `resolveAddonSettings(schema, global, device)` from
// `@camstack/types`, using the standard
// `AddonRegistryService.getAddonConfigSchema` +
// `ConfigService.getAddonConfig` / `getAddonDevice` pair. There is no
// alias cap method on the orchestrator — the 3-level resolver is the
// one and only read path for every addon, including this one.
//
// If a caller needs a typed view of the merged result, it's their
// responsibility to narrow the returned `Record<string, unknown>`
// locally (see `DetectionWiringService.resolveDeviceSettings` for the
// canonical example).

// ── Camera status aggregator schemas ──────────────────────────────────
// One server-composed block per pipeline stage. Each block is nullable
// (null = stage inactive or unreachable during the bounded fan-out).
// The `assignment` block is always present (composed from orchestrator-local
// state — no remote call required).

/** Stream entry surfaced from the stream-catalog for one device. */
const CameraSourceStreamSchema = z.object({
  camStreamId: z.string(),
  codec: z.string(),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  kind: z.string(),
})

/** Source block — always present; derives from the stream catalog. */
const CameraSourceStatusSchema = z.object({
  streams: z.array(CameraSourceStreamSchema).readonly(),
})

/** Assignment block — always present (orchestrator-local, no remote call). */
const CameraAssignmentStatusSchema = z.object({
  detectionNodeId: z.string().nullable(),
  decoderNodeId: z.string().nullable(),
  audioNodeId: z.string().nullable(),
  /**
   * The node that OWNS this camera's physical source pull (dials the RTSP and
   * hosts the broker/restream) — the cluster ingest owner today
   * (`clusterRoles.ingestNode`), per-camera once source assignment lands. Lets
   * the UI show WHERE a camera is sourced without SSH/logs, and is the node the
   * broker block below was read from (pinned). Nullable only pre-wiring.
   */
  sourceNodeId: z.string().nullable(),
  pinned: z.object({
    detection: z.boolean(),
    decoder: z.boolean(),
    audio: z.boolean(),
  }),
  reasons: z.object({
    detection: z.string().optional(),
    decoder: z.string().optional(),
    audio: z.string().optional(),
  }),
})

/** Broker profile slot entry within the broker block. */
const CameraBrokerProfileSchema = z.object({
  profile: z.string(),
  status: z.string(),
  codec: z.string(),
  width: z.number(),
  height: z.number(),
  subscribers: z.number(),
  /**
   * Encoded packets/s the broker receives from the camera. null when the
   * broker's stats read failed — unknown, never 0 (a 0 here reads as a stall).
   * There is no output rate: decoding runs in the session decode workers, not
   * in the broker, so the broker's own decoded-frame rate is 0 on every live
   * camera and is not served (D758).
   */
  inFps: z.number().nullable(),
})

/** Broker block — null when the broker stage is unreachable or inactive. */
const CameraBrokerStatusSchema = z.object({
  profiles: z.array(CameraBrokerProfileSchema).readonly(),
  webrtcSessions: z.number(),
  rtspRestream: z.boolean(),
})

/**
 * Decoder block — WHERE decode runs (co-located with the detection node by
 * construction); null when the camera has no detection node. It carries no
 * frame counter: the shared-memory plane whose counters it used to serve is
 * gone, and those fields read 0 forever. Whether frames actually flow is read
 * from `detection.actualFps` (frames delivered to and processed by the
 * detector), never from a counter nothing feeds.
 */
const CameraDecoderStatusSchema = z.object({
  nodeId: z.string(),
})

/** Motion block — null when motion detection is not active for this device. */
const CameraMotionStatusSchema = z.object({
  enabled: z.boolean(),
  fps: z.number(),
})

/** Detection engine provisioning state (mirrors pipeline-executor provisioning states). */
const CameraDetectionProvisioningStateSchema = z.enum([
  'idle',
  'installing',
  'verifying',
  'ready',
  'failed',
])

/** Detection provisioning sub-block. */
const CameraDetectionProvisioningSchema = z.object({
  state: CameraDetectionProvisioningStateSchema,
  error: z.string().optional(),
})

/** Detection phase — derived from the runner's engine phase. */
const CameraDetectionPhaseSchema = z.enum(['idle', 'watching', 'active'])

/** Detection block — null when no detection node is assigned or reachable. */
const CameraDetectionStatusSchema = z.object({
  nodeId: z.string(),
  engine: z.object({
    backend: z.string(),
    device: z.string(),
  }),
  phase: CameraDetectionPhaseSchema,
  configuredFps: z.number(),
  actualFps: z.number(),
  queueDepth: z.number(),
  avgInferenceMs: z.number(),
  provisioning: CameraDetectionProvisioningSchema,
})

/** Audio block — null when no audio node is assigned or reachable. */
const CameraAudioStatusSchema = z.object({
  nodeId: z.string(),
  enabled: z.boolean(),
})

/** Recording mode — THE one definition, shared with the `recording` cap. A
 *  copy of the list is how `on-device-decision` could have reached the recorder
 *  and not this status block. */
const CameraRecordingModeSchema = RecordingStorageModeSchema

/** Recording block — null when no recording cap is active for this device. */
const CameraRecordingStatusSchema = z.object({
  mode: CameraRecordingModeSchema,
  active: z.boolean(),
  storageBytes: z.number(),
})

/**
 * The stages of the status fan-out that issue a BOUNDED remote read, and can
 * therefore be cut short. Every other block (`assignment`, `decoder`, `motion`,
 * `audio`) is composed from orchestrator-local state and cannot time out.
 *
 * `switches` is the operator's per-camera function switches — the read behind
 * `switchedOff`, not a block of its own.
 */
const CameraStatusStageSchema = z.enum(['source', 'broker', 'detection', 'recording', 'switches'])

/**
 * WHY a stage could not be trusted.
 *
 * - `timeout` — the stage never answered and the whole status call paid the
 *   full per-stage bound for it. This is the one that used to be invisible.
 * - `error` — the source answered with a rejection.
 * - `partial` — the stage RETURNED, but from an incomplete set of sources: its
 *   value is a floor, not a total. `switchedOff` derived from a partial switch
 *   read can be empty while the operator has switches off.
 */
const CameraStatusDegradationReasonSchema = z.enum(['timeout', 'error', 'partial'])

/** One stage of the fan-out that could NOT be read, and how long it cost. */
const CameraStatusDegradationSchema = z.object({
  stage: CameraStatusStageSchema,
  reason: CameraStatusDegradationReasonSchema,
  /** Wall-clock ms spent on the stage before it was abandoned. */
  elapsedMs: z.number(),
})

/**
 * Aggregated per-camera pipeline status — server-composed, single call.
 *
 * The `assignment` and `source` blocks are always present.
 * Every other block is `null` when the stage is inactive or unreachable
 * during the bounded parallel fan-out in the orchestrator implementation.
 *
 * See spec: `docs/superpowers/specs/2026-06-24-camera-status-aggregator-cap.md`
 */
const DiskReconcileJobSchema = z.object({
  state: z.enum(['idle', 'running', 'done', 'error']),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  currentDeviceId: z.number().int().nullable(),
  failed: z.array(z.number().int()).readonly(),
  mediaDropped: z.number().int().nonnegative(),
  tracks: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  startedAtMs: z.number().int().nullable(),
  finishedAtMs: z.number().int().nullable(),
  error: z.string().nullable(),
})

const CameraStatusSchema = z.object({
  deviceId: z.number(),
  assignment: CameraAssignmentStatusSchema,
  source: CameraSourceStatusSchema,
  broker: CameraBrokerStatusSchema.nullable(),
  decoder: CameraDecoderStatusSchema.nullable(),
  motion: CameraMotionStatusSchema.nullable(),
  detection: CameraDetectionStatusSchema.nullable(),
  audio: CameraAudioStatusSchema.nullable(),
  recording: CameraRecordingStatusSchema.nullable(),
  /**
   * Per-camera functions an OPERATOR has turned off
   * ([D61](../../../../docs/decisions/adr-0067.md)).
   *
   * Composed from the AUTHORITIES themselves — the wrapper bindings,
   * `RecordingConfig.enabled`, the notification mute, the broker's audio
   * policy, the camera's own microphone — via `composeSwitchedOff`, not from
   * the deprecated `getCameraSwitches` group ([D113](../../../../docs/decisions/adr-0113.md)).
   * The badge outlives the control panel: the panel was a convenience, this is
   * the difference between a camera being off and a camera being dead.
   *
   * This is the difference between DISABLED and BROKEN. A camera whose
   * `detection` block reports zero fps and whose `switchedOff` contains
   * `'object-detection'` was switched off by a person; the same camera with an
   * empty list is failing. Every status surface must render the two
   * differently — a quiet camera that looks identical to a dead one is the
   * silence-reads-as-never-happened trap this repo keeps paying for.
   *
   * Empty when nothing is off, and never contains a switch no provider offers
   * — but an empty list is only a POSITIVE claim when `degraded` does not name
   * `'switches'`. When it does, the switch set could not be read and nothing
   * here may be rendered as "the operator turned nothing off": that is the
   * D62 failure (a camera we could not read painted as broken) in the very
   * field that exists to prevent it.
   */
  switchedOff: z.array(CameraSwitchIdSchema).readonly(),
  /**
   * The camera's attached sensors (D672). Optional only for a status composed
   * by an orchestrator older than D672; this orchestrator always sets it.
   */
  cameraSensors: CameraSensorsStatusSchema.optional(),
  /**
   * Stages of the bounded fan-out that were CUT SHORT — a timeout or a
   * rejection — and whose block is therefore `null` because we could not
   * READ it, not because there is nothing there.
   *
   * Without this, three different facts arrive as the same `null`: "the stage
   * timed out", "the stage failed", and "this camera legitimately has no
   * decoder / no recording". Every surface that draws a conclusion from a null
   * block (or from an empty `switchedOff`) must consult this first; a stage
   * named here supports no conclusion at all, only "unknown".
   *
   * Empty on a clean read — the overwhelmingly common case.
   */
  degraded: z.array(CameraStatusDegradationSchema).readonly(),
  /** Unix timestamp (ms) when this snapshot was composed server-side. */
  fetchedAt: z.number(),
})

// ── Node inference devices (Phase 4 multi-device — merged HW + opt-in view) ──
//
// The DEVICE-AWARE view the operator/UI needs to configure a node's
// accelerators. Each entry is one PHYSICAL inference device the node actually
// HAS (probed live via a node-pinned `platformProbe.getCapabilities`) joined
// with:
//   - its stored opt-in state (`enabled`/`weight` from
//     `AgentPipelineSettings.inferenceDevices`, defaulting to
//     `enabled:false` / `weight:1`), and
//   - the object-detection model the executor would run on that deviceKey by
//     default (`defaultModelId`) — mirrors the executor's per-device model
//     resolution (P0-3) so the UI can show what will actually run.
//
// Disabled-but-configured keys still appear (the merge is opt-OUT: a probed
// device defaults enabled, an explicit `{enabled:false}` disables it). When the
// node is unreachable,
// `reachable:false` + `devices:[]` (and any stored keys surfaced as
// `available:false`) — the method NEVER throws.
/**
 * Why the dispatcher does NOT consider a device the node HAS for the
 * camera-root election. The list is the CONTRACT between the orchestrator's
 * `resolveInferenceDeviceEligibility` (which computes it) and the admin UI
 * (which renders it) — the orchestrator's `InferenceDeviceExclusionReason`
 * derives from this tuple so the two can never drift.
 *
 * Every one of these drops used to be silent, and an accelerator that is
 * enabled, available, and never chosen is indistinguishable from one that was
 * never configured. The reason is the difference.
 */
const INFERENCE_DEVICE_EXCLUSION_REASONS = [
  /** The operator turned it off (CPU/edgetpu are opt-IN, so absent = off). */
  'disabled',
  /** The live probe did not report it as usable — unplugged, or provisioning. */
  'unavailable',
  /** Its engine format cannot run the object-detection camera root. */
  'cannot-host-camera-root',
  /** It is the CPU fallback and this node has a real accelerator serving (D215). */
  'accelerator-preferred',
] as const

const InferenceDeviceExclusionReasonSchema = z.enum(INFERENCE_DEVICE_EXCLUSION_REASONS)

const NodeInferenceDeviceSchema = z.object({
  /** Stable per-node device key, e.g. `openvino:npu`, `edgetpu:usb`, `cpu`. */
  key: z.string(),
  backend: z.string(),
  device: z.string(),
  format: z.enum(MODEL_FORMATS),
  /** Whether the node's live probe reports the device as usable right now. */
  available: z.boolean(),
  /**
   * Is the device on the node at all (D919)? `present` — the live probe
   * reported it; `absent` — the probe ANSWERED and did not report it, so only
   * its stored settings remain (unplugged, moved to another node): never
   * eligible, whatever its stored `enabled`, and forgettable with
   * `forgetInferenceDevice`; `unknown` — the probe did not answer, nothing is
   * claimed (D315). Optional only for an orchestrator older than the field.
   */
  presence: z.enum(['present', 'absent', 'unknown']).optional(),
  /**
   * Whether this device participates in dispatch. AUTO default (spec C2):
   * accelerators are opt-OUT (a discovered NPU/iGPU/Coral/ANE with no stored
   * entry is `true`); CPU is opt-IN (`false` by default — the fallback pool,
   * not a balanced target). An explicit stored value always wins; a stored-only
   * (unavailable) key keeps its stored value.
   */
  enabled: z.boolean(),
  /** Relative balancer weight for the enabled device (default 1). */
  weight: z.number(),
  /** Per-device concurrent-session cap; null = unlimited (multi-device C4). */
  maxSessions: z.number().nullable(),
  /** Object-detection model the executor defaults to for this deviceKey. */
  defaultModelId: z.string(),
  /**
   * Per-(node,device) BASE provisioning (C7.2/C7.4) — the RAW stored
   * `stepId → {modelId?, settings?}` map from `inferenceDevices[key].steps`.
   * Absent/empty ⇒ no base (every step uses its device format default). The
   * UI cross-references `pipelineExecutor.getSchema` for the models actually
   * available per format; this is the stored selection that becomes the
   * default for EVERY camera landing on this accelerator.
   */
  steps: z.record(z.string(), DeviceStepConfigSchema).optional(),
  /**
   * `null` when the device IS a camera-root candidate on this node; otherwise
   * the reason the dispatcher drops it. Computed by the SAME
   * `resolveInferenceDeviceEligibility` the dispatcher runs, so this view can
   * never disagree with the election — deriving it in the UI from
   * `enabled`/`available` would silently miss `cannot-host-camera-root` (needs
   * the node's model catalog) and `accelerator-preferred` (needs the node-wide
   * "an accelerator is serving" predicate).
   */
  exclusion: InferenceDeviceExclusionReasonSchema.nullable(),
})

// `CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS` lives in the leaf module
// `pipeline/cluster-model-scope.ts`: the rebuild's refusal vocabulary in
// `pipeline-analytics.cap.ts` spreads it, and importing it from THIS cap closed
// an import cycle (pipeline-runner.cap → … → pipeline-orchestrator.cap).
export { CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS }

/**
 * The operator's model choice for one cluster-scoped step, answered by the
 * addon that OWNS the `clusterModel:*` settings (D651). Three answers, never
 * folded: a written choice, a key nobody wrote (the cluster runs the default
 * BY ABSENCE), or no answer. A caller that rewrites an index acts only on the
 * first two, read twice and agreeing.
 */
export const ClusterModelChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stored'), modelId: z.string() }),
  z.object({ kind: z.literal('absent'), defaultModelId: z.string() }),
  z.object({
    kind: z.literal('unreadable'),
    reason: z.enum(CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS),
    error: z.string().optional(),
  }),
])

const NodeInferenceDevicesSchema = z.object({
  nodeId: z.string(),
  /** False when the node's platform-probe was unreachable (no live device set). */
  reachable: z.boolean(),
  devices: z.array(NodeInferenceDeviceSchema).readonly(),
})

/**
 * Pipeline Orchestrator capability — global load balancer + camera dispatcher.
 *
 * Lives on the hub. Tracks the camera-to-agent assignment map, listens to
 * device lifecycle events, queries each runner's capacity + hardware
 * profile, and dispatches `attachCamera` / `detachCamera` cap calls to the
 * appropriate runner instances. Persists assignments via the multi-level
 * settings store so they survive hub restarts.
 *
 * Strictly the control plane: never sees a frame, never calls inference,
 * never drains queues. The runner does that work locally on each agent.
 */
/**
 * The input of `setCameraSensors` (G5, D676): the ONE typed write path of a
 * camera's attached sensors (D672). `config: null` removes the attachment —
 * the camera reads `not-configured` again, never `unreadable`.
 */
export const SetCameraSensorsInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  /** `null` removes the attachment: the camera goes back to `not-configured`. */
  config: CameraSensorsConfigSchema.nullable(),
})
export type SetCameraSensorsInput = z.infer<typeof SetCameraSensorsInputSchema>

/**
 * Why an early occupancy look (D691) was not scheduled.
 *
 * - `unknown-camera` — no session was ever dispatched for it, so there is no
 *   node and no config to attach a burst with.
 * - `out-of-range` — the ask is negative or further out than the orchestrator
 *   will hold a timer for; the parked-object cadence is the answer there.
 * - `no-burst-producer` — this build has no burst producer at all.
 * - `already-looked` — this camera's ONE early look since its last session has
 *   been spent. A look's own burst can re-arm a flickering flip, and a look
 *   per arm would chain a burst every ~30 s forever (review H2); the next
 *   real session re-arms the budget.
 */
export const OccupancyLookRefusalSchema = z.enum([
  'unknown-camera',
  'out-of-range',
  'no-burst-producer',
  'already-looked',
])
export type OccupancyLookRefusal = z.infer<typeof OccupancyLookRefusalSchema>

/** The input of `requestOccupancyLook` (D691). */
export const OccupancyLookRequestSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  /** How long from NOW until the pending flip's sustain window ends. RELATIVE,
   *  so the caller's clock and the orchestrator's never have to agree. */
  afterMs: z.number().finite(),
  /** Why, for the log. */
  reason: z.string(),
})
export type OccupancyLookRequest = z.infer<typeof OccupancyLookRequestSchema>

/** The answer of `requestOccupancyLook` (D691). */
export const OccupancyLookAnswerSchema = z.object({
  scheduled: z.boolean(),
  /** When `scheduled`: how long until the burst is dialled. */
  dueInMs: z.number().optional(),
  /** When not `scheduled`: why. */
  refusedBecause: OccupancyLookRefusalSchema.optional(),
})
export type OccupancyLookAnswer = z.infer<typeof OccupancyLookAnswerSchema>

export const pipelineOrchestratorCapability = {
  name: 'pipeline-orchestrator',
  scope: 'system',
  mode: 'singleton',
  // This cap lives ONLY on the hub singleton. Several methods carry `nodeId`
  // as DATA — the node to *assign* work to (`assignAudio`, `setCapBinding`) —
  // which the hub provider dispatches internally. Without `nodeIdMode: 'data'`
  // the generic router treats `nodeId` as a routing selector and forwards the
  // whole call to that node, where `pipeline-orchestrator` doesn't exist →
  // PRECONDITION_FAILED. Mirrors addon-settings / addons / nodes.
  nodeIdMode: 'data',
  exposesDeviceSettings: true,
  methods: {
    /**
     * D691 — an occupancy flip is pending on this camera and can commit
     * `afterMs` from now: dial ONE occupancy burst at the end of its sustain
     * window instead of leaving the commit to the 300 s parked-object cadence.
     * Called by the notification centre, the only component that knows a flip
     * is pending; the dial is the recheck's own (attach on the last session
     * node, `requestOccupancyBurst`, detach). One pending look per camera; a
     * session open at the due time is the look, and no burst is dialled.
     */
    requestOccupancyLook: method(OccupancyLookRequestSchema, OccupancyLookAnswerSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Internal storage-migration participant lease. While held, dispatch
     * requests are accepted as pending but no new runner attachment starts. */
    pauseForStorageMigration: method(
      StorageMigrationLeaseInputSchema,
      z.object({ paused: z.literal(true) }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    resumeForStorageMigration: method(
      StorageMigrationLeaseInputSchema,
      z.object({ resumed: z.literal(true) }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    // ── Pipeline placement overrides ────────────────────────────────────
    /**
     * Pin a camera's pipeline to a specific agent (L1 affinity).
     * The orchestrator re-evaluates the assignment immediately and persists
     * the pin under the canonical `pipelineNodeId` device-store key (the
     * legacy `preferredAgent` key is nulled on write and kept only as a
     * read-only fallback for stores written before the unification).
     */
    assignPipeline: method(
      z.object({ deviceId: z.number(), agentNodeId: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Clear a camera's pipeline pin and let the auto-balancer re-pick
     * the optimal agent. The orchestrator persists the canonical
     * `pipelineNodeId='auto'` (and nulls the legacy `preferredAgent`),
     * then re-runs the balancer with the
     * cached `RunnerCameraConfig` and migrates only when the chosen
     * node differs. The camera stays in `getPipelineAssignments()` —
     * just with `pinned=false`. If no runner is currently available
     * (cluster-wide), the camera is left unassigned but the cached
     * config is kept so the next dispatch event re-attaches it.
     */
    unassignPipeline: method(
      z.object({ deviceId: z.number() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Pin a camera's detection to a specific INFERENCE DEVICE (accelerator)
     * within its node — a SOFT L1 device affinity honoured by the per-session
     * device `balance()` pass (sibling of the node-level `pipelineNodeId` pin;
     * persisted as `pipelineDeviceKey` in the device store, read by
     * `readPipelineDevicePin`). `deviceKey` is a concrete key
     * (`openvino:npu` / `edgetpu:usb` / `cpu`), or the `'auto'` sentinel /
     * empty string to CLEAR the pin and let the balancer pick the device.
     *
     * Applies promptly: the device is chosen per-session at dispatch, so any
     * running detection session is closed and re-dispatched onto the new pin
     * (the camera stays on the SAME node — a device pin never moves the camera).
     * Cameras with no active session pick it up on their next dispatch.
     */
    setPipelineDevicePin: method(
      z.object({ deviceId: z.number(), deviceKey: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Read a camera's persisted inference-device pin (`pipelineDeviceKey`).
     * Returns the concrete device key, or `null` when unpinned (auto). Lets the
     * UI show the current pin alongside the node pin (parity with the node-pin
     * value carried on the assignment record).
     */
    getPipelineDevicePin: method(
      z.object({ deviceId: z.number() }),
      z.object({ deviceKey: z.string().nullable() }),
    ),
    /**
     * Trigger a full rebalance pass. Iterates over all assigned cameras,
     * recomputes the optimal agent for each one based on current load +
     * hardware affinity, and migrates cameras whose current agent is no
     * longer optimal. Pinned cameras are never migrated. `skipped` names the
     * cameras the pass wanted to move and could not, with why — a target node
     * that has not answered its catalog / device health yet, or a device that
     * cannot run the camera's root (D650).
     */
    rebalance: method(
      z.void(),
      z.object({
        migrated: z.number(),
        // A camera the pass wanted to move and could not, with why (D650).
        skipped: z
          .array(z.object({ deviceId: z.number(), targetNodeId: z.string(), reason: z.string() }))
          .default([]),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Observability ────────────────────────────────────────────────
    /** Get the full camera-to-agent assignment map. */
    getPipelineAssignments: method(z.void(), z.array(PipelineAssignmentSchema).readonly()),
    /** Get one camera's assignment, or null if unassigned. */
    getPipelineAssignment: method(
      z.object({ deviceId: z.number() }),
      PipelineAssignmentSchema.nullable(),
    ),
    /** Get per-agent load summaries used by the load balancer + dashboards. */
    getAgentLoad: method(z.void(), z.array(AgentLoadSummarySchema).readonly()),
    /**
     * The operator's STORED model choice for one cluster-scoped step (D651).
     * Read three-way from this addon's own store, only once its boot has
     * settled. Unlike `addonSettings.getGlobalSettings`, it never answers a
     * default as though someone chose it.
     */
    getClusterModelChoice: method(z.object({ stepId: z.string() }), ClusterModelChoiceSchema),
    /** Aggregate global metrics across the whole detection cluster. */
    getGlobalMetrics: method(z.void(), GlobalMetricsSchema),
    /**
     * Per-camera live metrics (phase, fps, inference, queue, drops).
     * The orchestrator owns the device→agent assignment map and is the
     * canonical place to ask "give me the metrics for this camera". It
     * resolves the agent that holds the camera and delegates to that
     * runner's `getCameraMetrics`. Returns null if the device is not
     * assigned or the runner has no record for it (e.g. the camera was
     * just dispatched and the runner hasn't received the first frame).
     */
    getCameraMetrics: method(z.object({ deviceId: z.number() }), CameraMetricsSchema.nullable()),

    // ── Capability bindings (which addon implements each cap on each node) ──
    /** Read the capability binding map for one node. Empty record = no overrides (first-registered wins). */
    getCapabilityBindings: method(z.object({ nodeId: z.string() }), CapabilityBindingsSchema),
    /** Set the addon that implements `capName` on `nodeId`. Emits `capability.binding-changed`. */
    setCapabilityBinding: method(
      z.object({ nodeId: z.string(), capName: z.string(), addonId: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Cluster roles ────────────────────────────────────────────────────
    /**
     * The cluster's single camera-source owner — resolved UNCONDITIONALLY
     * from `clusterRoles.ingestNode` (NOT the detection-decode
     * `remoteSourcingNodes` knob). Consumers (recorder/snapshot/audio) pin
     * their broker calls to `ownerNodeId` and dial `reachableHost` when
     * present. Defaults to `{ ownerNodeId: 'hub' }`.
     */
    getIngestOwner: method(z.void(), IngestOwnerSchema),

    // ── Audio scheduling ───────────────────────────────────────────────
    /** Pin a device's audio analysis to a specific cluster node. */
    assignAudio: method(
      z.object({ deviceId: z.number(), nodeId: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Clear a device's audio node pin (revert to auto load-balanced). */
    unassignAudio: method(
      z.object({ deviceId: z.number() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Get the current audio assignment for one device, or null if not yet assigned. */
    getAudioAssignment: method(
      z.object({ deviceId: z.number() }),
      z
        .object({
          nodeId: z.string(),
          pinned: z.boolean(),
          assignedAt: z.number(),
        })
        .nullable(),
    ),
    /** Get per-node audio load (device counts) for all known audio-analyzer nodes. */
    getAudioNodeLoad: method(
      z.void(),
      z.array(z.object({ nodeId: z.string(), deviceCount: z.number() })),
    ),
    /** Get all current audio assignments across all devices. */
    getAudioAssignments: method(
      z.void(),
      z.array(
        z.object({
          deviceId: z.number(),
          nodeId: z.string(),
          pinned: z.boolean(),
          assignedAt: z.number(),
        }),
      ),
    ),

    // NOTE: the `getDeviceOrchestrationSettings`,
    // `getDeviceOrchestrationOverrides` and `getGlobalOrchestrationSettings`
    // methods were removed in Phase 6. Consumers now read settings via
    // the standard 3-level resolver (`resolveAddonSettings`) over the
    // addon config store — see the top of this file for details.

    // ── Per-(node,device) pipeline settings ────────────────────────────
    //
    // A model is chosen by the accelerator that runs it (D927):
    //   `camera.stepToggles`  (per-camera enablement; absent = catalog default),
    //   `inferenceDevices[node][deviceKey].steps` (the accelerator's model+settings),
    //   `camera.stepSettings` (camera-semantic settings only, never a model or
    //   a model-bound threshold).
    //
    // At dispatch the balancer picks `(node, deviceKey)`; the resolver builds
    // the enabled tree (structure only) and a single provisioning stage
    // attaches model+settings: accelerator ?? format-default, settings
    // node ⊕ camera.

    // `agentNodeId` (not `nodeId`) is intentional: the generated cap router
    // auto-routes any input field literally named `nodeId` to that node's
    // provider. `pipeline-orchestrator` is a HUB-SINGLETON cap — the
    // agent-node identifier here is DATA ("which agent to read/write"),
    // not routing. Using `agentNodeId` keeps the call on the hub as
    // intended.

    /** Read one agent's settings. Null when not yet seeded. */
    getAgentSettings: method(
      z.object({ agentNodeId: z.string() }),
      AgentPipelineSettingsSchema.nullable(),
    ),
    /** Enumerate every agent's settings (hub + remote runners). */
    listAgentSettings: method(
      z.void(),
      z
        .array(
          z.object({
            nodeId: z.string(),
            settings: AgentPipelineSettingsSchema,
          }),
        )
        .readonly(),
    ),
    /**
     * Drop a single agent's persisted settings. Used by the cluster
     * "Offline agents" panel to evict stale entries left behind when an
     * agent's data dir was rebuilt (new random nodeId) or older code wrote
     * the env name as the nodeId. The orchestrator otherwise never deletes
     * agentSettings — entries accumulate until a hub reset.
     *
     * `success: false` indicates the nodeId wasn't in the store (no-op).
     * Refuses to remove `hub` (the orchestrator always co-resides with it).
     */
    removeAgentSettings: method(
      z.object({ agentNodeId: z.string() }),
      z.object({ success: z.boolean(), removed: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Set the per-node camera cap for one agent.
     *
     * `maxCameras: 0` and `maxCameras: null` are both treated as unlimited
     * by the load balancer (0 is stored as-is; the balancer treats ≤0 as
     * unlimited alongside null). Pass `null` to clear an existing cap.
     * Note: the admin UI normalises 0→null before calling this method, so
     * `maxCameras: 0` only reaches the store via direct SDK or CLI calls.
     * Changes take effect immediately on the next dispatch cycle — cameras
     * currently assigned over-cap are left in place (no forced eviction),
     * but new assignments obey the updated cap.
     */
    setAgentMaxCameras: method(
      z.object({
        agentNodeId: z.string(),
        maxCameras: z.number().int().nonnegative().nullable(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Set one node's placement CAPABILITIES — the per-node record that
     * replaced the four flat orchestrator lists (`enabledNodes`,
     * `enabledDecoderNodes`, `enabledAudioNodes`, `remoteSourcingNodes`).
     * Each flag is optional in the patch: omit a flag to leave it unchanged,
     * pass `null` to reset it to the node default (`hub` → capable, every
     * other node → not). Detection/audio eligibility is derived from these
     * flags across the cluster; changing them re-derives the enabled sets
     * and reconciles dispatch immediately. There is NO separate decode flag:
     * decode is always co-located with its frame consumer, so decode
     * eligibility IS detect eligibility.
     */
    setAgentCapabilities: method(
      z.object({
        agentNodeId: z.string(),
        detect: z.boolean().nullable().optional(),
        audio: z.boolean().nullable().optional(),
        ingest: z.boolean().nullable().optional(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Size ONE node's decode admission: its RAM budget and live-worker cap.
     * `null` clears a limit (back to the cluster setting or the RAM-derived
     * default); an omitted key leaves it alone. Read by the node's runner on
     * its next lease refresh (D365).
     */
    setAgentDecodeLimits: method(
      z.object({
        agentNodeId: z.string(),
        decodeBudgetMb: z.number().int().min(1024).max(65536).nullable().optional(),
        maxLiveDecodeWorkers: z.number().int().min(1).max(32).nullable().optional(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Set (or clear) the operator override for the LAN host a cross-node
     * decoder dials to reach this node's restream. Pass a non-empty string to
     * override the auto-detected address (the runner's `CAMSTACK_HUB_URL`
     * default); pass `null` or an empty string to clear it and revert to
     * auto-detect. Applied on the next dispatch cycle — takes effect for new
     * cross-node attaches; existing attaches keep their current host until
     * re-dispatched.
     */
    setAgentReachableHost: method(
      z
        .object({
          agentNodeId: z.string(),
          reachableHost: z.string().nullable().optional(),
          color: NodeColorIdSchema.nullable().optional(),
        })
        .refine((v) => v.reachableHost !== undefined || v.color !== undefined, {
          message: 'reachableHost or color required',
        }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Set one node's multi-device inference opt-in (Phase 4 multi-device) — the
     * per-node `deviceKey → { enabled, weight }` map that decides which
     * accelerators the dispatcher may balance detection sessions across.
     * The map REPLACES the node's stored `inferenceDevices` wholesale (pass the
     * complete desired set; an empty map clears the opt-in → the node reverts to
     * its single DEFAULT accelerator). `weight` is optional and defaults to 1.
     * `models` is the optional per-device model override (`stepId → modelId`,
     * C7.2/C7.4) — a stepId absent ⇒ the step uses that device's default model.
     * Creates the node's settings entry if absent. Changes take effect on the
     * next dispatch/rebalance cycle — the dispatcher reads the enabled set via
     * `PipelineSettingsStore.buildNodeInferenceDevices` when placing sessions
     * and the per-(node,device) base provisioning via
     * `buildNodeInferenceDeviceSteps`.
     */
    setAgentInferenceDevices: method(
      z.object({
        agentNodeId: z.string(),
        inferenceDevices: z.record(
          z.string(),
          z.object({
            enabled: z.boolean(),
            weight: z.number().positive().optional(),
            maxSessions: z.number().int().positive().optional(),
            steps: z.record(z.string(), DeviceStepConfigSchema).optional(),
          }),
        ),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Write or clear one step's NODE-wide settings (D927) — the content that
     * holds on every accelerator of the node (`agentSettings[node].stepSettings`).
     * `settings` is the whole bag for the step; `null` or `{}` clears it.
     * REFUSES a model-scoped key (a model id, a binding, a `minConfidence*`
     * floor): those are set on the accelerator (`setAgentInferenceDevices`).
     */
    setNodeStepSettings: method(
      z.object({
        agentNodeId: z.string(),
        addonId: z.string(),
        settings: z.record(z.string(), z.unknown()).nullable(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * DEVICE-AWARE merged view of ONE node's inference accelerators. Joins each
     * physical device the node HAS — probed live via a node-pinned
     * `platformProbe.getCapabilities` (the platform-probe singleton is targeted
     * by the `nodeId` cap INPUT, since a `nodePin` context is ignored by a
     * singleton mount) — with its stored opt-in (`enabled`/`weight`) and the
     * object-detection `defaultModelId` the executor would run for that
     * deviceKey. Disabled-but-configured keys still appear. An unreachable node
     * returns `reachable:false` + best-effort stored-only devices (never
     * throws). Read surface for the cluster/agent multi-device UI — hence a
     * default (read-level) auth, matching the other `getAgent*` reads.
     */
    getNodeInferenceDevices: method(z.object({ nodeId: z.string() }), NodeInferenceDevicesSchema),
    /**
     * Delete ONE stored device entry of a node — the "forget" of a device the
     * node no longer has (D919). Refused unless the node's probe ANSWERED and
     * did not report the key: a present device is switched off, not forgotten,
     * and an unreachable node proves nothing about its hardware. The rest of
     * the node's map is kept as stored.
     */
    forgetInferenceDevice: method(
      z.object({ agentNodeId: z.string(), deviceKey: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    // Phase 2f: `setAgentEngineChoice`, `setAgentHwAccel`,
    // `reprobeAgentHwAccel` removed. Engine ownership moved to the
    // `detection-pipeline` addon (`engineRuntime/engineBackend/engineDevice`
    // + the detection engine derive). Hwaccel ownership moved to
    // the decoder addon (`decoder-nodeav` global settings +
    // `decoder.reprobeHwaccel`), read per node through `decoder.getInfo`.

    /**
     * Reset one node's pipeline to its hardware-aware defaults — the HONEST
     * reset (replaces the executor's legacy `resetToDefault`, which cleared a
     * dead persisted step-tree seed nothing in the live path read):
     *   (a) strips every `modelId` pin from that node's
     *       `agentSettings.addonDefaults` (cells revert to Auto — the node
     *       resolves its own hardware-aware format default at runtime);
     *   (b) hot-reloads every camera assigned to the node.
     * There is no per-camera model to clear (D927).
     *
     * Returns the EFFECTIVE post-reset object-detection model for the node
     * (the format default of the accelerator hosting the camera root) so the
     * UI can report what will actually run.
     */
    resetNodePipelineDefaults: method(
      z.object({ agentNodeId: z.string() }),
      z.object({
        success: z.literal(true),
        /** Hardware-aware default detection model now in effect on the node (null when unresolvable). */
        effectiveModelId: z.string().nullable(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Auto tune (D745, D755) — DRY RUN. Recommends ONE detector family
     * (YOLOv9) for the whole cluster from each node's static hardware class
     * and the measured latency table: per device, the most accurate model
     * that sustains at least `minSessionsPerDevice` parallel sessions at the
     * camera rate with the headroom kept free (no load input), and lists every write
     * the apply would make: the node model pins set, the enrichment pins and
     * model-bound thresholds removed — all on the accelerators, the only
     * layer that carries a model (D927). Writes nothing. Step
     * enablement, device enablement, pins, recording, notifications, zones and
     * rules are never part of it. `planHash` names exactly this diff.
     */
    planAutoTune: method(AutoTuneOptionsSchema, AutoTunePlanSchema, { auth: 'admin' }),
    /**
     * Auto tune (D745) — APPLY the plan the operator confirmed. Recomputes
     * the plan and refuses (`stale`, with the fresh plan) when its hash is not
     * `planHash`, so what is written is exactly the confirmed diff. Offline
     * nodes are skipped; there is no undo.
     */
    applyAutoTune: method(AutoTuneApplyInputSchema, AutoTuneApplyResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Load balancing (D748) — write node shares (`detectWeight`) and per-node
     * device shares (inference-device `weight`) in ONE atomic read-modify-write
     * of the agent settings — the only writer of node shares (the per-node
     * `setAgentDetectWeight` it replaced raced its siblings, one RMW each).
     * A node or device left out keeps its weight. Never changes the
     * `sessionPlacement` policy.
     */
    setLoadBalancingShares: method(
      LoadBalancingSharesInputSchema,
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Load balancing (D748) — what placement actually did: per node and
     * device, sessions now, sessions started and the time-weighted share of
     * PARALLEL sessions over `windowMs`; the cluster's parallel peak; yields
     * a share election made; and every device pin the session path cannot
     * honour. In memory on the hub — a restart starts a new window.
     */
    getPlacementStats: method(PlacementStatsInputSchema, PlacementStatsSchema, { auth: 'admin' }),
    /**
     * Load balancing (D748, D755) — shares proportional to each node's
     * capacity in parallel sessions: from the latency table at the models
     * Auto tune picks (`hardware`), or from node benchmark results
     * (`benchmark`, each node without results falling back to `hardware` and
     * saying so). The automatic shares are exactly this answer. Per device,
     * an ADVISORY session cap. Writes nothing.
     */
    suggestShares: method(SuggestSharesInputSchema, SuggestSharesResultSchema, { auth: 'admin' }),
    /**
     * Load balancing (D750) — the shares placement reads now: the source
     * (automatic capacity shares or the operator's sliders), each node's and
     * device's configured share, and the effective share after a node or
     * device that cannot take sessions gave its share to the others.
     */
    getEffectiveShares: method(z.void(), EffectiveSharesSchema, { auth: 'admin' }),
    /**
     * Load balancing (D750, D755) — switch the share source: `hardware`
     * (automatic, from static capacity), `benchmark` (automatic, from node
     * benchmark results) or `manual`. Going manual seeds the sliders with the
     * current automatic shares (one atomic write), so nothing jumps; going
     * to an automatic source recomputes at once.
     */
    setShareSource: method(SetShareSourceInputSchema, z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Node benchmark (D791) ──────────────────────────────────────────
    /**
     * Node benchmark — what a run of this plan would do, without doing it:
     * the cameras that leave the node, those that cannot (the node is their
     * only frame source; they stay and flag the run), the estimated duration
     * and every reason it may not start. The confirmation shows this.
     */
    getNodeBenchmarkPreflight: method(NodeBenchmarkPlanSchema, NodeBenchmarkPreflightSchema, {
      auth: 'admin',
    }),
    /**
     * Node benchmark — start ONE run (cluster-wide lock). The orchestrator
     * persists a restore manifest, enters benchmark mode for the node (out of
     * placement, its camera pins ignored, nothing rewritten), drains it, drives
     * the node's own runner, then restores — always, including after an
     * abort, a lost node or a hub restart. Answers at once; poll
     * `getNodeBenchmarkStatus`. Refused runs carry the preflight.
     */
    startNodeBenchmark: method(
      NodeBenchmarkPlanSchema,
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('started'), runId: z.string() }),
        z.object({ kind: z.literal('refused'), preflight: NodeBenchmarkPreflightSchema }),
      ]),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Node benchmark — the active run (or the last one) and the node in benchmark mode. */
    getNodeBenchmarkStatus: method(z.void(), NodeBenchmarkStatusSchema, { auth: 'admin' }),
    /** Node benchmark — stop the active run; the cluster is restored as it was. */
    abortNodeBenchmark: method(
      z.object({ runId: z.string() }),
      z.object({ aborted: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Node benchmark — root detector candidates per device (what Auto tune
     * would pick first, then the family) and the detail steps the node's
     * catalog offers, for the plan editor.
     */
    getNodeBenchmarkCandidates: method(
      z.object({ nodeId: z.string() }),
      NodeBenchmarkCandidatesSchema,
      { auth: 'admin' },
    ),
    /** Node benchmark — stored results, newest first, each with its standing today. */
    listNodeBenchmarkResults: method(
      ListNodeBenchmarkResultsInputSchema,
      z.array(NodeBenchmarkResultViewSchema).readonly(),
      { auth: 'admin' },
    ),
    /** Node benchmark — delete one result; Auto tune and the shares stop reading it. */
    deleteNodeBenchmarkResult: method(
      z.object({ id: z.string() }),
      z.object({ deleted: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Read one camera's settings. Null when never touched (inherits agent defaults fully). */
    getCameraSettings: method(
      z.object({ deviceId: z.number() }),
      CameraPipelineSettingsSchema.nullable(),
    ),
    /** Set or clear the 3-state toggle for one (camera, addonId). Pass `enabled: null` to clear and revert to agent default. */
    setCameraStepToggle: method(
      z.object({
        deviceId: z.number(),
        addonId: z.string(),
        enabled: z.boolean().nullable(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Where this camera's first-level detections come from: this node's own
     * root step (`pipeline`), the camera's onboard detector alone (`onboard`),
     * or no root detector (`none`). A camera runs at most one root detector
     * (D507), so there is no "both". Read from the camera's stored
     * `detectionSources` — the one authority; `explicit` is false while the
     * operator has never picked and the default stands.
     */
    getCameraDetectionSource: method(
      z.object({ deviceId: z.number() }),
      z.object({
        source: CameraDetectionSourceSchema,
        explicit: z.boolean(),
        onboard: z.object({
          /** The camera has an onboard detector this system can read. */
          available: z.boolean(),
          /** What its detections carry — a camera with no box cannot be a root step. */
          geometry: z.enum(['boxed', 'while-streaming', 'flag-only', 'unknown']),
        }),
      }),
    ),
    /**
     * Pick where this camera's detections come from. Writes `detectionSources`
     * and arms (or disarms) the vendor's boxed sub-stream that the choice
     * drives. Refuses `onboard` on a camera with no onboard detector.
     */
    setCameraDetectionSource: method(
      z.object({ deviceId: z.number(), source: CameraDetectionSourceSchema }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Write or clear one step's CAMERA-WIDE settings (D754) — the
     * camera-semantic fields this camera overrides on every accelerator it
     * runs on. `settings` is the whole field-level bag for that step (only the
     * overridden keys); `null` or `{}` clears it. Merged at dispatch over the
     * node base, key by key. REFUSES a model-scoped key — a model id, a model
     * binding or a `minConfidence*` floor (D927): those belong to the
     * accelerator that runs the model.
     */
    setCameraStepSettings: method(
      z.object({
        deviceId: z.number(),
        addonId: z.string(),
        settings: z.record(z.string(), z.unknown()).nullable(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Resolve the effective pipeline for `(deviceId, agentNodeId?)` — walks the full precedence chain. Read-only preview used by the UI to show what will run. */
    resolvePipeline: method(
      z.object({ deviceId: z.number(), agentNodeId: z.string().optional() }),
      CameraPipelineConfigSchema,
    ),

    // ── Per-camera function switches — DEPRECATED, compatibility only ──
    /**
     * @deprecated The aggregate switch group is being withdrawn
     * ([D113](../../../../docs/decisions/adr-0113.md)). Build nothing new on
     * this pair; read the authority directly.
     *
     * The whole per-camera function switch group, DERIVED — never a stored
     * list ([D61](../../../../docs/decisions/adr-0067.md)).
     *
     * The group adds no state. Each switch is a view onto the authority that
     * already owned it (`deviceManager.setDisabled`,
     * `deviceManager.setWrapperActive`, `RecordingConfig.enabled`,
     * `notificationRules.setDeviceMuted`), and `switch.authority` says which.
     * Availability comes from `deviceManager.listBindableCapsForDeviceType`,
     * so a deployment with no audio analyzer renders no audio switch.
     *
     * `auth: 'view'` deliberately — a NON-admin must be able to see that a
     * camera is quiet because somebody switched it off. Only the mutation is
     * admin-gated.
     *
     * **Removal plan.** It stays and it KEEPS WORKING while shipped viewers
     * (v1.0.305) and the admin UI still call it — removing it now is a broken
     * app on a device nobody can redeploy from here. It is served by a thin
     * shim over the same authorities (`camera-switch-service.ts`), so the
     * behaviour of the pair is the behaviour of the authorities by
     * construction. It is deleted once every surface reaches its own
     * component's options and the last caller is gone. Nothing on this server
     * reads it: `CameraStatus.switchedOff` is composed from the authorities
     * directly via `composeSwitchedOff`.
     */
    getCameraSwitches: method(z.object({ deviceId: z.number() }), CameraSwitchGroupSchema, {
      role: 'viewer',
    }),
    /**
     * @deprecated See {@link getCameraSwitches}. Write the authority — the
     * wrapper binding, `RecordingConfig.enabled`, the notification mute — not
     * this ([D113](../../../../docs/decisions/adr-0113.md)).
     *
     * Flip ONE switch, routed to its existing authority.
     *
     * Never writes a parallel map: `recording` patches `RecordingConfig.enabled`
     * and leaves `bands` byte-identical (clearing bands to express "off"
     * destroys the operator's authored schedule and turning the camera back on
     * would silently record nothing), and the two pipeline switches write the
     * SAME wrapper binding the legacy `pipelineEnabled` / `audioEnabled`
     * booleans were migrated onto.
     *
     * Rejects a switch this camera does not offer rather than persisting a
     * write nothing reads.
     */
    setCameraSwitch: method(
      z.object({
        deviceId: z.number(),
        switchId: CameraSwitchIdSchema,
        enabled: z.boolean(),
      }),
      CameraSwitchGroupSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Camera status aggregator ───────────────────────────────────────
    /**
     * Server-composed aggregated status for a single camera.
     *
     * Fans out in parallel (bounded, per-stage graceful degradation) to
     * broker / decoder / motion / detection / audio / recording source caps
     * via `ctx.api`. A stage whose source errors or times out becomes `null`
     * in the returned payload — one slow agent never breaks the whole call.
     *
     * Intended for "on open / on camera select" snapshots. Live deltas
     * keep arriving from the existing ~1Hz events the UI already subscribes to.
     */
    getCameraStatus: method(z.object({ deviceId: z.number() }), CameraStatusSchema),
    /**
     * Server-composed aggregated status for multiple cameras in one call.
     *
     * `deviceIds` defaults to all cameras currently tracked by the
     * orchestrator's assignment map when omitted.
     *
     * Runs per-device composition in parallel (bounded). Use this to
     * populate the cluster assignments table and the pipeline flow overview
     * rail without issuing N parallel browser round-trips.
     */
    getCameraStatuses: method(
      z.object({ deviceIds: z.array(z.number()).optional() }),
      z.array(CameraStatusSchema).readonly(),
    ),

    /**
     * Attach sensors to a camera, or detach them with `config: null` (D672
     * configuration, G5/D676). Written to the orchestrator's per-device store
     * under the same key `applyDeviceSettingsPatch` writes, and announced as a
     * settings change so the camera-sensors bridge refreshes. Refused by name
     * — nothing written — for a device that cannot be read, does not exist,
     * is not a camera, or names itself as its own sensor.
     */
    setCameraSensors: method(SetCameraSensorsInputSchema, z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Disk-wins fleet reconcile after a recordings wipe. Starts the walk in
     * the addon process and returns immediately with the job snapshot — the
     * work outlives the tRPC/UDS 60s timeout. Poll `getReconcileFromDiskStatus`.
     * Admin-only. Idempotent while a job is already running.
     */
    reconcileFromDisk: method(z.void(), DiskReconcileJobSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Snapshot of the in-flight or last disk-wins fleet reconcile. */
    getReconcileFromDiskStatus: method(z.void(), DiskReconcileJobSchema, {
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IPipelineOrchestratorProvider = InferProvider<typeof pipelineOrchestratorCapability>
export type ClusterModelChoice = z.infer<typeof ClusterModelChoiceSchema>
export type ClusterModelChoiceUnreadableReason =
  (typeof CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS)[number]
export type DiskReconcileJob = z.infer<typeof DiskReconcileJobSchema>

// ── Camera status aggregator — named type exports ───────────────────
// Use `z.infer<>` — never duplicate these types manually.
export type CameraStatus = z.infer<typeof CameraStatusSchema>
export type CameraStatusDegradation = z.infer<typeof CameraStatusDegradationSchema>
export type CameraStatusStage = z.infer<typeof CameraStatusStageSchema>
export type CameraStatusDegradationReason = z.infer<typeof CameraStatusDegradationReasonSchema>
export type CameraAssignmentStatus = z.infer<typeof CameraAssignmentStatusSchema>
export type CameraSourceStatus = z.infer<typeof CameraSourceStatusSchema>
export type CameraSourceStream = z.infer<typeof CameraSourceStreamSchema>
export type CameraBrokerStatus = z.infer<typeof CameraBrokerStatusSchema>
export type CameraBrokerProfile = z.infer<typeof CameraBrokerProfileSchema>
export type CameraDecoderStatus = z.infer<typeof CameraDecoderStatusSchema>
export type CameraMotionStatus = z.infer<typeof CameraMotionStatusSchema>
export type CameraDetectionStatus = z.infer<typeof CameraDetectionStatusSchema>
export type CameraDetectionProvisioning = z.infer<typeof CameraDetectionProvisioningSchema>
export type CameraDetectionProvisioningState = z.infer<
  typeof CameraDetectionProvisioningStateSchema
>
export type CameraDetectionPhase = z.infer<typeof CameraDetectionPhaseSchema>
export type CameraAudioStatus = z.infer<typeof CameraAudioStatusSchema>
export type CameraRecordingStatus = z.infer<typeof CameraRecordingStatusSchema>
export type CameraRecordingMode = z.infer<typeof CameraRecordingModeSchema>
export type IngestOwner = z.infer<typeof IngestOwnerSchema>
export type NodeInferenceDevice = z.infer<typeof NodeInferenceDeviceSchema>
export type NodeInferenceDevices = z.infer<typeof NodeInferenceDevicesSchema>
export type InferenceDeviceExclusionReason = z.infer<typeof InferenceDeviceExclusionReasonSchema>

export {
  AgentLoadSummarySchema,
  CameraAssignmentStatusSchema,
  CameraAudioStatusSchema,
  CameraBrokerProfileSchema,
  CameraBrokerStatusSchema,
  CameraDecoderStatusSchema,
  CameraDetectionPhaseSchema,
  CameraDetectionProvisioningSchema,
  CameraDetectionProvisioningStateSchema,
  CameraDetectionStatusSchema,
  CameraMotionStatusSchema,
  CameraPipelineConfigSchema,
  CameraRecordingModeSchema,
  CameraRecordingStatusSchema,
  CameraSourceStatusSchema,
  CameraSourceStreamSchema,
  // Camera status aggregator schemas
  CameraStatusDegradationReasonSchema,
  CameraStatusDegradationSchema,
  CameraStatusSchema,
  CameraStatusStageSchema,
  CapabilityBindingsSchema,
  DiskReconcileJobSchema,
  GlobalMetricsSchema,
  INFERENCE_DEVICE_EXCLUSION_REASONS,
  InferenceDeviceExclusionReasonSchema,
  IngestOwnerSchema,
  PipelineAssignmentSchema,
}
