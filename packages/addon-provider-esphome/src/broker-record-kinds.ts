import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { espConnectionSchema } from './config.js'

export const ESP_BROKERS_KIND = 'brokers'
export const ESP_BROKERS_OWNER = 'provider-esphome'

export const EspBrokerBodySchema = entryBody({
  connection: espConnectionSchema,
  integrationId: z.string().optional(),
})
export type EspBrokerBody = z.infer<typeof EspBrokerBodySchema>

export const espBrokersEntryKind = defineEntryKind(ESP_BROKERS_KIND, {
  title: 'ESPHome boards',
  schema: EspBrokerBodySchema,
  writeTrigger: 'an operator adds, edits or removes an ESPHome board connection',
})
