import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import { deviceTypeForRoster } from '@apocaliss92/nodepetkit'

/**
 * Minimal structural subset of a PetKit roster row the discovery code needs.
 * A `Pick`-like interface keeps the signature tight while staying structurally
 * compatible with the library's `PetkitDeviceInfo` and test fixtures — no cast.
 */
export interface PetkitDiscoverable {
  readonly id: string
  readonly deviceType: string
  readonly model: string
  readonly name: string
}

export interface BuildPetkitCandidatesInput {
  readonly devices: readonly PetkitDiscoverable[]
  /** petkitDeviceId → adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Map PetKit roster rows to adoption candidates — one `PetFeeder` candidate per
 * feeder. Non-feeder families (litter / fountain / purifier) are omitted: this
 * addon adopts feeders only. Pure: no network I/O, no side effects. Mirrors
 * `buildDreameCandidates`.
 */
export function buildPetkitCandidates(input: BuildPetkitCandidatesInput): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const device of input.devices) {
    if (deviceTypeForRoster(device.deviceType, device.model) !== 'feeder') continue
    const adoptedId = input.adopted.get(device.id) ?? null
    out.push({
      childNativeId: device.id,
      name: device.name.length > 0 ? device.name : device.id,
      type: DeviceType.PetFeeder,
      status: 'online',
      metadata: {
        serialNumber: device.id,
        model: device.model.length > 0 ? device.model : device.deviceType,
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: ['pet-feeder'],
    })
  }
  return out
}
