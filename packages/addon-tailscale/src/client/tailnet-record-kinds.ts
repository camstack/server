/**
 * The tailnet the host joins, as a record (D985, D996, epic #440 step 6): ONE `tailnet` row, owned
 * by `tailscale-client` and named after it. The pre-auth key is a keychain marker bound to the row.
 * What belongs to ONE host (accept routes, tags, ssh, the daemon source) stays in the node settings.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

/** A single-instance addon keeps its record under its own addon id. */
export const TAILNET_RECORD_ID = 'tailscale-client'

export const TAILNET_KIND_NAME = 'tailnet'

export type TailnetBody = {
  readonly name: string
  /** Pre-auth key from the Tailscale admin console. Empty or absent: the browser-redirect flow. */
  readonly authKey?: string | undefined
  /** Hostname this device advertises in the tailnet. Empty: the daemon picks the OS hostname. */
  readonly hostname: string
  /** The instance's own switch (D996). Absent means on. */
  readonly enabled?: boolean | undefined
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const TailnetBodySchema: z.ZodType<TailnetBody> = z.object({
  name: z.string().min(1),
  authKey: z.string().optional().meta({ secret: true }),
  hostname: z.string(),
  enabled: z.boolean().optional(),
})

export const tailnetKind: DefinedRecordKind<z.ZodType<TailnetBody>> = defineEntryKind(
  TAILNET_KIND_NAME,
  {
    title: 'Tailnet',
    nameField: 'name',
    schema: TailnetBodySchema,
  },
)

export const TAILNET_DEFAULT_BODY: Omit<TailnetBody, 'name'> = { hostname: '' }
