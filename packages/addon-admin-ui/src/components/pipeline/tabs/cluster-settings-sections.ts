/**
 * Cluster → Settings, as data: which titled card shows which settings.
 *
 * The settings come from three addons (orchestrator, pipeline-analytics,
 * pipeline-runner, plus the audio analyzer's backend) and are grouped by what
 * they are ABOUT, not by who stores them — the face encoder sits with the
 * face-matching knobs. Grouping is purely where a field is drawn
 * (`fieldKeys` / `sectionIds`); every key is still saved by its own addon.
 *
 * The cluster-scoped encoders (face, CLIP) are edited HERE and only here: they
 * are one row for the whole cluster (D651), and the step matrix shows them
 * read-only with a link to the card below (`settingsSectionForStep`).
 */
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  CLUSTER_STEP_SETTING_FIELDS,
  clusterModelSettingKey,
  clusterStepSettingKey,
  DETAIL_CROP_SECTION_ID,
  NATIVE_LEASE_SECTION_ID,
} from '@camstack/types'
import type { SettingsFieldScope } from '../../../lib/settings-field-scope'
import { PIPELINE_CLUSTER_FACE_ADDON, PIPELINE_CLUSTER_FACE_CAP } from '../pipeline-panel-addons'
import i18n from '../../../i18n/index'

export const ORCHESTRATOR = 'pipeline-orchestrator'
export const RUNNER = 'pipeline-runner'
export const AUDIO_ANALYZER = 'audio-analyzer'

/** One settings panel inside a card: one addon's schema, narrowed. */
export interface ClusterSettingsPanel {
  readonly addonId: string
  readonly capability?: string
  readonly sectionIds?: readonly string[]
  readonly fieldKeys?: readonly string[]
  readonly fieldScope?: SettingsFieldScope
}

export interface ClusterSettingsSection {
  /** `?section=` id; also what a link from the step matrix lands on. */
  readonly id: string
  readonly title: string
  readonly hint: string
  readonly panels: readonly ClusterSettingsPanel[]
}

/** The cluster-row keys (encoder + admission knobs) that belong to one step. */
function clusterKeysFor(stepId: string): readonly string[] {
  return [
    ...CLUSTER_MODEL_SCOPED_STEPS.filter((s) => s.stepId === stepId).map((s) =>
      clusterModelSettingKey(s.stepId),
    ),
    ...CLUSTER_STEP_SETTING_FIELDS.filter((f) => f.stepId === stepId).map((f) =>
      clusterStepSettingKey(f.stepId, f.key),
    ),
  ]
}

export const FACES_SECTION_ID = 'faces'
export const SEMANTIC_SEARCH_SECTION_ID = 'semantic-search'
export const LOAD_BALANCER_SECTION_ID = 'load-balancer'
/** The orchestrator's own settings-section id for the four load-balancer knobs. */
export const LOAD_SETTINGS_SECTION_ID = 'load'

export const CLUSTER_SETTINGS_SECTIONS: readonly ClusterSettingsSection[] = [
  {
    id: FACES_SECTION_ID,
    get title() {
      return i18n.t('helpers.clusterSettingsSections.facesTitle')
    },
    get hint() {
      return i18n.t('helpers.clusterSettingsSections.facesHint')
    },
    panels: [
      { addonId: ORCHESTRATOR, fieldKeys: clusterKeysFor('face-embedding') },
      { addonId: PIPELINE_CLUSTER_FACE_ADDON, capability: PIPELINE_CLUSTER_FACE_CAP },
    ],
  },
  {
    id: SEMANTIC_SEARCH_SECTION_ID,
    get title() {
      return i18n.t('helpers.clusterSettingsSections.semanticTitle')
    },
    get hint() {
      return i18n.t('helpers.clusterSettingsSections.semanticHint')
    },
    panels: [{ addonId: ORCHESTRATOR, fieldKeys: clusterKeysFor('clip-embedding') }],
  },
  {
    id: DETAIL_CROP_SECTION_ID,
    get title() {
      return i18n.t('helpers.clusterSettingsSections.cropTitle')
    },
    get hint() {
      return i18n.t('helpers.clusterSettingsSections.cropHint')
    },
    panels: [{ addonId: ORCHESTRATOR, sectionIds: [DETAIL_CROP_SECTION_ID] }],
  },
  {
    id: NATIVE_LEASE_SECTION_ID,
    get title() {
      return i18n.t('helpers.clusterSettingsSections.nativeTitle')
    },
    get hint() {
      return i18n.t('helpers.clusterSettingsSections.nativeHint')
    },
    panels: [{ addonId: ORCHESTRATOR, sectionIds: [NATIVE_LEASE_SECTION_ID] }],
  },
  {
    id: 'runner-defaults',
    get title() {
      return i18n.t('helpers.clusterSettingsSections.runnerTitle')
    },
    get hint() {
      return i18n.t('helpers.clusterSettingsSections.runnerHint')
    },
    panels: [
      { addonId: RUNNER, fieldScope: 'cluster' },
      { addonId: AUDIO_ANALYZER, fieldScope: 'cluster' },
    ],
  },
  {
    id: LOAD_BALANCER_SECTION_ID,
    get title() {
      return i18n.t('helpers.clusterSettingsSections.loadTitle')
    },
    get hint() {
      return i18n.t('helpers.clusterSettingsSections.loadHint')
    },
    panels: [{ addonId: ORCHESTRATOR, sectionIds: [LOAD_SETTINGS_SECTION_ID] }],
  },
  {
    id: 'failover',
    get title() {
      return i18n.t('helpers.clusterSettingsSections.failoverTitle')
    },
    get hint() {
      return i18n.t('helpers.clusterSettingsSections.failoverHint')
    },
    panels: [{ addonId: ORCHESTRATOR, sectionIds: ['failover'] }],
  },
]

/**
 * Old `?section=` ids → the card that now holds them, so a bookmarked link
 * still lands somewhere sensible.
 */
export const LEGACY_SECTION_ALIASES: Readonly<Record<string, string>> = {
  'cluster-step-models': FACES_SECTION_ID,
}

/** The card a cluster-scoped step's encoder is edited in. */
export function settingsSectionForStep(stepId: string): string {
  return stepId === 'clip-embedding' ? SEMANTIC_SEARCH_SECTION_ID : FACES_SECTION_ID
}
