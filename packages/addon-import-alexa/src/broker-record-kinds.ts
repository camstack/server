import { declareBrokerLinkKind, defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { alexaConnectionSchema } from './config.js'

export const ALEXA_BROKERS_OWNER = 'import-alexa'

export const AlexaBrokerBodySchema = entryBody({
  ...alexaConnectionSchema.shape,
  /** Retired (D1012): the link lives on the integration's `connections` record. Only the migration reads it. */
  integrationId: z.string().optional(),
  enabled: z.boolean().optional(),
})
export type AlexaBrokerBody = z.infer<typeof AlexaBrokerBodySchema>

export const alexaBrokersEntryKind = defineEntryKind('brokers', {
  title: 'Alexa import brokers',
  schema: AlexaBrokerBodySchema,
  writeTrigger: 'an operator links or removes an Alexa account broker',
  // The nested shape's secrets: a declared secret path never stops being secret.
  retiredSecretPaths: ['connection.cookie', 'connection.refreshToken'],
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

/** An Alexa integration: the link to the Alexa account (broker) it imports devices from. */
export const alexaConnectionsEntryKind = declareBrokerLinkKind({
  title: 'Alexa integrations',
  writeTrigger: 'an operator links an Alexa integration to an Alexa account',
})

/** Every kind this addon declares, keyed by its name: `records.declare` refuses any other key. */
export const alexaRecordKinds = {
  brokers: alexaBrokersEntryKind,
  connections: alexaConnectionsEntryKind,
  'speak-sessions': alexaSpeakSessionsEntryKind,
} as const
