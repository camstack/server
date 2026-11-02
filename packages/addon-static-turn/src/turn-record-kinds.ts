/**
 * A static TURN/STUN server as a record (D985, D996): one `servers` row per server, owned by
 * `static-turn`, listed on the TURN Servers page. The credential is a keychain marker bound to
 * the row, so deleting the row deletes the secret.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

export type TurnServerBody = {
  readonly name: string
  /** One or more STUN/TURN URLs, comma- or newline-separated. Empty means "not configured yet". */
  readonly urls: string
  /** Long-term-credential username (coturn `user=NAME:PASS`). */
  readonly username: string
  /** Long-term-credential password. */
  readonly credential?: string | undefined
  /** The instance's own switch (D996). Absent means on. */
  readonly enabled?: boolean | undefined
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const TurnServerBodySchema: z.ZodType<TurnServerBody> = z.object({
  name: z.string().min(1),
  urls: z.string(),
  username: z.string(),
  credential: z.string().optional().meta({ secret: true }),
  enabled: z.boolean().optional(),
})

export const SERVERS_KIND_NAME = 'servers'

export const staticTurnServersKind: DefinedRecordKind<z.ZodType<TurnServerBody>> = defineEntryKind(
  SERVERS_KIND_NAME,
  { title: 'TURN servers', nameField: 'name', schema: TurnServerBodySchema },
)

export const TURN_DEFAULT_BODY: Omit<TurnServerBody, 'name'> = {
  urls: '',
  username: '',
}

/** The URLs of a stored `urls` text: one per line or comma-separated, blanks dropped. */
export function parseTurnUrls(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
