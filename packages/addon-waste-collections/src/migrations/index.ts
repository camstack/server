import type { AddonMigration } from '@camstack/types'
import { copySourcesToRecords, type WasteSourcePorts } from './sources-from-settings.js'

export type { WasteSourcePorts } from './sources-from-settings.js'

export const SOURCES_FROM_SETTINGS_ID =
  'waste-collections/2026-11-06-sources-from-settings-and-argsjson'

/** The `waste-collections` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<WasteSourcePorts>[] = [
  {
    meta: {
      id: SOURCES_FROM_SETTINGS_ID,
      owner: 'waste-collections',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Copy the addon-level sources setting (typed args, or a legacy argsJson string) into waste-source records, credentials in the keychain, each read back; an existing record is never overwritten',
      fixtureMark: 'the credential of a legacy argsJson row, read back from its record',
    },
    procedure: copySourcesToRecords,
  },
]
