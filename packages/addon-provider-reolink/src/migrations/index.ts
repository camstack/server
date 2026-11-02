import type { AddonMigration } from '@camstack/types'
import { type EmailPushMigrationPorts, moveEmailPushToMailbox } from './email-push-to-mailbox.js'

export type { EmailPushMigrationPorts, LegacyMailboxSettings } from './email-push-to-mailbox.js'

export const EMAIL_PUSH_TO_MAILBOX_ID = 'provider-reolink/2026-11-02-email-push-to-mailbox'

/** The `provider-reolink` catalogue (D987): offered to the engine when the addon initialises. */
export const REOLINK_MIGRATIONS: readonly AddonMigration<EmailPushMigrationPorts>[] = [
  {
    meta: {
      id: EMAIL_PUSH_TO_MAILBOX_ID,
      owner: 'provider-reolink',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Create the camera mailbox of the smtp-inbound broker from the SMTP intake settings, keeping port, domain and credentials so no camera is reconfigured',
      fixtureMark: 'a setting key the migration does not know',
    },
    procedure: moveEmailPushToMailbox,
  },
]
