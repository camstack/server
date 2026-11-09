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
    const { type, caps } = shapeOf(dev.kind)
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

interface CandidateShape {
  readonly type: DeviceType
  readonly caps: readonly string[]
}

function shapeOf(kind: HomeComDiscoverableDevice['kind']): CandidateShape {
  switch (kind) {
    case 'heating-circuit':
      return { type: DeviceType.Climate, caps: ['climate-control'] }
    case 'dhw':
      return { type: DeviceType.WaterHeater, caps: ['water-heater'] }
    case 'heat-pump':
      return { type: DeviceType.HeatPump, caps: ['heat-pump-status', 'heat-pump-control'] }
  }
}
