import type { AddonMigration } from '@camstack/types'
import {
  stripEchoTargetVolumeAndMode,
  type EchoTargetMigrationPorts,
} from './strip-echo-target-volume-and-mode.js'

export type { EchoTargetMigrationPorts } from './strip-echo-target-volume-and-mode.js'

/** The `import-alexa` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<EchoTargetMigrationPorts>[] = [
  {
    meta: {
      id: 'import-alexa/2026-11-01-strip-echo-target-volume-and-mode',
      owner: 'import-alexa',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description: 'Remove the retired volume and mode from every stored Echo target',
      fixtureMark: 'the Echo id and the name the migration does not know',
    },
    procedure: stripEchoTargetVolumeAndMode,
  },
]
