import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import type { HomeComDiscoverableDevice } from './homecom-gateway.js'

export interface BuildHomeComCandidatesInput {
  readonly devices: readonly HomeComDiscoverableDevice[]
  readonly adopted: ReadonlyMap<string, number>
}

export function buildHomeComCandidates(
  input: BuildHomeComCandidatesInput,
): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const dev of input.devices) {
    const type = dev.kind === 'heating-circuit' ? DeviceType.Climate : DeviceType.WaterHeater
    const caps = dev.kind === 'heating-circuit' ? ['climate-control'] : ['water-heater']
    const adoptedId = input.adopted.get(dev.nativeId) ?? null
    out.push({
      childNativeId: dev.nativeId,
      name: dev.name,
      type,
      status: 'online',
      metadata: { serialNumber: dev.nativeId },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: caps,
    })
  }
  return out
}
