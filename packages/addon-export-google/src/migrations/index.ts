import type { AddonMigration } from '@camstack/types'
import { type DropPublicHubUrlPorts, planDropPublicHubUrl } from './drop-public-hub-url.js'
import {
  type DropMovedExposurePorts,
  type MoveExposurePorts,
  moveExposureToRecord,
  planDropMovedExposure,
} from './exposure-to-record.js'

export type { DropPublicHubUrlPorts } from './drop-public-hub-url.js'
export type {
  DropMovedExposurePorts,
  ExposureMigrationLog,
  MoveExposurePorts,
} from './exposure-to-record.js'

/** Every body reads through ONE port object, so the addon binds the catalogue once. */
export type GoogleCataloguePorts = DropPublicHubUrlPorts &
  MoveExposurePorts &
  DropMovedExposurePorts

export const DROP_PUBLIC_HUB_URL_ID = 'export-google/2026-11-02-drop-public-hub-url'
export const EXPOSURE_TO_RECORD_ID = 'export-google/2026-11-04-exposure-to-record'
export const DROP_MOVED_EXPOSURE_ID = 'export-google/2026-11-04-drop-moved-exposure'

const FIXTURE_MARK = 'the linked account list the migration does not know'

/** The `export-google` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<GoogleCataloguePorts>[] = [
  {
    meta: {
      id: DROP_PUBLIC_HUB_URL_ID,
      owner: 'export-google',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the retired publicHubUrl and detectedPublicHubUrl settings; the public URL is the publicEndpoint role',
      fixtureMark: FIXTURE_MARK,
    },
    plan: planDropPublicHubUrl,
  },
  {
    meta: {
      id: EXPOSURE_TO_RECORD_ID,
      owner: 'export-google',
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the exposed devices and actions into the google-exports record; the record is read back before anything is deleted',
      fixtureMark: FIXTURE_MARK,
    },
    procedure: moveExposureToRecord,
  },
  {
    meta: {
      id: DROP_MOVED_EXPOSURE_ID,
      owner: 'export-google',
      level: 'addon-state',
      seq: 3,
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
]
