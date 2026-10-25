/**
 * The scoped grant for `addons.updatePackage` (D842): a node may call it on its
 * OWN node, to the version the hub itself has installed, and every decision is
 * audited. Two real brokers share a fake transporter; the router is synthetic.
 */
import { CORE_CAP_SERVICE_NAME } from '@camstack/system'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CORE_CAP_REMOTE_FORBIDDEN_TYPE, buildCoreCapService } from '../api/trpc/core-cap-bridge.js'
import { HttpRequestCensus } from '../api/trpc/http-request-census.js'
import {
  type RemoteUpdateAuditEvent,
  authorizeRemoteUpdatePackage,
} from '../api/trpc/remote-addon-update-grant.js'
import { protectedProcedure, trpcRouter } from '../api/trpc/trpc.middleware.js'
import type { AppRouter } from '../api/trpc/trpc.router.js'

const HUB_VERSIONS: Readonly<Record<string, string>> = { '@camstack/addon-a': '1.2.0' }

function harness() {
  const updates: unknown[] = []
  const audit: RemoteUpdateAuditEvent[] = []
  const router = trpcRouter({
    addons: trpcRouter({
      updatePackage: protectedProcedure
        .input(z.object({ name: z.string(), version: z.string().optional(), nodeId: z.string() }))
        .mutation(({ input }) => {
          updates.push(input)
          return { success: true }
        }),
    }),
  }) as unknown as AppRouter
  const grant = {
    hubInstalledVersion: (name: string) => HUB_VERSIONS[name] ?? null,
    audit: async (event: RemoteUpdateAuditEvent) => {
      audit.push(event)
    },
  }
  return { updates, audit, router, grant }
}

describe('authorizeRemoteUpdatePackage', () => {
  const run = (caller: string, input: unknown) => {
    const h = harness()
    return authorizeRemoteUpdatePackage(caller, input, h.grant).then((d) => ({ d, h }))
  }
  const own = { name: '@camstack/addon-a', version: '1.2.0', nodeId: 'agent-1' }

  it('allows the caller own node at the hub version, and audits it', async () => {
    const { d, h } = await run('agent-1', own)
    expect(d).toEqual({ allowed: true, reason: null })
    expect(h.audit).toEqual([
      expect.objectContaining({ action: 'agent-addon-update', userId: 'node:agent-1' }),
    ])
  })

  it('refuses another node, naming both', async () => {
    const { d, h } = await run('agent-1', { ...own, nodeId: 'agent-2' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('own node only')
    expect(d.reason).toContain('agent-2')
    expect(h.audit[0]).toMatchObject({ action: 'agent-addon-update-refused' })
    expect(h.audit[0]?.detail).toMatchObject({ reason: 'other-node', target: 'agent-2' })
  })

  it("refuses a version that is not the hub's record", async () => {
    const { d, h } = await run('agent-1', { ...own, version: '9.9.9' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('1.2.0')
    expect(h.audit[0]?.detail).toMatchObject({ reason: 'version-differs', hubVersion: '1.2.0' })
  })

  it('refuses a package the hub does not install, and an incomplete request', async () => {
    expect((await run('agent-1', { ...own, name: '@camstack/other' })).d.reason).toContain(
      'does not install',
    )
    expect((await run('agent-1', { name: '@camstack/addon-a', nodeId: 'agent-1' })).d.allowed).toBe(
      false,
    )
  })
})

describe('$core-caps addons.updatePackage from a node', () => {
  const started: ServiceBroker[] = []
  afterEach(async () => {
    for (const b of started.splice(0)) await b.stop()
  })

  async function cluster(withGrant: boolean) {
    const h = harness()
    const ns = `grant-${Math.random().toString(36).slice(2)}`
    const hub = new ServiceBroker({
      nodeID: 'hub',
      namespace: ns,
      transporter: 'Fake',
      logger: false,
    })
    const agent = new ServiceBroker({
      nodeID: 'agent-1',
      namespace: ns,
      transporter: 'Fake',
      logger: false,
    })
    started.push(hub, agent)
    hub.createService(
      buildCoreCapService(h.router, new HttpRequestCensus(), {
        ownNodeId: 'hub',
        ...(withGrant ? { remoteUpdateGrant: h.grant } : {}),
      }),
    )
    await hub.start()
    await agent.start()
    await agent.waitForServices([CORE_CAP_SERVICE_NAME])
    return { hub, agent, ...h }
  }
  const action = `${CORE_CAP_SERVICE_NAME}.addons.updatePackage`
  const own = { name: '@camstack/addon-a', version: '1.2.0', nodeId: 'agent-1' }

  it('runs the update for the caller own node at the hub version', async () => {
    const c = await cluster(true)
    expect(await c.agent.call(action, own)).toEqual({ success: true })
    expect(c.updates).toEqual([own])
    expect(c.audit.map((e) => e.action)).toEqual(['agent-addon-update'])
  }, 30_000)

  it('refuses another node before anything runs, and says why', async () => {
    const c = await cluster(true)
    await expect(c.agent.call(action, { ...own, nodeId: 'agent-2' })).rejects.toMatchObject({
      type: CORE_CAP_REMOTE_FORBIDDEN_TYPE,
      message: expect.stringContaining('own node only'),
    })
    expect(c.updates).toEqual([])
    expect(c.audit.map((e) => e.action)).toEqual(['agent-addon-update-refused'])
  }, 30_000)

  it('refuses a version other than the hub record', async () => {
    const c = await cluster(true)
    await expect(c.agent.call(action, { ...own, version: '0.0.1' })).rejects.toMatchObject({
      type: CORE_CAP_REMOTE_FORBIDDEN_TYPE,
    })
    expect(c.updates).toEqual([])
  }, 30_000)

  it('stays refused as before when the grant is not wired', async () => {
    const c = await cluster(false)
    await expect(c.agent.call(action, own)).rejects.toMatchObject({
      type: CORE_CAP_REMOTE_FORBIDDEN_TYPE,
    })
    expect(c.updates).toEqual([])
  }, 30_000)

  it('does not gate the hub own call', async () => {
    const c = await cluster(true)
    expect(await c.hub.call(action, { ...own, version: 'anything', nodeId: 'agent-9' })).toEqual({
      success: true,
    })
  }, 30_000)
})
