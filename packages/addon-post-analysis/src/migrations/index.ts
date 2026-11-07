import type { AddonMigration } from '@camstack/types'
import {
  migrateDeviceTemplateVariable,
  type NcTemplateMigrationPorts,
} from './device-template-var.js'
import {
  backfillRetrainVerdictFrames,
  type RetrainVerdictFramePorts,
} from './retrain-verdict-frames.js'
import { planRetireFaceKeys, type RetiredFaceKeysPorts } from './retired-face-keys.js'
import {
  type EnabledSplitPorts,
  PIPELINE_ANALYTICS_ID,
  planSplitEnabledKey,
} from './split-enabled-key.js'

export type { NcTemplateMigrationPorts } from './device-template-var.js'
export type { EnabledSplitPorts } from './split-enabled-key.js'
export type { RetiredFaceKeysPorts } from './retired-face-keys.js'
export type { RetrainVerdictFramePorts, StagedRetrainTrack } from './retrain-verdict-frames.js'

/** Everything the `pipeline-analytics` catalogue reads and writes. */
export type PipelineAnalyticsMigrationPorts = NcTemplateMigrationPorts &
  EnabledSplitPorts &
  RetiredFaceKeysPorts &
  RetrainVerdictFramePorts

export const SPLIT_ENABLED_KEY_MIGRATION_ID = 'pipeline-analytics/2026-11-05-split-enabled-key'
export const RETIRE_FACE_KEYS_MIGRATION_ID = 'pipeline-analytics/2026-11-07-retire-face-keys'
export const RETRAIN_VERDICT_FRAMES_MIGRATION_ID =
  'pipeline-analytics/2026-11-07-retrain-verdict-frames'

/** The `pipeline-analytics` catalogue (D987): offered to the engine at the hub's boot. */
export const ADDON_MIGRATIONS: readonly AddonMigration<PipelineAnalyticsMigrationPorts>[] = [
  {
    meta: {
      id: 'pipeline-analytics/2026-11-01-template-camera-to-device',
      owner: 'pipeline-analytics',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Rename the {{camera}} template variable to {{device}} in every stored notification rule, timelapse rule and text override',
      fixtureMark: 'the rule name and the trigger conditions the migration does not know',
    },
    procedure: migrateDeviceTemplateVariable,
  },
  {
    meta: {
      id: SPLIT_ENABLED_KEY_MIGRATION_ID,
      owner: PIPELINE_ANALYTICS_ID,
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      // The resolvers read the new keys: an owner that could not move the value must not serve
      // the defaults in place of an operator's choice.
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description:
        'Split the shared `enabled` setting into faceRecognitionEnabled and stationarySuppressionEnabled, copying the stored value into both, for the cluster and for every camera',
      fixtureMark: 'a setting the migration does not know',
    },
    plan: planSplitEnabledKey,
  },
  {
    meta: {
      id: RETIRE_FACE_KEYS_MIGRATION_ID,
      owner: PIPELINE_ANALYTICS_ID,
      level: 'addon-state',
      seq: 3,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      // The keys are declared by no scope and read by nobody: a pass that cannot run leaves them for the next boot.
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the retired suggestionMinCosine and minFaceConfidence settings from the cluster row, announcing the value each one held',
      fixtureMark: 'a setting the migration does not know',
    },
    plan: planRetireFaceKeys,
  },
  {
    meta: {
      id: RETRAIN_VERDICT_FRAMES_MIGRATION_ID,
      owner: PIPELINE_ANALYTICS_ID,
      level: 'addon-state',
      seq: 4,
      dependsOn: [],
      // Runs AFTER the retrain corpus is built (a second phase of the boot), not with the settings phase.
      store: 'settings',
      scope: 'cluster',
      // A track left without its frame is where it was before this migration.
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Copy the best frame of every retrain track an operator answered about on a notification and that holds none, and write a verdict given on a fused-away id under its survivor',
      fixtureMark: 'the rule name and the user the verdict row carries',
    },
    procedure: backfillRetrainVerdictFrames,
  },
]
