import { defineEntryKind, entryBody } from '@camstack/types'
import type { z } from 'zod'
import { GoogleBrokerEntrySchema } from './google-types.js'

export const GOOGLE_BROKERS_OWNER = 'google-services'

export const GoogleBrokerBodySchema = entryBody({
  clientId: GoogleBrokerEntrySchema.shape.clientId,
  clientSecret: GoogleBrokerEntrySchema.shape.clientSecret,
  calendarFilter: GoogleBrokerEntrySchema.shape.calendarFilter,
  fromAddress: GoogleBrokerEntrySchema.shape.fromAddress,
  fromName: GoogleBrokerEntrySchema.shape.fromName,
})
export type GoogleBrokerBody = z.infer<typeof GoogleBrokerBodySchema>

export const googleBrokersEntryKind = defineEntryKind('brokers', {
  title: 'Google brokers',
  schema: GoogleBrokerBodySchema,
  writeTrigger: 'an operator adds or edits a Google OAuth broker',
})
