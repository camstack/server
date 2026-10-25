/**
 * Settings-redesign Phase 9 — hardcoded addon id lists that drive the
 * Pipeline page panels.
 *
 * Decision from the brainstorming: UI routing is explicit, not derived
 * from capability manifests or scope markers. Each Pipeline tab passes a
 * literal `addonIds` array to `NodeAddonsSettingsPanel`. The panel then
 * calls `addons.get*Settings` for each and silently drops addons that
 * return `null` (don't implement that level) — so this list is the
 * authoritative roster of pipeline-participating addons the Pipeline
 * page knows about.
 *
 * When a new addon joins the pipeline family, add it here + declare the
 * appropriate `get*Settings` method in the addon itself. No UI changes
 * beyond this file are required.
 */

/**
 * Addon ids whose **addon-level** settings are rendered in
 * Cluster → Pipeline → Settings. Orchestrator owns cluster-wide
 * placement / crop / encoder knobs. Face matching lives on the
 * `face-gallery` cap of `pipeline-analytics` — Cluster Settings asks
 * for that cap so the panel is the same store as System → Settings,
 * not a second copy.
 */
export const PIPELINE_CLUSTER_DEFAULT_ADDONS = ['pipeline-orchestrator'] as const

/** Provider of `face-gallery`. Matching knobs are its global settings, scoped by cap. */
export const PIPELINE_CLUSTER_FACE_ADDON = 'pipeline-analytics' as const

export const PIPELINE_CLUSTER_FACE_CAP = 'face-gallery' as const

/**
 * Addon ids whose **device-level** settings are rendered in
 * Cluster → Pipeline → Device Overrides. The panel iterates each
 * addon and asks it for `getDeviceSettings(deviceId)`; addons that
 * don't implement that level fall off silently.
 *
 * Current members (migrated in Phase 3):
 *  - `pipeline-orchestrator`: motionFps / detectionFps / routing /
 *    motionCooldownMs per camera
 *  - `motion-wasm`: threshold / minArea / blur / dilate per camera
 *  - `audio-analyzer`: minConfidence / enabledAudioClasses per camera
 *  - `detection-pipeline`: per-device object detection settings
 *    (enabled classes, per-class confidence thresholds)
 */
export const PIPELINE_CLUSTER_DEVICE_ADDONS = [
  'pipeline-orchestrator',
  'motion-wasm',
  'audio-analyzer',
  'detection-pipeline',
] as const

/**
 * Addon ids whose **addon-level** settings are rendered on the per-node
 * Pipeline → Settings tab. Orchestrator is excluded because its addon
 * settings belong to the Cluster page; everything else on the pipeline
 * roster that exposes addon-level config appears here.
 *
 * Today only `pipeline-runner` has node-local tuning fields (queue
 * depth / concurrency / target load / minThrottledFps). Other pipeline
 * addons either have nothing at the addon level or surface their
 * per-node config via their own dedicated cap methods.
 */
export const PIPELINE_NODE_SETTINGS_ADDONS = ['pipeline-runner'] as const
