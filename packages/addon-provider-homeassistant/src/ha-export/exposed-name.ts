/**
 * The Home Assistant name of an exported device (`device-export` exposed name, D1049).
 *
 * One name per Home Assistant connection (broker id = instance id), stored in this addon's
 * per-device store (D865). The plan is built once for every broker; the name is applied to the
 * `dev` block per broker at announce time. Only `dev.name` changes: the device key
 * (`dev.ids[0]`, `device_id` on the wire) is the numeric id's, so a rename updates the same
 * Home Assistant device and its entity ids stay.
 */
import { type ExposedNameStore, freeTextNameValidator, readExposedName } from '@camstack/types'
import type { HaDeviceBlock } from './types.js'

/** Home Assistant takes free text for a device name; it is kept to a length its UI shows. */
export const HA_NAME_MAX_LENGTH = 100
export const haNameValidator = freeTextNameValidator('Home Assistant', HA_NAME_MAX_LENGTH)

/** The saved name of the device on each of `brokerIds` that has one. */
export async function namesByBroker(
  store: ExposedNameStore,
  deviceId: number,
  brokerIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (brokerIds.length === 0) return new Map()
  const blob = await store.read(deviceId)
  const out = new Map<string, string>()
  for (const brokerId of brokerIds) {
    const name = readExposedName(blob, brokerId, haNameValidator)
    if (name !== null) out.set(brokerId, name)
  }
  return out
}

/** The `dev` block announced to one broker: its saved name, else the plan's. */
export function devBlockFor(
  dev: HaDeviceBlock,
  names: ReadonlyMap<string, string> | undefined,
  brokerId: string,
): HaDeviceBlock {
  const name = names?.get(brokerId)
  return name === undefined ? dev : { ...dev, name }
}
