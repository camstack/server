import type { AddonMigration } from '@camstack/types'
import { type DropPublicHubUrlPorts, planDropPublicHubUrl } from './drop-public-hub-url.js'

export type { DropPublicHubUrlPorts } from './drop-public-hub-url.js'

/** The `export-alexa` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<DropPublicHubUrlPorts>[] = [
  {
    meta: {
      id: 'export-alexa/2026-11-02-drop-public-hub-url',
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the retired publicHubUrl setting; the public URL is the publicEndpoint role',
      fixtureMark: 'the exposed device list the migration does not know',
    },
    plan: planDropPublicHubUrl,
  },
]
