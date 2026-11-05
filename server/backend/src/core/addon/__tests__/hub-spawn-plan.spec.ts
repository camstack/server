/**
 * The hub plans runners only for addons the stale gate passes (planning#447):
 * after a server swap an addon below `requires.addons` must not be spawned.
 */
import type { AddonDeclaration, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { AddonRegistryService } from '../addon-registry.service.js'

function declaration(id: string): AddonDeclaration {
  return { id, name: id } as AddonDeclaration
}

function build(): {
  readonly registry: AddonRegistryService
  readonly warn: ReturnType<typeof vi.fn>
} {
  const warn = vi.fn()
  const sink: IScopedLogger = {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: () => sink,
    withTags: () => sink,
  }
  const registry = new AddonRegistryService(
    { createLogger: () => sink } as never,
    { emit: () => undefined, subscribe: () => () => undefined } as never,
    { get: () => undefined } as never,
    {} as never,
    { setRegistry: () => undefined } as never,
    {
      broker: { nodeID: 'hub' },
      childRegistry: {},
      setRunnerIdResolver: () => undefined,
    } as never,
    {} as never,
  )
  const entries = Reflect.get(registry, 'addonEntries') as Map<string, Record<string, unknown>>
  for (const [id, pkg, version] of [
    ['old', '@camstack/addon-old', '1.0.0'],
    ['fresh', '@camstack/addon-fresh', '3.0.0'],
  ] as const) {
    entries.set(id, {
      addon: { manifest: { id, name: id } },
      initialized: true,
      source: 'installed',
      packageName: pkg,
      packageVersion: version,
      declaredCapabilities: [],
      addonDir: `/data/addons/${pkg}`,
      declaration: declaration(id),
    })
  }
  Reflect.set(registry, 'staleGateContext', () => ({
    serverVersion: '1.2.721',
    serverRequiresAddons: { '@camstack/addon-old': '>=2.0.0' },
    installedVersions: {
      '@camstack/addon-old': '1.0.0',
      '@camstack/addon-fresh': '3.0.0',
    },
    requiresOfDir: () => undefined,
  }))
  return { registry, warn }
}

describe('AddonRegistryService.buildSpawnPlan', () => {
  it('leaves an addon below the server minimum out of the plan and logs it', () => {
    const { registry, warn } = build()
    const plan = registry.buildSpawnPlan(['old', 'fresh'])
    expect([...plan.keys()]).toEqual(['fresh'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('1.0.0')
  })
})
