/**
 * HA specs declare the provider's kinds on the shared in-memory records fake.
 */
import { makeInMemoryRecords, type InMemoryRecords } from '@camstack/types'
import { haNotifyRecordKinds } from '../ha-notification-output.js'
import { haAllRecordKinds } from '../record-kinds.js'

export type FakeHaRecords = InMemoryRecords

export function makeFakeHaRecords(owner = 'provider-homeassistant'): FakeHaRecords {
  return makeInMemoryRecords(owner)
}

export async function makeHaRecords(): Promise<FakeHaRecords> {
  const world = makeFakeHaRecords()
  await world.records.declare({ ...haAllRecordKinds, ...haNotifyRecordKinds })
  return world
}
