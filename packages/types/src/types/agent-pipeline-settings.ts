/**
 * Agent + camera pipeline settings — the persisted shapes that back the
 * 3-level resolution model:
 *
 *   1. Agent declares which addons it runs by default (every addonId in
 *      the catalog gets an entry with enabled/modelId/settings). Seeded
 *      automatically from the catalog on first boot, editable after.
 *
 *   2. Camera opts in or out of specific addonIds via a boolean overlay
 *      (`stepToggles`). Absent = inherit agent. Present = force.
 *
 *   3. A model is chosen by the accelerator that runs it (D927): a camera
 *      turns steps on or off and may carry camera-semantic step settings,
 *      never a model, a model-bound threshold or a tree of its own.
 *
 * The resolver walks this chain and emits the existing
 * `CameraPipelineConfig` shape that the runner consumes — no changes
 * required downstream of the orchestrator.
 */
import type { NodeColorId } from '../node-color.js'

// Phase 2f: `AgentHwAccelSettings` removed. Hwaccel ownership moved to
// the decoder addon (`decoder-nodeav`) global settings — `hwaccel` +
// `probedBestHwaccel`, read per node through `decoder.getInfo`.

/**
 * Per-(node,device) BASE provisioning for one step: the model + intrinsic
 * settings the executing node applies for EVERY camera landing on that
 * accelerator. Both fields optional — absent = the executor resolves its own
 * format default at runtime. The ONE authority over which model a step runs
 * on an accelerator (D927) — no camera layer overrides it.
 */
export interface DeviceStepConfig {
  readonly modelId?: string
  readonly settings?: Readonly<Record<string, unknown>>
  /**
   * Step-tree device jump (same-node, phase 1) — OPTIONAL operator override.
   * The `<backend>:<device>` key of another ENABLED device on the SAME node
   * this step should run on, bypassing the runtime AUTO-jump. Validated at save
   * (a disabled/absent target is rejected). Absent ⇒ the runner auto-jumps only
   * when the effective device's format cannot run the step's model.
   */
  readonly jumpDeviceKey?: string
}

/**
 * Per-agent pipeline settings. Phase 2f: engine + hwaccel + audio
 * ownership moved to per-addon global settings (detection-pipeline,
 * decoder-nodeav/ffmpeg, audio-analyzer). What's left on the
 * orchestrator is the per-step defaults map (modelId / step settings)
 * consumed by the resolver. Engine is node-local — each executing node
 * resolves its own format default at dispatch time; it is never stored
 * on these settings nor carried on the attach payload.
 */
export interface AgentPipelineSettings {
  /**
   * Optional per-node camera capacity cap. When set, the load balancer will
   * not assign more than this many cameras to this agent. `null` = unlimited.
   * Defaults to `null` on the Zod schema so existing persisted blobs load
   * without migration.
   */
  readonly maxCameras?: number | null
  /**
   * Optional per-node detection WEIGHT (relative share). Unpinned cameras
   * distribute proportionally to weight across detect-capable nodes (e.g.
   * Mac 60 / hub 30 / N100 10). `undefined`/absent = weight 1 (equal share,
   * back-compat: identical to score-only balancing). Ceiling (`maxCameras`)
   * still clamps on top of the weight share.
   */
  readonly detectWeight?: number
  /**
   * Placement capabilities (placement-model-design §6) — the per-node record
   * that replaced the four flat orchestrator lists (`enabledNodes`,
   * `enabledDecoderNodes`, `enabledAudioNodes`, `remoteSourcingNodes`). Each
   * flag is optional; an absent flag is ON for every node (only an
   * explicit `false` turns a role off). The orchestrator derives its
   * enabled-node sets from these flags across the cluster.
   */
  readonly detect?: boolean
  /**
   * @deprecated DEPRECATED AND IGNORED. Decode is always co-located with its
   * frame consumer (the shm ring is node-local; off-owner detection decodes
   * locally via the satellite plane), so a separate per-node decode flag is
   * meaningless: decode eligibility IS detect eligibility. The field is kept
   * OPTIONAL purely so persisted stores written before the removal still
   * parse — no code reads it and no write path emits it.
   */
  readonly decode?: boolean
  readonly audio?: boolean
  /** This node's decode RAM budget, MB — wins over the cluster `nodeDecodeBudgetMb` (D365). */
  readonly decodeBudgetMb?: number
  /** This node's live decode-worker cap — wins over the cluster `maxLiveDecodeWorkers` (D365). */
  readonly maxLiveDecodeWorkers?: number
  readonly ingest?: boolean
  /**
   * Operator override for the LAN host a cross-node decoder dials to reach
   * THIS node's restream (Cluster UI). Absent → auto-detect: a remote runner
   * falls back to its `CAMSTACK_HUB_URL`-derived host. Set only when the
   * auto-detected address is wrong (multi-homed host, NAT, custom interface).
   */
  readonly reachableHost?: string
  /**
   * Hub-persisted UI colour for this node (Cluster / Nodes). Absent until
   * first `listAgentSettings` ensure or an operator edit; auto-assigned from
   * `assignNodeColorId(nodeId)` when missing.
   */
  readonly color?: NodeColorId
  /**
   * NODE-wide step settings (D927): `[stepId] → { fieldKey → value }`, the
   * content that holds on every accelerator of this node (an allow-list of
   * species, an IoU). Never a model or a model-bound threshold — those belong
   * to the accelerator (`inferenceDevices[key].steps[step]`). Merged under
   * the device's own settings at dispatch; a sibling device entry is never
   * read.
   */
  readonly stepSettings?: Readonly<
    Record<string /* stepId */, Readonly<Record<string /* fieldKey */, unknown>>>
  >
  /**
   * Multi-device inference opt-in (Phase 4 multi-device). Maps a device key
   * (`openvino:npu`, `openvino:gpu`, `edgetpu:usb`, `edgetpu:usb:1`, `cpu`, …
   * from `enumerateInferenceDevices`) to whether the orchestrator may dispatch
   * detection SESSIONS onto that device's pool, plus a relative `weight`.
   *
   * Absent / all-disabled ⇒ the node runs detection on its single DEFAULT
   * device (the runner picks it; deviceKey is left unset) — the safe default:
   * one best accelerator, others opt-in. When TWO+ keys are enabled the
   * dispatcher balances new sessions across them (weighted, by active-session
   * count) so the accelerators run CONCURRENTLY.
   *
   * `steps` (per-(node,device) BASE provisioning) — an optional
   * `stepId → {modelId?, settings?}` map: the default model + intrinsic
   * settings for EVERY camera landing on that accelerator (no camera layer
   * overrides the model, D927). A stepId ABSENT ⇒
   * that step uses the device format default. A pinned modelId MUST have a
   * build for the device's FORMAT, else the executor's `resolveInputSteps`
   * substitutes it back to the format default (the UI only offers
   * format-compatible models, so a stored base is always valid).
   */
  readonly inferenceDevices?: Readonly<
    Record<
      string /* deviceKey */,
      {
        readonly enabled: boolean
        readonly weight?: number
        readonly maxSessions?: number
        readonly steps?: Readonly<Record<string /* stepId */, DeviceStepConfig>>
      }
    >
  >
}

/**
 * Per-camera pipeline settings. Sparse by design — a camera that has
 * accepted every agent default has an empty record here. `stepToggles`
 * are keyed on `addonId` (flat), not on tree-path, so operators can
 * enable/disable an addon irrespective of where it sits in the
 * resolved tree.
 */
export interface CameraPipelineSettings {
  readonly stepToggles?: Readonly<Record<string /* addonId */, boolean>>
  /**
   * Camera-wide step SETTINGS (D754, narrowed by D927): `[addonId] → { fieldKey
   * → value }`, the CAMERA-SEMANTIC fields this camera overrides on every
   * accelerator it is balanced onto (an allow-list of classes, a zone-driven
   * option). A sparse, field-level bag — a key present here is an override, an
   * absent key inherits the node. Merge order at dispatch, per key:
   * node ⊕ this. Never a model and never a model-bound threshold
   * ({@link isModelScopedStepSettingKey}): those belong to the accelerator that
   * runs the model — the writer refuses them and dispatch ignores a stored one.
   */
  readonly stepSettings?: Readonly<
    Record<string /* addonId */, Readonly<Record<string /* fieldKey */, unknown>>>
  >
}

/**
 * Is `key` a step setting that only the accelerator running the model may
 * carry (D927)? A model id, a model binding (`<key>ModelId`, D738) or a
 * confidence floor (`minConfidence*` — every `bindsToModel` field). A camera
 * layer never stores one: the floor of one model is wrong on the next, and a
 * camera does not know which accelerator — or which model — it lands on.
 * (Per-camera thresholds are a possible future extension, see D927.)
 */
export function isModelScopedStepSettingKey(key: string): boolean {
  return key === 'modelId' || key.endsWith('ModelId') || key.startsWith('minConfidence')
}

/** The keys of `bag` a camera layer may not carry ({@link isModelScopedStepSettingKey}), sorted. */
export function modelScopedStepSettingKeys(bag: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(bag).filter(isModelScopedStepSettingKey).toSorted()
}

/** `bag` without its model-scoped keys — what a camera layer contributes at dispatch. Fresh object. */
export function cameraScopedStepSettings(
  bag: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(bag).filter(([key]) => !isModelScopedStepSettingKey(key)),
  )
}
