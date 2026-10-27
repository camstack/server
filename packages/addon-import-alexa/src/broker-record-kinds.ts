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

/**
 * The cookie jar the Echo worker last wrote for ONE broker, keyed by the broker
 * id. It is derived from the broker's login and is replaced whenever the worker
 * signs in again; the operator never types it.
 */
export const AlexaSpeakSessionBodySchema = entryBody({
  session: z.string().default('').meta({ secret: true }),
})
export type AlexaSpeakSessionBody = z.infer<typeof AlexaSpeakSessionBodySchema>

export const alexaSpeakSessionsEntryKind = defineEntryKind('speak-sessions', {
  title: 'Alexa Echo speech sessions',
  schema: AlexaSpeakSessionBodySchema,
  writeTrigger: 'an Echo worker signs in as an Alexa account broker',
})
