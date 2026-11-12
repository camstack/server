/**
 * A gateway name is chosen when the device is created. An id the integration
 * already adopted is reported as that device; nothing writes a new name over it.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildVeluxAdoptionProvider } from '../velux-adoption-provider.js'
import { gatewayNativeId } from '../velux-discovery.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const INT = 'int-1'

function provider(adopted: ReadonlyArray<{ id: number; config: Record<string, unknown> }>) {
  const adoptDevice = vi.fn(async () => ({ deviceId: 7 }))
  return {
    adoptDevice,
    provider: buildVeluxAdoptionProvider({
      hasIntegration: () => true,
      listIntegrations: () => [INT],
      integrationName: () => 'Casa KLF',
      isOnline: () => true,
      nodesOf: () => [],
      listAdopted: async () => adopted,
      adoptDevice,
      removeDevice: async () => undefined,
      findDeviceConfig: async () => null,
      logger: quiet,
    }),
  }
}

describe('Velux gateway adoption names', () => {
  it('names a new gateway Velux KLF200, not the integration', async () => {
    const { provider: adoption, adoptDevice } = provider([])
    await adoption.adopt({ integrationId: INT, childNativeIds: [gatewayNativeId(INT)] })
    expect(adoptDevice).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Velux KLF200', nativeId: gatewayNativeId(INT) }),
    )
  })

  it('keeps an already adopted gateway on its stored device', async () => {
    const nativeId = gatewayNativeId(INT)
    const { provider: adoption, adoptDevice } = provider([
      { id: 42, config: { system: 'velux', integrationId: INT, nativeId } },
    ])
    const out = await adoption.adopt({ integrationId: INT, childNativeIds: [nativeId] })
    expect(adoptDevice).not.toHaveBeenCalled()
    expect(out.adopted[0]?.parentDeviceId).toBe(42)
  })
})
