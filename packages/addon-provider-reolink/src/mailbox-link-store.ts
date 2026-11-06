/**
 * The `mailboxId` link of the Reolink integration records, over the addon's own record door.
 * Written here and not through `updateInstance`: a link change is bookkeeping, it must not make the
 * addon reconcile its hub sessions (`onChanged`).
 */
import type { RecordsAccess } from '@camstack/types'
import { MAILBOX_LINK_FIELD, type MailboxLinkStore } from './email-push-bridge.js'
import { reolinkConnectionsEntryKind } from './reolink-instances.js'

const INTEGRATIONS_MAX = 1000

export function mailboxLinkStoreOver(records: Pick<RecordsAccess, 'kind'>): MailboxLinkStore {
  const handle = records.kind(reolinkConnectionsEntryKind)
  return {
    list: async () => {
      const page = await handle.query({ limit: INTEGRATIONS_MAX })
      return page.records.map((row) => {
        const linked = row.data[MAILBOX_LINK_FIELD]
        return { id: row.id, mailboxId: typeof linked === 'string' ? linked : '' }
      })
    },
    set: async (integrationId, mailboxId) => {
      await handle.patch(integrationId, {
        [MAILBOX_LINK_FIELD]: mailboxId === '' ? null : mailboxId,
      })
    },
  }
}
