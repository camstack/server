import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { SECRET_ARG_KEYS } from './waste-secrets.js'

export const WASTE_COLLECTIONS_OWNER = 'waste-collections'

/** A plain (non-credential) argument of a source. */
const PlainArgValueSchema = z.union([z.string(), z.number(), z.boolean()])

/**
 * The arguments of a source. The credential keys (`waste-secrets.ts`) are NAMED here so the
 * records door keeps them in the keychain, bound to the row (`args.password`, ...); every other
 * argument the service catalog declares rides in the catch-all.
 */
const SecretArgShape = Object.fromEntries(
  SECRET_ARG_KEYS.map((key) => [key, z.string().meta({ secret: true }).optional()]),
)

export const WasteSourceArgsSchema = z.object(SecretArgShape).catchall(PlainArgValueSchema)

export const WasteSourceBodySchema = entryBody({
  module: z.string().min(1),
  args: WasteSourceArgsSchema.default({}),
  enabled: z.boolean().default(true),
})
export type WasteSourceBody = z.infer<typeof WasteSourceBodySchema>

export const wasteSourceEntryKind = defineEntryKind('waste-source', {
  title: 'Waste collection sources',
  schema: WasteSourceBodySchema,
  writeTrigger: 'an operator adds or edits a municipal waste calendar source',
})
