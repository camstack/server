import type { AddonMigration } from '@camstack/types'
import {
  migrateDeviceTemplateVariable,
  type NcTemplateMigrationPorts,
} from './device-template-var.js'

export type { NcTemplateMigrationPorts } from './device-template-var.js'

/** The `pipeline-analytics` catalogue (D987): offered to the engine at the hub's boot. */
export const ADDON_MIGRATIONS: readonly AddonMigration<NcTemplateMigrationPorts>[] = [
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
]
