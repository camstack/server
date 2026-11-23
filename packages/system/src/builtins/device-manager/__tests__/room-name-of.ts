/**
 * The room name a persisted device row points at (D1089). The row stores only
 * `locationId`; the name is the room record's, so a spec resolves it the way a
 * reader does — through the rooms the provider lists — and an unknown id reads
 * as unset.
 */
import type { IDeviceManagerProvider } from '@camstack/types'
import { type FakeSettingsStore, readDeviceRow } from './settings-store-api.js'

export async function roomNameOf(
  provider: Pick<IDeviceManagerProvider, 'listRooms'>,
  store: FakeSettingsStore,
  deviceId: number,
): Promise<string | null> {
  const id = (await readDeviceRow(store, deviceId))['locationId']
  if (typeof id !== 'string') return null
  const rooms = await provider.listRooms()
  return rooms.find((room) => room.id === id)?.name ?? null
}
