import type { Integration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * An integration's `enabled` is a projection of its instance body (epic #440, step 3): the addon's
 * `integration-instances` provider answers it, the registry's stored flag is returned for a
 * row the addon cannot speak for (no provider, no instance, an addon that fails) but marked `switchUnknown`, and
 * `integrations.update` writes it for no row at all.
 */

function row(id: string, addonId: string, enabled: boolean, fixed = false): Integration {
  return {
    id,
    addonId,
    name: id,
    enabled,
    info: fixed ? { fixed: true } : {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function harness(rows: readonly Integration[], instancesOf: (addonId: string) => unknown) {
  const registry = {
    listIntegrations: vi.fn(async () => rows),
    getIntegration: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    getIntegrationByAddonId: vi.fn(
      async (addonId: string) => rows.find((r) => r.addonId === addonId) ?? null,
    ),
    updateIntegration: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
  }
  const emit = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const addonReg = {
    getIntegrationRegistry: vi.fn(() => registry),
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

function instancesProvider(entries: readonly { id: string; enabled?: boolean }[]) {
  return {
    createInstance: vi.fn(),
    getInstance: vi.fn(),
    listInstances: vi.fn(async () =>
      entries.map((e) => ({ name: e.id, configured: true, formValues: {}, ...e })),
    ),
  }
}

describe('integrations.list / get / getByAddonId project enabled from the instance body', () => {
  it('serves the body switch, not the registry flag', async () => {
    const h = harness([row('int_1', 'provider-x', true), row('int_2', 'provider-x', false)], () =>
      instancesProvider([
        { id: 'int_1', enabled: false },
        { id: 'int_2', enabled: true },
      ]),
    )

    const listed = await h.provider.list()
    expect(listed.map((i) => [i.id, i.enabled])).toEqual([
      ['int_1', false],
      ['int_2', true],
    ])
    expect((await h.provider.get({ id: 'int_1' })).enabled).toBe(false)
    expect((await h.provider.getByAddonId({ addonId: 'provider-x' }))?.enabled).toBe(false)
  })

  it('marks a row the addon cannot speak for as switchUnknown (the stored flag is stale, not the state), and logs an addon that fails', async () => {
    const failing = {
      createInstance: vi.fn(),
      getInstance: vi.fn(),
      listInstances: vi.fn(async () => {
        throw new Error('addon down')
      }),
    }
    const h = harness(
      [
        row('int_1', 'provider-x', false),
        row('int_2', 'provider-no-provider', false),
        row('int_3', 'provider-fails', false),
        row('int_4', 'provider-x', true),
      ],
      (addonId) =>
        addonId === 'provider-x'
          ? instancesProvider([{ id: 'int_4', enabled: true }])
          : addonId === 'provider-fails'
            ? failing
            : null,
    )

    const listed = await h.provider.list()

    expect(listed.map((i) => [i.id, i.switchUnknown])).toEqual([
      ['int_1', true],
      ['int_2', true],
      ['int_3', true],
      ['int_4', undefined],
    ])
    expect(listed.find((i) => i.id === 'int_4')?.enabled).toBe(true)
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('not projected'),
      expect.objectContaining({ tags: { addonId: 'provider-fails' } }),
    )
  })
})

describe('a fixed builtin keeps its switch in the registry, whatever its record says', () => {
  it('projects a disabled fixed builtin as disabled although a name-only record is seeded', async () => {
    // The seeded record carries a name and no flag: read as a body it would mean `enabled`.
    const h = harness(
      [row('int_9', 'core-blocks', false, true), row('int_1', 'provider-x', false)],
      (addonId) =>
        addonId === 'core-blocks'
          ? instancesProvider([{ id: 'int_9' }])
          : instancesProvider([{ id: 'int_1', enabled: true }]),
    )

    const listed = await h.provider.list()

    expect(listed.map((i) => [i.id, i.enabled])).toEqual([
      ['int_9', false],
      ['int_1', true],
    ])
    expect((await h.provider.get({ id: 'int_9' })).enabled).toBe(false)
    expect((await h.provider.getByAddonId({ addonId: 'core-blocks' }))?.enabled).toBe(false)
    expect(listed.map((i) => i.switchUnknown)).toEqual([undefined, undefined])
  })
})

describe('integrations.update and the switch', () => {
  it('refuses enabled for an integration that has an instance record', async () => {
    const h = harness([row('int_1', 'provider-x', true)], () => instancesProvider([]))
    await expect(h.provider.update({ id: 'int_1', enabled: false })).rejects.toThrow(
      /setInstanceEnabled/,
    )
    expect(h.registry.updateIntegration).not.toHaveBeenCalled()
  })

  it('refuses enabled for a fixed builtin too: its switch is setInstanceEnabled', async () => {
    const h = harness([row('int_9', 'core-blocks', true, true)], () => instancesProvider([]))
    await expect(h.provider.update({ id: 'int_9', enabled: false })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('setInstanceEnabled'),
    })
    expect(h.registry.updateIntegration).not.toHaveBeenCalled()
  })

  it('marks a fixed builtin switchUnknown while its addon provider is absent (the hub half cannot write)', async () => {
    const h = harness([row('int_9', 'core-blocks', true, true)], () => null)
    expect((await h.provider.get({ id: 'int_9' })).switchUnknown).toBe(true)
  })
})
