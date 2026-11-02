import type { AddonMigration } from '@camstack/types'
import {
  type DropMovedSettingsPorts,
  type SmtpMigrationPorts,
  moveConnectionToRecord,
  planDropMovedSettings,
} from './connection-to-records.js'

export type {
  DropMovedSettingsPorts,
  SmtpMigrationLog,
  SmtpMigrationPorts,
  SmtpRecordState,
} from './connection-to-records.js'

/** Both bodies read through ONE port object, so the addon binds the catalogue once. */
export type SmtpCataloguePorts = SmtpMigrationPorts & DropMovedSettingsPorts

export const CONNECTION_TO_RECORDS_ID = 'smtp-nodemailer/2026-11-02-connection-to-records'
export const DROP_MOVED_SETTINGS_ID = 'smtp-nodemailer/2026-11-02-drop-moved-settings'

const FIXTURE_MARK = 'a setting key the migration does not know'

/** The `smtp-nodemailer` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<SmtpCataloguePorts>[] = [
  {
    meta: {
      id: CONNECTION_TO_RECORDS_ID,
      owner: 'smtp-nodemailer',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the SMTP relay (host, port, TLS, credentials, From) from the addon settings into a relays record under an integrations row',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveConnectionToRecord,
  },
  {
    meta: {
      id: DROP_MOVED_SETTINGS_ID,
      owner: 'smtp-nodemailer',
      level: 'addon-state',
      seq: 2,
      dependsOn: [CONNECTION_TO_RECORDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description: 'Delete the relay keys that moved into the relays record',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropMovedSettings,
  },
]
