import type { Integration, IntegrationTestConnectionResult } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * An addon that registers `integration-instances` is a `connection` integration
 * type: the Integrations page lists it, and its create / settings / delete /
 * test go to ITS provider (typed records), never to `integration-settings`.
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

function harness(opts: { instanceMode?: 'single' | 'multiple'; withProvider?: boolean } = {}) {
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
    getIntegrationSettings: vi.fn(async () => ({})),
    setIntegrationSettings: vi.fn(async () => undefined),
    setIntegrationSetting: vi.fn(async () => undefined),
  }
  const instances = {
    describe: vi.fn(async () => ({
      instanceMode: opts.instanceMode ?? 'single',
      kind: 'destination',
      canTest: true,
    })),
    createInstance: vi.fn(async (input: { id: string }) => ({ id: input.id })),
    updateInstance: vi.fn(async () => ({ ok: true as const })),
    deleteInstance: vi.fn(async () => ({ ok: true as const })),
    getInstance: vi.fn(async (input: { id: string }) => ({
      id: input.id,
      name: 'Loki',
      configured: true,
      formValues: { url: 'http://loki:3100', password: { $secret: 'ref', v: 1, set: true } },
    })),
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
    listAddons: vi.fn(() => [
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
  return { provider, registry, instances, restartAddon }
}

describe('integrations over an integration-instances provider', () => {
  it('lists the addon as a connection type; single is standalone and unique', async () => {
    const h = harness({ instanceMode: 'single' })
    const types = await h.provider.getAvailableTypes()
    expect(types).toHaveLength(1)
    expect(types[0]).toMatchObject({
      addonId: ADDON_ID,
      kind: 'connection',
      mode: 'standalone',
      instanceMode: 'unique',
      canTest: true,
      canAdd: true,
    })
  })

  it('multiple instances are an account', async () => {
    const h = harness({ instanceMode: 'multiple' })
    const [type] = await h.provider.getAvailableTypes()
    expect(type).toMatchObject({ kind: 'connection', mode: 'account', canAdd: true })
  })

  it('setSettings writes the instance record and never integration-settings', async () => {
    const h = harness()
    await h.provider.create({ addonId: ADDON_ID, name: 'Loki' })
    h.registry.setIntegrationSettings.mockClear()
    h.registry.setIntegrationSetting.mockClear()
    await h.provider.setSettings({ id: 'int_0001', settings: { url: 'http://x' } })
    expect(h.instances.updateInstance).toHaveBeenLastCalledWith({
      id: 'int_0001',
      values: { url: 'http://x' },
    })
    expect(h.registry.setIntegrationSettings).not.toHaveBeenCalled()
    expect(h.registry.setIntegrationSetting).not.toHaveBeenCalled()
    expect(h.restartAddon).not.toHaveBeenCalled()
  })

  it('getSettings reads the instance form values, secrets as views', async () => {
    const h = harness()
    await h.provider.create({ addonId: ADDON_ID, name: 'Loki' })
    const settings = await h.provider.getSettings({ id: 'int_0001' })
    expect(settings).toMatchObject({ url: 'http://loki:3100', password: { set: true } })
    expect(h.registry.getIntegrationSettings).not.toHaveBeenCalled()
  })

  it('create inserts the registry row, then the record with the typed settings, no restart', async () => {
    const h = harness()
    const created = await h.provider.create({
      addonId: ADDON_ID,
      name: 'Loki',
      settings: { url: 'http://x' },
    })
    expect(created.id).toBe('int_0001')
    expect(h.instances.createInstance).toHaveBeenCalledWith({ id: 'int_0001', name: 'Loki' })
    expect(h.instances.updateInstance).toHaveBeenCalledWith({
      id: 'int_0001',
      values: { url: 'http://x' },
    })
    expect(h.registry.setIntegrationSettings).not.toHaveBeenCalled()
    expect(h.restartAddon).not.toHaveBeenCalled()
  })

  it('a refused record deletes the registry row (no orphan)', async () => {
    const h = harness()
    h.instances.updateInstance.mockRejectedValueOnce(new Error('refused'))
    await expect(
      h.provider.create({ addonId: ADDON_ID, name: 'Loki', settings: { url: 'bad' } }),
    ).rejects.toThrow('refused')
    expect(h.registry.deleteIntegration).toHaveBeenCalledWith('int_0001')
    expect(await h.registry.listIntegrations()).toHaveLength(0)
  })

  it('a rejected test blocks the create before any row exists', async () => {
    const h = harness()
    h.instances.testInstance.mockResolvedValueOnce({
      success: false,
      status: 'rejected',
      error: 'bad credentials',
    })
    await expect(
      h.provider.create({ addonId: ADDON_ID, name: 'Loki', settings: { url: 'bad' } }),
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

  it('testConnection goes to testInstance', async () => {
    const h = harness()
    const result = await h.provider.testConnection({
      addonId: ADDON_ID,
      settings: { url: 'http://x' },
    })
    expect(h.instances.testInstance).toHaveBeenCalledWith({
      id: null,
      values: { url: 'http://x' },
    })
    expect(result).toMatchObject({ success: true, status: 'validated' })
  })

  it('without a provider the legacy integration-settings path is unchanged', async () => {
    const h = harness({ withProvider: false })
    await h.provider.create({ addonId: ADDON_ID, name: 'Loki' })
    await h.provider.setSettings({ id: 'int_0001', settings: { url: 'http://x' } })
    expect(h.registry.setIntegrationSettings).toHaveBeenCalled()
    expect(h.instances.updateInstance).not.toHaveBeenCalled()
  })
})
