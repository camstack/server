import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { HmBrokerEntrySchema } from './config.js'

export const HM_BROKERS_KIND = 'brokers'
export const HM_BROKERS_OWNER = 'provider-homematic'

export const HmBrokerBodySchema = entryBody({
  connection: HmBrokerEntrySchema.shape.connection,
  integrationId: z.string().optional(),
})
export type HmBrokerBody = z.infer<typeof HmBrokerBodySchema>

export const hmBrokersEntryKind = defineEntryKind(HM_BROKERS_KIND, {
  title: 'Homematic brokers',
  schema: HmBrokerBodySchema,
  writeTrigger: 'an operator adds, edits or removes a Homematic CCU broker connection',
})
