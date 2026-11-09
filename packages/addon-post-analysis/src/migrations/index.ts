import type { AddonMigration } from '@camstack/types'
import {
  migrateDeviceTemplateVariable,
  type NcTemplateMigrationPorts,
} from './device-template-var.js'
import {
  migrateRuleActionsToActions,
  type NcRuleActionsMigrationPorts,
} from './rule-actions-to-actions.js'
import {
  migrateSystemEventDeliveryModes,
  type NcSystemEventDeliveryPorts,
} from './system-event-delivery-modes.js'
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
export type { NcSystemEventDeliveryPorts } from './system-event-delivery-modes.js'
export type { EnabledSplitPorts } from './split-enabled-key.js'
export type { RetiredFaceKeysPorts } from './retired-face-keys.js'
export type { MigratedAction, NcMigrationActionsPort, NcRuleActionsMigrationPorts } from './rule-actions-to-actions.js'
export type { RetrainVerdictFramePorts, StagedRetrainTrack } from './retrain-verdict-frames.js'

/** Everything the `pipeline-analytics` catalogue reads and writes. */
export type PipelineAnalyticsMigrationPorts = NcTemplateMigrationPorts &
  EnabledSplitPorts &
  RetiredFaceKeysPorts &
  RetrainVerdictFramePorts &
  NcSystemEventDeliveryPorts &
  NcRuleActionsMigrationPorts

export const SYSTEM_EVENT_DELIVERY_MODES_MIGRATION_ID =
  'pipeline-analytics/2026-11-07-system-event-delivery-modes'
export const SPLIT_ENABLED_KEY_MIGRATION_ID = 'pipeline-analytics/2026-11-05-split-enabled-key'
export const RETIRE_FACE_KEYS_MIGRATION_ID = 'pipeline-analytics/2026-11-07-retire-face-keys'
export const RULE_ACTIONS_TO_ACTIONS_MIGRATION_ID =
  'pipeline-analytics/2026-11-09-rule-actions-to-actions'
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
  {
    meta: {
      id: SYSTEM_EVENT_DELIVERY_MODES_MIGRATION_ID,
      owner: PIPELINE_ANALYTICS_ID,
      level: 'addon-state',
      seq: 5,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      // The store reads a legacy delivery in the modes shape on load, so a rule left for the next boot behaves the same.
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Write the delivery of every device-events and system notification rule as a combination of modes (when it starts, when it clears, on a schedule), keeping what each rule did',
      fixtureMark: 'the rule name and the kinds the migration does not collapse',
    },
    procedure: migrateSystemEventDeliveryModes,
  },
  {
    meta: {
      id: RULE_ACTIONS_TO_ACTIONS_MIGRATION_ID,
      owner: PIPELINE_ANALYTICS_ID,
      level: 'addon-state',
      seq: 6,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      // The store drops a rule's old-shape actions on read (the rule still notifies), so a pass left for the next boot loses nothing.
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Make an Action of every shared sequence and of the inline steps of every notification rule, and rebind the rules and buttons to Action ids; the sequence rows are deleted only after a fresh read confirms it',
      fixtureMark: 'the rule name and the button label the migration does not know',
    },
    procedure: migrateRuleActionsToActions,
  },
]
