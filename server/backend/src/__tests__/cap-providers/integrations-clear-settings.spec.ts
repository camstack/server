import type { Integration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * `integrations.clearSettings` deletes an integration's legacy rows and their keychain values,
 * and only for the addon that owns the integration (it moved the rows into its record first).
 */

const ADDON_ID = 'provider-fake'

function integration(): Integration {
  return {
    id: 'int_0001',
    addonId: ADDON_ID,
    name: 'Fake',
    enabled: true,
    info: null,
    settings: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Integration
}

function harness() {
  const registry = {
    getIntegration: vi.fn(async () => integration()),
    getIntegrationSettings: vi.fn(async () => ({ a: { $secret: 'ref-1' }, b: 2 })),
    clearIntegrationSettings: vi.fn(async () => ['ref-1']),
  }
  const secretsDelete = vi.fn(async () => undefined)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const addonReg = {
    getIntegrationRegistry: vi.fn(() => registry),
    secretsForOwner: vi.fn(() => ({ delete: secretsDelete })),
    runnerIdFor: vi.fn(() => 'runner-fake'),
    listAddons: vi.fn(() => []),
    getCapabilityRegistry: vi.fn(() => ({
      getSingleton: vi.fn(() => null),
      getProviderByAddon: vi.fn(() => null),
    })),
  }
  const provider = buildIntegrationsProvider(
    addonReg as never,
    { emit: vi.fn() } as never,
    { createLogger: vi.fn(() => log) } as never,
    null,
  )
  return { provider, registry, secretsDelete }
}

describe('integrations.clearSettings', () => {
  it('clears the rows and releases the keychain values for the owning addon', async () => {
    const h = harness()
    const stamped = { id: 'int_0001', callerAddonId: ADDON_ID }
    expect(await h.provider.clearSettings(stamped)).toEqual({ rows: 2, secrets: 1 })
    expect(h.registry.clearIntegrationSettings).toHaveBeenCalledWith('int_0001')
    expect(h.secretsDelete).toHaveBeenCalledWith(['ref-1'])
  })

  it('refuses anyone who is not the owning addon, and clears nothing', async () => {
    const h = harness()
    await expect(h.provider.clearSettings({ id: 'int_0001' })).rejects.toThrow(
      /only by its own addon/,
    )
    const foreign = { id: 'int_0001', callerAddonId: 'provider-someone-else' }
    await expect(h.provider.clearSettings(foreign)).rejects.toThrow(/only by its own addon/)
    expect(h.registry.clearIntegrationSettings).not.toHaveBeenCalled()
  })
})
