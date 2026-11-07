import type { AddonMigration } from '@camstack/types'
import {
  copyTerminalsToRecords,
  type TerminalMigrationPorts,
} from './terminal-instances-to-records.js'

export {
  LEGACY_TERMINAL_INSTANCES_KEY,
  terminalPortsOver,
  type TerminalMigrationPorts,
  type TerminalPortsApi,
} from './terminal-instances-to-records.js'

export const INSTANCES_TO_RECORDS_ID = 'terminal/2026-11-07-instances-to-records'

/** The `terminal` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<TerminalMigrationPorts>[] = [
  {
    meta: {
      id: INSTANCES_TO_RECORDS_ID,
      owner: 'terminal',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Copy the addon-level Terminal list (terminalInstances) into terminals records under the same ids, each read back; the legacy key is deleted only once every row has its record',
      fixtureMark: 'profileSettings.mark of an instance row, read back from its record',
    },
    procedure: copyTerminalsToRecords,
  },
]
