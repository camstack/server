import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildProviderZigbeeZ2mAdoptionProvider } from '../provider-zigbee-z2m-adoption.js'
import { planZ2mDevice } from '../z2m-exposes.js'
import { contactSensorExposes } from './fixtures/z2m-fixtures.js'
import { recordingLogger } from './fakes.js'

const plan = planZ2mDevice(contactSensorExposes)
if (plan === null) throw new Error('fixture has no plan')

function provider(firmware: boolean) {
  return buildProviderZigbeeZ2mAdoptionProvider({
    hasIntegration: async () => true,
    listIntegrations: async () => ['z2m-1'],
    discover: async () => [
      { id: '0x1', name: 'door', type: DeviceType.Sensor, online: true, plan, firmware },
    ],
    adopted: async () => new Map(),
    create: async () => 1,
    remove: async () => {},
    logger: recordingLogger(),
  })
}

describe('Zigbee2MQTT adoption candidates', () => {
  it('offers a firmware Update device beside a device the server can update', async () => {
    const page = await provider(true).listCandidates({
      integrationId: 'z2m-1',
      page: 1,
      pageSize: 50,
    })
    const update = page.candidates.find((c) => c.childNativeId === '0x1#update')
    expect(update).toMatchObject({
      type: DeviceType.Update,
      name: 'door firmware',
      capabilities: ['update'],
    })
  })

  it('offers none for a device without firmware updates', async () => {
    const page = await provider(false).listCandidates({
      integrationId: 'z2m-1',
      page: 1,
      pageSize: 50,
    })
    expect(page.candidates.some((c) => c.type === DeviceType.Update)).toBe(false)
  })
})
