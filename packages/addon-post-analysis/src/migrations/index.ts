import type { AddonMigration } from '@camstack/types'
import {
  migrateDeviceTemplateVariable,
  type NcTemplateMigrationPorts,
} from './device-template-var.js'
import {
  type EnabledSplitPorts,
  PIPELINE_ANALYTICS_ID,
  planSplitEnabledKey,
} from './split-enabled-key.js'

export type { NcTemplateMigrationPorts } from './device-template-var.js'
export type { EnabledSplitPorts } from './split-enabled-key.js'

/** Everything the `pipeline-analytics` catalogue reads and writes. */
export type PipelineAnalyticsMigrationPorts = NcTemplateMigrationPorts & EnabledSplitPorts

export const SPLIT_ENABLED_KEY_MIGRATION_ID = 'pipeline-analytics/2026-11-05-split-enabled-key'

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
]
