import type { Integration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * `integrations.setSettings` respawns the integration's addon so it reloads
 * what was saved. An addon that holds several sessions in one integration
 * (ESPHome boards) applies the change itself and asks the hub NOT to respawn
 * it — but only the owner may ask: any other caller would leave an addon
 * running on settings it never reloaded.
 */

const ADDON_ID = 'provider-fake-multi'
const RUNNER_ID = 'runner-fake-multi'

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
    getIntegrationSettings: vi.fn(async () => ({})),
    setIntegrationSettings: vi.fn(async () => undefined),
  }
  const restartAddon = vi.fn(async () => ({ success: true }))
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const addonReg = {
    getIntegrationRegistry: vi.fn(() => registry),
    restartAddon,
    runnerIdFor: vi.fn(() => RUNNER_ID),
    listAddons: vi.fn(() => []),
    getCapabilityRegistry: vi.fn(() => ({ getSingleton: vi.fn(() => null) })),
  }
  const provider = buildIntegrationsProvider(
    addonReg as never,
    { emit: vi.fn() } as never,
    { createLogger: vi.fn(() => log) } as never,
    null,
  )
  return { provider, registry, restartAddon }
}

describe('integrations.setSettings skipRestart', () => {
  it('respawns the addon by default', async () => {
    const h = harness()
    await h.provider.setSettings({ id: 'int_0001', settings: { a: 1 } })
    expect(h.restartAddon).toHaveBeenCalledTimes(1)
  })

  it('does not respawn when the OWNER asks, and still persists', async () => {
    const h = harness()
    // The transport stamps callerAddonId into the call; it is not in the input schema.
    const stamped = {
      id: 'int_0001',
      settings: { a: 1 },
      skipRestart: true,
      callerAddonId: ADDON_ID,
    }
    await h.provider.setSettings(stamped)
    expect(h.registry.setIntegrationSettings).toHaveBeenCalledTimes(1)
    expect(h.restartAddon).not.toHaveBeenCalled()
  })

  it('respawns when a caller that is not the owner asks to skip', async () => {
    const h = harness()
    await h.provider.setSettings({
      id: 'int_0001',
      settings: { a: 1 },
      skipRestart: true,
    })
    const stamped = {
      id: 'int_0001',
      settings: { a: 1 },
      skipRestart: true,
      callerAddonId: 'provider-someone-else',
    }
    await h.provider.setSettings(stamped)
    expect(h.restartAddon).toHaveBeenCalledTimes(2)
  })
})
