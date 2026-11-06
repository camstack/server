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
function argsSchema(secret: boolean) {
  const shape = Object.fromEntries(
    SECRET_ARG_KEYS.map((key) => [
      key,
      secret ? z.string().meta({ secret: true }).optional() : z.string().optional(),
    ]),
  )
  return z.object(shape).catchall(PlainArgValueSchema)
}

export const WasteSourceArgsSchema = argsSchema(true)

function bodySchema(secret: boolean) {
  return entryBody({
    module: z.string().min(1),
    args: argsSchema(secret).default({}),
    enabled: z.boolean().default(true),
  })
}

export const WasteSourceBodySchema = bodySchema(true)
export type WasteSourceBody = z.infer<typeof WasteSourceBodySchema>

const TITLE = 'Waste collection sources'
const WRITE_TRIGGER = 'an operator adds or edits a municipal waste calendar source'

export const wasteSourceEntryKind = defineEntryKind('waste-source', {
  title: TITLE,
  schema: WasteSourceBodySchema,
  writeTrigger: WRITE_TRIGGER,
})

/**
 * The same kind WITHOUT its secret fields: how the records looked before this version. It stays
 * the declared kind of a boot where a credential stored as plain text could not be moved into
 * the keychain (a declaration can add secret fields, never drop them, so declaring the real kind
 * early would hide that text for good).
 */
export const plainWasteSourceKind = defineEntryKind('waste-source', {
  title: TITLE,
  schema: bodySchema(false),
  writeTrigger: WRITE_TRIGGER,
})
