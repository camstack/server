import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildAlexaAdoptionProvider } from '../alexa-adoption-provider.js'
import type { EchoDevice } from '../speak/worker-protocol.js'

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as IScopedLogger

const kitchen: EchoDevice = {
  id: 'S1',
  name: 'Kitchen',
  family: 'ECHO',
  online: true,
  kind: 'device',
  dnd: false,
  deviceType: 'T1',
  room: 'Kitchen room',
}
const group: EchoDevice = {
  ...kitchen,
  id: 'G1',
  name: 'Everywhere',
  family: 'WHA',
  kind: 'group',
}

function build(adopted: ReadonlyArray<{ id: number; config: Record<string, unknown> }> = []) {
  const adoptEcho = vi.fn(async () => ({ deviceId: 55 }))
  const provider = buildAlexaAdoptionProvider({
    registry: {
      getAppliancesForBroker: () => [],
      getEchoesForBroker: () => [kitchen, group],
      list: () => [{ id: 'b', name: 'Home' }],
      has: () => true,
    },
    getBrokerIdForIntegration: async () => 'b',
    listAdoptedAlexa: async () => adopted,
    adoptAppliance: vi.fn(),
    adoptEcho,
    removeDevice: vi.fn(),
    findDeviceConfig: async () => null,
    logger,
  })
  return { provider, adoptEcho }
}

describe('Echo adoption candidates', () => {
  it('offers each Echo as a media player named echo:<serial> and skips WHA groups', async () => {
    const { provider } = build()
    const { candidates } = await provider.listCandidates({
      integrationId: 'i',
      page: 0,
      pageSize: 50,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      childNativeId: 'echo:S1',
      name: 'Kitchen',
      type: 'media-player',
      alreadyAdopted: false,
      capabilities: ['media-player', 'do-not-disturb'],
    })
  })

  it('marks an adopted Echo by its serial', async () => {
    const { provider } = build([
      { id: 9, config: { system: 'alexa', brokerId: 'b', serial: 'S1' } },
    ])
    const { candidates } = await provider.listCandidates({
      integrationId: 'i',
      page: 0,
      pageSize: 50,
    })
    expect(candidates[0]).toMatchObject({
      alreadyAdopted: true,
      adoptedDeviceId: 9,
    })
  })

  it('adopts an Echo through adoptEcho and refuses a group', async () => {
    const { provider, adoptEcho } = build()
    const result = await provider.adopt({
      integrationId: 'i',
      childNativeIds: ['echo:S1'],
    })
    expect(adoptEcho).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'b',
        echo: kitchen,
        name: 'Kitchen',
      }),
    )
    expect(result.adopted[0]).toMatchObject({
      childNativeId: 'echo:S1',
      parentDeviceId: 55,
    })
    await expect(
      provider.adopt({ integrationId: 'i', childNativeIds: ['echo:G1'] }),
    ).rejects.toThrow()
  })
})
