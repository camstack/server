/**
 * Isolated builtins split into two spawn waves. Snapshot is a consumer of
 * `settings-store`. sqlite-settings is the engine behind it. One wave would
 * put them on the same side of in-process boot, which is wrong for both.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  isolatedBuiltinPhase,
  partitionIsolatedBuiltinIds,
  runHubAddonBoot,
  waitUntilReady,
} from '../isolated-builtin-phase.js'

const pkgPath = path.join(fileURLToPath(new URL('../../../package.json', import.meta.url)))

interface ManifestAddon {
  readonly id: string
  readonly execution?: { readonly isolate?: boolean }
  readonly capabilities?: readonly { readonly name: string }[]
}

function systemAddons(): readonly ManifestAddon[] {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    readonly camstack: { readonly addons: readonly ManifestAddon[] }
  }
  return pkg.camstack.addons
}

describe('isolatedBuiltinPhase', () => {
  it('puts a data-store-provider builtin in the infra wave', () => {
    expect(isolatedBuiltinPhase([{ name: 'data-store-provider' }, { name: 'vector-store' }])).toBe(
      'infra',
    )
  })

  it('puts snapshot in the consumer wave', () => {
    expect(isolatedBuiltinPhase([{ name: 'snapshot' }])).toBe('consumer')
  })

  it('partitions sqlite-settings ahead of snapshot', () => {
    const { infra, consumers } = partitionIsolatedBuiltinIds(
      ['snapshot', 'sqlite-settings'],
      (id) =>
        id === 'sqlite-settings'
          ? [{ name: 'data-store-provider' }, { name: 'vector-store' }]
          : [{ name: 'snapshot' }],
    )
    expect(infra).toEqual(['sqlite-settings'])
    expect(consumers).toEqual(['snapshot'])
  })
})

describe('sqlite-settings manifest isolate', () => {
  it('forks the engine the same way snapshot does', () => {
    const sqlite = systemAddons().find((a) => a.id === 'sqlite-settings')
    expect(sqlite?.execution?.isolate).toBe(true)
  })

  it('leaves storage-orchestrator in-process — it owns the door, not the engine', () => {
    const door = systemAddons().find((a) => a.id === 'storage-orchestrator')
    expect(door?.execution?.isolate).not.toBe(true)
  })
})

describe('runHubAddonBoot', () => {
  it('spawns forked addons only after the isolated engine is in the collection and the in-process door has booted', async () => {
    const order: string[] = []
    let doorUp = false
    let forksSawDoor = false
    await runHubAddonBoot({
      spawnIsolatedInfra: async () => {
        order.push('sqlite')
      },
      waitForDataStoreProvider: async () => {
        order.push('wait-engine')
      },
      bootInProcessInfra: async () => {
        doorUp = true
        order.push('door')
      },
      spawnForkedAddons: async () => {
        forksSawDoor = doorUp
        order.push('forks')
      },
      bootInProcessConsumers: async () => {
        order.push('in-process-consumers')
      },
      spawnIsolatedConsumers: async () => {
        order.push('snapshot')
      },
    })
    expect(order).toEqual([
      'sqlite',
      'wait-engine',
      'door',
      'forks',
      'in-process-consumers',
      'snapshot',
    ])
    expect(forksSawDoor).toBe(true)
  })
})

describe('waitUntilReady', () => {
  it('returns immediately when the predicate is already true', async () => {
    const started = Date.now()
    await waitUntilReady(() => true, { timeoutMs: 1_000, intervalMs: 50, what: 'already' })
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('resolves once the predicate flips', async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 40)
    await waitUntilReady(() => ready, { timeoutMs: 1_000, intervalMs: 10, what: 'flip' })
    expect(ready).toBe(true)
  })

  it('throws when the engine never appears', async () => {
    await expect(
      waitUntilReady(() => false, {
        timeoutMs: 30,
        intervalMs: 10,
        what: 'isolated data-store-provider engine',
      }),
    ).rejects.toThrow(/Timed out waiting for isolated data-store-provider engine/)
  })
})
