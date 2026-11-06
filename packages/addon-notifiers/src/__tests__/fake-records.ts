/**
 * A records world for notifiers specs: the REAL `ctx.records` facade over the shared in-memory
 * engine, keychain included (a target's token is a secret field, so the door needs one). Test-only.
 */
import {
  makeInMemoryRecords,
  notificationTargetKinds,
  type InMemoryRecords,
  type TargetKind,
} from '@camstack/types'
import { notifierDescriptors } from '../record-kinds.js'

export type FakeNotifiersRecords = InMemoryRecords

export function makeFakeNotifiersRecords(owner = 'notifiers'): FakeNotifiersRecords {
  return makeInMemoryRecords(owner)
}

/** The fake with the notifiers kinds declared, ready to build stores from. */
export async function makeNotifiersRecords(
  descriptors: readonly TargetKind[] = notifierDescriptors(),
): Promise<FakeNotifiersRecords> {
  const world = makeFakeNotifiersRecords()
  await world.records.declare(notificationTargetKinds(descriptors))
  return world
}
