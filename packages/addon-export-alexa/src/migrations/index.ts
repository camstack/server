import type { AddonMigration } from '@camstack/types'
import { type DropPublicHubUrlPorts, planDropPublicHubUrl } from './drop-public-hub-url.js'
import {
  type DropMovedSettingsPorts,
  type MoveLedgersPorts,
  type MoveSettingsPorts,
  moveLedgersToLinks,
  moveSettingsToSkill,
  planDropMovedSettings,
} from './settings-to-records.js'

export type { DropPublicHubUrlPorts } from './drop-public-hub-url.js'
export type {
  AlexaMigrationLog,
  DropMovedSettingsPorts,
  MoveLedgersPorts,
  MoveSettingsPorts,
} from './settings-to-records.js'

/** Every body reads through ONE port object, so the addon binds the catalogue once. */
export type AlexaCataloguePorts = DropPublicHubUrlPorts &
  MoveSettingsPorts &
  MoveLedgersPorts &
  DropMovedSettingsPorts

export const DROP_PUBLIC_HUB_URL_ID = 'export-alexa/2026-11-02-drop-public-hub-url'
export const SETTINGS_TO_INTEGRATION_ID = 'export-alexa/2026-11-03-settings-to-integration'
export const LEDGERS_TO_INTEGRATION_ID = 'export-alexa/2026-11-03-ledgers-to-integration'
export const DROP_MOVED_SETTINGS_ID = 'export-alexa/2026-11-03-drop-moved-settings'

const FIXTURE_MARK = 'the exposed device list the migration does not know'

/**
 * The `export-alexa` catalogue (D987): offered to the engine when the addon initialises. Every
 * entry is `tolerate`; until a record exists the addon keeps reading the legacy keys.
 */
export const ADDON_MIGRATIONS: readonly AddonMigration<AlexaCataloguePorts>[] = [
  {
    meta: {
      id: DROP_PUBLIC_HUB_URL_ID,
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
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropPublicHubUrl,
  },
  {
    meta: {
      id: SETTINGS_TO_INTEGRATION_ID,
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move the Alexa skill settings (mode, region, audience, feature switches) into the skills record',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveSettingsToSkill,
  },
  {
    meta: {
      id: LEDGERS_TO_INTEGRATION_ID,
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 3,
      dependsOn: [SETTINGS_TO_INTEGRATION_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move the linked accounts and Amazon push grants into the skill-links record; the old credentials are cleared only after the record reads back identical',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveLedgersToLinks,
  },
  {
    meta: {
      id: DROP_MOVED_SETTINGS_ID,
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 4,
      dependsOn: [SETTINGS_TO_INTEGRATION_ID, LEDGERS_TO_INTEGRATION_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the Alexa settings and ledger keys that moved into the records',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropMovedSettings,
  },
]
