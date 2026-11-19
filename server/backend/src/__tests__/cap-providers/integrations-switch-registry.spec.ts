import { type Integration, SERVICE_INSTANCE_INFO_KEY } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * The hub registry row is the ONLY stored switch (D1066). `integrations.list / get / getByAddonId /
 * listByAddon` are pure registry reads: they never call an addon (the projection that did made every
 * integration read depend on every addon, and closed a hub <-> addon call cycle). `update({ enabled })`
 * is the one door: it writes the row, then tells the addon; the row holds when the addon is down.
 */

function row(
  id: string,
  addonId: string,
  enabled: boolean,
  info: Readonly<Record<string, unknown>> = {},
): Integration {
  return {
    id,
    addonId,
    name: id,
    enabled,
    info,
    createdAt: 1,
    updatedAt: 1,
  }
}

function harness(initial: readonly Integration[], instancesOf: (addonId: string) => unknown) {
  // The registry holds what was written to it: an adopted row is there for the next read.
  const rows: Integration[] = [...initial]
  const registry = {
    listIntegrations: vi.fn(async () => rows),
    getIntegration: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    getIntegrationByAddonId: vi.fn(
      async (addonId: string) => rows.find((r) => r.addonId === addonId) ?? null,
    ),
    updateIntegration: vi.fn(async (id: string, patch: { enabled?: boolean }) => {
      const at = rows.findIndex((r) => r.id === id)
      const current = rows[at]
      if (current === undefined) return null
      const next = {
        ...current,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      }
      rows[at] = next
      return next
    }),
    createIntegration: vi.fn(
      async (input: {
        id?: string
        addonId: string
        name: string
        enabled?: boolean
        info?: Record<string, unknown>
      }) => {
        const created = row(
          input.id ?? 'int_new',
          input.addonId,
          input.enabled !== false,
          input.info,
        )
        rows.push(created)
        return created
      },
    ),
  }
  const emit = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const addonReg = {
    getIntegrationRegistry: vi.fn(() => registry),
    instanceLifecycleDeps: vi.fn(() => ({
      logger: log,
      integrations: () => registry,
      eventBus: { emit },
    })),
    listAddons: vi.fn(() => []),
    restartAddon: vi.fn(async () => undefined),
    getCapabilityRegistry: vi.fn(() => ({
      getProviderByAddon: vi.fn((_cap: string, addonId: string) => instancesOf(addonId)),
      getProviderByAddonId: vi.fn(() => null),
      getSingleton: vi.fn(() => null),
    })),
  }
  const provider = buildIntegrationsProvider(
    addonReg as never,
    { createLogger: vi.fn(() => log) } as never,
  )
  return { provider, registry, log, emit }
}

/** An addon provider every call of which is recorded: a registry read must leave all of them at zero. */
function strictAddon() {
  return {
    describe: vi.fn(async () => {
      throw new Error('a registry read must not describe the addon')
    }),
    createInstance: vi.fn(),
    getInstance: vi.fn(async () => {
      throw new Error('a registry read must not read the addon')
    }),
    listInstances: vi.fn(async () => {
      throw new Error('a registry read must not list the addon')
    }),
    setInstanceEnabled: vi.fn(async () => ({ ok: true as const })),
  }
}

function calls(addon: ReturnType<typeof strictAddon>): number {
  return (
    addon.describe.mock.calls.length +
    addon.getInstance.mock.calls.length +
    addon.listInstances.mock.calls.length
  )
}

describe('integrations reads are registry reads: the row is the switch, no addon is called', () => {
  it('serves the registry flag and calls the addon zero times', async () => {
    const addon = strictAddon()
    const h = harness(
      [row('int_1', 'provider-x', false), row('int_2', 'provider-x', true)],
      () => addon,
    )

    const listed = await h.provider.list()
    expect(listed.map((i) => [i.id, i.enabled])).toEqual([
      ['int_1', false],
      ['int_2', true],
    ])
    expect((await h.provider.get({ id: 'int_1' })).enabled).toBe(false)
    expect((await h.provider.getByAddonId({ addonId: 'provider-x' }))?.enabled).toBe(false)
    expect(calls(addon)).toBe(0)
  })

  it('answers while the addon is down and carries no unknown marker', async () => {
    const h = harness([row('int_1', 'provider-gone', false)], () => null)
    const got = await h.provider.get({ id: 'int_1' })
    expect(got.enabled).toBe(false)
    expect('switchUnknown' in got).toBe(false)
  })

  it('hides the rows of a services instance from the list but lists them for the addon that owns them', async () => {
    const h = harness(
      [
        row('int_1', 'provider-x', true),
        row('relay-a', 'provider-x', false, { [SERVICE_INSTANCE_INFO_KEY]: true }),
        row('relay-b', 'other', true, { [SERVICE_INSTANCE_INFO_KEY]: true }),
      ],
      () => null,
    )
    expect((await h.provider.list()).map((i) => i.id)).toEqual(['int_1'])
    expect(
      (await h.provider.listByAddon({ addonId: 'provider-x' })).map((i) => [i.id, i.enabled]),
    ).toEqual([
      ['int_1', true],
      ['relay-a', false],
    ])
  })
})

describe('integrations.update({ enabled }) is the one door', () => {
  it('writes the registry row first, then tells the addon, and emits', async () => {
    const addon = strictAddon()
    const h = harness([row('int_1', 'provider-x', true)], () => addon)
    await h.provider.update({ id: 'int_1', enabled: false })
    expect(h.registry.updateIntegration).toHaveBeenCalledWith('int_1', { enabled: false })
    expect(addon.setInstanceEnabled).toHaveBeenCalledWith({ id: 'int_1', enabled: false })
    expect(h.emit.mock.calls[0]?.[0]).toMatchObject({ category: 'integration.disabled' })
  })

  it('holds when the addon is down: the row is written, nothing throws', async () => {
    const h = harness([row('int_9', 'core-blocks', false, { fixed: true })], () => null)
    await h.provider.update({ id: 'int_9', enabled: true })
    expect(h.registry.updateIntegration).toHaveBeenCalledWith('int_9', { enabled: true })
  })

  it('holds when the addon refuses the notice: logged, the row stays switched', async () => {
    const addon = strictAddon()
    addon.setInstanceEnabled.mockRejectedValueOnce(new Error('addon down'))
    const h = harness([row('int_1', 'provider-x', true)], () => addon)
    await h.provider.update({ id: 'int_1', enabled: false })
    expect(h.registry.updateIntegration).toHaveBeenCalledWith('int_1', { enabled: false })
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('addon was not told'),
      expect.anything(),
    )
  })
})

describe('adoptInstanceRows: the hub keeps the one copy of every instance switch (D1066)', () => {
  it('creates the missing row of a services instance with the body state, false included', async () => {
    const { provider, registry } = harness([], () => null)
    const result = await provider.adoptInstanceRows({
      addonId: 'waste-collections',
      rows: [{ id: 'home', name: 'Home', enabled: false, stated: true }],
    })
    expect(result).toEqual({ created: 1, updated: 0, conflicts: [] })
    expect(registry.createIntegration).toHaveBeenCalledWith({
      id: 'home',
      addonId: 'waste-collections',
      name: 'Home',
      enabled: false,
      info: { [SERVICE_INSTANCE_INFO_KEY]: true },
    })
  })

  it('a stated body wins over a disagreeing registry row; an unstated one never overwrites it', async () => {
    const { provider, registry } = harness([row('int_0001', 'matter', true)], () => null)
    expect(
      await provider.adoptInstanceRows({
        addonId: 'matter',
        rows: [{ id: 'int_0001', name: 'A', enabled: false, stated: false }],
      }),
    ).toEqual({ created: 0, updated: 0, conflicts: [] })
    expect(registry.updateIntegration).not.toHaveBeenCalled()
    expect(
      await provider.adoptInstanceRows({
        addonId: 'matter',
        rows: [{ id: 'int_0001', name: 'A', enabled: false, stated: true }],
      }),
    ).toEqual({ created: 0, updated: 1, conflicts: [] })
    expect(registry.updateIntegration).toHaveBeenCalledWith('int_0001', { enabled: false })
  })

  it("a rerun with the same rows changes nothing, and another addon's row is skipped, not taken", async () => {
    const { provider, registry } = harness(
      [row('int_0001', 'matter', false), row('int_0002', 'other', true)],
      () => null,
    )
    expect(
      await provider.adoptInstanceRows({
        addonId: 'matter',
        rows: [
          { id: 'int_0001', name: 'A', enabled: false, stated: true },
          { id: 'int_0002', name: 'B', enabled: false, stated: true },
        ],
      }),
    ).toEqual({
      created: 0,
      updated: 0,
      conflicts: [{ id: 'int_0002', ownerAddonId: 'other' }],
    })
    expect(registry.updateIntegration).not.toHaveBeenCalled()
    expect(registry.createIntegration).not.toHaveBeenCalled()
  })
})

describe('adoptInstanceRows: who may adopt, and what the adopted row can do (D1066)', () => {
  it('refuses an addon naming another addon in the call: nothing is written', async () => {
    const { provider, registry } = harness([], () => null)
    await expect(
      provider.adoptInstanceRows({
        addonId: 'victim',
        callerAddonId: 'intruder',
        rows: [{ id: 'x', name: 'X', enabled: false, stated: true }],
      } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(registry.createIntegration).not.toHaveBeenCalled()
  })

  it('accepts the addon adopting its own rows, and the hub-side caller with no stamp', async () => {
    const { provider } = harness([], () => null)
    await expect(
      provider.adoptInstanceRows({
        addonId: 'waste-collections',
        callerAddonId: 'addon:waste-collections',
        rows: [{ id: 'a', name: 'A', enabled: true, stated: false }],
      } as never),
    ).resolves.toMatchObject({ created: 1 })
  })

  it('a record adopted after the fact is switchable through the one door', async () => {
    const addon = strictAddon()
    const h = harness([], () => addon)
    await h.provider.adoptInstanceRows({
      addonId: 'ai',
      rows: [{ id: 'seed-ollama-lan', name: 'Seed', enabled: false, stated: false }],
    })
    await h.provider.update({ id: 'seed-ollama-lan', enabled: true })
    expect(h.registry.updateIntegration).toHaveBeenCalledWith('seed-ollama-lan', { enabled: true })
    expect(addon.setInstanceEnabled).toHaveBeenCalledWith({ id: 'seed-ollama-lan', enabled: true })
  })

  it('writes an explicit id through the registry only (the registry refuses to overwrite)', async () => {
    const { provider, registry } = harness([], () => null)
    registry.createIntegration.mockRejectedValueOnce(new Error('rev conflict'))
    registry.getIntegration
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row('int_0007', 'other', true))
    expect(
      await provider.adoptInstanceRows({
        addonId: 'matter',
        rows: [{ id: 'int_0007', name: 'A', enabled: false, stated: true }],
      }),
    ).toEqual({
      created: 0,
      updated: 0,
      conflicts: [{ id: 'int_0007', ownerAddonId: 'other' }],
    })
  })
})

describe('getByAddonId answers for the addon, never for one of its service instances', () => {
  it('skips a services instance row and returns the devices-role row', async () => {
    const { provider } = harness(
      [
        row('home', 'waste-collections', true, { [SERVICE_INSTANCE_INFO_KEY]: true }),
        row('int_0005', 'waste-collections', true),
      ],
      () => null,
    )
    expect(await provider.getByAddonId({ addonId: 'waste-collections' })).toMatchObject({
      id: 'int_0005',
    })
  })

  it('is null when only services instance rows exist', async () => {
    const { provider } = harness(
      [row('home', 'waste-collections', true, { [SERVICE_INSTANCE_INFO_KEY]: true })],
      () => null,
    )
    expect(await provider.getByAddonId({ addonId: 'waste-collections' })).toBeNull()
  })
})
