import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import { availableSpecs, capsOfSpec } from './enpal-catalog.js'
import { ENPAL_EQUIPMENT, childNativeId } from './enpal-equipment.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'

export interface BuildEnpalCandidatesInput {
  /** The latest poll of the integration, or null while its box is unreachable. */
  readonly snapshot: EnpalSnapshot | null
  /** Adopted container device id per equipment id. */
  readonly adopted: ReadonlyMap<string, number>
}

const METADATA = { manufacturer: 'Enpal', integration: 'enpal' } as const

/**
 * One Container candidate per equipment the box reported at least one value for, with the
 * Sensor children it reported. Pure.
 */
export function buildEnpalCandidates(
  input: BuildEnpalCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const { snapshot } = input
  if (snapshot === null) return []
  const reported = new Map(availableSpecs(snapshot).map((spec) => [spec.id, spec]))
  const out: DiscoveredChildDevice[] = []
  for (const equipment of ENPAL_EQUIPMENT) {
    const specs = equipment.specIds.flatMap((id) => reported.get(id) ?? [])
    if (specs.length === 0) continue
    const adoptedId = input.adopted.get(equipment.id) ?? null
    out.push({
      childNativeId: equipment.id,
      name: equipment.name,
      type: DeviceType.Container,
      status: 'online',
      metadata: METADATA,
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: [],
      children: specs.map(
        (spec): DiscoveredChildDevice => ({
          childNativeId: childNativeId(equipment.id, spec.id),
          name: spec.name,
          type: DeviceType.Sensor,
          status: 'online',
          metadata: METADATA,
          alreadyAdopted: false,
          adoptedDeviceId: null,
          capabilities: capsOfSpec(spec),
        }),
      ),
    })
  }
  return out
}
