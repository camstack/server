/**
 * The `smtp-inbound` mailbox as a record (D999): one `mailboxes` row per mailbox, owned by
 * `smtp-nodemailer`. The row id is the broker id. The SMTP AUTH password is a keychain-bound secret
 * field; nothing else holds a copy.
 */
import { type DefinedRecordKind, defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'

export const MailboxBodySchema = entryBody({
  port: z.number().int().min(1).max(65535),
  bindHost: z.string().min(1),
  domain: z.string().min(1),
  requireAuth: z.boolean(),
  username: z.string(),
  password: z.string().optional().meta({ secret: true }),
  starttls: z.boolean(),
  maxMessageBytes: z.number().int().positive(),
})
export type MailboxBody = z.infer<typeof MailboxBodySchema>

export const MAILBOXES_KIND_NAME = 'mailboxes'

export const mailboxesKind: DefinedRecordKind<typeof MailboxBodySchema> = defineEntryKind(
  MAILBOXES_KIND_NAME,
  {
    title: 'Inbound mailboxes',
    nameField: 'name',
    schema: MailboxBodySchema,
    writeTrigger: 'an operator (or a consumer addon, once) adds or edits an inbound mailbox',
  },
)
