/**
 * Cloudflare TURN — customActions catalog.
 *
 *   testCredentials — fire one fetch against the configured TURN Key ID
 *                     + API Token and return either the success payload
 *                     (server count + first URL) or the error reason.
 *                     The settings form exposes a "Test" button below
 *                     the credential inputs so operators can validate
 *                     before going to the WebRTC consumer side.
 */
import { z } from 'zod'
import { customAction, defineCustomActions } from '@camstack/types'

const TestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    urlCount: z.number(),
    hasCredentials: z.boolean(),
    firstUrl: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    status: z.number().optional(),
    body: z.string(),
    hint: z.string().optional(),
  }),
])

export const cloudflareTurnActions = defineCustomActions({
  testCredentials: customAction(
    // `.optional()` because tRPC elides `{}` inputs on the wire.
    z.object({}).optional(),
    TestResultSchema,
    { kind: 'mutation' },
  ),
})

export type CloudflareTurnActions = typeof cloudflareTurnActions
