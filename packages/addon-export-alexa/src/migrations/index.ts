import type { AddonMigration } from '@camstack/types'
import {
  type AlexaNameMovePorts,
  planAlexaNameToExposedName,
} from './alexa-name-to-exposed-name.js'
import { type DropPublicHubUrlPorts, planDropPublicHubUrl } from './drop-public-hub-url.js'
import {
  type DropMovedExposurePorts,
  type MoveExposurePorts,
  moveExposureToRecord,
  planDropMovedExposure,
} from './exposure-to-record.js'
import {
  type DropMovedStatePorts,
  type MoveStatePorts,
  moveStateToInstance,
  planDropMovedState,
} from './state-to-instance.js'
import {
  type DropMovedSettingsPorts,
  type MoveLedgersPorts,
  type MoveSettingsPorts,
  moveLedgersToLinks,
  moveSettingsToSkill,
  planDropMovedSettings,
} from './settings-to-records.js'

export type { AlexaNameMovePorts } from './alexa-name-to-exposed-name.js'
export type { DropPublicHubUrlPorts } from './drop-public-hub-url.js'
export type {
  DropMovedExposurePorts,
  ExposureMigrationLog,
  MoveExposurePorts,
} from './exposure-to-record.js'
export type { DropMovedStatePorts, MoveStatePorts } from './state-to-instance.js'
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
  DropMovedSettingsPorts &
  MoveExposurePorts &
  DropMovedExposurePorts &
  MoveStatePorts &
  DropMovedStatePorts &
  AlexaNameMovePorts

export const DROP_PUBLIC_HUB_URL_ID = 'export-alexa/2026-11-02-drop-public-hub-url'
export const SETTINGS_TO_INTEGRATION_ID = 'export-alexa/2026-11-03-settings-to-integration'
export const LEDGERS_TO_INTEGRATION_ID = 'export-alexa/2026-11-03-ledgers-to-integration'
export const DROP_MOVED_SETTINGS_ID = 'export-alexa/2026-11-03-drop-moved-settings'

export const EXPOSURE_TO_RECORD_ID = 'export-alexa/2026-11-04-exposure-to-record'
export const DROP_MOVED_EXPOSURE_ID = 'export-alexa/2026-11-04-drop-moved-exposure'

export const STATE_TO_INSTANCE_ID = 'export-alexa/2026-11-04-state-to-instance'
export const DROP_MOVED_STATE_ID = 'export-alexa/2026-11-04-drop-moved-state'

export const ALEXA_NAME_TO_EXPOSED_NAME_ID = 'export-alexa/2026-11-12-alexa-name-to-exposed-name'

const FIXTURE_MARK = 'the endpoint sync state the migration does not know'

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
  {
    meta: {
      id: EXPOSURE_TO_RECORD_ID,
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 5,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the exposed devices and actions into the skill-exports record; the record is read back before anything is deleted',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveExposureToRecord,
  },
  {
    meta: {
      id: DROP_MOVED_EXPOSURE_ID,
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 6,
      dependsOn: [EXPOSURE_TO_RECORD_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description:
        'Delete the exposed and exposedActions settings keys once the record holds what they carried',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropMovedExposure,
  },
  {
    meta: {
      id: STATE_TO_INSTANCE_ID,
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 7,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the ingress token, vision namespace and push mirrors into the skill-state record of the default instance; the record is read back, token included',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveStateToInstance,
  },
  {
    meta: {
      id: DROP_MOVED_STATE_ID,
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 8,
      dependsOn: [STATE_TO_INSTANCE_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description:
        'Release the ingress token keychain entry and delete the moved state keys once the record holds what they carried',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropMovedState,
  },
  {
    meta: {
      id: ALEXA_NAME_TO_EXPOSED_NAME_ID,
      owner: 'export-alexa',
      level: 'addon-state',
      seq: 9,
      // After seq 2 (the default skill record): the name is written under every skill id.
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Copy every device`s Alexa name to the exposed name of every Alexa skill and delete the alexaName key',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planAlexaNameToExposedName,
  },
]
