import { CORE_CAP_SERVICE_NAME } from '@camstack/system'
import { ServiceBroker } from 'moleculer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  __resetRemotePrivilegeObservationForTests,
  buildCoreCapService,
  CORE_CAP_REMOTE_FORBIDDEN_TYPE,
  describeMeshOrigin,
  isCoreServiceCapName,
  setRemotePrivilegeLogSink,
} from '../api/trpc/core-cap-bridge.js'
import {
  ADDON_BACKED_SERVER_CAP_NAMES,
  HUB_SERVICE_CAP_NAMES,
} from '../api/trpc/server-provided-caps.js'
import { HttpRequestCensus } from '../api/trpc/http-request-census.js'
import { protectedProcedure, publicProcedure, trpcRouter } from '../api/trpc/trpc.middleware.js'
import type { AppRouter } from '../api/trpc/trpc.router.js'

/**
 * Synthetic router covering every branch of `buildCoreCapService`:
 *  - a core namespace with a query + a mutation
 *  - a camelCase core namespace (kebab-case action name)
 *  - a core namespace with a subscription (must be skipped)
 *  - a non-core namespace (must be excluded)
 *  - the deliberately-excluded `auth` namespace
 *  - a `protectedProcedure` (must pass under the trusted mesh ctx)
 */
function makeRouter() {
  return trpcRouter({
    system: trpcRouter({
      info: publicProcedure.query(() => ({ version: '9.9.9' })),
      getSiteLocation: publicProcedure.query(() => ({ lat: 45.0, lng: 9.0 })),
      setRetentionConfig: protectedProcedure
        .input(z.object({ days: z.number() }))
        .mutation(({ input }) => ({ days: input.days })),
    }),
    addons: trpcRouter({
      list: publicProcedure.query(() => [{ id: 'test-addon' }]),
      listCapabilityProviders: protectedProcedure.query(({ ctx }) => ctx.user?.id ?? null),
    }),
    streamProbe: trpcRouter({
      probe: publicProcedure.query(() => ({ ok: true })),
    }),
    // Server-provided cap routers (`buildServerProviders`): no addon serves
    // them, so a forked runner can ONLY reach them through this bridge.
    serverManagement: trpcRouter({
      getServerPackageStatus: publicProcedure.query(() => ({ version: '1.2.3' })),
    }),
    networkQuality: trpcRouter({
      getReport: publicProcedure.query(() => ({ ok: true })),
    }),
    toast: trpcRouter({
      onToast: publicProcedure.subscription(async function* () {
        yield 1
      }),
    }),
    deviceManager: trpcRouter({
      listAll: publicProcedure.query(() => []),
    }),
    auth: trpcRouter({
      login: publicProcedure.query(() => 'token'),
    }),
    // D802: `repl.execute` runs code in the hub — never on the mesh.
    repl: trpcRouter({
      execute: protectedProcedure.mutation(() => 'executed'),
    }),
    // D802: bridged for the hub's own runners, refused to another node.
    logs: trpcRouter({
      query: protectedProcedure.query(() => ['hub log line']),
    }),
    // Who the bridge says is calling.
    capabilities: trpcRouter({
      whoami: protectedProcedure.query(({ ctx }) => ctx.user?.id ?? null),
    }),
  })
}

function asAppRouter(router: ReturnType<typeof makeRouter>): AppRouter {
  // The synthetic router is structurally a tRPC router; the cast lets
  // the test exercise `buildCoreCapService` without booting every
  // backend service the real appRouter depends on.
  return router as unknown as AppRouter
}

describe('buildCoreCapService', () => {
  let broker: ServiceBroker

  afterEach(async () => {
    if (broker) await broker.stop()
  })

  it('exposes core query + mutation procedures as kebab-cased actions', () => {
    const schema = buildCoreCapService(asAppRouter(makeRouter()))
    expect(schema.name).toBe(CORE_CAP_SERVICE_NAME)
    expect(schema.actions?.['system.info']).toBeDefined()
    expect(schema.actions?.['system.setRetentionConfig']).toBeDefined()
    expect(schema.actions?.['stream-probe.probe']).toBeDefined()
  })

  it('bridges EVERY hub-service cap the server provides, not a hand-copied subset', () => {
    // The inference-timeout guard's first fingerprint failed on all three
    // nodes with "no provider registered for cap server-management": the
    // server provides it, no addon does, and the bridge list had been copied
    // by hand before the cap existed. The list of server-provided caps is
    // now the single source, and the bridge derives from it.
    const schema = buildCoreCapService(asAppRouter(makeRouter()))
    expect(schema.actions?.['server-management.getServerPackageStatus']).toBeDefined()
    expect(schema.actions?.['network-quality.getReport']).toBeDefined()
    for (const capName of HUB_SERVICE_CAP_NAMES) {
      expect(isCoreServiceCapName(capName), capName).toBe(true)
    }
    // `webrtc-session` is a server FACTORY over an addon singleton: a forked
    // caller resolves it through the registry like any addon cap, and a miss
    // there means the broker addon is down — not a route for the bridge.
    for (const capName of ADDON_BACKED_SERVER_CAP_NAMES) {
      expect(isCoreServiceCapName(capName), capName).toBe(false)
    }
  })

  it('excludes non-core namespaces, the auth router, and subscriptions', () => {
    const schema = buildCoreCapService(asAppRouter(makeRouter()))
    expect(schema.actions?.['device-manager.listAll']).toBeUndefined()
    expect(schema.actions?.['auth.login']).toBeUndefined()
    expect(schema.actions?.['toast.onToast']).toBeUndefined()
  })

  it('routes a bridged query through the trusted mesh caller', async () => {
    broker = new ServiceBroker({ nodeID: 'test', transporter: 'Fake', logger: false })
    broker.createService(buildCoreCapService(asAppRouter(makeRouter())))
    await broker.start()

    const result = await broker.call(`${CORE_CAP_SERVICE_NAME}.system.info`)
    expect(result).toEqual({ version: '9.9.9' })
  })

  it('passes protectedProcedure under the synthetic admin mesh identity', async () => {
    broker = new ServiceBroker({ nodeID: 'test', transporter: 'Fake', logger: false })
    broker.createService(buildCoreCapService(asAppRouter(makeRouter())))
    await broker.start()

    const result = await broker.call(`${CORE_CAP_SERVICE_NAME}.system.setRetentionConfig`, {
      days: 30,
    })
    expect(result).toEqual({ days: 30 })
  })
})

/**
 * D802 — the bridge is not a blanket admin door for the LAN.
 *
 * Neutralisations:
 *  - put `'repl'` back in `CORE_NAMESPACES` → "repl is never bridged" fails;
 *  - drop the `remoteOrigin` check → the `logs` call from `agent-a`
 *    succeeds and "refuses a denied namespace" fails;
 *  - build one shared caller again → `whoami` answers `mesh` for the agent.
 */
describe('$core-caps — per-node principal (D802)', () => {
  const started: ServiceBroker[] = []
  afterEach(async () => {
    for (const b of started.splice(0)) await b.stop()
  })

  async function hubAndAgent(): Promise<{ hub: ServiceBroker; agent: ServiceBroker }> {
    const ns = `core-cap-${Math.random().toString(36).slice(2)}`
    const hub = new ServiceBroker({
      nodeID: 'hub',
      namespace: ns,
      transporter: 'Fake',
      logger: false,
    })
    const agent = new ServiceBroker({
      nodeID: 'agent-a',
      namespace: ns,
      transporter: 'Fake',
      logger: false,
    })
    started.push(hub, agent)
    hub.createService(
      buildCoreCapService(asAppRouter(makeRouter()), new HttpRequestCensus(), { ownNodeId: 'hub' }),
    )
    await hub.start()
    await agent.start()
    await agent.waitForServices([CORE_CAP_SERVICE_NAME])
    return { hub, agent }
  }

  it('repl is never bridged', () => {
    const schema = buildCoreCapService(asAppRouter(makeRouter()), new HttpRequestCensus())
    expect(Object.keys(schema.actions ?? {}).some((a) => a.startsWith('repl.'))).toBe(false)
    expect(isCoreServiceCapName('repl')).toBe(false)
  })

  it('a call from another node runs as node:<id>; the hub own calls as mesh', async () => {
    const { hub, agent } = await hubAndAgent()
    expect(await agent.call(`${CORE_CAP_SERVICE_NAME}.addons.listCapabilityProviders`)).toBe(
      'node:agent-a',
    )
    expect(await hub.call(`${CORE_CAP_SERVICE_NAME}.capabilities.whoami`)).toBe('mesh')
  }, 30_000)

  it('refuses a denied namespace to another node, serves it to the hub itself', async () => {
    const { hub, agent } = await hubAndAgent()
    await expect(agent.call(`${CORE_CAP_SERVICE_NAME}.logs.query`)).rejects.toMatchObject({
      type: CORE_CAP_REMOTE_FORBIDDEN_TYPE,
    })
    expect(await hub.call(`${CORE_CAP_SERVICE_NAME}.logs.query`)).toEqual(['hub log line'])
  }, 30_000)
})

/**
 * Remote privilege grant — {@link REMOTE_PRIVILEGE_ALLOWLIST} enforced for `node:<id>`.
 */
describe('$core-caps — remote privilege grant', () => {
  const started: ServiceBroker[] = []
  const warn = vi.fn<(message: string) => void>()

  beforeEach(() => {
    warn.mockClear()
    __resetRemotePrivilegeObservationForTests()
    setRemotePrivilegeLogSink({ warn })
  })

  afterEach(async () => {
    for (const b of started.splice(0)) await b.stop()
    __resetRemotePrivilegeObservationForTests()
  })

  async function hubAndAgent(): Promise<{ hub: ServiceBroker; agent: ServiceBroker }> {
    const ns = `priv-${Math.random().toString(36).slice(2)}`
    const hub = new ServiceBroker({
      nodeID: 'hub',
      namespace: ns,
      transporter: 'Fake',
      logger: false,
    })
    const agent = new ServiceBroker({
      nodeID: 'agent-a',
      namespace: ns,
      transporter: 'Fake',
      logger: false,
    })
    started.push(hub, agent)
    hub.createService(
      buildCoreCapService(asAppRouter(makeRouter()), new HttpRequestCensus(), { ownNodeId: 'hub' }),
    )
    await hub.start()
    await agent.start()
    await agent.waitForServices([CORE_CAP_SERVICE_NAME])
    return { hub, agent }
  }

  it('allows a remote call on the grant allowlist', async () => {
    const { agent } = await hubAndAgent()
    expect(await agent.call(`${CORE_CAP_SERVICE_NAME}.addons.list`)).toEqual([{ id: 'test-addon' }])
    expect(warn).not.toHaveBeenCalled()
  }, 30_000)

  it('refuses a remote call not on the grant, with one refused warn per (node, path)', async () => {
    const { agent } = await hubAndAgent()
    await expect(agent.call(`${CORE_CAP_SERVICE_NAME}.system.info`)).rejects.toMatchObject({
      type: CORE_CAP_REMOTE_FORBIDDEN_TYPE,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe(
      'mesh privilege: node:agent-a called system.info (refused; not on grant)',
    )

    await expect(agent.call(`${CORE_CAP_SERVICE_NAME}.system.info`)).rejects.toMatchObject({
      type: CORE_CAP_REMOTE_FORBIDDEN_TYPE,
    })
    expect(warn).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('still serves a non-grant path to the hub itself', async () => {
    const { hub } = await hubAndAgent()
    expect(await hub.call(`${CORE_CAP_SERVICE_NAME}.system.info`)).toEqual({ version: '9.9.9' })
    expect(warn).not.toHaveBeenCalled()
  }, 30_000)
})

/**
 * The MESH plane of the transport census.
 *
 * Neutralisations:
 *  - *"a bridged call lands on the mesh plane"* — drop the `countMeshCall` call
 *    in the wrapped invoker and the plane reads 0 while the call still
 *    succeeds, which is exactly the invisible state this plane was in before
 *    2026-08-27.
 *  - *"disarmed, a bridged call counts nothing"* — move the `census.armed`
 *    guard below the `observe()` and the disarmed census starts accumulating.
 *  - *"the mesh plane cannot double-count a store read"* — add
 *    `deviceManager` to `CORE_NAMESPACES` and the assertion fails, which is
 *    what would let one addon `listAll` be counted here AND by the fleet
 *    census as `addon:<id>`.
 */
describe('the mesh plane', () => {
  let broker: ServiceBroker

  afterEach(async () => {
    if (broker) await broker.stop()
  })

  async function callBridged(census: HttpRequestCensus): Promise<void> {
    broker = new ServiceBroker({ nodeID: 'hub-test', transporter: 'Fake', logger: false })
    broker.createService(buildCoreCapService(asAppRouter(makeRouter()), census))
    await broker.start()
    await broker.call(`${CORE_CAP_SERVICE_NAME}.system.info`)
  }

  it('counts a bridged call on the mesh plane, named by the calling node', async () => {
    const census = new HttpRequestCensus()
    census.arm(60_000)
    await callBridged(census)

    const snap = census.snapshot()
    expect(snap.planes).toEqual({ http: 0, ws: 0, mesh: 1, unknown: 0 })
    expect(snap.procedureCalls).toBe(1)
    expect(snap.planesExplainTotal).toBe(true)
    const group = snap.groups[0]
    expect(group?.plane).toBe('mesh')
    expect(group?.procedure).toBe('system.info')
    expect(group?.principal.startsWith('mesh:')).toBe(true)
    // No socket behind an in-process call: both render as the named unknown.
    expect(group?.ip).toBe('unknown')
    expect(group?.userAgent).toBe('unknown')
  })

  it('counts nothing while the census is disarmed', async () => {
    const census = new HttpRequestCensus()
    await callBridged(census)
    expect(census.snapshot().procedureCalls).toBe(0)
  })

  it('cannot double-count a cap-channel read: `deviceManager` is not bridged', () => {
    // The fleet census attributes an addon `deviceManager.listAll` as
    // `addon:<id>`; that call reaches the device-manager provider directly and
    // never enters the hub router. If it were ALSO a `$core-caps` action, the
    // same call would appear on this plane too and the two instruments could
    // no longer be read side by side.
    const schema = buildCoreCapService(asAppRouter(makeRouter()), new HttpRequestCensus())
    const bridged = Object.keys(schema.actions ?? {})
    expect(bridged.some((name) => name.startsWith('device-manager.'))).toBe(false)
  })

  it('renders an origin Moleculer could not name without going blank', () => {
    expect(describeMeshOrigin({ nodeId: 'hub', caller: 'export-alexa.boot' })).toBe(
      'mesh:hub via export-alexa.boot',
    )
    expect(describeMeshOrigin({ nodeId: 'hub', caller: null })).toBe('mesh:hub')
    expect(describeMeshOrigin({ nodeId: null, caller: null })).toBe('mesh:unknown')
  })
})
