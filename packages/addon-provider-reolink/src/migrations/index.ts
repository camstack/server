import { type AddonMigration, claimDevicesMigration } from '@camstack/types'
import { MIGRATED_FROM_HUB_KEY } from '../reolink-hub-migration.js'
import { planDropWebhookIntakeSettings } from './drop-webhook-intake-settings.js'
import { type EmailPushMigrationPorts, moveEmailPushToMailbox } from './email-push-to-mailbox.js'

export {
  REOLINK_ROWS_TO_RECORD_ID,
  REOLINK_ROWS_TO_RECORD_MIGRATION,
} from './integration-rows-to-record.js'
export {
  type EmailPushMigrationPorts,
  type LegacyMailboxSettings,
  type PendingMailbox,
  PendingMailboxSchema,
} from './email-push-to-mailbox.js'

export const DROP_WEBHOOK_INTAKE_SETTINGS_ID =
  'provider-reolink/2026-11-02-drop-webhook-intake-settings'
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
  {
    meta: {
      id: DROP_WEBHOOK_INTAKE_SETTINGS_ID,
      owner: 'provider-reolink',
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the retired baichuanWebhookEnabled, baichuanWebhookPort and baichuanWebhookBindHost settings; the webhook is served on the addon data plane',
      fixtureMark: 'a setting key the migration does not know',
    },
    plan: planDropWebhookIntakeSettings,
  },
]

/** The date of the device claim (D1007). */
export const CLAIM_DEVICES_DATE = '2026-11-04'

/**
 * Every persisted camera that names no integration is claimed to the addon's default one. The
 * integration a hub migration created is never the default, so it is not eligible. The integration
 * settings themselves stay where they are until this addon's own wave moves them.
 */
export const REOLINK_CLAIM_MIGRATION = claimDevicesMigration({
  addonId: 'provider-reolink',
  date: CLAIM_DEVICES_DATE,
  seq: 3,
  dependsOn: [],
  eligible: (integration) => integration.info[MIGRATED_FROM_HUB_KEY] === undefined,
})
