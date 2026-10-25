import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import type { HomeConnectApplianceInfo } from './home-connect-ws-client.js'

export interface BuildHomeConnectCandidatesInput {
  readonly appliances: readonly HomeConnectApplianceInfo[]
  readonly adopted: ReadonlyMap<string, number>
}

/** Dishwasher accessory label: `Dishwasher` plus the appliance name. */
export function homeConnectDishwasherEntityName(containerName: string): string {
  const base = containerName.trim()
  return base.length > 0 ? `Dishwasher ${base}` : 'Dishwasher'
}

function deviceTypeForApplianceType(type: string): DeviceType | null {
  const normalized = type.toLowerCase()
  if (normalized.includes('dishwasher')) return DeviceType.Container
  return null
}

/**
 * The container candidate for one appliance. Its sensor children are not listed here:
 * they are the entities the appliance's own description declares, known once it is
 * connected, and they are attached to the container as that description is read.
 */
function dishwasherContainerCandidate(
  app: HomeConnectApplianceInfo,
  adoptedId: number | null,
): DiscoveredChildDevice {
  const name = app.name.length > 0 ? app.name : app.haId
  const children: DiscoveredChildDevice[] = [
    {
      childNativeId: `${app.haId}#dishwasher`,
      name: homeConnectDishwasherEntityName(name),
      type: DeviceType.Dishwasher,
      status: 'online',
      metadata: { serialNumber: app.haId, model: app.type },
      alreadyAdopted: false,
      adoptedDeviceId: null,
      capabilities: ['dishwasher'],
    },
  ]
  return {
    childNativeId: app.haId,
    name,
    type: DeviceType.Container,
    status: 'online',
    metadata: {
      serialNumber: app.haId,
      model: app.type,
    },
    alreadyAdopted: adoptedId !== null,
    adoptedDeviceId: adoptedId,
    capabilities: [],
    children,
  }
}

export function buildHomeConnectCandidates(
  input: BuildHomeConnectCandidatesInput,
): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const app of input.appliances) {
    const camType = deviceTypeForApplianceType(app.type)
    if (camType === null) continue
    const adoptedId = input.adopted.get(app.haId) ?? null
    out.push(dishwasherContainerCandidate(app, adoptedId))
  }
  return out
}
