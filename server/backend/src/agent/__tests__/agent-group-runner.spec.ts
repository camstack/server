import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import {
  isGroupRunnerAddon,
  ensureGroupRunner,
  registerGroupRunnerProviders,
  readPackageManifestAddons,
  type GroupCandidate,
  type GroupRunnerDeps,
  type ProviderDeps,
} from '../agent-group-runner.js'
import type { LoadedAddonEntry } from '../agent-service.js'

/**
 * Faithful CapabilityRegistry double: throws on a duplicate `(cap, addonId)`
 * pair exactly like the real registry's deliberate guard, and supports the
 * `hasProvider`/`unregisterProvider` used by the idempotent reload path.
 */
function throwingRegistry() {
  const providers = new Map<string, Set<string>>()
  const registered: Array<{ cap: string; addonId: string }> = []
  return {
    registered,
    registerProvider(cap: string, addonId: string) {
      const set = providers.get(cap) ?? new Set<string>()
      if (set.has(addonId)) {
        throw new Error(
          `CapabilityRegistry: provider already registered for capability "${cap}" by addon "${addonId}".`,
        )
      }
      set.add(addonId)
      providers.set(cap, set)
      registered.push({ cap, addonId })
    },
    hasProvider(cap: string, addonId: string) {
      return providers.get(cap)?.has(addonId) ?? false
    },
    unregisterProvider(cap: string, addonId: string) {
      providers.get(cap)?.delete(addonId)
    },
  }
}

const noopLogger: IScopedLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return noopLogger
  },
  withTags() {
    return noopLogger
  },
}

function candidate(over: Partial<GroupCandidate> = {}): GroupCandidate {
  return {
    groupId: 'g1',
    addonId: 'a1',
    addonDir: '/data/addons/a1',
    version: '1.0.0',
    packageName: '@camstack/a1',
    packageVersion: '1.0.0',
    capabilities: ['cap-x'],
    ...over,
  }
}

function writePkg(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-manifest-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(content))
  return dir
}

describe('readPackageManifestAddons', () => {
  it('reads camstack.addons declarations without importing the entry module', () => {
    const dir = writePkg({
      name: '@camstack/addon-pipeline',
      version: '1.0.4',
      camstack: {
        addons: [
          {
            id: 'pipeline-runner',
            execution: { placement: 'any-node' },
            capabilities: [{ name: 'pipeline-runner' }],
          },
          {
            id: 'recorder',
            execution: { placement: 'any-node' },
            capabilities: [{ name: 'recorder' }],
          },
        ],
      },
    })
    const m = readPackageManifestAddons(dir)
    expect(m).not.toBeNull()
    expect(m?.packageName).toBe('@camstack/addon-pipeline')
    expect(m?.packageVersion).toBe('1.0.4')
    expect(m?.declarations.map((d) => d.id)).toEqual(['pipeline-runner', 'recorder'])
    // The parsed declarations feed the placement helpers directly.
    expect(m?.declarations.every((d) => isGroupRunnerAddon(d))).toBe(true)
  })

  it('skips malformed entries (no string id) and returns null on missing/empty manifest', () => {
    const dir = writePkg({
      name: '@camstack/x',
      version: '2.0.0',
      camstack: { addons: [{ id: 'ok' }, { noId: true }, 42, null] },
    })
    expect(readPackageManifestAddons(dir)?.declarations.map((d) => d.id)).toEqual(['ok'])

    expect(readPackageManifestAddons('/nonexistent/dir/xyz')).toBeNull()
    expect(
      readPackageManifestAddons(writePkg({ name: '@camstack/empty', version: '1.0.0' })),
    ).toBeNull()
  })
})

describe('isGroupRunnerAddon', () => {
  it('is true for an addon with execution + non-hub placement', () => {
    expect(isGroupRunnerAddon({ execution: { placement: 'any-node' } })).toBe(true)
    expect(isGroupRunnerAddon({ execution: { placement: 'agent-only' } })).toBe(true)
  })

  it('is false without an execution block (defaults to hub-only)', () => {
    expect(isGroupRunnerAddon({})).toBe(false)
  })

  it('is false for an explicit hub-only placement', () => {
    expect(isGroupRunnerAddon({ execution: { placement: 'hub-only' } })).toBe(false)
  })
})

describe('ensureGroupRunner', () => {
  it('spawns a fresh runner when none is running (restart → not found)', async () => {
    const calls: Array<{ action: string; params: unknown }> = []
    const broker = {
      call: async (action: string, params?: unknown) => {
        calls.push({ action, params })
        if (action === '$process.restart') return { success: false, reason: 'not found' }
        return { ok: true }
      },
    }
    const registered: Array<{ cap: string; addonId: string }> = []
    const capabilityRegistry = {
      registerProvider: (cap: string, addonId: string) => {
        registered.push({ cap, addonId })
      },
      hasProvider: () => false,
      unregisterProvider: () => {},
    }
    const loadedAddons = new Map<string, LoadedAddonEntry>()

    await ensureGroupRunner(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: broker.call return is narrowed, BrokerCall is generic
      {
        broker: broker as unknown as GroupRunnerDeps['broker'],
        capabilityRegistry,
        loadedAddons,
        logger: noopLogger,
      },
      'g1',
      [candidate()],
    )

    expect(calls.map((c) => c.action)).toEqual(['$process.restart', '$process.spawnRunner'])
    const spawn = calls.find((c) => c.action === '$process.spawnRunner')
    expect(spawn?.params).toEqual({
      runnerId: 'g1',
      addons: [{ addonId: 'a1', addonDir: '/data/addons/a1' }],
    })
    expect(registered).toEqual([{ cap: 'cap-x', addonId: 'a1' }])
    expect(loadedAddons.get('a1')?.status).toBe('running')
    expect(loadedAddons.get('a1')?.packageVersion).toBe('1.0.0')
  })

  it('restarts (does not spawn) when the runner is already running', async () => {
    const calls: string[] = []
    const broker = {
      call: async (action: string) => {
        calls.push(action)
        if (action === '$process.restart') return { success: true, pid: 1234 }
        return { ok: true }
      },
    }
    const registered: string[] = []
    const capabilityRegistry = {
      registerProvider: (cap: string) => {
        registered.push(cap)
      },
      hasProvider: () => false,
      unregisterProvider: () => {},
    }
    const loadedAddons = new Map<string, LoadedAddonEntry>()

    await ensureGroupRunner(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: broker.call return is narrowed, BrokerCall is generic
      {
        broker: broker as unknown as GroupRunnerDeps['broker'],
        capabilityRegistry,
        loadedAddons,
        logger: noopLogger,
      },
      'g1',
      [candidate()],
    )

    expect(calls).toEqual(['$process.restart'])
    expect(calls).not.toContain('$process.spawnRunner')
    expect(registered).toEqual(['cap-x'])
    expect(loadedAddons.get('a1')?.status).toBe('running')
  })

  it('marks the addons errored when both restart and spawn fail', async () => {
    const broker = {
      call: vi.fn(async (action: string) => {
        if (action === '$process.restart') return { success: false, reason: 'not found' }
        throw new Error('spawn boom')
      }),
    }
    const capabilityRegistry = {
      registerProvider: vi.fn(),
      hasProvider: vi.fn(() => false),
      unregisterProvider: vi.fn(),
    }
    const loadedAddons = new Map<string, LoadedAddonEntry>()

    await ensureGroupRunner(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: broker.call return is narrowed, BrokerCall is generic
      {
        broker: broker as unknown as GroupRunnerDeps['broker'],
        capabilityRegistry,
        loadedAddons,
        logger: noopLogger,
      },
      'g1',
      [candidate()],
    )

    expect(loadedAddons.get('a1')?.status).toBe('error')
    expect(capabilityRegistry.registerProvider).not.toHaveBeenCalled()
  })
})

describe('registerGroupRunnerProviders — in-place reload idempotency', () => {
  const broker = { call: async () => ({ ok: true }) }

  function deps(registry: ReturnType<typeof throwingRegistry>): ProviderDeps {
    return {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: BrokerCall is generic
      broker: broker as unknown as ProviderDeps['broker'],
      capabilityRegistry: registry,
      loadedAddons: new Map<string, LoadedAddonEntry>(),
    }
  }

  it('re-registers the same (cap, addonId) on a second call without throwing (reload path)', () => {
    const registry = throwingRegistry()
    const addons = [candidate({ capabilities: ['decoder'] })]

    // Boot registration — registry empty, installs the proxy.
    registerGroupRunnerProviders(deps(registry), addons)
    expect(registry.hasProvider('decoder', 'a1')).toBe(true)

    // Reload registration (post `$process.restart`) — the prior proxy is still
    // registered. WITHOUT the idempotency fix this throws
    // "provider already registered"; with it, the stale proxy is dropped first.
    expect(() => registerGroupRunnerProviders(deps(registry), addons)).not.toThrow()
    expect(registry.hasProvider('decoder', 'a1')).toBe(true)
    // Exactly two successful registrations across the two calls — the second
    // replaced the first, no duplicate left dangling.
    expect(registry.registered).toEqual([
      { cap: 'decoder', addonId: 'a1' },
      { cap: 'decoder', addonId: 'a1' },
    ])
  })

  it('a fresh addon (never registered) registers cleanly — no spurious unregister', () => {
    const registry = throwingRegistry()
    const unreg = vi.spyOn(registry, 'unregisterProvider')

    registerGroupRunnerProviders(deps(registry), [candidate({ capabilities: ['cap-x'] })])

    expect(registry.hasProvider('cap-x', 'a1')).toBe(true)
    expect(unreg).not.toHaveBeenCalled()
  })
})
