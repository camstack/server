/**
 * Grouping map for the settings tabs of the device "Detection pipeline" tab
 * (the bar is Steps, then these groups).
 *
 * The Settings surface aggregates MANY contributed sections (object
 * detection, tracking, motion, stationary, zones, audio, cluster
 * assignment …) from three addons. Rendering them as one flat list
 * scrolled forever; this map folds each contributed section into a
 * second-level sub-tab keyed by the detection PIECE it configures, so the
 * operator navigates by concern instead of hunting a long column.
 *
 * Data-driven on purpose: a section lands in its group by `id`, and any
 * section id not listed here falls through to {@link DEFAULT_SETTINGS_GROUP}
 * so a newly-contributed section is never silently dropped — it just shows
 * up under the default group until it's mapped explicitly.
 */

import i18n from '../../../i18n/index'

/** A tab whose label is resolved on read, so a language switch is picked up. */
function groupTab(id: string, labelKey: string, icon: string) {
  return {
    id,
    get label(): string {
      return i18n.t(labelKey)
    },
    icon,
  }
}

/**
 * Sub-tab groups, in the order they appear in the bar. `icon` satisfies the
 * `ConfigTabDeclaration` shape the aggregate merges these into (the sub-tab
 * bar itself renders labels only).
 */
export const SETTINGS_GROUP_TABS: ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly icon: string
}> = [
  groupTab('zones', 'helpers.detectionSettingsGroups.zones', 'shapes'),
  groupTab('object-detection', 'helpers.detectionSettingsGroups.objectDetection', 'scan-search'),
  groupTab('tracking', 'helpers.detectionSettingsGroups.tracking', 'route'),
  groupTab('motion', 'helpers.detectionSettingsGroups.motion', 'activity'),
  groupTab('stationary', 'helpers.detectionSettingsGroups.stationary', 'square-parking'),
  groupTab('audio', 'helpers.detectionSettingsGroups.audio', 'volume-2'),
  groupTab('cluster', 'helpers.detectionSettingsGroups.cluster', 'server'),
]

/** Group a section lands in when its id isn't in {@link SECTION_TO_GROUP}. */
export const DEFAULT_SETTINGS_GROUP = 'object-detection'

/**
 * Contributed section id → group id. Section ids come from the actual
 * contributions:
 *   - orchestrator (`settings-ui-schemas.ts` + `device-config-contributions.ts`):
 *     `pipeline-object-detection`, `pipeline-audio`, `motion-tuning`,
 *     `occupancy`, `cluster-assignment`, `zones`, `orchestrator-live`.
 *   - post-analysis (`pipeline-analytics`): `detection-sensitivity`,
 *     `tracking`, `stationary-objects`.
 */
const SECTION_TO_GROUP: Readonly<Record<string, string>> = {
  // Object detection — when/how the detector runs + confidence/NMS.
  'pipeline-object-detection': 'object-detection',
  'detection-sensitivity': 'object-detection',
  // Tracking — the tracker + the false-positive dedup/voting/confirm knobs.
  tracking: 'tracking',
  // Motion — analyzer tuning (sources, stream, fps, cooldown).
  'motion-tuning': 'motion',
  // Stationary — parked-object promotion + occupancy re-sampling.
  'stationary-objects': 'stationary',
  occupancy: 'stationary',
  // Zones — the polygon zone editor + per-stage rules.
  zones: 'zones',
  // Audio — audio classification mode.
  'pipeline-audio': 'audio',
  // Cluster — per-camera node placement + live assignment status.
  'cluster-assignment': 'cluster',
  'orchestrator-live': 'cluster',
}

/** Resolve the sub-tab group id for a contributed section id. */
export function groupOfSettingsSection(sectionId: string): string {
  return SECTION_TO_GROUP[sectionId] ?? DEFAULT_SETTINGS_GROUP
}
