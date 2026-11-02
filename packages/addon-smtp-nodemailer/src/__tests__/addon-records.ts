import type { RecordsAccess } from '@camstack/types'
import { mailboxesKind } from '../mailbox-record-kinds.js'
import { smtpRelaysKind } from '../relay-record-kinds.js'

/** Declare the kinds the addon declares, as a spec seeds them. */
export async function relayRecordsFor(records: RecordsAccess): Promise<void> {
  await records.declare({ relays: smtpRelaysKind, mailboxes: mailboxesKind })
}
