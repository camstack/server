import { makeInMemoryRecords } from '@camstack/types'
import { hmBrokersEntryKind } from '../broker-record-kinds.js'

export async function makeHmRecords() {
  const world = makeInMemoryRecords('provider-homematic')
  await world.records.declare({ brokers: hmBrokersEntryKind })
  return world
}
