/**
 * The Cloudflare TURN account as a record (D985, D996): ONE `accounts` row, owned by
 * `cloudflare-turn` and named after it, listed on the TURN Servers page. The API token is a
 * keychain marker bound to the row.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

/** A single-instance addon keeps its record under its own addon id. */
export const CLOUDFLARE_TURN_RECORD_ID = 'cloudflare-turn'

export type CloudflareTurnBody = {
  readonly name: string
  /** The Realtime TURN app's Token ID (called "Key ID" in the dashboard). */
  readonly keyId: string
  /** The TURN app's API token (bearer credential). */
  readonly apiToken?: string | undefined
  /** The instance's own switch (D996). Absent means on. */
  readonly enabled?: boolean | undefined
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const CloudflareTurnBodySchema: z.ZodType<CloudflareTurnBody> = z.object({
  name: z.string().min(1),
  keyId: z.string(),
  apiToken: z.string().optional().meta({ secret: true }),
  enabled: z.boolean().optional(),
})

export const ACCOUNTS_KIND_NAME = 'accounts'

export const cloudflareTurnAccountsKind: DefinedRecordKind<z.ZodType<CloudflareTurnBody>> =
  defineEntryKind(ACCOUNTS_KIND_NAME, {
    title: 'Cloudflare TURN account',
    nameField: 'name',
    schema: CloudflareTurnBodySchema,
  })

export const CLOUDFLARE_TURN_DEFAULT_BODY: Omit<CloudflareTurnBody, 'name'> = {
  keyId: '',
}
