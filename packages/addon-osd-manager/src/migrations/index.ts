import type { AddonMigration } from '@camstack/types'
import {
  BINDINGS_TO_TEMPLATES_MIGRATION_ID,
  type BindingsToTemplatesPorts,
  OSD_MANAGER_ID,
  planBindingsToTemplates,
} from './bindings-to-templates.js'

export type { BindingsToTemplatesPorts } from './bindings-to-templates.js'
export { BINDINGS_TO_TEMPLATES_MIGRATION_ID } from './bindings-to-templates.js'

/** Everything the `osd-manager` catalogue reads and writes. */
export type OsdManagerMigrationPorts = BindingsToTemplatesPorts

/** The `osd-manager` catalogue (D987): offered to the engine before the manager is built. */
export const ADDON_MIGRATIONS: readonly AddonMigration<OsdManagerMigrationPorts>[] = [
  {
    meta: {
      id: BINDINGS_TO_TEMPLATES_MIGRATION_ID,
      owner: OSD_MANAGER_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      // The manager parses its stores against the new shapes: an owner that could not
      // move them must not run on rows it cannot read.
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description:
        'Rewrite every OSD slot binding and named template onto the device-template engine: displayUnit, maxDecimals, valueMap and the ${value} wrapper become template text, and the clock, recognition and device-state sources become generated named templates',
      fixtureMark: 'a schedule and a gate the migration does not touch',
    },
    plan: planBindingsToTemplates,
  },
]
