import type { AddonMigration } from '@camstack/types'
import { EMAIL_SEND_WITH_ID, linkEmailSenders } from './email-send-with.js'
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
export { EMAIL_SEND_WITH_ID } from './email-send-with.js'
export type {
  EmailSendWithPorts,
  EmailTargetRow,
  LegacySenderCandidate,
} from './email-send-with.js'
export {
  legacySenderCandidate,
  legacySendersOver,
  pickLegacySender,
} from './email-send-with.js'
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
        'Move each notification target from the single targets kind to the record kind of its target kind, the config flat in the body, every secret in the keychain and read back before the old row goes; a row that fails stays in the old kind, named in the log',
      fixtureMark: 'the token, the switch (off) and the id of a Telegram target',
    },
    procedure: moveNotifierTargets,
  },
  {
    meta: {
      id: EMAIL_SEND_WITH_ID,
      owner: 'notifiers',
      level: 'addon-state',
      seq: 2,
      dependsOn: [TARGETS_TO_BODY_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Link each email target to the instance that sends it (sendWith): the relay it pinned, else the first sender of the provider it named; the two old keys go, every other field stays; a provider that cannot be read fails the step for the next boot',
      fixtureMark: 'the recipients, the switch (off) and the owner of an email target',
    },
    procedure: (ports) => linkEmailSenders(ports.emailSenders),
  },
]
