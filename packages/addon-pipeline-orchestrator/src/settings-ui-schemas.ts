/**
 * Pure settings-UI schema builders + the pure derivation half of
 * `applyRuntimeSettings`, extracted verbatim from `index.ts` (S2 refactor
 * step — zero behavior change).
 *
 * `globalSettingsSchema` / `deviceSettingsSchema` / `applyRuntimeSettings`
 * stay on the class as thin delegates: they gather the `this`-scoped inputs
 * (node-id lists, private-static defaults) these builders can't reach
 * directly and pass them in explicitly, so the section-building logic is a
 * pure, independently-testable function of its inputs.
 */
import type { ConfigSection } from '@camstack/types'
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  CLUSTER_MODEL_SECTION_ID,
  CLUSTER_STEP_SETTING_FIELDS,
  clusterModelSettingKey,
  clusterStepSettingKey,
  DEFAULT_DETAIL_CROP_CONVENTION,
  DEFAULT_SESSION_PLACEMENT_POLICY,
  SESSION_PLACEMENT_SETTING_KEY,
  DETAIL_CROP_PADDING_FIELD,
  DETAIL_CROP_PADDING_KEY,
  DETAIL_CROP_SECTION_ID,
  DETAIL_CROP_SQUARE_KEY,
  FACE_RESCORE_INTERVAL_FIELD,
  FACE_RESCORE_INTERVAL_KEY,
  FACE_RESCORE_SECTION_ID,
  NATIVE_LEASE_ACTIVITY_FIELD,
  NATIVE_LEASE_ACTIVITY_KEY,
  NATIVE_LEASE_ADMISSION_FIELD,
  NATIVE_LEASE_ADMISSION_KEY,
  NATIVE_LEASE_BUDGET_FIELD,
  NATIVE_LEASE_BUDGET_KEY,
  NATIVE_LEASE_HOLD_FIELD,
  NATIVE_LEASE_HOLD_KEY,
  NATIVE_LEASE_SCENE_BUDGET_FIELD,
  NATIVE_LEASE_SCENE_BUDGET_KEY,
  NATIVE_LEASE_SECTION_ID,
  NATIVE_LEASE_TILE_BUDGET_FIELD,
  NATIVE_LEASE_TILE_BUDGET_KEY,
  RunnerCameraDeviceUIFields,
  readDetailCropConvention,
} from '@camstack/types'
import { ACTIVITY_DETECTION_FPS_DEFAULT } from './device-detection-settings.js'
import {
  type ClusterRoles,
  DEFAULT_FAILOVER_POLICY,
  type FailoverPolicy,
} from './orchestrator-types.js'

/**
 * Inputs the global-settings schema reads from the class that a free
 * function can't reach directly (private statics).
 */
export interface GlobalSettingsSchemaOptions {
  /**
   * `PipelineOrchestratorAddon.DEFAULT_FPS_MIN_THRESHOLD` — default for the
   * load-balancer's `fpsMinThreshold` slider.
   */
  readonly fpsMinThresholdDefault: number
}

// Store identity of the cluster-wide crop convention. Defined in
// `@camstack/types` (NOT here) because the reader is a different addon — the
// pipeline runner, which reads this addon's global settings through the
// hub-routed `addon-settings` cap, the same neutral-owner idiom
// `decoder-backend.ts` uses. Addons never import each other, so a key defined
// here would have to be hand-copied there, and a hand-copied key is how a
// setting silently stops arriving. Re-exported so this module's own UI and
// tests name the same constants.
export {
  CLUSTER_MODEL_SECTION_ID,
  clusterModelSettingKey,
  DETAIL_CROP_PADDING_KEY,
  DETAIL_CROP_SECTION_ID,
  DETAIL_CROP_SQUARE_KEY,
  readDetailCropConvention,
}

/** Build the addon-level schema sections (cluster roles + crop + balancer + failover). */
export function buildGlobalSettingsSections(options: GlobalSettingsSchemaOptions): ConfigSection[] {
  // The per-concern enable multiselects were removed in the placement-model
  // redesign — node capabilities now live in the per-node agent-settings
  // store (`setAgentCapabilities`). This schema exposes only the cluster-wide
  // singleton ROLE selectors (`node-select`, options populated dynamically by
  // the UI) plus the balancer + failover tunables. `hub` is the default for
  // every role — the only node guaranteed to exist on a single-node cluster.
  return [
    // ── Cluster roles ─────────────────────────────────────────────
    {
      id: 'cluster',
      title: 'Cluster Roles',
      tab: 'pipeline',
      description:
        'Cluster-wide singleton roles: the single node that serves each role for every camera. Per-node detection/decode/audio CAPABILITIES + weights + camera caps are edited in the per-node capability table (agent settings), not here.',
      fields: [
        {
          key: 'ingestNode',
          type: 'node-select' as const,
          label: 'Ingest Node',
          description:
            'The node that connects every camera and serves the compressed restream. Defaults to the hub. (Arbitrary ingest ≠ hub is a later phase; kept here so the role is modeled.)',
          default: 'hub',
          showOffline: true,
        },
        {
          key: 'audioNode',
          type: 'node-select' as const,
          label: 'Audio Node',
          description:
            'The node that runs all audio analysis. Defaults to the hub. Must be an audio-capable node.',
          default: 'hub',
          showOffline: true,
        },
        {
          key: 'motionNode',
          type: 'node-select' as const,
          label: 'Motion Node',
          default: 'hub',
          showOffline: true,
          description:
            'Node that hosts software (analyzer) motion-watch. Analyzer cameras run their grey-decode motion analysis here; onboard (hardware-motion) cameras are unaffected.',
        },
      ],
    },
    // ── Load Balancer ────────────────────────────────────────────
    {
      id: 'load',
      title: 'Load Balancer',
      tab: 'pipeline',
      fields: [
        {
          key: SESSION_PLACEMENT_SETTING_KEY,
          type: 'select',
          label: 'Session placement',
          description:
            'How a new detection session picks its node and device. Honour shares (default) = the share of PARALLEL sessions is held to the node and device shares, and a node at its cap yields to a free one. Least-loaded = the node with the fewest sessions per unit of weight; an idle node always wins the tie, so weights only matter once nodes are busy.',
          options: [
            { value: 'share', label: 'Honour shares' },
            { value: 'least-loaded', label: 'Least-loaded' },
          ],
          default: DEFAULT_SESSION_PLACEMENT_POLICY,
        },
        {
          key: 'fpsMinThreshold',
          type: 'slider',
          label: 'Min FPS Threshold',
          description:
            "Per-camera low-FPS load shedding. If a camera sustains FPS below this value for the duration set by 'Low FPS Window' below, it is paused (load-shed) and new dispatches are blocked. Auto-resumes with exponential backoff. 0 = disabled (default) — a single slow camera is never detached; only capacity-based placement applies.",
          min: 0,
          max: 10,
          step: 1,
          default: options.fpsMinThresholdDefault,
          showValue: true,
          unit: 'fps',
        },
        {
          key: 'nodeStressMode',
          type: 'select',
          label: 'Node stress handling',
          description:
            'When a node is saturated (queue pressure, dropped frames and delivered-vs-configured fps of active cameras), Failover moves one of its cameras to an idle node. One camera at a time, a cooldown per camera, never back to the node it just left, at most 4 moves an hour across the cluster. A camera is never paused. Observe only logs the verdict; Off does nothing.',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'observe', label: 'Observe (log only)' },
            { value: 'failover', label: 'Failover (relocate a camera)' },
          ],
          default: 'failover',
        },
        {
          key: 'fpsLowWindowMs',
          type: 'slider',
          label: 'Low FPS Window',
          description:
            'How long a camera must stay below the Min FPS Threshold before it is paused. Resets the moment FPS recovers above threshold. Larger values tolerate longer cold-start / GC stalls without false-killing the camera.',
          min: 5_000,
          max: 600_000,
          step: 5_000,
          default: 60_000,
          showValue: true,
          unit: 's',
          displayScale: 1000,
        },
      ],
    },
    // ── Cluster model choices ─────────────────────────────────────
    //
    // ONE row for the whole cluster, per step whose definition declares
    // `modelScope: 'cluster'`. See `packages/types/src/pipeline/cluster-model-scope.ts`
    // for why these two steps and no others, and why the value can never become
    // per-node. The choices are the catalog's own, mirrored into
    // `CLUSTER_MODEL_SCOPED_STEPS` and kept honest by
    // `scripts/check-cluster-model-scope.ts` — the orchestrator may not import
    // the pipeline addon that owns the catalog.
    {
      id: CLUSTER_MODEL_SECTION_ID,
      title: 'Enrichment models',
      tab: 'pipeline',
      description:
        'The face and search encoders, one each for the whole cluster: each fills a single shared index, and vectors from two models cannot be compared. Changing one keeps what is stored but hides it from matching and search until it is re-embedded.',
      fields: [
        ...CLUSTER_MODEL_SCOPED_STEPS.map((step) => ({
          key: clusterModelSettingKey(step.stepId),
          type: 'select' as const,
          label: step.label,
          description: `Used on every node. A node that has no build of this model skips the step (and logs it) rather than use another model. Changing it hides what is already in ${step.indexName} until it is re-embedded.`,
          options: step.options.map((o) => ({ value: o.id, label: o.label })),
          default: step.defaultModelId,
        })),
        ...CLUSTER_STEP_SETTING_FIELDS.map((field) => ({
          key: clusterStepSettingKey(field.stepId, field.key),
          type: 'slider' as const,
          label: field.label,
          description: field.description,
          min: field.min,
          max: field.max,
          step: field.step,
          default: field.default,
          showValue: true,
        })),
      ],
    },
    // ── Detail crop convention ────────────────────────────────────
    // See `packages/types/src/pipeline/detail-crop.ts` for why this is one
    // cluster-wide value and can never become per-node or per-device.
    {
      id: DETAIL_CROP_SECTION_ID,
      title: 'Enrichment crop',
      tab: 'pipeline',
      description:
        'How the crop handed to the search, face and plate models is cut from the frame. One value for the whole cluster, because search results are only comparable when every crop is cut the same way. After changing it, rebuild the search index (Camera → Semantic search index → Rebuild).',
      fields: [
        {
          key: DETAIL_CROP_PADDING_KEY,
          type: 'slider',
          label: 'Crop margin',
          description:
            'Extra margin added on each side of the detection box, as a fraction of its size. 0 = tight box, 0.15 = default. Search works better with some surroundings in the crop.',
          min: DETAIL_CROP_PADDING_FIELD.min,
          max: DETAIL_CROP_PADDING_FIELD.max,
          step: DETAIL_CROP_PADDING_FIELD.step,
          default: DETAIL_CROP_PADDING_FIELD.default,
          showValue: true,
        },
        {
          key: DETAIL_CROP_SQUARE_KEY,
          type: 'boolean',
          label: 'Square the crop',
          description:
            'Widen the crop to a square so a tall subject is not squashed when the model resizes it. Off by default because the existing index was built without it.',
          default: DEFAULT_DETAIL_CROP_CONVENTION.square,
        },
      ],
    },
    // ── Face suggestions refresh (D866) ───────────────────────────
    // Cluster-wide: the gallery is one table. Read by pipeline-analytics on
    // every tick, so a change applies without a restart.
    {
      id: FACE_RESCORE_SECTION_ID,
      title: 'Face suggestions',
      tab: 'pipeline',
      description:
        'How often the people suggestions on unassigned faces are refreshed against the current gallery. The job only runs when the gallery or the set of unassigned faces changed since the last run; otherwise it does nothing.',
      fields: [
        {
          key: FACE_RESCORE_INTERVAL_KEY,
          type: 'slider',
          label: 'Suggestion refresh interval',
          description:
            '0 = off (use the Recompute suggestions button). Values from 1 to 9 run every 10 minutes. The first run happens one interval after the addon starts.',
          min: FACE_RESCORE_INTERVAL_FIELD.min,
          max: FACE_RESCORE_INTERVAL_FIELD.max,
          step: FACE_RESCORE_INTERVAL_FIELD.step,
          default: FACE_RESCORE_INTERVAL_FIELD.default,
          showValue: true,
          unit: 'min',
        },
      ],
    },
    // ── Native-frame lease ────────────────────────────────────────
    // The decode worker's native-resolution frame retention. Cluster-wide for
    // the same reason the crop convention is: it decides whether a stored crop
    // is native pixels or the ≤640 detection-frame fallback, and that must not
    // depend on which node the balancer happened to pick. Read by the
    // pipeline-runner over the hub-routed `addon-settings` cap and injected
    // into each decode worker at fork time — see
    // `packages/types/src/pipeline/native-lease.ts`.
    {
      id: NATIVE_LEASE_SECTION_ID,
      title: 'Native frame lease',
      tab: 'pipeline',
      description:
        'How each camera keeps full-resolution pixels so a crop taken seconds later (snapshot, face, plate) is sharp instead of cut from the small detection frame. A held frame is a whole picture (~25 MB at 4K) kept until its detections arrive; a tile is one subject, or one whole-scene copy, saved as JPEG for tens of seconds. Applies from the next session of each camera.',
      fields: [
        {
          key: NATIVE_LEASE_HOLD_KEY,
          type: 'slider',
          label: 'Frames held at once',
          description:
            'Most frames kept per camera while their detections are pending; past it the oldest is dropped. 1 to 4 are in use normally. Raise it only if a slow node drops frames (holdOverflow in the logs) — it does not make crops sharper.',
          min: NATIVE_LEASE_HOLD_FIELD.min,
          max: NATIVE_LEASE_HOLD_FIELD.max,
          step: NATIVE_LEASE_HOLD_FIELD.step,
          default: NATIVE_LEASE_HOLD_FIELD.default,
          showValue: true,
          unit: 'frames',
        },
        {
          key: NATIVE_LEASE_TILE_BUDGET_KEY,
          type: 'slider',
          label: 'Subject tile RAM',
          description:
            'RAM per camera for subject tiles: full-resolution crops of each detected subject, kept so a crop asked for seconds later is still sharp. A tile is ~60-120 KB. 0 = off (late crops come from the small detection frame).',
          min: NATIVE_LEASE_TILE_BUDGET_FIELD.min,
          max: NATIVE_LEASE_TILE_BUDGET_FIELD.max,
          step: NATIVE_LEASE_TILE_BUDGET_FIELD.step,
          default: NATIVE_LEASE_TILE_BUDGET_FIELD.default,
          showValue: true,
          unit: 'MB',
        },
        {
          key: NATIVE_LEASE_SCENE_BUDGET_KEY,
          type: 'slider',
          label: 'Scene tile RAM',
          description:
            'RAM per camera for scene tiles: a full-resolution JPEG of the whole picture (~2 MB at 4K) on frames where something was detected, for key frames and whole-frame crops. 0 = off (those then fall back to the small detection frame).',
          min: NATIVE_LEASE_SCENE_BUDGET_FIELD.min,
          max: NATIVE_LEASE_SCENE_BUDGET_FIELD.max,
          step: NATIVE_LEASE_SCENE_BUDGET_FIELD.step,
          default: NATIVE_LEASE_SCENE_BUDGET_FIELD.default,
          showValue: true,
          unit: 'MB',
        },
        {
          key: NATIVE_LEASE_BUDGET_KEY,
          type: 'slider',
          label: 'Lease RAM ceiling',
          description:
            'Safety ceiling on the RAM held frames may use per camera; the frame count above is what normally limits it. Lower it on a small host. 0 turns full-resolution crops off almost entirely — for diagnosis only.',
          min: NATIVE_LEASE_BUDGET_FIELD.min,
          max: NATIVE_LEASE_BUDGET_FIELD.max,
          step: NATIVE_LEASE_BUDGET_FIELD.step,
          default: NATIVE_LEASE_BUDGET_FIELD.default,
          showValue: true,
          unit: 'MB',
        },
        {
          key: NATIVE_LEASE_ACTIVITY_KEY,
          type: 'slider',
          label: 'Demand window',
          description:
            'Keep full-resolution pixels only within this long of the last crop request, so a camera nobody crops costs nothing; the first crop after a quiet spell falls back once. 0 = always keep (heavy on small hosts).',
          min: NATIVE_LEASE_ACTIVITY_FIELD.min,
          max: NATIVE_LEASE_ACTIVITY_FIELD.max,
          step: NATIVE_LEASE_ACTIVITY_FIELD.step,
          default: NATIVE_LEASE_ACTIVITY_FIELD.default,
          showValue: true,
          unit: 's',
          displayScale: 1000,
        },
        {
          key: NATIVE_LEASE_ADMISSION_KEY,
          type: 'select',
          label: 'What to retain',
          description:
            "Which frames get a full-resolution copy. 'Only frames sent to inference' keeps the frames a crop can actually ask for (about 80% less RAM); 'Every delivered frame' keeps all of them.",
          options: NATIVE_LEASE_ADMISSION_FIELD.options,
          default: NATIVE_LEASE_ADMISSION_FIELD.default,
        },
      ],
    },
    // ── Failover policy ───────────────────────────────────────────
    {
      id: 'failover',
      title: 'Failover Policy',
      fields: [
        {
          key: 'onDisconnect',
          type: 'select',
          label: 'When a node disconnects',
          description: 'Move its unpinned cameras to other nodes, or leave them stopped.',
          default: DEFAULT_FAILOVER_POLICY.onDisconnect,
          options: [
            { value: 'migrate', label: 'Migrate non-pinned cameras' },
            {
              value: 'leave-unassigned',
              label: 'Leave all cameras unassigned',
            },
          ],
        },
        {
          key: 'pinnedOnDisconnect',
          type: 'select',
          label: 'Its pinned cameras',
          description: 'Keep the pin and wait for the node, or drop the pin and move them.',
          default: DEFAULT_FAILOVER_POLICY.pinnedOnDisconnect,
          options: [
            { value: 'leave-pinned', label: 'Leave pinned, unassigned' },
            { value: 'unpin-and-migrate', label: 'Auto-unpin and migrate' },
          ],
        },
        {
          key: 'onReconnect',
          type: 'select',
          label: 'When it comes back',
          description: 'Put its cameras back where they were, or rebalance the whole cluster.',
          default: DEFAULT_FAILOVER_POLICY.onReconnect,
          options: [
            { value: 'restore', label: 'Restore previous assignments' },
            { value: 'rebalance', label: 'Trigger full rebalance' },
          ],
        },
      ],
    },
  ]
}

/**
 * The node-id option list the device-settings schema's cluster-assignment
 * select needs (`collectRunnerNodeIds` on the topology service). There is no
 * decoder list: decode is always co-located with the detection pipeline
 * (detect ⇒ decode), so the former per-camera 'Decoder Node' select was
 * removed. There is no audio list either: audio runs on the cluster-wide
 * `clusterRoles.audioNode` singleton role, so the per-device 'Audio Node'
 * pin select was removed (the balancer keeps a dormant `audioNodeId`
 * escape hatch for legacy stored pins, but it is no longer operator-set).
 */
export interface NodeOptionLists {
  readonly runnerNodeIds: readonly string[]
}

/** Build the device-level schema sections (per-camera detection wiring). */
export function buildDeviceSettingsSections(nodeOptions: NodeOptionLists): ConfigSection[] {
  // Per-concern sections tagged with well-known tab ids. The device-
  // manager aggregator groups every contributor's sections by `tab`,
  // so these fields show up on the Motion / Object Detection / Audio
  // / Pipeline tabs alongside contributions from motion-detection,
  // object-detection, audio-analyzer, etc. The orchestrator owns the
  // per-camera enable flags + stream-profile routing + dispatch
  // rates because those are orchestration-level decisions; addon-
  // specific tuning (thresholds, minArea, …) stays with each addon.
  return [
    // ── Motion tab ────────────────────────────────────────────────
    // Motion on/off lives in the `motion-detection` wrapper binding
    // (BindingsTab). This section only exposes the tuning knobs —
    // sources, stream profile, FPS, cooldown. See F15a.
    //
    // The cap-1:1 fields (motionSources, motionFps, detectionFps,
    // motionCooldownMs) are imported from the pipeline-runner cap
    // so a single change to defaults / ranges in the cap propagates
    // to both the wire schema AND the rendered UI. The
    // orchestrator only adds fields it owns directly:
    //   - motionStreamProfile: transformed into motionStreamId
    //     (string) before dispatch — not in the cap-wire schema.
    {
      id: 'motion-tuning',
      title: 'Motion',
      // Hoisted into the consolidated `Detection pipeline → Settings` sub-tab
      // (top-tab) so per-camera motion tuning sits beside Object Detection /
      // Tracking / Stationary, instead of being buried under Config → Motion.
      tab: 'detection-pipeline',
      location: 'top-tab' as const,
      order: 4,
      fields: [
        ...RunnerCameraDeviceUIFields.filter(
          (f) =>
            f.key !== 'detectionFps' &&
            f.key !== 'occupancyRecheckSec' &&
            f.key !== 'occupancyRecheckFrames' &&
            f.key !== 'preRollInferenceEnabled' &&
            f.key !== 'preRollInferenceFrames',
        ),
        {
          key: 'motionStreamProfile',
          type: 'select',
          label: 'Motion Stream (analyzer)',
          default: 'low',
          options: [
            { value: 'high', label: 'High' },
            { value: 'mid', label: 'Medium' },
            { value: 'low', label: 'Low' },
          ],
          // Analyzer-only — same gate as motionFps / motionCooldownMs.
          showWhen: { field: 'motionSources', includes: 'analyzer' },
        },
      ],
    },
    // ── Orchestrator: Object Detection ────────────────────────────
    {
      id: 'pipeline-object-detection',
      title: 'Object Detection',
      tab: 'detection-pipeline',
      location: 'top-tab' as const,
      order: 5,
      description:
        'When the SW object detection pipeline (yolov9s, scrfd, …) runs for this camera. Wrappers stay bound regardless — the runner reads this mode at attach time to decide whether to pull the substream.',
      fields: [
        {
          key: 'detectionMode',
          type: 'select',
          label: 'Object detection',
          default: 'on-motion',
          options: [
            { value: 'disabled', label: 'Disabled' },
            { value: 'always-on', label: 'Always on' },
            { value: 'on-motion', label: 'On motion (firmware/PIR/SW)' },
          ],
        },
        {
          key: 'detectionStreamProfile',
          type: 'select',
          label: 'Detection Stream',
          default: 'high',
          options: [
            { value: 'high', label: 'High' },
            { value: 'mid', label: 'Medium' },
            { value: 'low', label: 'Low' },
          ],
          showWhen: { field: 'detectionMode', notEquals: 'disabled' },
        },
        {
          key: 'detectionFps',
          type: 'slider',
          label: 'Detection FPS',
          min: 1,
          max: 30,
          step: 1,
          default: 10,
          showValue: true,
          unit: 'fps',
          description: 'Maximum frames decoded and sent to object detection each second',
          showWhen: { field: 'detectionMode', notEquals: 'disabled' },
        },
        {
          key: 'activityDetectionFps',
          type: 'slider',
          label: 'Detection FPS while the device is working',
          min: 1,
          max: 10,
          step: 1,
          default: ACTIVITY_DETECTION_FPS_DEFAULT,
          showValue: true,
          unit: 'fps',
          description:
            'A device-activity session lasts as long as the job does — a cleaning run is tens of minutes. This caps the rate for that session only; a session opened by motion keeps the rate above.',
          showWhen: { field: 'motionSources', includes: 'device-activity' },
        },
      ],
    },
    // ── Orchestrator: Audio classification ────────────────────────
    {
      id: 'pipeline-audio',
      title: 'Audio classification',
      tab: 'detection-pipeline',
      location: 'top-tab' as const,
      order: 6,
      description:
        'When the audio classifier (apple-soundanalysis, etc.) runs for this camera. Default for battery cams: disabled (continuous audio holds the substream open).',
      fields: [
        {
          key: 'audioMode',
          type: 'select',
          label: 'Audio classification',
          default: 'always-on',
          options: [
            { value: 'disabled', label: 'Disabled' },
            { value: 'always-on', label: 'Always on' },
            { value: 'on-motion', label: 'On motion (firmware/PIR/SW)' },
          ],
        },
        // WHICH rung the classifier listens on. A rung, never a cam-stream id:
        // the id is broker-internal and changes when a slot is reassigned.
        // `auto` is the default and a real value — the lowest AVAILABLE rung
        // that is NATIVE, because an audio-only consumer must never cause a
        // video transcode (D537). An explicit rung is obeyed verbatim, and
        // refused by name if the camera stops publishing it.
        {
          key: 'audioStreamPick',
          type: 'select',
          label: 'Audio stream',
          default: 'auto',
          description:
            'Which camera stream the audio classifier listens on. Auto picks the lowest stream the camera serves natively — a transcoded stream is never started just to hear a camera.',
          options: [
            { value: 'auto', label: 'Auto (lowest native)' },
            { value: 'high', label: 'High' },
            { value: 'mid', label: 'Medium' },
            { value: 'low', label: 'Low' },
          ],
          showWhen: { field: 'audioMode', notEquals: 'disabled' },
        },
      ],
    },
    // ── Orchestrator: Occupancy ───────────────────────────────────
    {
      id: 'occupancy',
      title: 'Occupancy',
      tab: 'detection-pipeline',
      location: 'top-tab' as const,
      order: 7,
      description:
        'Periodic re-sampling to keep stationary objects / occupancy fresh while the camera is idle (watching).',
      fields: RunnerCameraDeviceUIFields.filter(
        (f) => f.key === 'occupancyRecheckSec' || f.key === 'occupancyRecheckFrames',
      ),
    },
    // ── Runner: Pre-roll detection ────────────────────────────────
    // Its own section rather than a line inside Motion: this is about what the
    // DETECTOR looks at, not about how motion is sampled, and the operator who
    // goes looking for it will be asking "why did the track start late".
    {
      id: 'pre-roll-detection',
      title: 'Pre-roll detection',
      tab: 'detection-pipeline',
      location: 'top-tab' as const,
      order: 8,
      description:
        'When motion opens a session the camera has already buffered a few seconds of footage. Detecting over it finds a subject at the moment it appeared instead of after the decoder has warmed up.',
      fields: RunnerCameraDeviceUIFields.filter(
        (f) => f.key === 'preRollInferenceEnabled' || f.key === 'preRollInferenceFrames',
      ),
    },
    // ── Orchestrator: Cluster Assignment ──────────────────────────
    {
      id: 'cluster-assignment',
      title: 'Cluster Assignment',
      tab: 'detection-pipeline',
      location: 'top-tab' as const,
      order: 10,
      fields: [
        {
          key: 'pipelineNodeId',
          type: 'select',
          label: 'Pipeline Node',
          // Deferred-apply: saving this form persists the canonical
          // `pipelineNodeId` pin, but the OrchestrationSettingsUpdated
          // handler only restarts detection — the new pin migrates the
          // camera on the next dispatch/rebalance, not instantly. Use the
          // pipeline page's assign action for an immediate migration.
          description: 'Which node runs the detection pipeline for this camera.',
          options: [
            { value: 'auto', label: 'Auto (load balanced)' },
            ...nodeOptions.runnerNodeIds.map((id) => ({
              value: id,
              label: id,
            })),
          ],
          default: 'auto',
        },
        // The per-device 'Audio Node' pin was removed: audio analysis runs on
        // the cluster-wide `clusterRoles.audioNode` singleton role, not a
        // per-camera pin. (The audio balancer still honours a stored
        // `audioNodeId` as a dormant legacy escape hatch, but it is no longer
        // exposed for operators to set.)
      ],
    },
  ]
}

/** Pure derivation result of `deriveRuntimeSettings` — mirrors `applyRuntimeSettings`'s writes onto `this.failoverPolicy` / `this.clusterRoles`. */
export interface DerivedRuntimeSettings {
  readonly failoverPolicy: FailoverPolicy
  readonly clusterRoles: ClusterRoles
}

/**
 * Pure half of `applyRuntimeSettings`: derive `failoverPolicy` +
 * `clusterRoles` from the resolved global-settings config blob. The I/O
 * half (writing the derived values onto `this.`, plus scheduling the
 * pending-retry sweep) stays on the class.
 */
export function deriveRuntimeSettings(config: Record<string, unknown>): DerivedRuntimeSettings {
  const failoverPolicy: FailoverPolicy = {
    onDisconnect: config['onDisconnect'] === 'leave-unassigned' ? 'leave-unassigned' : 'migrate',
    pinnedOnDisconnect:
      config['pinnedOnDisconnect'] === 'unpin-and-migrate' ? 'unpin-and-migrate' : 'leave-pinned',
    onReconnect: config['onReconnect'] === 'rebalance' ? 'rebalance' : 'restore',
  }
  // Cluster singleton roles (placement-model §6). Each is a single
  // node-select; an absent / non-string value falls back to the hub —
  // the schema default and the only node guaranteed to exist.
  const readRole = (key: string): string => {
    const raw = config[key]
    return typeof raw === 'string' && raw.length > 0 && !raw.includes('/') ? raw : 'hub'
  }
  const clusterRoles: ClusterRoles = {
    ingestNode: readRole('ingestNode'),
    audioNode: readRole('audioNode'),
    motionNode: readRole('motionNode'),
  }
  return { failoverPolicy, clusterRoles }
}
