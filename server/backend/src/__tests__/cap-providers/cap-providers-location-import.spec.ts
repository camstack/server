/**
 * cap-providers-location-import.spec.ts
 *
 * Verifies that `buildIntegrationsProvider().getAvailableTypes()` correctly
 * surfaces the `supportsLocationImport` flag:
 *   - A `device-adoption` addon whose manifest declares `supportsLocationImport: true`
 *     → returned entry has `supportsLocationImport === true`.
 *   - A `device-adoption` addon WITHOUT the flag
 *     → returned entry has `supportsLocationImport === false`.
 *   - A `device-provider` addon (non-adoption kind), regardless of the flag
 *     → returned entry has `supportsLocationImport === false`.
 *
 * Harness mirrors integrations-delete-cascade.spec.ts in the same directory.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers.js'

// ── Minimal stubs ────────────────────────────────────────────────────────────

function makeIntegrationRegistry() {
  return {
    listIntegrations: vi.fn(async () => []),
    getIntegration: vi.fn(async (_id: string) => null),
    deleteIntegration: vi.fn(async (_id: string) => undefined),
    createIntegration: vi.fn(),
    updateIntegration: vi.fn(),
    getIntegrationByAddonId: vi.fn(),
    getIntegrationSettings: vi.fn(),
    setIntegrationSettings: vi.fn(),
  }
}

type FakeAddonRow = {
  manifest: {
    id: string
    name: string
    description: string
    capabilities: Array<{ name: string }>
    supportsLocationImport?: boolean
    brokerKind?: string
    instanceMode?: string
    icon?: string
    color?: string
  }
  declaration?: {
    supportsLocationImport?: boolean
    brokerKind?: string
    instanceMode?: string
    icon?: string
    color?: string
  }
  process?: { state: string }
}

function makeAddonRegistry(addons: FakeAddonRow[] = []) {
  const integrationReg = makeIntegrationRegistry()
  return {
    getIntegrationRegistry: vi.fn(() => integrationReg),
    listAddons: vi.fn(() => addons),
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

function makeLoggingService() {
  const log = makeLogger()
  return { createLogger: vi.fn(() => log) }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getAvailableTypes — supportsLocationImport flag', () => {
  it('returns supportsLocationImport=true for a device-adoption addon that declares it in the manifest', async () => {
    const addon: FakeAddonRow = {
      manifest: {
        id: 'provider-homeassistant',
        name: 'Home Assistant',
        description: 'Adopt HA devices',
        capabilities: [{ name: 'device-adoption' }],
        supportsLocationImport: true,
        brokerKind: 'home-assistant',
        instanceMode: 'multiple',
      },
    }
    const ar = makeAddonRegistry([addon])
    const provider = buildIntegrationsProvider(
      ar as never,
      makeEventBus() as never,
      makeLoggingService() as never,
      null,
    )
    const types = await provider.getAvailableTypes()

    expect(types).toHaveLength(1)
    expect(types[0]).toMatchObject({
      addonId: 'provider-homeassistant',
      kind: 'device-adoption',
      supportsLocationImport: true,
    })
  })

  it('returns supportsLocationImport=false for a device-adoption addon that omits the flag', async () => {
    const addon: FakeAddonRow = {
      manifest: {
        id: 'provider-test-adoption',
        name: 'Test Adoption Provider',
        description: 'Adoption without location import',
        capabilities: [{ name: 'device-adoption' }],
        brokerKind: 'test-broker',
        instanceMode: 'multiple',
      },
    }
    const ar = makeAddonRegistry([addon])
    const provider = buildIntegrationsProvider(
      ar as never,
      makeEventBus() as never,
      makeLoggingService() as never,
      null,
    )
    const types = await provider.getAvailableTypes()

    expect(types).toHaveLength(1)
    expect(types[0]).toMatchObject({
      addonId: 'provider-test-adoption',
      kind: 'device-adoption',
      supportsLocationImport: false,
    })
  })

  it('returns supportsLocationImport=false for a device-provider addon even when the flag is set on manifest', async () => {
    const addon: FakeAddonRow = {
      manifest: {
        id: 'provider-reolink',
        name: 'Reolink Provider',
        description: 'Classic device provider',
        capabilities: [{ name: 'device-provider' }],
        // Hypothetical: even if someone mistakenly sets this on a device-provider
        supportsLocationImport: true,
        instanceMode: 'single',
      },
    }
    const ar = makeAddonRegistry([addon])
    const provider = buildIntegrationsProvider(
      ar as never,
      makeEventBus() as never,
      makeLoggingService() as never,
      null,
    )
    const types = await provider.getAvailableTypes()

    expect(types).toHaveLength(1)
    expect(types[0]).toMatchObject({
      addonId: 'provider-reolink',
      kind: 'device-provider',
      supportsLocationImport: false,
    })
  })

  it('prefers declaration.supportsLocationImport over manifest when declaration is present', async () => {
    const addon: FakeAddonRow = {
      manifest: {
        id: 'provider-homeassistant',
        name: 'Home Assistant',
        description: 'Adopt HA devices',
        capabilities: [{ name: 'device-adoption' }],
        supportsLocationImport: false,
        brokerKind: 'home-assistant',
        instanceMode: 'multiple',
      },
      declaration: {
        supportsLocationImport: true,
        brokerKind: 'home-assistant',
        instanceMode: 'multiple',
      },
    }
    const ar = makeAddonRegistry([addon])
    const provider = buildIntegrationsProvider(
      ar as never,
      makeEventBus() as never,
      makeLoggingService() as never,
      null,
    )
    const types = await provider.getAvailableTypes()

    expect(types).toHaveLength(1)
    expect(types[0]).toMatchObject({
      addonId: 'provider-homeassistant',
      kind: 'device-adoption',
      supportsLocationImport: true,
    })
  })
})
