import type { Integration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * An integration's `enabled` is a projection of its instance body (epic #440, step 3): the addon's
 * `integration-instances` provider answers it, the registry's stored flag is only the answer for a
 * row the addon cannot speak for (no provider, no instance, an addon that fails), and
 * `integrations.update` no longer writes it for anything but a fixed builtin.
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
    { emit: vi.fn() } as never,
    { createLogger: vi.fn(() => log) } as never,
    null,
  )
  return { provider, registry, log }
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

  it('keeps the stored flag for a row the addon cannot speak for, and logs an addon that fails', async () => {
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

    expect(listed.map((i) => [i.id, i.enabled])).toEqual([
      ['int_1', false],
      ['int_2', false],
      ['int_3', false],
      ['int_4', true],
    ])
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('not projected'),
      expect.objectContaining({ tags: { addonId: 'provider-fails' } }),
    )
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

  it('still switches a fixed builtin, which keeps no instance record', async () => {
    const h = harness([row('int_9', 'core-blocks', true, true)], () => null)
    await h.provider.update({ id: 'int_9', enabled: false })
    expect(h.registry.updateIntegration).toHaveBeenCalledWith('int_9', { enabled: false })
  })
})
