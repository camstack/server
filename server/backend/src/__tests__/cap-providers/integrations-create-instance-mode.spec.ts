import { TRPCError } from '@trpc/server'
import type { Integration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * `instanceMode: 'unique'` is a rule of the BACKEND (D979), not of the picker:
 * a second `integrations.create` for a unique addon is refused with a typed
 * CONFLICT whatever client sent it. A `multiple` addon is unaffected, and the
 * candidate an integration was born from reaches the registry.
 */

function integration(id: string, addonId: string): Integration {
  return { id, addonId, name: id, enabled: true, info: {}, createdAt: 1, updatedAt: 1 }
}

function harness(instanceMode: 'unique' | 'multiple', existing: readonly Integration[]) {
  const registry = {
    listIntegrations: vi.fn(async () => existing),
    createIntegration: vi.fn(async (input: { addonId: string; name: string }) =>
      integration('int_new', input.addonId),
    ),
    getIntegration: vi.fn(),
    setIntegrationSettings: vi.fn(),
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const addonReg = {
    getIntegrationRegistry: vi.fn(() => registry),
    listAddons: vi.fn(() => [
      {
        manifest: { id: 'provider-x', name: 'X', instanceMode, capabilities: [] },
        declaration: undefined,
        process: { state: 'running' },
      },
    ]),
    restartAddon: vi.fn(async () => undefined),
    getCapabilityRegistry: vi.fn(() => ({
      getProviderByAddon: vi.fn(() => null),
      getProviderByAddonId: vi.fn(() => null),
      getSingleton: vi.fn(() => null),
    })),
  }
  const provider = buildIntegrationsProvider(
    addonReg as never,
    { emit: vi.fn() } as never,
    { createLogger: vi.fn(() => log) } as never,
    null,
  )
  return { provider, registry }
}

describe('integrations.create and instanceMode', () => {
  it('refuses a second instance of a unique addon with a typed CONFLICT', async () => {
    const h = harness('unique', [integration('int_0001', 'provider-x')])
    const err = await h.provider
      .create({ addonId: 'provider-x', name: 'Second', skipRestart: true })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect(err instanceof TRPCError ? err.code : null).toBe('CONFLICT')
    expect(h.registry.createIntegration).not.toHaveBeenCalled()
  })

  it('allows the first instance of a unique addon', async () => {
    const h = harness('unique', [])
    await h.provider.create({ addonId: 'provider-x', name: 'First', skipRestart: true })
    expect(h.registry.createIntegration).toHaveBeenCalledTimes(1)
  })

  it('allows several instances of a multiple addon, and keeps the origin candidate', async () => {
    const h = harness('multiple', [integration('int_0001', 'provider-x')])
    await h.provider.create({
      addonId: 'provider-x',
      name: 'Hub B',
      originStableId: 'mac-aabbccddeeff',
      skipRestart: true,
    })
    expect(h.registry.createIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ originStableId: 'mac-aabbccddeeff' }),
    )
  })
})
