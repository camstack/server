/**
 * A NEW Ecowitt setup (an integration with no Hub device behind it) proposes the Gateway first,
 * as a sibling of the group Containers, and adopting it creates a top-level device.
 */
import { DeviceType, type IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ECOWITT_GATEWAY_DEVICE_KIND } from '../devices/ecowitt-gateway-device.js'
import {
  buildEcowittAdoptionProvider,
  type EcowittAdoptionProviderDeps,
} from '../ecowitt-adoption-provider.js'
import {
  type EcowittDiscoverableSensor,
  gatewayDeviceNativeId,
  groupNativeId,
} from '../ecowitt-discovery.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const INT = 'int-1'
const KEY = 'ecowitt:int-1'
const SENSORS: readonly EcowittDiscoverableSensor[] = [
  {
    id: 's-wind',
    quantity: 'wind_speed',
    channel: undefined,
    model: 'ws90',
    name: 'Wind',
    category: 'weather-station',
  },
]

function rig(adopted: Array<{ id: number; config: Record<string, unknown> }> = []) {
  const calls: string[] = []
  const deps: EcowittAdoptionProviderDeps = {
    getSensors: () => SENSORS,
    gatewayKeyOf: (id) => (id === INT ? KEY : null),
    listIntegrations: () => [INT],
    integrationName: async () => 'Garden station',
    isOnline: () => true,
    hasAdminLink: () => true,
    listAdopted: async () => adopted,
    adoptGateway: async ({ gatewayKey, name }) => {
      calls.push(`gateway:${gatewayKey}:${name}`)
      return { deviceId: 50 }
    },
    adoptContainer: async ({ group }) => {
      calls.push(`container:${group}`)
      return { deviceId: 60, accessoryDeviceIds: [61] }
    },
    removeDevice: async () => undefined,
    findDeviceConfig: async () => null,
    logger: quiet,
  }
  return { provider: buildEcowittAdoptionProvider(deps), calls }
}

describe('Ecowitt adoption of a new setup', () => {
  it('proposes the Gateway first, then the group Containers', async () => {
    const { provider } = rig()
    const { candidates } = await provider.listCandidates({
      integrationId: INT,
      page: 1,
      pageSize: 50,
    })
    expect(candidates[0]?.type).toBe(DeviceType.Gateway)
    expect(candidates[0]?.childNativeId).toBe(gatewayDeviceNativeId(KEY))
    expect(candidates.slice(1).every((c) => c.type === DeviceType.Container)).toBe(true)
    expect(candidates).toHaveLength(4)
  })

  it('adopting the Gateway creates it top-level, named from the brand and model', async () => {
    const { provider, calls } = rig()
    const result = await provider.adopt({
      integrationId: INT,
      childNativeIds: [gatewayDeviceNativeId(KEY), groupNativeId(KEY, 'weather-station')],
    })
    expect(calls).toEqual([`gateway:${KEY}:Ecowitt`, 'container:weather-station'])
    expect(result.adopted.map((a) => a.parentDeviceId)).toEqual([50, 60])
  })

  it('is idempotent: an already adopted Gateway is reported, not created again', async () => {
    const { provider, calls } = rig([
      {
        id: 50,
        config: {
          system: 'ecowitt',
          integrationId: INT,
          kind: ECOWITT_GATEWAY_DEVICE_KIND,
        },
      },
    ])
    const { candidates } = await provider.listCandidates({
      integrationId: INT,
      page: 1,
      pageSize: 50,
    })
    expect(candidates[0]?.alreadyAdopted).toBe(true)
    const result = await provider.adopt({
      integrationId: INT,
      childNativeIds: [gatewayDeviceNativeId(KEY)],
    })
    expect(calls).toEqual([])
    expect(result.adopted[0]?.parentDeviceId).toBe(50)
  })
})
