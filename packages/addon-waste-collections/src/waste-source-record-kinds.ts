import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { WasteArgValueSchema } from './waste-types.js'

export const WASTE_COLLECTIONS_OWNER = 'waste-collections'

export const WasteSourceBodySchema = entryBody({
  module: z.string().min(1),
  args: z.preprocess((v) => v ?? {}, z.record(z.string(), WasteArgValueSchema)),
  enabled: z.boolean().default(true),
})
export type WasteSourceBody = z.infer<typeof WasteSourceBodySchema>

export const wasteSourceEntryKind = defineEntryKind('waste-source', {
  title: 'Waste collection sources',
  schema: WasteSourceBodySchema,
  writeTrigger: 'an operator adds or edits a municipal waste calendar source',
})
