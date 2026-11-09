import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Integration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * The fixed Blocks and Notification Center integrations stay on the Integrations page while their
 * addon's `integration-instances` provider cannot answer `describe()` (boot, a forked respawn).
 * With no `integrationRole` in the manifest the role falls back to "keeps instances means
 * services" and the rows would be filtered out; the REAL manifest entries say `devices`.
 */

const ROOT = resolve(__dirname, '../../../../..')

interface ManifestEntry {
  readonly id: string
  readonly integrationRole?: 'devices' | 'services'
  readonly capabilities: ReadonlyArray<{ readonly name: string }>
}

function manifestEntry(pkg: string, id: string): ManifestEntry {
  const parsed: { camstack: { addons: ManifestEntry[] } } = JSON.parse(
    readFileSync(resolve(ROOT, pkg, 'package.json'), 'utf8'),
  )
  const entry = parsed.camstack.addons.find((a) => a.id === id)
  if (entry === undefined) throw new Error(`no manifest entry ${id} in ${pkg}`)
  return entry
}

function fixedRow(id: string, addonId: string): Integration {
  return { id, addonId, name: id, enabled: true, info: { fixed: true }, createdAt: 1, updatedAt: 1 }
}

async function listedWith(entries: readonly ManifestEntry[], rows: readonly Integration[]) {
  const registry = { listIntegrations: vi.fn(async () => rows) }
  const failing = {
    describe: vi.fn(async () => {
      throw new Error('provider is not up yet')
    }),
    listInstances: vi.fn(async () => {
      throw new Error('provider is not up yet')
    }),
  }
  const addonReg = {
    getIntegrationRegistry: vi.fn(() => registry),
    listAddons: vi.fn(() => entries.map((e) => ({ manifest: { ...e, name: e.id } }))),
    getCapabilityRegistry: vi.fn(() => ({
      getProviderByAddon: vi.fn(() => failing),
      getProviderByAddonId: vi.fn(() => null),
      getSingleton: vi.fn(() => null),
    })),
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const provider = buildIntegrationsProvider(
    addonReg as never,
    { createLogger: vi.fn(() => log) } as never,
  )
  return (await provider.list()).map((i) => i.id)
}

describe('integrations.list keeps the fixed builtins that keep an instance record', () => {
  const blocks = manifestEntry('packages/system', 'core-blocks')
  const alarm = manifestEntry('packages/addon-post-analysis', 'pipeline-analytics')
  const rows = [fixedRow('int_0024', 'core-blocks'), fixedRow('int_0018', 'pipeline-analytics')]

  it('declares both entries as keeping instances, with the devices role', () => {
    for (const entry of [blocks, alarm]) {
      expect(entry.capabilities.map((c) => c.name)).toContain('integration-instances')
      expect(entry.integrationRole).toBe('devices')
    }
  })

  it('lists both rows although the provider cannot describe itself', async () => {
    expect(await listedWith([blocks, alarm], rows)).toEqual(['int_0024', 'int_0018'])
  })

  it('would filter them out without the manifest role (the failure this pins)', async () => {
    const without = [blocks, alarm].map(({ integrationRole: _role, ...rest }) => rest)
    expect(await listedWith(without, rows)).toEqual([])
  })
})
