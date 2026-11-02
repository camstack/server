import type { AddonMigration } from '@camstack/types'
import { type EmailPushMigrationPorts, moveEmailPushToMailbox } from './email-push-to-mailbox.js'

export {
  type EmailPushMigrationPorts,
  type LegacyMailboxSettings,
  type PendingMailbox,
  PendingMailboxSchema,
} from './email-push-to-mailbox.js'

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
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Keep the SMTP intake settings (port, domain, credentials) as the pending camera mailbox, created by the bridge when the smtp-inbound broker is reachable, so no camera is reconfigured',
      fixtureMark: 'a setting key the migration does not know',
    },
    procedure: moveEmailPushToMailbox,
  },
]
