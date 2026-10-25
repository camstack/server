import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { AlexaBrokerEntrySchema } from './config.js'

export const ALEXA_BROKERS_OWNER = 'import-alexa'

export const AlexaBrokerBodySchema = entryBody({
  connection: AlexaBrokerEntrySchema.shape.connection,
  integrationId: z.string().optional(),
})
export type AlexaBrokerBody = z.infer<typeof AlexaBrokerBodySchema>

export const alexaBrokersEntryKind = defineEntryKind('brokers', {
  title: 'Alexa import brokers',
  schema: AlexaBrokerBodySchema,
  writeTrigger: 'an operator links or removes an Alexa account broker',
})
