import type { AddonMigration } from '@camstack/types'
import {
  moveNotifierTargets,
  type NotifiersMigrationPorts,
  TARGETS_TO_BODY_ID,
} from './targets-to-body.js'

export {
  OLD_TARGETS_KIND,
  oldTargetKinds,
  TARGETS_TO_BODY_ID,
} from './targets-to-body.js'
export type {
  NotifiersMigrationPorts,
  OldTargetsHandle,
} from './targets-to-body.js'

/** The `notifiers` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<NotifiersMigrationPorts>[] = [
  {
    meta: {
      id: TARGETS_TO_BODY_ID,
      owner: 'notifiers',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move each notification target from the single targets kind to the record kind of its target kind, the config flat in the body, every secret in the keychain and read back before the old row goes; a row that fails stays in the old kind and is still served',
      fixtureMark: 'the token, the switch (off) and the id of a Telegram target',
    },
    procedure: moveNotifierTargets,
  },
]
