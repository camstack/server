import {
  DeviceType,
  type DiscoveredChildDevice,
  deviceAdminLinkCapability,
  gatewayDeviceName,
} from '@camstack/types'
import { availableSpecs, capsOfSpec } from './enpal-catalog.js'
import {
  ENPAL_BOX_ID,
  ENPAL_EQUIPMENT,
  childNativeId,
  findEquipment,
  type EnpalEquipment,
} from './enpal-equipment.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'

export { ENPAL_BOX_ID }

export interface BuildEnpalCandidatesInput {
  /** The box behind the integration: its name, and whether its last poll succeeded. */
  readonly box: { readonly name: string; readonly online: boolean }
  /** The latest poll of the integration, or null while its box is unreachable. */
  readonly snapshot: EnpalSnapshot | null
  /** Adopted device id per equipment id (the box under {@link ENPAL_BOX_ID}). */
  readonly adopted: ReadonlyMap<string, number>
}

const METADATA = { manufacturer: 'Enpal', integration: 'enpal' } as const

/** The Sensor candidates of one piece: the catalog entries of it the box reported. */
function reportedChildren(
  equipment: EnpalEquipment,
  snapshot: EnpalSnapshot | null,
): readonly DiscoveredChildDevice[] {
  if (snapshot === null) return []
  const reported = new Map(availableSpecs(snapshot).map((spec) => [spec.id, spec]))
  return equipment.specIds.flatMap((id): DiscoveredChildDevice[] => {
    const spec = reported.get(id)
    if (spec === undefined) return []
    return [
      {
        childNativeId: childNativeId(equipment.id, spec.id),
        name: spec.name,
        type: DeviceType.Sensor,
        status: 'online',
        metadata: METADATA,
        alreadyAdopted: false,
        adoptedDeviceId: null,
        capabilities: capsOfSpec(spec),
      },
    ]
  })
}

/**
 * The box ({@link DeviceType.Gateway}, always offered, offline while it is unreachable, with the
 * diagnostics it reported as children), then one Container candidate per other piece the box
 * reported at least one value for, with the Sensor children it reported. Pure.
 */
export function buildEnpalCandidates(
  input: BuildEnpalCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const { snapshot } = input
  const boxAdopted = input.adopted.get(ENPAL_BOX_ID) ?? null
  const box = findEquipment(ENPAL_BOX_ID)
  const boxChildren = box === undefined ? [] : reportedChildren(box, snapshot)
  // A sibling of the equipment, never its parent. Besides its diagnostics, the only thing the
  // box offers is its local device page; it has no reboot or update.
  const out: DiscoveredChildDevice[] = [
    {
      childNativeId: ENPAL_BOX_ID,
      name: gatewayDeviceName('Enpal', 'Box'),
      type: DeviceType.Gateway,
      status: input.box.online ? 'online' : 'offline',
      metadata: METADATA,
      alreadyAdopted: boxAdopted !== null,
      adoptedDeviceId: boxAdopted,
      capabilities: [deviceAdminLinkCapability.name],
      ...(boxChildren.length > 0 ? { children: boxChildren } : {}),
    },
  ]
  for (const equipment of ENPAL_EQUIPMENT) {
    if (equipment.kind !== 'container') continue
    const children = reportedChildren(equipment, snapshot)
    if (children.length === 0) continue
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
      children,
    })
  }
  return out
}
