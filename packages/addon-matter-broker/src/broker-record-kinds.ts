import { declareLinkKind, defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { matterConnectionSchema } from './config.js'

export const MATTER_BROKERS_OWNER = 'matter-broker'

export const MatterBrokerBodySchema = entryBody({
  ...matterConnectionSchema.shape,
  /** Retired (D1012): the link lives on the integration's `connections` record. Only the migration reads it. */
  integrationId: z.string().optional(),
  enabled: z.boolean().optional(),
})
export type MatterBrokerBody = z.infer<typeof MatterBrokerBodySchema>

export const matterBrokersEntryKind = defineEntryKind('brokers', {
  title: 'Matter brokers',
  schema: MatterBrokerBodySchema,
  writeTrigger: 'an operator adds, edits or removes a Matter fabric broker',
  // The nested shape's secrets: a declared secret path never stops being secret.
  retiredSecretPaths: ['connection.threadDataset', 'connection.wifiPassword'],
})

/** A Matter integration: the link to the fabric (broker) it imports devices from. */
export const matterConnectionsEntryKind = declareLinkKind({
  name: 'connections',
  links: { brokerId: { cap: 'broker', kind: 'matter' } },
  title: 'Matter integrations',
  writeTrigger: 'an operator links a Matter integration to a Matter fabric',
})
export type MatterConnectionBody = z.infer<typeof matterConnectionsEntryKind.schema>
