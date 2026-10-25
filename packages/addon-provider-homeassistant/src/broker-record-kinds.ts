/**
 * Broker entry kind (B2): credentials live in records; integrations keep brokerId.
 */
import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { HaBrokerEntrySchema } from './ha-broker-registry.js'

export const HA_BROKERS_KIND = 'brokers'
export const HA_BROKERS_OWNER = 'provider-homeassistant'

export const HaBrokerBodySchema = entryBody({
  auth: HaBrokerEntrySchema.shape.auth,
  integrationId: z.string().optional(),
})
export type HaBrokerBody = z.infer<typeof HaBrokerBodySchema>

export const haBrokersEntryKind = defineEntryKind(HA_BROKERS_KIND, {
  title: 'Home Assistant brokers',
  schema: HaBrokerBodySchema,
  writeTrigger: 'an operator adds, edits or removes a Home Assistant broker connection',
})
