/**
 * The account record the addon specs run against: the real `brokers` kind (keychain included),
 * holding one connected Google account. The addon persists sessions here, so a spec asserts on
 * what the record holds, not on a mock.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { googleBrokersEntryKind } from '../broker-record-kinds.js'
import { GoogleBrokerStore } from '../google-broker-store.js'
import type { GoogleServicesAddon } from '../google-services.addon.js'

export const SEEDED_ACCOUNT = {
  id: 'google_001',
  name: 'Work Google',
  clientId: 'cid',
  clientSecret: 'sec',
  calendarFilter: '',
  fromAddress: '',
  fromName: '',
} as const

export async function seededBrokerStore(refreshToken = 'rt'): Promise<GoogleBrokerStore> {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({ brokers: googleBrokersEntryKind })
  const store = GoogleBrokerStore.of(world.records)
  await store.putOne(SEEDED_ACCOUNT, {
    refreshToken,
    accountEmail: 'a@example.com',
    scopes: '',
    needsReauth: false,
  })
  return store
}

/** The store an addon under test persists to. */
export function brokerStoreOf(addon: GoogleServicesAddon): GoogleBrokerStore {
  const store: unknown = Reflect.get(addon, 'brokerStore')
  if (!(store instanceof GoogleBrokerStore)) throw new Error('no broker store on the addon')
  return store
}
