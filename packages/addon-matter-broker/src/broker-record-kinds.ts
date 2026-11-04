import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { matterConnectionSchema } from './config.js'

export const MATTER_BROKERS_OWNER = 'matter-broker'

export const MatterBrokerBodySchema = entryBody({
  ...matterConnectionSchema.shape,
  integrationId: z.string().optional(),
  enabled: z.boolean().optional(),
})
export type MatterBrokerBody = z.infer<typeof MatterBrokerBodySchema>

export const matterBrokersEntryKind = defineEntryKind('brokers', {
  title: 'Matter brokers',
  schema: MatterBrokerBodySchema,
  writeTrigger: 'an operator adds, edits or removes a Matter fabric broker',
})
