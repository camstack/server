/**
 * Broker entry kind (B2): credentials live in records; integrations keep brokerId.
 *
 * The body is FLAT (planning#408 P3): the form the instances page edits is the stored shape,
 * with the two tokens at the top level where the records door keeps them in the keychain.
 */
import { declareBrokerLinkKind, declareLinkKind, defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { HaBrokerEntrySchema } from './ha-broker-registry.js'

export const HA_BROKERS_KIND = 'brokers'
export const HA_BROKERS_OWNER = 'provider-homeassistant'

export const HaBrokerBodySchema = entryBody({
  authKind: HaBrokerEntrySchema.shape.authKind,
  baseUrl: HaBrokerEntrySchema.shape.baseUrl,
  accessToken: HaBrokerEntrySchema.shape.accessToken,
  supervisorToken: HaBrokerEntrySchema.shape.supervisorToken,
  /** Retired: the integration names its broker now; only the link migration reads it. */
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

/** One Home Assistant integration: the connection it imports from, named by id. */
export const haConnectionsEntryKind = declareBrokerLinkKind({
  title: 'Home Assistant integrations',
  writeTrigger: 'an operator creates, edits or removes a Home Assistant integration',
})

/**
 * One calendar a Home Assistant connection imports (D1013): a record that LINKS to the connection
 * it is read from and names the `calendar.*` entity by its id, which is also the id the calendar
 * answers to elsewhere.
 */
export const haCalendarsEntryKind = declareLinkKind({
  name: 'calendars',
  title: 'Home Assistant calendars',
  writeTrigger: 'an operator adds or removes a calendar a Home Assistant connection imports',
  links: { accountId: { cap: 'broker', kind: 'home-assistant' } },
  fields: { calendarId: z.string().default('') },
})
export type HaCalendarBody = z.infer<typeof haCalendarsEntryKind.schema>
