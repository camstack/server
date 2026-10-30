import { describe, expect, it, vi } from 'vitest'
import { buildRademacherAdoptionProvider } from '../rademacher-adoption-provider.js'
import type { AdoptableCover } from '../rademacher-discovery.js'
import { RecordingLogger } from './recording-logger.js'

const INT = 'int-1'
const COVERS: readonly AdoptableCover[] = [
  {
    did: '7',
    name: 'Salotto',
    model: 'RolloTron',
    online: true,
    supportsPosition: true,
    supportsTilt: true,
  },
]

function setup(running = true) {
  const adoptDevice = vi.fn(async (_: { nativeId: string; resolved: { kind: string } }) => ({
    deviceId: 100,
  }))
  const logger = new RecordingLogger()
  const provider = buildRademacherAdoptionProvider({
    logger,
    hasIntegration: () => running,
    listIntegrations: () => [INT],
    integrationName: () => 'Casa',
    isOnline: () => true,
    hubModel: () => 'HomePilot',
    coversOf: () => COVERS,
    listAdopted: async () => [
      { id: 40, config: { system: 'rademacher', integrationId: INT, nativeId: `${INT}:gateway` } },
    ],
    adoptDevice,
    removeDevice: async () => {},
    findDeviceConfig: async () => null,
  })
  return { provider, adoptDevice, logger }
}

describe('Rademacher adoption provider', () => {
  it('lists the gateway and the shutters, flagging the gateway already adopted', async () => {
    const { provider } = setup()
    const page = await provider.listCandidates({ integrationId: INT, page: 1, pageSize: 50 })
    expect(page.candidates.map((c) => [c.childNativeId, c.alreadyAdopted])).toEqual([
      ['int-1:gateway', true],
      ['int-1:cover:7', false],
    ])
  })

  it('adopts a shutter beside the gateway (no parent), reusing what is already adopted', async () => {
    const { provider, adoptDevice } = setup()
    const out = await provider.adopt({
      integrationId: INT,
      childNativeIds: ['int-1:gateway', 'int-1:cover:7'],
    })
    expect(out.adopted.map((a) => [a.childNativeId, a.parentDeviceId])).toEqual([
      ['int-1:gateway', 40],
      ['int-1:cover:7', 100],
    ])
    expect(adoptDevice).toHaveBeenCalledTimes(1)
    expect(adoptDevice.mock.calls[0]?.[0].resolved.kind).toBe('cover')
  })

  it('refuses a native id the hub no longer has, on the record, and fails the call when nothing was adopted', async () => {
    const { provider, logger } = setup()
    await expect(
      provider.adopt({ integrationId: INT, childNativeIds: ['int-1:cover:404'] }),
    ).rejects.toThrow(/failed/)
    expect(
      logger.lines.some((l) => l.level === 'warn' && l.message.includes('not adoptable')),
    ).toBe(true)
  })

  it('refuses to adopt for an integration that is not running', async () => {
    const { provider } = setup(false)
    await expect(
      provider.adopt({ integrationId: INT, childNativeIds: ['int-1:cover:7'] }),
    ).rejects.toThrow(/not running/)
  })
})
