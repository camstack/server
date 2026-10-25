/**
 * The cap-usage graph must SEE a forked addon's outbound `ctx.api` traffic.
 *
 * `nodes.getCapUsageGraph` returned `[]` in 0.21 s against a live hub running
 * 64 addons and 1019 devices — an in-memory read of an empty map. The reason is
 * structural, and this file pins it: the only writer was
 * `addon-context-factory.ts`'s `localProviderLink` observer, which
 *
 *   a) lives in the FORKED RUNNER's process, so it writes to that process's
 *      `getCapUsageRegistry()` module singleton — an object hub-main, which
 *      holds the reader, never sees; and
 *   b) fires only when the call resolves to a CO-LOCATED provider. Every
 *      `return next(op)` is silent, and `ipcParentLink` — the link that carries
 *      every cross-process cap call, including every `ctx.settings.*` — takes no
 *      observer at all.
 *
 * So the tests below drive REAL calls down the real link chain
 * (`ctx.api` → localProviderLink miss → ipcParentLink → UDS → the parent's
 * `LocalChildRegistry`) and assert on the registry the hub's
 * `getCapUsageGraph` provider actually reads. Nothing here asserts on a spy
 * that was handed the answer.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeclaration } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUdsAddonContext } from '../../moleculer/addon-context-factory.js'
import {
  __resetCapUsageRegistryForTests,
  getCapUsageRegistry,
} from '../../moleculer/cap-usage-registry.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'

const PARENT_NODE = 'hub'
const CALLER_ID = 'addon-post-analysis'
const PROVIDER_ID = 'addon-pipeline'
const PROVIDED_CAP = 'stream-catalog'

interface Harness {
  readonly registry: LocalChildRegistry
  readonly callerClient: LocalChildClient
  readonly providerClient: LocalChildClient
  readonly unowned: CapCallInput[]
  readonly tmpDir: string
}

describe('the cap-usage graph observes a forked addon’s outbound ctx.api calls', () => {
  let h: Harness

  beforeEach(async () => {
    __resetCapUsageRegistryForTests()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-usage-obs-'))
    const unowned: CapCallInput[] = []
    const usage = getCapUsageRegistry()

    const registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(PARENT_NODE),
      ownNodeId: PARENT_NODE,
      // The wiring the hub does in `moleculer.service.ts`: the parent process
      // owns the reader, so the parent process is where recording belongs.
      capUsageObserver: (obs) => usage.recordCall(obs),
      onUnownedCall: async (input) => {
        unowned.push(input)
        return { routedByParent: true }
      },
    })
    registry.onReadinessSnapshotRequest(() => [])
    await registry.start()

    // A sibling runner that OWNS `stream-catalog`. A call to it is short-
    // circuited by `resolveChildId` and never reaches `onUnownedCall` — which
    // is why recording cannot live there.
    const providerClient = new LocalChildClient({
      nodeId: PARENT_NODE,
      childId: PROVIDER_ID,
      caps: [{ capName: PROVIDED_CAP, mode: 'singleton' }],
      dispatch: async () => ({ entries: [] }),
    })
    await providerClient.start()

    const callerClient = new LocalChildClient({
      nodeId: PARENT_NODE,
      childId: CALLER_ID,
      caps: [],
      dispatch: async () => {
        throw new Error('caller has no inbound caps')
      },
    })
    await callerClient.start()

    h = { registry, callerClient, providerClient, unowned, tmpDir }
  })

  afterEach(async () => {
    await h.callerClient.close()
    await h.providerClient.close()
    await h.registry.close()
    fs.rmSync(h.tmpDir, { recursive: true, force: true })
    __resetCapUsageRegistryForTests()
  })

  async function callerCtx() {
    const declaration: AddonDeclaration = { id: CALLER_ID, entry: './index.js' }
    return await createUdsAddonContext(
      h.callerClient,
      `${PARENT_NODE}/${CALLER_ID}`,
      declaration,
      h.tmpDir,
    )
  }

  it('attributes a sibling-routed call to the right caller, provider and cap', async () => {
    const ctx = await callerCtx()
    const api = ctx.api as unknown as {
      streamCatalog: { getCatalog: { query: (i: unknown) => Promise<unknown> } }
    }

    await api.streamCatalog.getCatalog.query({ deviceId: 102 })

    // Sanity: this really did take the sibling short-circuit, not the parent
    // fallback. If this ever flips, the test below is measuring another path.
    expect(h.unowned).toHaveLength(0)

    const graph = getCapUsageRegistry().getGraph({ windowSeconds: 60, nowMs: Date.now() })
    expect(graph).toEqual([
      {
        callerAddonId: CALLER_ID,
        providerAddonId: PROVIDER_ID,
        capName: PROVIDED_CAP,
        callsPerMin: 1,
        lastCallAtMs: expect.any(Number),
      },
    ])
  })

  it('sees ctx.settings traffic — the parent-routed call the graph most needs', async () => {
    const ctx = await callerCtx()

    // `ctx.settings.*` IS `ctx.api.settingsStore.*`. No sibling owns
    // `settings-store` (it is hub-in-process), so this is the OTHER branch of
    // the cap-call-out handler: the parent-routed one.
    // The harness answers `{}` to a query - an unreadable store, which THROWS; the
    // call itself is what the graph observes.
    await ctx.settings?.readAddonStore().catch(() => ({}))

    expect(h.unowned).toHaveLength(1)
    expect(h.unowned[0]?.capName).toBe('settings-store')

    const graph = getCapUsageRegistry().getGraph({ windowSeconds: 60, nowMs: Date.now() })
    expect(graph).toHaveLength(1)
    expect(graph[0]).toMatchObject({
      callerAddonId: CALLER_ID,
      capName: 'settings-store',
    })
  })

  /**
   * The question that started this: would the graph have caught the fleet-wide
   * `deviceManager.getAllBindings` reads?
   *
   * It resolves like `settings-store` — `device-manager` is an in-process hub
   * builtin, so no sibling owns it and the parent routes it. The answer is
   * therefore YES for "which addon, which capability, how often", and NO for
   * "which METHOD": `CapUsageEdge` carries no `methodName`, so a caller pulling
   * the whole fleet 20×/min and one asking `getBindings` for a single camera
   * 20×/min produce the SAME edge. `methodName` is recorded on the way in
   * (`CapUsageCallRecord`) and collapsed by `getGraph`. This test pins exactly
   * how far the instrument reaches, so nobody has to re-derive it from an
   * empty-looking graph.
   */
  it('names the addon and the cap for a fleet-wide deviceManager read — but not the method', async () => {
    const ctx = await callerCtx()
    const api = ctx.api as unknown as {
      deviceManager: {
        getAllBindings: { query: (i: unknown) => Promise<unknown> }
        getBindings: { query: (i: unknown) => Promise<unknown> }
      }
    }

    await api.deviceManager.getAllBindings.query({})
    await api.deviceManager.getBindings.query({ deviceId: 102 })

    expect(h.unowned.map((c) => c.method)).toEqual(['getAllBindings', 'getBindings'])
    // Both calls carry the caller the parent stamped off the socket.
    expect(h.unowned.every((c) => c.callerAddonId === CALLER_ID)).toBe(true)

    const graph = getCapUsageRegistry().getGraph({ windowSeconds: 60, nowMs: Date.now() })
    // ONE edge, not two: the two methods collapse into the capability.
    expect(graph).toHaveLength(1)
    expect(graph[0]).toMatchObject({
      callerAddonId: CALLER_ID,
      capName: 'device-manager',
      callsPerMin: 2,
    })
  })

  it('counts each call once — a repeated call is not double-recorded', async () => {
    const ctx = await callerCtx()
    const api = ctx.api as unknown as {
      streamCatalog: { getCatalog: { query: (i: unknown) => Promise<unknown> } }
    }

    for (let i = 0; i < 5; i++) await api.streamCatalog.getCatalog.query({ deviceId: 102 })

    const graph = getCapUsageRegistry().getGraph({ windowSeconds: 60, nowMs: Date.now() })
    expect(graph).toHaveLength(1)
    expect(graph[0]?.callsPerMin).toBe(5)
  })

  it('never fails the call it observes, even when the sink throws', async () => {
    // Rebuild the parent with a hostile observer. The call must still answer.
    await h.callerClient.close()
    await h.providerClient.close()
    await h.registry.close()

    const registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(`${PARENT_NODE}-hostile`),
      ownNodeId: `${PARENT_NODE}-hostile`,
      capUsageObserver: () => {
        throw new Error('observer-broken')
      },
      onUnownedCall: async () => ({ routedByParent: true }),
    })
    registry.onReadinessSnapshotRequest(() => [])
    await registry.start()

    const providerClient = new LocalChildClient({
      nodeId: `${PARENT_NODE}-hostile`,
      childId: PROVIDER_ID,
      caps: [{ capName: PROVIDED_CAP, mode: 'singleton' }],
      dispatch: async () => ({ entries: ['ok'] }),
    })
    await providerClient.start()

    const callerClient = new LocalChildClient({
      nodeId: `${PARENT_NODE}-hostile`,
      childId: CALLER_ID,
      caps: [],
      dispatch: async () => {
        throw new Error('caller has no inbound caps')
      },
    })
    await callerClient.start()

    const declaration: AddonDeclaration = { id: CALLER_ID, entry: './index.js' }
    const ctx = await createUdsAddonContext(
      callerClient,
      `${PARENT_NODE}-hostile/${CALLER_ID}`,
      declaration,
      h.tmpDir,
    )
    const api = ctx.api as unknown as {
      streamCatalog: { getCatalog: { query: (i: unknown) => Promise<unknown> } }
    }

    await expect(api.streamCatalog.getCatalog.query({ deviceId: 1 })).resolves.toEqual({
      entries: ['ok'],
    })

    await callerClient.close()
    await providerClient.close()
    await registry.close()

    // Re-open the harness pieces afterEach expects to close.
    h = { ...h, registry, callerClient, providerClient }
  })
})
