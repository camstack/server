import { DeviceType, type DiscoveredChildDevice, deviceAdminLinkCapability } from '@camstack/types'
import { availableSpecs, capsOfSpec } from './enpal-catalog.js'
import { ENPAL_EQUIPMENT, childNativeId } from './enpal-equipment.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'

/** The `childNativeId` and equipment id of the box itself, one per integration. */
export const ENPAL_BOX_ID = 'box'

export interface BuildEnpalCandidatesInput {
  /** The box behind the integration: its name, and whether its last poll succeeded. */
  readonly box: { readonly name: string; readonly online: boolean }
  /** The latest poll of the integration, or null while its box is unreachable. */
  readonly snapshot: EnpalSnapshot | null
  /** Adopted container device id per equipment id. */
  readonly adopted: ReadonlyMap<string, number>
}

const METADATA = { manufacturer: 'Enpal', integration: 'enpal' } as const

/**
 * The box ({@link DeviceType.Gateway}, always offered, offline while it is unreachable), then one
 * Container candidate per equipment the box reported at least one value for, with the
 * Sensor children it reported. Pure.
 */
export function buildEnpalCandidates(
  input: BuildEnpalCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const { snapshot } = input
  const boxAdopted = input.adopted.get(ENPAL_BOX_ID) ?? null
  // A sibling of the equipment, never its parent. The only thing the box offers is its local
  // device page; it has no reboot or update.
  const out: DiscoveredChildDevice[] = [
    {
      childNativeId: ENPAL_BOX_ID,
      name: input.box.name,
      type: DeviceType.Gateway,
      status: input.box.online ? 'online' : 'offline',
      metadata: METADATA,
      alreadyAdopted: boxAdopted !== null,
      adoptedDeviceId: boxAdopted,
      capabilities: [deviceAdminLinkCapability.name],
    },
  ]
  if (snapshot === null) return out
  const reported = new Map(availableSpecs(snapshot).map((spec) => [spec.id, spec]))
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
