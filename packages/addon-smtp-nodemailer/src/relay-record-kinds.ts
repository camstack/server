/**
 * The SMTP relay as a record (D985, D996): one `relays` row per relay, owned by
 * `smtp-nodemailer`, listed on the Integrations page like any other connection. The row id is the
 * `integrations` registry id (`int_NNNN`). The password is a keychain marker bound to the row.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

/** The inclusive bounds of the port: the schema and the settings migration read ONE copy. */
export const RELAY_PORT_BOUNDS: { readonly min: number; readonly max: number } = {
  min: 1,
  max: 65535,
}

export type SmtpRelayBody = {
  readonly name: string
  readonly host: string
  readonly port: number
  /** Implicit TLS on connect (port 465 style); false lets nodemailer STARTTLS. */
  readonly secure: boolean
  readonly username: string
  readonly password?: string | undefined
  /** Default `From` address, used when the caller omits `from`. */
  readonly fromAddress: string
  /** Optional display name prefixing the `From` address. */
  readonly fromName: string
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const SmtpRelayBodySchema: z.ZodType<SmtpRelayBody> = z.object({
  name: z.string().min(1),
  host: z.string(),
  port: z.number().int().min(RELAY_PORT_BOUNDS.min).max(RELAY_PORT_BOUNDS.max),
  secure: z.boolean(),
  username: z.string(),
  password: z.string().optional().meta({ secret: true }),
  fromAddress: z.string(),
  fromName: z.string(),
})

export const RELAYS_KIND_NAME = 'relays'

export const smtpRelaysKind: DefinedRecordKind<z.ZodType<SmtpRelayBody>> = defineEntryKind(
  RELAYS_KIND_NAME,
  { title: 'SMTP relays', nameField: 'name', schema: SmtpRelayBodySchema },
)

export const RELAY_DEFAULT_BODY: Omit<SmtpRelayBody, 'name'> = {
  host: '',
  port: 587,
  secure: false,
  username: '',
  fromAddress: '',
  fromName: '',
}
