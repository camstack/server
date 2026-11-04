/**
 * Broker entry kind (B2): credentials live in records; integrations keep brokerId.
 *
 * The body is FLAT (planning#408 P3): the form the instances page edits is the stored shape,
 * with the two tokens at the top level where the records door keeps them in the keychain.
 */
import { defineEntryKind, entryBody } from '@camstack/types'
import type { z } from 'zod'
import { HaBrokerEntrySchema } from './ha-broker-registry.js'

export const HA_BROKERS_KIND = 'brokers'
export const HA_BROKERS_OWNER = 'provider-homeassistant'

export const HaBrokerBodySchema = entryBody({
  authKind: HaBrokerEntrySchema.shape.authKind,
  baseUrl: HaBrokerEntrySchema.shape.baseUrl,
  accessToken: HaBrokerEntrySchema.shape.accessToken,
  supervisorToken: HaBrokerEntrySchema.shape.supervisorToken,
  integrationId: HaBrokerEntrySchema.shape.integrationId,
  enabled: HaBrokerEntrySchema.shape.enabled,
})
export type HaBrokerBody = z.infer<typeof HaBrokerBodySchema>

export const haBrokersEntryKind = defineEntryKind(HA_BROKERS_KIND, {
  title: 'Home Assistant brokers',
  schema: HaBrokerBodySchema,
  writeTrigger: 'an operator adds, edits or removes a Home Assistant broker connection',
  // The nested shape's secrets: a declared secret path never stops being secret.
  retiredSecretPaths: ['auth.accessToken', 'auth.supervisorToken'],
})
