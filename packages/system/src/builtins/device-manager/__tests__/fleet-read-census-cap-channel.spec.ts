/**
 * Load-bearing proof: a fleet read that arrives over the CAP CHANNEL is
 * attributed to the addon that made it, not to an unattributed/generic stack
 * frame.
 *
 * ## The gap this closes
 *
 * The 2026-08-26 boot census measured 5 001 calls landing on
 * `DeviceRowStore.list < DeviceRowStore.listFleet < listAll` with nothing
 * nameable above it. That is not a stack-depth problem: every frame between a
 * forked addon's UDS socket write and this store's `list()` is the SAME
 * generic dispatcher code (`onUnownedCall`, `CapRouteResolver.dispatch`,
 * `InProcessProviderRef.invoke`) no matter which addon called — the identity
 * lives in DATA (`LocalChildRegistry`'s registered `childId`), never in a
 * function name, so no amount of stack capture would ever recover it.
 *
 * This test drives the REAL `CapRouteResolver` — the same class that routes
 * every forked addon's `ctx.api.deviceManager.listFleet.query()` once
 * `LocalChildRegistry.onUnownedCall` resolves it to a hub-in-process route —
 * against a REAL `DeviceRowStore` wired the same way
 * `device-manager.addon.ts` wires its provider (a method that extracts
 * `callerAddonId` off its input and forwards it to the store). It proves the
 * call is attributed to `addon:pipeline-analytics`, never to the empty/local
 * site a stack walk alone would have produced for this same generic dispatch
 * path.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import type {
  CapRouteResolverDeps,
  HubLocalChildDispatcher,
  InProcessProviderLookup,
  NodeCapAuthority,
} from '../../../kernel/transport/cap-route-resolver.js'
import { CapRouteResolver } from '../../../kernel/transport/cap-route-resolver.js'
import type { InProcessProviderRef } from '../../../kernel/transport/cap-route.js'
import type { ServiceDiscoveryBroker } from '../../../kernel/moleculer/resilient-cap-call.js'
import { DeviceRowStore, deviceRowBackendOf } from '../device-row-store.js'
import { FleetReadCensus } from '../fleet-read-census.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

const HUB_NODE_ID = 'hub'

function makeFakeBroker(): ServiceDiscoveryBroker {
  return {
    call: vi.fn(async () => ({ from: 'broker' })),
    waitForServices: vi.fn(async () => {}),
  }
}

function makeFakeHubLocalRegistry(): HubLocalChildDispatcher {
  return {
    resolveChildId: () => null,
    callCapOnChild: vi.fn(async () => ({})),
  }
}

function makeFakeNodeAuthority(): NodeCapAuthority {
  return {
    nodeKnowsCap: () => false,
    nodeIsAgent: () => false,
    nodeOnline: (nodeId: string) => nodeId === HUB_NODE_ID,
    listNodeIds: () => [HUB_NODE_ID],
    getAddonId: () => null,
    getAgentChildId: () => null,
    isNativeCap: () => false,
  }
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

/**
 * The exact shape `device-manager.addon.ts` registers: a method that reads
 * `callerAddonId` off its input (the field `CapRouteResolver`'s hub-in-process
 * dispatch merges in) and forwards it to the store as an explicit argument —
 * never guessed, never inferred from a stack.
 */
function deviceManagerProviderRef(store: DeviceRowStore): InProcessProviderRef {
  return {
    invoke: async (method: string, args: unknown) => {
      if (method !== 'listFleet') throw new Error(`unexpected method ${method}`)
      const input = (args ?? {}) as { callerAddonId?: string }
      return store.listFleet({}, input.callerAddonId)
    },
  }
}

async function makeArmedStore(): Promise<{ store: DeviceRowStore; census: FleetReadCensus }> {
  const api = await makeSettingsStoreApi()
  const backend = deviceRowBackendOf(api.api)
  const census = new FleetReadCensus('60000', Date.now())
  const store = new DeviceRowStore(backend, makeLogger(), census)
  await store.upsert(
    {
      id: 1,
      addonId: 'addon-a',
      stableId: 's-1',
      type: 'camera',
      name: 'dev-1',
      location: null,
      disabled: false,
      parentDeviceId: null,
    },
    { registered: true },
  )
  return { store, census }
}

function buildResolver(ref: InProcessProviderRef): CapRouteResolver {
  const deps: CapRouteResolverDeps = {
    hubNodeId: HUB_NODE_ID,
    broker: makeFakeBroker(),
    hubLocalRegistry: makeFakeHubLocalRegistry(),
    nodeAuthority: makeFakeNodeAuthority(),
    inProcessProviders: ((capName: string) =>
      capName === 'device-manager' ? ref : null) as InProcessProviderLookup,
  }
  return new CapRouteResolver(deps)
}

describe('a cap-channel call is attributed to its addon, not to an empty stack', () => {
  it('CapRouteResolver.dispatch(hub-in-process, callerAddonId) → FleetReadCensus records addon:<id>', async () => {
    const { store, census } = await makeArmedStore()
    const resolver = buildResolver(deviceManagerProviderRef(store))
    const route = resolver.resolveCapRoute('device-manager', { nodeId: HUB_NODE_ID })
    expect(route.kind).toBe('hub-in-process')

    // Simulates exactly what `onUnownedCall` does for a forked addon's
    // `ctx.api.deviceManager.listFleet.query()`: dispatch with the
    // `callerAddonId` `LocalChildRegistry` captured off the registered
    // `childId` — see `local-child-registry.spec.ts` / the "routes an
    // unowned cap-call-out" test for that half of the chain.
    await resolver.dispatch(route, 'listFleet', {}, undefined, 'pipeline-analytics')

    const rows = census.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.site).toBe('addon:pipeline-analytics')
  })

  it('RED without the caller hint: the SAME call carries no attribution beyond the local stack', async () => {
    // Proves the negative the fix closes: a cap-channel call that did NOT
    // carry a `callerAddonId` (today's behaviour for every such call) is
    // still recorded, but its site is the store's OWN internal call chain —
    // never the addon that actually made the request. This is the exact
    // "listAll and nothing above it" shape the 2026-08-26 boot census
    // measured.
    const { store, census } = await makeArmedStore()
    const resolver = buildResolver(deviceManagerProviderRef(store))
    const route = resolver.resolveCapRoute('device-manager', { nodeId: HUB_NODE_ID })

    await resolver.dispatch(route, 'listFleet', {}) // no callerAddonId

    const rows = census.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.site).not.toMatch(/^addon:/)
  })
})
