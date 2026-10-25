import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'
import type { CapabilityRegistry } from '@camstack/system'
import type { Integration } from '@camstack/types'

// ── Minimal stubs ────────────────────────────────────────────────────────────

const INTEGRATION_ID = 'integ-abc-123'
const ADDON_ID = 'provider-test'

function makeIntegration(id = INTEGRATION_ID): Integration {
  return {
    id,
    addonId: ADDON_ID,
    name: 'Test Integration',
    enabled: true,
    info: null,
    settings: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Integration
}

function makeIntegrationRegistry(integration: Integration | null = makeIntegration()) {
  return {
    getIntegration: vi.fn(async (_id: string) => integration),
    deleteIntegration: vi.fn(async (_id: string) => undefined),
    listIntegrations: vi.fn(async () => (integration ? [integration] : [])),
    createIntegration: vi.fn(),
    updateIntegration: vi.fn(),
    getIntegrationByAddonId: vi.fn(),
    getIntegrationSettings: vi.fn(),
    setIntegrationSettings: vi.fn(),
  }
}

function makeAddonRegistry(reg = makeIntegrationRegistry()) {
  return {
    getIntegrationRegistry: vi.fn(() => reg),
    listAddons: vi.fn(() => []),
    restartAddon: vi.fn(),
    getCapabilityRegistry: vi.fn(() => ({
      getProviderByAddon: vi.fn(() => null),
    })),
  }
}

function makeEventBus() {
  return { emit: vi.fn() }
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeLoggingService(log = makeLogger()) {
  return { createLogger: vi.fn(() => log) }
}

function makeCapabilityRegistry(
  removeByIntegration:
    | ((input: { integrationId: string }) => Promise<{ removed: number }>)
    | null = vi.fn(async () => ({ removed: 2 })),
): CapabilityRegistry {
  return {
    getSingleton: vi.fn((_cap: string) => (removeByIntegration ? { removeByIntegration } : null)),
  } as unknown as CapabilityRegistry
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('integrations.delete cascade-removes devices via removeByIntegration', () => {
  let integrationReg: ReturnType<typeof makeIntegrationRegistry>
  let addonReg: ReturnType<typeof makeAddonRegistry>
  let eb: ReturnType<typeof makeEventBus>
  let log: ReturnType<typeof makeLogger>
  let loggingService: ReturnType<typeof makeLoggingService>

  beforeEach(() => {
    integrationReg = makeIntegrationRegistry()
    addonReg = makeAddonRegistry(integrationReg)
    eb = makeEventBus()
    log = makeLogger()
    loggingService = makeLoggingService(log)
  })

  it('refuses a FIXED integration before touching a single device', async () => {
    // The defect this pins: the registry's own `fixed` guard is the LAST step,
    // and the cascade above it is best-effort — so the refusal used to arrive
    // after every device was already gone. It destroyed the alarm panel, which
    // then came back with a new id and no state.
    const fixed = { ...makeIntegration(), info: { fixed: true } } as unknown as Integration
    integrationReg = makeIntegrationRegistry(fixed)
    addonReg = makeAddonRegistry(integrationReg)
    const removeByIntegration = vi.fn(async () => ({ removed: 1 }))
    const capReg = makeCapabilityRegistry(removeByIntegration)

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )

    await expect(provider.delete({ id: INTEGRATION_ID })).rejects.toThrow(/is fixed/)

    expect(removeByIntegration).not.toHaveBeenCalled()
    expect(integrationReg.deleteIntegration).not.toHaveBeenCalled()
    expect(eb.emit).not.toHaveBeenCalled()
  })

  it('calls removeByIntegration with the integration id before deleteIntegration', async () => {
    const removeByIntegration = vi.fn(async () => ({ removed: 3 }))
    const capReg = makeCapabilityRegistry(removeByIntegration)

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )
    await provider.delete({ id: INTEGRATION_ID })

    expect(removeByIntegration).toHaveBeenCalledOnce()
    expect(removeByIntegration).toHaveBeenCalledWith({ integrationId: INTEGRATION_ID })
  })

  it('still deletes the integration record and emits integration.deleted after the cascade', async () => {
    const capReg = makeCapabilityRegistry()

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )
    const result = await provider.delete({ id: INTEGRATION_ID })

    expect(integrationReg.deleteIntegration).toHaveBeenCalledOnce()
    expect(integrationReg.deleteIntegration).toHaveBeenCalledWith(INTEGRATION_ID)

    expect(eb.emit).toHaveBeenCalledOnce()
    expect(eb.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'integration.deleted',
        data: expect.objectContaining({ integrationId: INTEGRATION_ID }),
      }),
    )

    expect(result).toEqual({ success: true, deletedId: INTEGRATION_ID })
  })

  it('logs the removed count from removeByIntegration', async () => {
    const removeByIntegration = vi.fn(async () => ({ removed: 5 }))
    const capReg = makeCapabilityRegistry(removeByIntegration)

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )
    await provider.delete({ id: INTEGRATION_ID })

    expect(log.info).toHaveBeenCalledWith(
      'cascade-removed devices',
      expect.objectContaining({ meta: expect.objectContaining({ removed: 5 }) }),
    )
  })

  it('does NOT abort the integration delete when removeByIntegration throws (best-effort)', async () => {
    const removeByIntegration = vi.fn(async () => {
      throw new Error('device-manager transient error')
    })
    const capReg = makeCapabilityRegistry(removeByIntegration)

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )

    // Should NOT throw
    await expect(provider.delete({ id: INTEGRATION_ID })).resolves.toEqual({
      success: true,
      deletedId: INTEGRATION_ID,
    })

    // Integration record deletion and event still fire
    expect(integrationReg.deleteIntegration).toHaveBeenCalledOnce()
    expect(eb.emit).toHaveBeenCalledOnce()

    // A warning is logged
    expect(log.warn).toHaveBeenCalledWith(
      'device cascade-remove failed (best-effort — continuing)',
      expect.anything(),
    )
  })

  it('warns and skips cascade when capabilityRegistry is null', async () => {
    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      null,
    )
    await provider.delete({ id: INTEGRATION_ID })

    expect(integrationReg.deleteIntegration).toHaveBeenCalledOnce()
    expect(eb.emit).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledWith(
      'device-manager not available — skipping cascade device removal',
      expect.anything(),
    )
  })

  it('warns and skips cascade when device-manager singleton is not registered', async () => {
    const capReg = makeCapabilityRegistry(null)

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )
    await provider.delete({ id: INTEGRATION_ID })

    expect(integrationReg.deleteIntegration).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledWith(
      'device-manager not available — skipping cascade device removal',
      expect.anything(),
    )
  })

  it('stamps legacy un-tagged devices of the addon BEFORE cascade so they are removed too', async () => {
    const removeByIntegration = vi.fn(async () => ({ removed: 1 }))
    const setIntegrationId = vi.fn(
      async (_input: { deviceId: number; integrationId: string }) => undefined,
    )
    // One un-tagged top-level device of the integration's addon (claimable),
    // one already-tagged (skip), one child (skip), one other-addon (skip).
    const listAll = vi.fn(async () => [
      { id: 4, addonId: ADDON_ID, parentDeviceId: null },
      { id: 5, addonId: ADDON_ID, parentDeviceId: null, integrationId: INTEGRATION_ID },
      { id: 6, addonId: ADDON_ID, parentDeviceId: 4 },
      { id: 7, addonId: 'provider-other', parentDeviceId: null },
    ])
    const capReg = {
      getSingleton: vi.fn(() => ({ removeByIntegration, listAll, setIntegrationId })),
    } as unknown as CapabilityRegistry

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )
    await provider.delete({ id: INTEGRATION_ID })

    // Only device 4 is claimed (untagged, top-level, this addon's single integration).
    expect(setIntegrationId).toHaveBeenCalledOnce()
    expect(setIntegrationId).toHaveBeenCalledWith({ deviceId: 4, integrationId: INTEGRATION_ID })
    // Cascade still runs after the claim.
    expect(removeByIntegration).toHaveBeenCalledWith({ integrationId: INTEGRATION_ID })
  })

  it('claim failure does not abort the integration delete (best-effort)', async () => {
    const removeByIntegration = vi.fn(async () => ({ removed: 0 }))
    const setIntegrationId = vi.fn(async () => {
      throw new Error('stamp boom')
    })
    const listAll = vi.fn(async () => [{ id: 4, addonId: ADDON_ID, parentDeviceId: null }])
    const capReg = {
      getSingleton: vi.fn(() => ({ removeByIntegration, listAll, setIntegrationId })),
    } as unknown as CapabilityRegistry

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )
    await expect(provider.delete({ id: INTEGRATION_ID })).resolves.toEqual({
      success: true,
      deletedId: INTEGRATION_ID,
    })
    expect(integrationReg.deleteIntegration).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledWith(
      'legacy device claim failed (best-effort — continuing)',
      expect.anything(),
    )
  })

  it('throws when the integration is not found (guard still fires before cascade)', async () => {
    integrationReg = makeIntegrationRegistry(null)
    addonReg = makeAddonRegistry(integrationReg)
    const capReg = makeCapabilityRegistry()

    const provider = buildIntegrationsProvider(
      addonReg as never,
      eb as never,
      loggingService as never,
      capReg,
    )

    await expect(provider.delete({ id: 'missing-id' })).rejects.toThrow('not found')

    // Nothing should have been cleaned up
    expect(integrationReg.deleteIntegration).not.toHaveBeenCalled()
    expect(eb.emit).not.toHaveBeenCalled()
  })
})
