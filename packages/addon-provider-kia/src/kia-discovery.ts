import type { DiscoveredChildDevice } from '@dominevo/types'
import { DeviceType } from '@dominevo/types'

/** One vehicle of a Kia account as discovery and adoption see it. */
export interface KiaDiscoverable {
  readonly vehicleId: string
  readonly name: string
  readonly model: string
  readonly year: number | null
  readonly engineType: string | null
}

export interface BuildKiaCandidatesInput {
  readonly vehicles: readonly KiaDiscoverable[]
  /** Kia cloud vehicle id to the adopted Dominevo device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Map the account's vehicles to adoption candidates. Pure: no network I/O. The VIN is
 * deliberately not in the metadata: it is personal data the candidate list does not need.
 */
export function buildKiaCandidates(input: BuildKiaCandidatesInput): DiscoveredChildDevice[] {
  return input.vehicles.map((vehicle) => {
    const adoptedId = input.adopted.get(vehicle.vehicleId) ?? null
    return {
      childNativeId: vehicle.vehicleId,
      name: vehicle.name.length > 0 ? vehicle.name : vehicle.model,
      type: DeviceType.Vehicle,
      status: 'online',
      metadata: { serialNumber: vehicle.vehicleId, model: vehicle.model },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: ['vehicle', 'location', 'consumables'],
    }
  })
}
