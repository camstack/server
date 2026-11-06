import type {
  AddonDeclaration,
  Integration,
  IntegrationInstance,
  IntegrationTestConnectionResult,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/** The slice of a listed addon the integrations provider reads. */
interface ListedAddon {
  readonly manifest: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly integrationRole?: AddonDeclaration['integrationRole']
    readonly capabilities: readonly { readonly name: string }[]
  }
}

/**
 * An addon that registers `integration-instances` keeps its connection as typed
 * records and is configured from its function page: the Integrations page neither
 * lists it nor offers it. Its settings / delete / test still go to ITS provider,
 * never to `integration-settings`.
 */

const ADDON_ID = 'loki-logging'

function row(id: string): Integration {
  return {
    id,
    addonId: ADDON_ID,
    name: 'Loki',
    enabled: true,
    info: {},
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Integration
}

function harness(
  opts: {
    instanceMode?: 'single' | 'multiple'
    withProvider?: boolean
    role?: 'devices' | 'services'
    discovery?: { mode: 'none' | 'lan' | 'account'; scopedToInstance: boolean }
  } = {},
) {
  const withProvider = opts.withProvider ?? true
  const stored = new Map<string, Integration>()
  const registry = {
    listIntegrations: vi.fn(async () => [...stored.values()]),
    getIntegration: vi.fn(async (id: string) => stored.get(id) ?? null),
    createIntegration: vi.fn(async () => {
      const created = row('int_0001')
      stored.set(created.id, created)
      return created
    }),
    deleteIntegration: vi.fn(async (id: string) => {
      stored.delete(id)
    }),
  }
  const instances = {
    describe: vi.fn(async () => ({
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      ...(opts.discovery !== undefined ? { discovery: opts.discovery } : {}),
      instanceMode: opts.instanceMode ?? 'single',
      kind: 'destination',
      canTest: true,
    })),
    createInstance: vi.fn(async (input: { id: string }) => ({ id: input.id })),
    updateInstance: vi.fn(async () => ({ ok: true as const })),
    deleteInstance: vi.fn(async () => ({ ok: true as const })),
    getInstance: vi.fn(
      async (input: { id: string }): Promise<IntegrationInstance | null> => ({
        id: input.id,
        name: 'Loki',
        configured: true,
        formValues: {
          url: 'http://loki:3100',
          password: { $secret: 'ref', v: 1, set: true },
        },
      }),
    ),
    listInstances: vi.fn(async () => []),
    instanceFormSchema: vi.fn(async () => ({ sections: [] })),
    testInstance: vi.fn(
      async (): Promise<IntegrationTestConnectionResult> => ({
        success: true,
        status: 'validated',
      }),
    ),
  }
  const restartAddon = vi.fn(async () => ({ success: true }))
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const addonReg = {
    getIntegrationRegistry: vi.fn(() => registry),
    restartAddon,
    runnerIdFor: vi.fn(() => 'runner'),
    listAddons: vi.fn((): readonly ListedAddon[] => [
      {
        manifest: {
          id: ADDON_ID,
          name: 'Loki',
          description: 'Ship logs to Loki',
          capabilities: [{ name: 'log-destination' }, { name: 'integration-instances' }],
        },
      },
    ]),
    getCapabilityRegistry: vi.fn(() => ({
      getSingleton: vi.fn(() => null),
      getProviderByAddon: vi.fn((cap: string, addonId: string) =>
        withProvider && cap === 'integration-instances' && addonId === ADDON_ID ? instances : null,
      ),
    })),
  }
  const provider = buildIntegrationsProvider(
    addonReg as never,
    { emit: vi.fn() } as never,
    { createLogger: vi.fn(() => log) } as never,
    null,
  )
  return { provider, registry, instances, restartAddon, log, addonReg }
}

describe('integrations over an integration-instances provider', () => {
  it('does not offer the addon as an integration type: its page is the function page', async () => {
    const h = harness({ instanceMode: 'single' })
    expect(await h.provider.getAvailableTypes()).toEqual([])
  })

  it("does not list the addon's registry rows, and keeps them (no delete)", async () => {
    const h = harness()
    await h.provider.create({ addonId: ADDON_ID, name: 'Loki' })
    expect(await h.provider.list()).toEqual([])
    expect(h.registry.deleteIntegration).not.toHaveBeenCalled()
    expect(await h.registry.listIntegrations()).toHaveLength(1)
    // the row stays reachable by its id and by the addon id (the Loki migration uses it)
    expect(await h.provider.get({ id: 'int_0001' })).toMatchObject({
      addonId: ADDON_ID,
    })
  })

  it('an entry declaring integrationRole devices is listed on Integrations while its instances stay on the function page', async () => {
    const h = harness({ instanceMode: 'single' })
    h.addonReg.listAddons.mockReturnValue([
      {
        manifest: {
          id: ADDON_ID,
          name: 'Dual',
          description: 'Services and devices',
          integrationRole: 'devices',
          capabilities: [{ name: 'device-provider' }, { name: 'integration-instances' }],
        },
      },
    ])
    await h.provider.create({ addonId: ADDON_ID, name: 'Dual' })
    expect(await h.provider.list()).toHaveLength(1)
    const [type] = await h.provider.getAvailableTypes()
    expect(type).toMatchObject({ addonId: ADDON_ID })
    // the service instances are still answered by the integration-instances cap
    expect(h.instances.describe).toBeDefined()
  })

  it('an undeclared dual entry is derived as services and stays off Integrations', async () => {
    const h = harness()
    h.addonReg.listAddons.mockReturnValue([
      {
        manifest: {
          id: ADDON_ID,
          name: 'Dual',
          description: 'x',
          capabilities: [{ name: 'device-provider' }, { name: 'integration-instances' }],
        },
      },
    ])
    await h.provider.create({ addonId: ADDON_ID, name: 'Dual' })
    expect(await h.provider.list()).toEqual([])
    expect(await h.provider.getAvailableTypes()).toEqual([])
  })

  it('a device-bringing addon is still listed', async () => {
    const h = harness({ withProvider: false })
    h.addonReg.listAddons.mockReturnValue([
      {
        manifest: {
          id: 'reolink',
          name: 'Reolink',
          description: 'Reolink cameras',
          capabilities: [{ name: 'device-provider' }],
        },
      },
    ])
    const [type] = await h.provider.getAvailableTypes()
    expect(type).toMatchObject({ addonId: 'reolink', kind: 'device-provider' })
  })

  it('create inserts the registry row, then the record with the typed settings, no restart', async () => {
    const h = harness()
    const created = await h.provider.create({
      addonId: ADDON_ID,
      name: 'Loki',
      settings: { url: 'http://x' },
    })
    expect(created.id).toBe('int_0001')
    expect(h.instances.createInstance).toHaveBeenCalledWith({
      id: 'int_0001',
      name: 'Loki',
    })
    expect(h.instances.updateInstance).toHaveBeenCalledWith({
      id: 'int_0001',
      values: { url: 'http://x' },
    })
    expect(h.restartAddon).not.toHaveBeenCalled()
  })

  it('a refused record deletes the registry row (no orphan)', async () => {
    const h = harness()
    h.instances.updateInstance.mockRejectedValueOnce(new Error('refused'))
    await expect(
      h.provider.create({
        addonId: ADDON_ID,
        name: 'Loki',
        settings: { url: 'bad' },
      }),
    ).rejects.toThrow('refused')
    expect(h.registry.deleteIntegration).toHaveBeenCalledWith('int_0001')
    expect(await h.registry.listIntegrations()).toHaveLength(0)
  })

  it('a failing rollback does not hide why the record was refused', async () => {
    const h = harness()
    h.instances.updateInstance.mockRejectedValueOnce(new Error('refused'))
    h.registry.deleteIntegration.mockRejectedValueOnce(new Error('registry down'))
    await expect(
      h.provider.create({
        addonId: ADDON_ID,
        name: 'Loki',
        settings: { url: 'bad' },
      }),
    ).rejects.toThrow('refused')
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be removed'),
      expect.anything(),
    )
  })

  it('a rejected test blocks the create before any row exists', async () => {
    const h = harness()
    h.instances.testInstance.mockResolvedValueOnce({
      success: false,
      status: 'rejected',
      error: 'bad credentials',
    })
    await expect(
      h.provider.create({
        addonId: ADDON_ID,
        name: 'Loki',
        settings: { url: 'bad' },
      }),
    ).rejects.toThrow('bad credentials')
    expect(h.registry.createIntegration).not.toHaveBeenCalled()
  })

  it('delete removes the record, then the registry row', async () => {
    const h = harness()
    await h.provider.create({ addonId: ADDON_ID, name: 'Loki' })
    await h.provider.delete({ id: 'int_0001' })
    expect(h.instances.deleteInstance).toHaveBeenCalledWith({ id: 'int_0001' })
    expect(h.registry.deleteIntegration).toHaveBeenCalledWith('int_0001')
  })

  it('without an instances provider, settings on create are dropped and the addon is not restarted', async () => {
    const h = harness({ withProvider: false })
    await h.provider.create({
      addonId: ADDON_ID,
      name: 'Loki',
      settings: { url: 'http://x' },
    })
    expect(h.instances.updateInstance).not.toHaveBeenCalled()
    expect(h.restartAddon).not.toHaveBeenCalled()
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('settings dropped'),
      expect.anything(),
    )
  })
})

describe('the provider describes what its instances are (planning#416)', () => {
  /** A device-bringing addon on records: the manifest says nothing, `describe()` decides. */
  function deviceAddon(
    h: ReturnType<typeof harness>,
    extra: { integrationRole?: 'services' } = {},
  ) {
    h.addonReg.listAddons.mockReturnValue([
      {
        manifest: {
          id: ADDON_ID,
          name: 'Gizmo',
          description: 'Gizmo devices',
          ...extra,
          capabilities: [{ name: 'device-provider' }, { name: 'integration-instances' }],
        },
      },
    ])
  }

  it('describe().role devices lists the addon and offers it, though the manifest declares no role', async () => {
    const h = harness({ role: 'devices', instanceMode: 'multiple' })
    deviceAddon(h)
    await h.provider.create({ addonId: ADDON_ID, name: 'Gizmo' })
    expect(await h.provider.list()).toHaveLength(1)
    const [type] = await h.provider.getAvailableTypes()
    expect(type).toMatchObject({ addonId: ADDON_ID, instanceMode: 'multiple' })
  })

  it('describe().role services hides it, and the manifest integrationRole still overrides describe()', async () => {
    const hidden = harness({ role: 'services' })
    deviceAddon(hidden)
    expect(await hidden.provider.getAvailableTypes()).toEqual([])
    const overridden = harness({ role: 'services' })
    overridden.addonReg.listAddons.mockReturnValue([
      {
        manifest: {
          id: ADDON_ID,
          name: 'Gizmo',
          description: 'x',
          integrationRole: 'devices',
          capabilities: [{ name: 'device-provider' }, { name: 'integration-instances' }],
        },
      },
    ])
    expect(await overridden.provider.getAvailableTypes()).toHaveLength(1)
  })

  it('a provider that cannot answer describe() falls back to the manifest instead of failing the page', async () => {
    const h = harness({ role: 'devices' })
    deviceAddon(h)
    h.instances.describe.mockRejectedValue(new Error('addon restarting'))
    await h.provider.create({ addonId: ADDON_ID, name: 'Gizmo' }).catch(() => undefined)
    expect(await h.provider.list()).toEqual([])
  })

  it('the wizard word for discovery and the test button come from describe()', async () => {
    const lan = harness({
      role: 'devices',
      instanceMode: 'multiple',
      discovery: { mode: 'lan', scopedToInstance: false },
    })
    deviceAddon(lan)
    expect((await lan.provider.getAvailableTypes())[0]).toMatchObject({
      discoveryMode: 'auto',
      canTest: true,
      mode: 'standalone',
    })
    const account = harness({
      role: 'devices',
      instanceMode: 'multiple',
      discovery: { mode: 'account', scopedToInstance: true },
    })
    deviceAddon(account)
    expect((await account.provider.getAvailableTypes())[0]).toMatchObject({
      discoveryMode: 'manual',
      mode: 'account',
    })
  })
})
